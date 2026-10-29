#!/usr/bin/env node
/**
 * Dunea drinking water (dunea.nl, "Mijn Dunea") CLI wrapper — logs in with DUNEA_EMAIL
 * and DUNEA_PASSWORD on every run
 *
 * Usage: node scripts/dunea.mjs <command> [args]
 *
 * Commands:
 *   account                                customer number, contact details, payment method, contracts
 *   invoices                               advance invoices and yearly bills, open and paid
 *   invoice <invoiceNumber> [file.pdf]     download an invoice PDF
 *   voorschot [agreementId]                advance payment: amount, term, allowed range
 *   usage [agreementId]                    meter readings and water use per yearly period
 */

import { fileURLToPath } from 'url';
import { existsSync, writeFileSync } from 'fs';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const EMAIL = process.env.DUNEA_EMAIL;
const PASSWORD = process.env.DUNEA_PASSWORD;

const WWW = 'https://www.dunea.nl';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Login (Sitecore site, Azure AD B2C user flow at mijndunea.b2clogin.com)
//
//   1. GET  /mijn-dunea                     -> 302 to /identity/login/..., a page whose
//      script POSTs an empty form to /identity/externallogin?authenticationType=AzureAdB2C...
//   2. POST that form                        -> 302 to the B2C authorize URL
//      (response_type=id_token, response_mode=form_post)
//   3. GET  <authorize URL>                  -> sign-in page; its SETTINGS hold csrf, transId,
//      hosts.tenant and hosts.policy. SETTINGS is a JS literal, not JSON, so read fields one by one.
//   4. POST <tenant>/SelfAsserted            -> {"status":"200"}, or status "400" with a message
//   5. GET  <tenant>/api/CombinedSigninAndSignup/confirmed -> auto-post form (state, id_token)
//      to www.dunea.nl/, with single-quoted attributes
//   6. POST it                               -> /identity/externallogincallback -> /mijn-dunea,
//      setting the .AspNet.Cookies session
//
// Like HTM's policy, the credential field is `email`, not `signInName`. The page allows 3
// tries (retryLimit) before B2C makes the user wait, so a failed login is never retried.
// ---------------------------------------------------------------------------

function extract(html, re, what, flow = 'Login') {
  const m = html.match(re);
  if (!m) throw new Error(`${flow} flow changed: could not find ${what}`);
  return m[1];
}

