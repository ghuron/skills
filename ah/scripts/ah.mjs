#!/usr/bin/env node
/**
 * Albert Heijn CLI — goes through api.ah.nl, as the Albert Heijn app does; reads the session
 * from AH_SESSION (set by `login`)
 *
 * Usage: node scripts/ah.mjs <command> [args]
 *
 * Commands:
 *   login                                      print the address to sign in at
 *   login <code>                               trade the code the sign-in ends with for a session; saves AH_SESSION to .env
 *   orders                                     online orders, newest first
 *   order <orderId>                            an order's products, delivery and invoice
 *   invoice <orderId> [file.pdf]               download an order's invoice (factuur) PDF
 *   receipts [count|all]                       in-store receipts (kassabonnen), newest first (default 20)
 *   receipt <id>                               a receipt's products, discounts, payments and VAT
 *   csv [--force] [--out <dir>] <pdf|dir>...   invoice PDFs -> <order number>.csv
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setTimeout as sleep } from 'timers/promises';

const DIR = dirname(fileURLToPath(import.meta.url));

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const API = 'https://api.ah.nl';
const CLIENT_ID = 'appie-ios';
const HEADERS = {
  'User-Agent': 'Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)',
  'x-application': 'AHWEBSHOP',
  Accept: 'application/json',
};

// ---------------------------------------------------------------------------
// Login (login.ah.nl, then the app's token API at api.ah.nl/mobile-auth)
//
// The app signs in on a web page: login.ah.nl/secure/oauth/authorize with
// client_id appie-ios and redirect_uri appie://login-exit. The page posts the
// password to /login/api/login with an invisible hCaptcha token, and the server
// checks it (no token: 400 INVALID_CAPTCHA), so a script can't sign in by
// itself. A person signs in in a browser instead, which then tries to open
// appie://login-exit?code=…; the code is good for one exchange at
// /mobile-auth/v1/auth/token, which returns an access token (7 days) and a
// refresh token. /mobile-auth/v1/auth/token/refresh trades the refresh token
// for new ones, and the refresh token changes every time. AH_SESSION keeps
// both, "<refresh>:<access>:<access expiry, epoch ms>", and the refresh token
// is used only when the access token has less than a day left; then the new
// pair is written back to .env.
// ---------------------------------------------------------------------------

/** fetch, retrying network-level failures ("fetch failed": resets, DNS hiccups) a couple of times. */
async function http(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!(e instanceof TypeError) || attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

/** POST JSON to the token API; returns {access_token, refresh_token, expires_in}. */
async function token(path, body) {
  const r = await http(`${API}/mobile-auth/v1/auth/${path}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, ...body }),
  });
  const res = await r.json().catch(() => ({}));
  if (r.ok && res.access_token) return res;
  throw Object.assign(new Error(`HTTP ${r.status} from /mobile-auth/v1/auth/${path}${res.message ? `: ${res.message}` : ''}`),
    { status: r.status });
}

/** `login`, step 1: where to sign in. */
export function signInUrl() {
  return {
    url: `https://login.ah.nl/secure/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=appie://login-exit&response_type=code`,
    next: 'open it in a browser tab with the developer tools on the Console, sign in, then within a few minutes run '
      + '`login <address>` with the address from "Failed to launch \'appie://login-exit?code=…\'"',
  };
}

/** A token API answer as the AH_SESSION string. */
const sessionOf = res => [res.refresh_token, res.access_token, Date.now() + res.expires_in * 1000].join(':');

/** `login`, step 2: trade the code (or the whole appie:// address) for a session string. */
export async function exchangeCode(code) {
  const m = code.trim().match(/(?:[?&]code=)?([^?&=\s]+)$/);
  if (!m) throw new Error('Pass the code from the appie://login-exit?code=… address the sign-in ends on.');
  try {
    return sessionOf(await token('token', { code: decodeURIComponent(m[1]) }));
  } catch (e) {
    if (e.status === 400) throw new Error('AH did not accept the code: it works once and only for a few minutes. Run `login` and sign in again.');
    throw e;
  }
}

/** Writes AH_SESSION into the skill folder's .env, keeping its other lines. */
function saveSession(session) {
  const file = fileURLToPath(ENV_FILE);
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
    .filter(l => !l.startsWith('AH_SESSION='));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  writeFileSync(file, [...lines, `AH_SESSION=${session}`].join('\n') + '\n', { mode: 0o600 });
  return file;
}

/** The session's access token, refreshed (and saved) when it has less than a day left; returns {token}. */
export async function login(session = process.env.AH_SESSION) {
  const [refresh, access, expires] = session?.split(':') ?? [];
  if (!refresh) throw new Error('No AH_SESSION: run `node scripts/ah.mjs login`.');
  if (access && Number(expires) - Date.now() > 86_400_000) return { token: access };
  try {
    const res = await token('token/refresh', { refreshToken: refresh });
    saveSession(sessionOf(res));
    return { token: res.access_token };
  } catch (e) {
    if (e.status === 401) throw new Error('AH no longer accepts AH_SESSION: run `node scripts/ah.mjs login`.');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Data: REST under /mobile-services and GraphQL at /graphql, as the app uses
// them. GraphQL introspection is off; the field names come from the app.
// ---------------------------------------------------------------------------

async function call(s, path, accept = 'application/json') {
  const r = await http(`${API}/${path}`, { headers: { ...HEADERS, Accept: accept, Authorization: `Bearer ${s.token}` } });
  if (r.status === 401) throw new Error('AH no longer accepts AH_SESSION: run `node scripts/ah.mjs login`.');
  if (!r.ok) throw new Error(`HTTP ${r.status} for /${path.split('?')[0]}`);
  return r;
}

export async function rest(s, path) {
  return (await call(s, path)).json();
}

export async function graphql(s, query, variables = {}) {
  const r = await http(`${API}/graphql`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401) throw new Error('AH no longer accepts AH_SESSION: run `node scripts/ah.mjs login`.');
  const res = await r.json().catch(() => ({}));
  if (res.errors?.length) throw new Error(`AH GraphQL: ${res.errors.map(e => e.message).join('; ')}`);
  if (!r.ok || !res.data) throw new Error(`HTTP ${r.status} from /graphql`);
  return res.data;
}

// "2026-10-27 08:25:00 GMT+01:00"
const LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
});

/** instant (ms or ISO string) -> "2026-10-27T08:25:00+01:00" (Amsterdam) */
const localTime = t => t == null ? null : LOCAL.format(new Date(t)).replace(' ', 'T').replace(' GMT', '');

/** Amsterdam wall time "2026-10-27 08:25:00" -> "2026-10-27T08:25:00+01:00" */
function wallTime(s) {
  if (!s) return null;
  const guess = Date.parse(`${s.replace(' ', 'T')}Z`);
  const offset = guess - Date.parse(localTime(guess).slice(0, 19) + 'Z'); // Amsterdam's offset then, negated
  return localTime(guess + offset);
}

const money = m => m?.amount ?? null;

// ---------------------------------------------------------------------------
// Online orders: /mobile-services/order/v1
//
// summaries lists the 25 most recent orders, whatever paging parameters are
// passed. details-grouped-by-taxonomy has an order's products by category and,
// once delivered, its invoiceId; invoice/download?invoiceId= is the PDF. The
// products carry today's price and Bonus offer, not what the order cost; the
// invoice has that. DELETE /order/v1/{orderId} cancels an order: never sent.
// ---------------------------------------------------------------------------

const slot = (from, to) => from && to ? `${from.slice(-8, -3)}-${to.slice(-8, -3)}` : null;

export async function orders(s) {
  return (await rest(s, 'mobile-services/order/v1/summaries?sortBy=DEFAULT')).map(o => ({
    orderId: o.orderId,
    state: o.state,
    type: o.orderType,
    date: o.deliveryDate,
    slot: o.slotInfo ? `${o.slotInfo.startTime}-${o.slotInfo.endTime}` : null,
    total: o.orderTotalPrice?.priceTotalPayable ?? null,
    discount: o.orderTotalPrice?.priceDiscount ?? null,
    changeableUntil: o.isReopenable ? localTime(o.closingTime) : null,
  }));
}

const orderDetails = (s, orderId) => {
  if (!/^\d+$/.test(orderId)) throw new Error(`Not an order number: ${orderId} (see \`orders\`)`);
  return rest(s, `mobile-services/order/v1/${orderId}/details-grouped-by-taxonomy`);
};

export async function order(s, orderId) {
  const o = await orderDetails(s, orderId);
  return {
    orderId: o.orderId,
    state: o.orderState,
    type: o.deliveryType,
    date: o.deliveryDate,
    slot: slot(o.deliveryTimePeriod?.startDateTime, o.deliveryTimePeriod?.endDateTime),
    changeableUntil: o.reopenable ? localTime(o.closingTime) : null,
    invoiceId: o.invoiceId ?? null,
    products: (o.groupedProductsInTaxonomy ?? []).flatMap(g => g.orderedProducts.map(({ amount, product: p }) => ({
      productId: p.webshopId,
      title: p.title,
      unitSize: p.salesUnitSize ?? null,
      quantity: amount,
      category: g.taxonomyName,
      price: p.currentPrice ?? p.priceBeforeBonus ?? null,
      bonus: p.isBonus ? p.bonusMechanism ?? null : null,
    }))),
  };
}

/** Download an order's invoice PDF; returns where it went. */
export async function invoice(s, orderId, file = `${orderId}.pdf`) {
  const o = await orderDetails(s, orderId);
  if (!o.invoiceId) throw new Error(`Order ${orderId} has no invoice yet (${o.orderState}); AH makes one once it's delivered.`);
  const r = await call(s, `mobile-services/order/v1/invoice/download?invoiceId=${encodeURIComponent(o.invoiceId)}`, 'application/pdf');
  const pdf = Buffer.from(await r.arrayBuffer());
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error(`AH sent no PDF for invoice ${o.invoiceId}`);
  writeFileSync(file, pdf);
  return { orderId: o.orderId, invoiceId: o.invoiceId, file, bytes: pdf.length };
}

/** Invoice PDFs -> one CSV per order, via parse_invoice.py (needs python3 with pypdf). Returns the exit code. */
export function invoiceCsv(args) {
  return spawnSync('python3', [join(DIR, 'parse_invoice.py'), ...args], { stdio: 'inherit' }).status ?? 1;
}

// ---------------------------------------------------------------------------
// In-store receipts (kassabonnen): GraphQL posReceiptsPage and posReceiptDetails
//
// Every purchase with the account's Bonus card, back about two years. A page
// holds at most 100 (more gives "Subgraph errors redacted"). Product names are
// the till's abbreviations. Products' amounts plus deposits plus discounts
// (negative) add up to the total. packageTax is the single-use plastic levy
// included in the amount; the indicator "bonusDiscount" marks a Bonus product.
// ---------------------------------------------------------------------------

const PAGE = 100;

export async function receipts(s, count = 20) {
  const want = count === 'all' ? Infinity : Number(count);
  if (!(want > 0)) throw new Error('count is a number, or all');
  const out = [];
  for (let offset = 0; out.length < want; offset += PAGE) {
    const { posReceiptsPage: page } = await graphql(s, `query($offset: Int!, $limit: Int!) {
      posReceiptsPage(pagination: {offset: $offset, limit: $limit}) {
        pagination { totalElements }
        posReceipts { id dateTime totalAmount { amount } storeAddress { street houseNumber city } }
      }
    }`, { offset, limit: Math.min(PAGE, want - out.length) });
    for (const r of page.posReceipts ?? []) {
      const a = r.storeAddress;
      out.push({
        id: r.id,
        time: localTime(r.dateTime),
        total: money(r.totalAmount),
        store: a ? `${[a.street, a.houseNumber].filter(Boolean).join(' ')}, ${a.city}` : null,
      });
    }
    if (!page.posReceipts?.length || offset + PAGE >= page.pagination.totalElements) break;
  }
  return out;
}

export async function receipt(s, id) {
  const { posReceiptDetails: r } = await graphql(s, `query($id: String!) {
    posReceiptDetails(id: $id) {
      id
      products {
        id quantity weight { amount unit } name price { amount } amount { amount } deposit { amount }
        indicators { name percentage } packageTax { amount }
      }
      discounts { type name amount { amount } }
      total { amount }
      payments { method amount { amount } }
      vat { levels { percentage salesAmount { amount } amount { amount } } }
      transaction { store lane dateTime }
    }
  }`, { id }).catch(e => {
    // an unknown id gives only this
    throw /Subgraph errors redacted/.test(e.message) ? new Error(`AH has no receipt ${id} (see \`receipts\`)`) : e;
  });
  if (!r) throw new Error(`AH has no receipt ${id} (see \`receipts\`)`);
  return {
    id: r.id,
    time: wallTime(r.transaction?.dateTime),
    storeNumber: r.transaction?.store ?? null,
    lane: r.transaction?.lane ?? null,
    products: (r.products ?? []).map(p => ({
      productId: p.id,
      name: p.name,
      quantity: p.quantity,
      weight: p.weight ? `${p.weight.amount} ${p.weight.unit}` : null,
      unitPrice: money(p.price),
      amount: money(p.amount),
      deposit: money(p.deposit),
      bonus: (p.indicators ?? []).some(i => i.name === 'bonusDiscount'),
      discountPercentage: (p.indicators ?? []).find(i => i.percentage)?.percentage ?? null,
      plasticLevy: p.packageTax?.amount ?? null,
    })),
    discounts: (r.discounts ?? []).map(d => ({ type: d.type, name: d.name, amount: money(d.amount) })),
    total: money(r.total),
    payments: (r.payments ?? []).map(p => ({ method: p.method, amount: money(p.amount) })),
    vat: (r.vat?.levels ?? []).map(v => ({ percentage: v.percentage, net: money(v.salesAmount), vat: money(v.amount) })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/ah.mjs <command> [args]
  login                                      print the address to sign in at
  login <code>                               trade the code the sign-in ends with for a session; saves AH_SESSION to .env
  orders                                     online orders, newest first
  order <orderId>                            an order's products, delivery and invoice
  invoice <orderId> [file.pdf]               download an order's invoice (factuur) PDF
  receipts [count|all]                       in-store receipts (kassabonnen), newest first (default 20)
  receipt <id>                               a receipt's products, discounts, payments and VAT
  csv [--force] [--out <dir>] <pdf|dir>...   invoice PDFs -> <order number>.csv`;

async function main([cmd, ...args]) {
  const print = out => console.log(JSON.stringify(out, null, 2));
  if (cmd === 'csv') process.exit(invoiceCsv(args));
  if (cmd === 'login') {
    if (!args[0]) return print(signInUrl());
    return print({ ok: true, savedTo: saveSession(await exchangeCode(args[0])) });
  }
  const commands = { // name: [required args, run]
    orders: [0, s => orders(s)],
    order: [1, s => order(s, args[0])],
    invoice: [1, s => invoice(s, args[0], args[1])],
    receipts: [0, s => receipts(s, args[0])],
    receipt: [1, s => receipt(s, args[0])],
  };
  if (!commands[cmd] || args.length < commands[cmd][0]) { console.error(USAGE); process.exit(1); }
  print(await commands[cmd][1](await login()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
