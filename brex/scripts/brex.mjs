#!/usr/bin/env node
/**
 * Brex CLI wrapper — reads card expenses through Brex's public API with BREX_API_TOKEN
 * (an API token with read access to expenses)
 *
 * Usage: node scripts/brex.mjs <command> [args]
 *
 * Commands:
 *   expenses [from [to]]          expenses purchased in the window, newest first
 *                                 (--posted: posted in it; --updated: changed in it)
 *   expense <expenseId>           one expense, with signed links to its receipts
 *   receipts <expenseId> [dir]    download an expense's receipts
 *
 * --user <userId>[,<userId>...] keeps those cardholders only; --all keeps canceled and declined charges.
 */

import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// The token may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const API = 'https://platform.brexapis.com';

// ---------------------------------------------------------------------------
// Brex Expenses API (developer.brex.com), Authorization: Bearer <token>
//
//   GET /v1/expenses        pages of at most 100 (a higher limit is cut to 100), next_cursor;
//                           filters purchased_at_start/_end, updated_at_start/_end, user_id[] (without
//                           the brackets it is ignored), status[], payment_status[], expense_type[]
//   GET /v1/expenses/{id}   one expense, same fields; 404 {type: NOT_FOUND} for an unknown id
//
// expand[] = merchant, user, budget, department, payment, receipts.download_uris and
// load_custom_fields=true add the nested objects; without expand[]=user there is no user_id either.
// A token without the expenses scope gets 403 with the missing scope in `message`; a bad one, 401.
//
// Amounts are integers in the currency's ISO 4217 minor unit: cents for USD, yen for JPY.
// A refund is an expense of its own with negative amounts and payment_status REFUNDED; the purchase
// it refunds stays CLEARED. CANCELED (a released authorisation) and DECLINED never post.
// payment_posted_at can trail purchased_at by weeks (hotels, car rentals), so a window by posting
// date is fetched by purchase date from LOOKBACK_DAYS earlier and filtered here.
// Receipt links are signed files.brex.com URLs that expire (their Expires parameter); no token needed.
// ---------------------------------------------------------------------------

const PAGE = 100;
const LOOKBACK_DAYS = 60;
const EXPAND = ['merchant', 'user', 'budget', 'department', 'payment', 'receipts.download_uris'];
const NEVER_CHARGED = new Set(['CANCELED', 'DECLINED']);

// ISO 4217 currencies whose minor unit isn't 1/100; all others have cents.
const DECIMALS = {
  ...Object.fromEntries('BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'.split(' ').map(c => [c, 0])),
  ...Object.fromEntries('BHD IQD JOD KWD LYD OMR TND'.split(' ').map(c => [c, 3])),
  CLF: 4, UYW: 4,
};