/** fetch, retrying network-level failures ("fetch failed": resets, DNS hiccups) a couple of times. */
async function http(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!(e instanceof TypeError) || attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

/** A fetch that keeps cookies per host and follows redirects across hosts, like a browser. */
function browser() {
  const jars = new Map(); // host -> Map(name -> value)
  const jar = host => jars.get(host) ?? jars.set(host, new Map()).get(host);
  const cookies = host => [...jar(host)].map(([k, v]) => `${k}=${v}`).join('; ');
  const request = async (url, init = {}) => {
    const { host } = new URL(url);
    const r = await http(url, {
      ...init,
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...init.headers, Cookie: cookies(host) },
    });
    for (const sc of r.headers.getSetCookie()) {
      const kv = sc.split(';', 1)[0];
      const eq = kv.indexOf('=');
      jar(host).set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
    return r;
  };
  const follow = async (url, init) => {
    let r = await request(url, init);
    for (let i = 0; i < 10 && r.status >= 300 && r.status < 400; i++) {
      url = new URL(r.headers.get('location'), url).href;
      r = await request(url);
    }
    return { r, url };
  };
  return { request, follow };
}

/** Hidden inputs of an HTML form, either quote style. */
const formFields = html => Object.fromEntries([...html.matchAll(
  /<input[^>]*\bname=(['"])([^'"]+)\1[^>]*\bvalue=(['"])([^'"]*)\3/g)].map(m => [m[2], decode(m[4])]));

/** Log in; returns a `get(path)` for www.dunea.nl that carries the session. */
export async function login(email = EMAIL, password = PASSWORD) {
  if (!email || !password) throw new Error('Set DUNEA_EMAIL and DUNEA_PASSWORD (the Mijn Dunea login).');
  const b = browser();

  // Steps 1-3: to the B2C sign-in page.
  let { r, url } = await b.follow(`${WWW}/mijn-dunea`);
  const action = decode(extract(await r.text(), /<form action="([^"]+)" method="POST"/, 'the external login form'));
  ({ r, url } = await b.follow(new URL(action, url).href, { method: 'POST' }));
  const page = await r.text();
  const b2c = new URL(url).origin;
  const csrf = extract(page, /"csrf":"([^"]+)"/, 'csrf token');
  const transId = extract(page, /"transId":"([^"]+)"/, 'transId');
  const tenant = extract(page, /"tenant":"([^"]+)"/, 'B2C tenant');
  const policy = extract(page, /"policy":"([^"]+)"/, 'B2C policy');

  // Step 4: the credentials.
  const query = `tx=${encodeURIComponent(transId)}&p=${encodeURIComponent(policy)}`;
  r = await b.request(`${b2c}${tenant}/SelfAsserted?${query}`, {
    method: 'POST',
    headers: {
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ request_type: 'RESPONSE', email, password }).toString(),
  });
  const asserted = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
  if (asserted.status !== '200') {
    throw new Error(`Login failed: ${asserted.message || JSON.stringify(asserted)} Check DUNEA_EMAIL and `
      + 'DUNEA_PASSWORD before trying again; repeated failures lock the account for a while.');
  }

  // Steps 5-6: hand the id_token back to www.dunea.nl.
  r = await b.request(`${b2c}${tenant}/api/CombinedSigninAndSignup/confirmed?rememberMe=false`
    + `&csrf_token=${encodeURIComponent(csrf)}&${query}`);
  const confirmed = await r.text();
  const target = extract(confirmed, /<form[^>]*\baction=['"]([^'"]+)['"]/,
    'the form back to dunea.nl (is two-step verification on? That is not supported)');
  ({ r, url } = await b.follow(decode(target), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(formFields(confirmed)).toString(),
  }));
  if (new URL(url).pathname !== '/mijn-dunea') throw new Error(`Login flow changed: ended on ${url}`);
  await r.arrayBuffer();

  return async path => {
    const res = await b.request(`${WWW}${path}`);
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`${path}: redirected to ${res.headers.get('location')} (session lost?)`);
    }
    if (res.status !== 200) throw new Error(`${path} -> HTTP ${res.status}`);
    return res;
  };
}

// ---------------------------------------------------------------------------
// Pages
//
// Mijn Dunea is server-rendered: each page hands its data to a React component as
// a JSON literal, ReactQueue.push(id, () => ReactDOM.render(React.createElement(
// DashboardSection, {"data": {...}}), ...)). One section per page holds everything:
//   /mijn-dunea                          DashboardSection: contracts (addressSelector), customer number
//   /mijn-dunea/facturen                 InvoicesSection: open and paid invoices of the last ~550 days
//   /mijn-dunea/voorschot-wijzigen       MonthlyPaymentFormSection: advance amount, term, min/max
//   /mijn-dunea/verbruiksoverzicht       ConsumptionSection: readings per meter per period
//   /mijn-dunea/contactgegevens-wijzigen AccountDetailsFormSection
//   /mijn-dunea/betaalgegevens-wijzigen  PaymentDetailsFormSection
// Pages about one contract take ?aid=<agreementId> and default to the first.
// Invoice PDFs are GET /download/<n>, n from an invoice's downloadUrl.
// ---------------------------------------------------------------------------

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', sup3: '³' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
      : named[e.toLowerCase()] ?? m);
}

/** The `data` prop passed to React component `name` on a page. */
function section(html, name, path) {
  const start = html.indexOf(`React.createElement(${name}, {`);
  if (start < 0) throw new Error(`Portal changed: no ${name} on ${path}`);
  // Walk the JSON literal to its closing brace, skipping braces inside strings.
  const from = html.indexOf('{', start);
  let depth = 0, inString = false;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(from, i + 1)).data;
  }
  throw new Error(`Portal changed: unterminated ${name} on ${path}`);
}

async function page(get, path, name) {
  return section(await (await get(path)).text(), name, path);
}

const withAid = (path, agreementId) => agreementId ? `${path}?aid=${encodeURIComponent(agreementId)}` : path;

/** An unknown ?aid= shows the first contract instead, so check that the page is about the one asked for. */
function checkAid(agreementId, shown) {
  if (agreementId && shown !== agreementId) throw new Error(`No contract ${agreementId} (run \`account\` for agreementIds)`);
}

/** "1.234,56" / "€105,96" -> 1234.56 / 105.96; "" -> null */
const euros = s => s ? +s.replace(/[€\s.]/g, '').replace(',', '.') : null;

const MONTHS = ['jan', 'feb', 'maa', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** "29 september 2026" / "03 nov 2023" / "1 mrt 2025" -> "2026-09-29" / "2023-11-03" / "2025-03-01" */
function isoDate(s) {
  const m = s?.trim().match(/^(\d{1,2}) ([a-z]+)\.? (\d{4})$/i);
  if (!m) return s || null;
  const mon = m[2].toLowerCase() === 'mrt' ? 3 : MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  if (!mon) return s;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const int = s => s === '' || s == null ? null : +String(s).replace(/\./g, '');

/** Contracts from a page's addressSelector: active ones first, then ended ones. */
const agreements = sel => [
  ...(sel?.links ?? []).map(l => ({ l, active: true })),
  ...(sel?.secondaryLinks ?? []).map(l => ({ l, active: false })),
].map(({ l, active }) => ({ agreementId: new URLSearchParams(l.href.split('?')[1]).get('aid'), address: l.text, active }));

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function account(get) {
  const [dash, details, payment] = await Promise.all([
    page(get, '/mijn-dunea', 'DashboardSection'),
    page(get, '/mijn-dunea/contactgegevens-wijzigen', 'AccountDetailsFormSection'),
    page(get, '/mijn-dunea/betaalgegevens-wijzigen', 'PaymentDetailsFormSection'),
  ]);
  const f = details.fields ?? {}, v = k => f[k]?.inputValue || null;
  const iban = payment.fields?.iban?.inputValue;
  const method = payment.fields?.paymentMethod?.inputValue;
  return {
    customerNumber: dash.servicesBlock?.clientNumber ?? v('accountNumber'),
    customerType: details.typeOfCustomer ?? null,
    salutation: v('salutation'),
    name: v('fullName'),
    companyName: v('companyName'),
    address: details.fullAddressAsSingleText ?? null,
    phone: v('phoneNumber'),
    email: v('emailAddress'),
    emailInvoices: v('emailAddressInvoices'),
    emailLogin: v('signInEmail'),
    twoStepVerification: details.isMfaEnabled ?? null,
    paymentMethod: { auto: 'Automatische incasso', manual: 'Handmatige overschrijving' }[method] ?? method ?? null,
    iban: iban ? `${iban.slice(0, 2)}****${iban.slice(-4)}` : null,
    contracts: agreements(dash.addressSelector),
  };
}

export async function invoices(get) {
  const d = await page(get, '/mijn-dunea/facturen', 'InvoicesSection');
  const row = (i, status) => ({
    invoiceNumber: i.invoiceNumber,
    type: i.subTitle || null,
    period: i.title || null,
    date: isoDate(i.date),
    amount: euros(i.amount),
    status,
    paymentMethod: i.paymentMethod || null,
    paymentRefused: i.paymentRefused ? i.paymentRefused === 'ja' : null,
    address: i.address || null,
    pdf: Boolean(i.download && i.downloadUrl),
  });
  return {
    openBalance: euros(d.openInvoicesTotalBalance) ?? 0,
    historyDays: d.invoiceHistoryInNumberOfDays ?? null,
    invoices: [
      ...(d.openItems ?? []).map(i => row(i, 'open')),
      ...(d.closedItems ?? []).map(i => row(i, 'paid')),
    ],
  };
}

export async function downloadInvoice(get, invoiceNumber, file = `${invoiceNumber}.pdf`) {
  const d = await page(get, '/mijn-dunea/facturen', 'InvoicesSection');
  const inv = [...(d.openItems ?? []), ...(d.closedItems ?? [])].find(i => i.invoiceNumber === invoiceNumber);
  if (!inv) throw new Error(`No invoice ${invoiceNumber} (run \`invoices\` for the numbers)`);
  if (!inv.download || !inv.downloadUrl) throw new Error(`Invoice ${invoiceNumber} has no PDF`);
  const pdf = Buffer.from(await (await get(inv.downloadUrl)).arrayBuffer());
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Invoice ${invoiceNumber}: download is not a PDF`);
  writeFileSync(file, pdf);
  return { file, bytes: pdf.length };
}

export async function voorschot(get, agreementId) {
  const d = await page(get, withAid('/mijn-dunea/voorschot-wijzigen', agreementId), 'MonthlyPaymentFormSection');
  const f = d.fields ?? {};
  if (!f.agreementId?.inputValue) throw new Error('No advance payment for this contract');
  checkAid(agreementId, f.agreementId.inputValue);
  return {
    agreementId: f.agreementId.inputValue,
    address: d.addressMessage ?? d.addressSelector?.selectedAddress ?? null,
    amount: euros(f.prepaymentAmount?.inputValue),
    term: f.paymentTerm?.inputValue ?? null,
    perMonth: euros(d.prepaymentAmountMonthly),
    perQuarter: euros(d.prepaymentAmountQuarterly),
    minimum: euros(f.minPrepayment?.inputValue),
    maximum: euros(f.maxPrepayment?.inputValue),
  };
}

export async function usage(get, agreementId) {
  const d = await page(get, withAid('/mijn-dunea/verbruiksoverzicht', agreementId), 'ConsumptionSection');
  const shown = agreements(d.addressSelector).find((a, i) => d.addressSelector.links[i]?.isActive);
  checkAid(agreementId, shown?.agreementId);
  return {
    agreementId: shown?.agreementId ?? null,
    address: d.addressSelector?.selectedAddress ?? null,
    meters: (d.usageHistoryBlock?.meters ?? []).map(m => ({
      meter: m.id,
      contractStart: isoDate(m.startDate),
      startReading: int(m.startMeterReading),
      periods: (m.consumptionTable ?? []).map(p => {
        const [from, to] = p.period.split(/\s+t\/m\s+/);
        return {
          from: isoDate(from),
          to: isoDate(to),
          reading: int(p.meterReading),
          m3: int(p.totalConsumption),
          litresPerDay: int(p.perDayUsage),
        };
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/dunea.mjs <command> [args]
  account                              customer number, contact details, payment method, contracts
  invoices                             advance invoices and yearly bills, open and paid
  invoice <invoiceNumber> [file.pdf]   download an invoice PDF
  voorschot [agreementId]              advance payment: amount, term, allowed range
  usage [agreementId]                  meter readings and water use per yearly period`;

async function main([cmd, ...args]) {
  const commands = { // name: [required args, run]
    account: [0, g => account(g)],
    invoices: [0, g => invoices(g)],
    invoice: [1, g => downloadInvoice(g, args[0], args[1])],
    voorschot: [0, g => voorschot(g, args[0])],
    usage: [0, g => usage(g, args[0])],
  };
  if (!commands[cmd] || args.length < commands[cmd][0]) { console.error(USAGE); process.exit(1); }
  console.log(JSON.stringify(await commands[cmd][1](await login()), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