/** A Brex money object {amount in minor units, currency} as a decimal number; null if absent. */
export function money(m) {
  if (m?.amount == null) return null;
  const d = DECIMALS[m.currency] ?? 2;
  return Number((m.amount / 10 ** d).toFixed(d));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/** Returns get(path, params) for the Brex API; array params repeat (expand[]=a&expand[]=b). */
export function client(token = process.env.BREX_API_TOKEN) {
  if (!token) throw new Error('Set BREX_API_TOKEN (a Brex API token with read access to expenses).');
  return async function get(path, params = {}) {
    const url = new URL(path, API);
    for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) if (x != null) url.searchParams.append(k, x);
    for (let attempt = 1; ; attempt++) {
      const r = await http(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if ((r.status === 429 || r.status >= 500) && attempt < 5) {
        await sleep(1000 * (Number(r.headers.get('retry-after')) || 2 ** attempt));
        continue;
      }
      const body = await r.json().catch(() => null);
      if (r.ok) return body;
      const message = body?.message ?? '';
      if (r.status === 401) throw Object.assign(new Error('Brex rejected BREX_API_TOKEN (401): it is wrong, revoked or expired'), { status: 401 });
      if (r.status === 403) throw Object.assign(new Error(`Brex refused ${url.pathname} (403): ${message || 'forbidden'}`), { status: 403 });
      throw Object.assign(new Error(`Brex ${url.pathname}: HTTP ${r.status} ${message}`.trim()), { status: r.status });
    }
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const customValue = v => v?.data?.option_label ?? v?.data?.value ?? v?.data ?? null;

function receiptLink(r) {
  const url = r.download_uris?.[0] ?? null;
  const expires = url && Number(new URL(url).searchParams.get('Expires'));
  return { id: r.id, url, expires: expires ? new Date(expires * 1000).toISOString() : null };
}

/** A raw Brex expense as the CLI prints it; `links` puts receipt links in place of their count. */
export function shape(e, { links = false } = {}) {
  const u = e.user;
  return {
    id: e.id,
    type: e.expense_type ?? null,
    status: e.status ?? null,
    paymentStatus: e.payment_status ?? null,
    ...(e.payment_status === 'DECLINED' && { declineReason: e.payment?.status_reason ?? null }),
    compliance: e.review?.compliance_status ?? null,
    purchasedAt: e.purchased_at ?? null,
    postedAt: e.payment_posted_at ?? null,
    submittedAt: e.submitted_at ?? null,
    approvedAt: e.approved_at ?? null,
    updatedAt: e.updated_at ?? null,
    user: u ? { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') } : e.user_id ? { id: e.user_id, name: null } : null,
    department: e.department?.name ?? null,
    budget: e.budget?.name ?? null,
    merchant: e.merchant?.raw_descriptor ?? null,
    mcc: e.merchant?.mcc ?? null,
    merchantCountry: e.merchant?.country ?? null,
    category: e.category ?? null,
    location: e.address ? { city: e.address.city ?? null, state: e.address.state ?? null, country: e.address.country ?? null } : null,
    amount: money(e.purchased_amount),
    currency: e.purchased_amount?.currency ?? null,
    billedAmount: money(e.billing_amount),
    billedCurrency: e.billing_amount?.currency ?? null,
    usdAmount: money(e.usd_equivalent_amount),
    memo: e.memo ?? null,
    receipts: links ? (e.receipts ?? []).map(receiptLink) : (e.receipts ?? []).length,
    customFields: Object.fromEntries((e.custom_fields ?? []).map(f => [f.display_name ?? f.key, customValue(f.value)])),
    billingEntityId: e.billing_entity_id ?? null,
    spendingEntityId: e.spending_entity_id ?? null,
    cardTransactionId: e.card_transaction_reference_id ?? null,
    url: e.dashboard_url ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const iso = d => d.toISOString().replace('.000Z', 'Z');

/** A date's start (or, with `end`, the next day's start) in UTC, or a UTC time as given. */
export function instant(s, end = false) {
  if (DATE.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (isNaN(d) || d.toISOString().slice(0, 10) !== s) throw new Error(`No such date: ${s}`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (TIME.test(s) && !isNaN(Date.parse(s))) return new Date(s);
  throw new Error(`Dates are YYYY-MM-DD or a UTC time like 2026-10-01T06:00:00Z, not ${s}`);
}

const FIELD = { purchased: 'purchased_at', posted: 'payment_posted_at', updated: 'updated_at' };
const OUT_FIELD = { purchased: 'purchasedAt', posted: 'postedAt', updated: 'updatedAt' };

/**
 * Expenses whose purchase (`by: 'posted'`: posting, `'updated'`: last change) falls in [from, to].
 * Without `from`, from the 1st of the current month; without `to`, through today (UTC).
 */
export async function expenses(get, { from, to, by = 'purchased', users = [], all = false, now = new Date() } = {}) {
  if (!FIELD[by]) throw new Error(`by must be purchased, posted or updated, not ${by}`);
  const start = from ? instant(from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = to ? instant(to, true) : instant(iso(now).slice(0, 10), true);
  if (start >= end) throw new Error(`The window is empty: ${from} is not before ${to ?? 'today'}`);

  const params = { 'expand[]': EXPAND, load_custom_fields: true, 'user_id[]': users };
  if (by === 'updated') Object.assign(params, { updated_at_start: iso(start), updated_at_end: iso(end) });
  else {
    const fetchFrom = by === 'posted' ? new Date(start.getTime() - LOOKBACK_DAYS * 864e5) : start;
    Object.assign(params, { purchased_at_start: iso(fetchFrom), purchased_at_end: iso(end) });
  }

  const rows = [], skipped = {};
  let cursor;
  do {
    const page = await get('/v1/expenses', { ...params, limit: PAGE, cursor });
    for (const e of page.items ?? []) {
      const t = Date.parse(e[FIELD[by]] ?? '');
      if (!(t >= start.getTime() && t < end.getTime())) continue;
      if (!all && NEVER_CHARGED.has(e.payment_status)) {
        skipped[e.payment_status] = (skipped[e.payment_status] ?? 0) + 1;
        continue;
      }
      rows.push(shape(e));
    }
    cursor = page.next_cursor;
  } while (cursor);

  const key = OUT_FIELD[by];
  rows.sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]) || (a.id < b.id ? -1 : 1));
  const billed = {};
  for (const r of rows) if (r.billedCurrency) billed[r.billedCurrency] = (billed[r.billedCurrency] ?? 0) + r.billedAmount;
  for (const c in billed) billed[c] = Number(billed[c].toFixed(DECIMALS[c] ?? 2));
  return {
    by,
    from: iso(start),
    to: iso(end),
    count: rows.length,
    billed,
    ...(Object.keys(skipped).length && { skipped }),
    expenses: rows,
  };
}

async function raw(get, id) {
  if (!id || /[/?#]/.test(id)) throw new Error(`Not a Brex expense id: ${id}`);
  try {
    return await get(`/v1/expenses/${encodeURIComponent(id)}`, { 'expand[]': EXPAND, load_custom_fields: true });
  } catch (e) {
    if (e.status === 404) throw new Error(`No Brex expense ${id}`);
    throw e;
  }
}

/** One expense, with signed links to its receipts. */
export async function expense(get, id) {
  return shape(await raw(get, id), { links: true });
}

/** The file type a receipt's first bytes show, or null. */
export function fileType(buf) {
  const ascii = (a, b) => buf.subarray(a, b).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(ascii(8, 12))) return 'heic';
  return null;
}

/** Downloads an expense's receipts into `dir` as brex-<expenseId>-<n>.<type>. */
export async function downloadReceipts(get, id, dir = '.') {
  const e = await raw(get, id);
  const files = [];
  for (const [i, r] of (e.receipts ?? []).entries()) {
    const url = r.download_uris?.[0];
    if (!url) throw new Error(`Receipt ${r.id} of ${id} has no download link`);
    const res = await http(url);
    if (!res.ok) throw new Error(`Receipt ${r.id} of ${id}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const fromUrl = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase().replace('jpeg', 'jpg');
    const type = fileType(buf) ?? fromUrl ?? 'bin';
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `brex-${id}-${i + 1}.${type}`);
    writeFileSync(file, buf);
    files.push({ receiptId: r.id, file, bytes: buf.length, type });
  }
  return { expenseId: id, files };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/brex.mjs <command> [args]
  expenses [from [to]] [--posted | --updated] [--user <userId>[,...]] [--all]
                              expenses purchased (--posted: posted, --updated: changed) in the window
  expense <expenseId>         one expense, with signed links to its receipts
  receipts <expenseId> [dir]  download its receipts (default: the current folder)
from and to are YYYY-MM-DD (UTC, both included) or UTC times; default: this month so far.`;

async function main(argv) {
  const usage = () => { console.error(USAGE); process.exit(1); };
  const flags = { posted: false, updated: false, all: false, users: [] };
  const args = [];
  let flagged = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) usage();
      flags.users.push(...v.split(',').filter(Boolean));
      flagged = true;
    } else if (a === '--posted' || a === '--updated' || a === '--all') {
      flags[a.slice(2)] = flagged = true;
    } else if (a.startsWith('--')) usage();
    else args.push(a);
  }
  const [cmd, ...rest] = args;
  const print = o => console.log(JSON.stringify(o, null, 2));
  const commands = { // name: [min args, max args, run]
    expenses: [0, 2, g => expenses(g, {
      from: rest[0], to: rest[1], users: flags.users, all: flags.all,
      by: flags.posted ? 'posted' : flags.updated ? 'updated' : 'purchased',
    })],
    expense: [1, 1, g => expense(g, rest[0])],
    receipts: [1, 2, g => downloadReceipts(g, rest[0], rest[1])],
  };
  const c = commands[cmd];
  if (!c || rest.length < c[0] || rest.length > c[1] || (flagged && cmd !== 'expenses') || (flags.posted && flags.updated)) usage();
  print(await c[2](client()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
