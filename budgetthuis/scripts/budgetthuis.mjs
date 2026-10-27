#!/usr/bin/env node
/**
 * Budget Thuis energy (budgetthuis.nl, "MijnBudget Energie") CLI wrapper —
 * reads the session from BUDGETTHUIS_SESSION (set by `login`); BUDGETTHUIS_LOGIN is the
 * account's email address, used only by `login`
 *
 * Usage: node scripts/budgetthuis.mjs <command> [args]
 *
 * Commands:
 *   login                            email a login link to BUDGETTHUIS_LOGIN
 *   login <link>                     sign in with that link; saves BUDGETTHUIS_SESSION to .env
 *   account                          customer number, name, address, masked contact/bank details
 *   contracts                        contracts: id, status, start, duration, supply address
 *   tariffs                          current contract terms and tariffs (per kWh / m³ / month)
 *   termijnbedrag                    monthly instalment, advice and allowed range
 *   invoices                         invoices with amount, due date and open balance
 *   invoice <invoiceId> [file.pdf]   download an invoice PDF
 *   usage <from> <to> [hour|day|week|month] [contractId]
 *                                    electricity, feed-in, gas and costs, dates YYYY-MM-DD
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const LOGIN = process.env.BUDGETTHUIS_LOGIN;

const PORTAL = 'https://mijn.budgetthuis.nl';
const ACCOUNTS = 'https://accounts.budgetthuis.nl';
const SESSION_COOKIE = '.AspNetCore.Identity.Application';
const API = 'https://api.budgetthuis.nl/energy/v1';
const APP_API = 'https://app.api.nutsservices.nl/energy/v1'; // the Budget Thuis app's backend
const UA = 'Mozilla/5.0';

// ---------------------------------------------------------------------------
// Login (Duende IdentityServer at accounts.budgetthuis.nl)
//
// There is no password login: /inloggen sends everyone to /inloglink-aanvragen, which
// emails a "Direct inloggen" link (a links.budgetthuis.nl click-tracking redirect to
// mijn.budgetthuis.nl/autologin/general_auto_login/?token=…&email=…). The link works
// for 30 days, more than once, and without the cookies of the browser that asked for
// it. Following it signs in at accounts.budgetthuis.nl, which sets the persistent
// .AspNetCore.Identity.Application cookie (90 days). That cookie is the session:
// with it, GET /energie/overzicht -> /connect/authorize -> /energie/oidc/return lands
// back on the portal without a form; without it (or once expired), authorize ends on
// /inloglink-aanvragen. A newer login does not end older sessions.
//
// The portal is the confidential OIDC client, so there is no PKCE or JavaScript
// on our side.
//
// Every /energie page then embeds the customer's relationId (a hidden input
// holding the Klantnummer, not the JWT's contact_person claim) and, in the chat
// widget's config, a 1-hour bearer token. Its scopes include webApi and
// mobileApi, so api.budgetthuis.nl and the app's own backend both accept it.
// ---------------------------------------------------------------------------

function extract(html, re, what, flow = 'Login') {
  const m = html.match(re);
  if (!m) throw new Error(`${flow} flow changed: could not find ${what}`);
  return m[1];
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', sup3: '³' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
      : named[e.toLowerCase()] ?? m);
}

/** Visible text of an HTML fragment, whitespace collapsed. */
const text = html => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim();

/** "€ 1.234,56" / "€ 400,-" / "€226" -> 1234.56 / 400 / 226 */
const euros = s => +s.replace(/[€\s.]/g, '').replace(',-', '').replace(',', '.');

/** "23-01-2026" -> "2026-01-23" */
const isoDate = s => s.replace(/^(\d\d)-(\d\d)-(\d{4})$/, '$3-$2-$1');

/** "2/1/2026 12:00:00 AM" (US format from the API) -> "2026-02-01" */
const usDate = s => {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s ?? null;
};

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
  const expiry = new Map(); // cookie name -> Date, from Set-Cookie's Expires
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
      const [kv, ...attrs] = sc.split(';');
      const eq = kv.indexOf('=');
      const name = kv.slice(0, eq).trim();
      jar(host).set(name, kv.slice(eq + 1).trim());
      const expires = attrs.find(a => /^\s*expires=/i.test(a));
      if (expires) expiry.set(name, new Date(expires.slice(expires.indexOf('=') + 1)));
    }
    return r;
  };
  const follow = async (url, init) => {
    let r = await request(url, init);
    for (let i = 0; i < 10 && r.status >= 300 && r.status < 400; i++) {
      url = new URL(r.headers.get('location'), url).href.replace(/^http:/, 'https:');
      r = await request(url);
    }
    return { r, url, html: await r.text() };
  };
  return { jar, expiry, cookies, follow };
}

/** `login`, step 1: have Budget Thuis email a login link to `email`. */
export async function requestLink(email = LOGIN) {
  if (!email) throw new Error("Set BUDGETTHUIS_LOGIN to the account's email address.");
  const b = browser();
  const form = await b.follow(`${PORTAL}/energie/overzicht`);
  if (new URL(form.url).pathname !== '/inloglink-aanvragen') {
    throw new Error(`Login flow changed: expected the login-link form, landed on ${form.url.split('?')[0]}`);
  }
  const field = name => decode(extract(form.html, new RegExp(`name="${name}"[^>]*value="([^"]*)"`), name));
  const sent = await b.follow(new URL('/inloglink-aanvragen', form.url).href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ReturnUrl: field('ReturnUrl'),
      Label: field('Label'),
      EmailAddress: email,
      __RequestVerificationToken: field('__RequestVerificationToken'),
    }).toString(),
  });
  if (new URL(sent.url).pathname !== '/inloglink-verzonden') {
    throw new Error(`Login flow changed: HTTP ${sent.r.status} ${sent.url.split('?')[0]} after asking for a login link`);
  }
  return { sent: email, next: 'run `login <link>` with the "Direct inloggen" link from the email "Uw persoonlijke inloglink"' };
}

/** `login`, step 2: follow the emailed link; returns the session cookie and when it expires. */
export async function completeLink(link) {
  if (!/^https:\/\/(links|mijn)\.budgetthuis\.nl\//.test(link)) {
    throw new Error('Pass the "Direct inloggen" link from the email (https://links.budgetthuis.nl/…)');
  }
  const b = browser();
  const home = await b.follow(link);
  const session = b.jar(new URL(ACCOUNTS).host).get(SESSION_COOKIE);
  if (!session || new URL(home.url).origin !== PORTAL || !home.r.ok) {
    throw new Error(`The link did not sign in (ended on HTTP ${home.r.status} ${home.url.split('?')[0]}). `
      + 'Links work for 30 days; run `login` for a new one.');
  }
  return { session, expires: b.expiry.get(SESSION_COOKIE)?.toISOString().slice(0, 10) ?? null };
}

/** Writes BUDGETTHUIS_SESSION into the skill folder's .env, keeping its other lines. */
function saveSession(session) {
  const file = fileURLToPath(ENV_FILE);
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
    .filter(l => !l.startsWith('BUDGETTHUIS_SESSION='));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  writeFileSync(file, [...lines, `BUDGETTHUIS_SESSION=${session}`].join('\n') + '\n', { mode: 0o600 });
  return file;
}

/**
 * Sign in to the portal with the session and return {cookie, relationId, token}. The
 * portal's OIDC callback occasionally answers 500, so the whole flow is retried, except
 * when the session itself is rejected.
 */
export async function login(session = process.env.BUDGETTHUIS_SESSION) {
  if (!session) throw new Error('No BUDGETTHUIS_SESSION: run `node scripts/budgetthuis.mjs login`.');
  for (let attempt = 1; ; attempt++) {
    try {
      return await loginOnce(session);
    } catch (e) {
      if (e.rejected || attempt === 3) throw e;
    }
  }
}

async function loginOnce(session) {
  const b = browser();
  b.jar(new URL(ACCOUNTS).host).set(SESSION_COOKIE, session);
  const home = await b.follow(`${PORTAL}/energie/overzicht`);
  const { origin, host } = new URL(home.url);
  if (origin === ACCOUNTS) {
    throw Object.assign(new Error('The Budget Thuis session has expired: run `node scripts/budgetthuis.mjs login`.'), { rejected: true });
  }
  if (origin !== PORTAL || !home.r.ok) {
    throw new Error(`Login flow changed: ended on HTTP ${home.r.status} ${home.url.split('?')[0]} instead of the portal`);
  }

  return {
    cookie: b.cookies(host),
    relationId: extract(home.html, /id="relationId" value="(\d+)"/, 'relationId'),
    token: extract(home.html, /\btoken: '(eyJ[^']+)'/, 'API token'),
  };
}

// ---------------------------------------------------------------------------
// Portal pages (cookie session) and the JSON API (bearer token)
//
// api.budgetthuis.nl is an Azure API Management gateway: unknown paths give a
// generic 404 whatever the auth, so it can't be explored by guessing. Its base
// URLs come from the Next.js renewal app's env config (ENERGY_API_BASE_URL,
// HOME_API_BASE_URL); the contracts endpoint is in that bundle, invoices was
// found by probing. Both want the relationId; a contact-person or contract id
// gives a descriptive 403.
//
// app.api.nutsservices.nl (Nuts is Budget Thuis's parent) is the Android app's
// backend. Its endpoints come from the app's DEX string tables and method
// annotations: R8 renamed Retrofit's @GET/@Query/@Path, so match on annotation
// values that look like API paths. An invalid query value makes the API list the
// valid ones. Besides usagecosts/details below, the same token works for
// customer/{contractId}/contract-info (tariffs as JSON),
// energy/v2/contract/{contractId}/monthlyAmount (termijnbedrag and advice),
// energy/v2/contract/{contractId}/houseHoldUsage and home/v1/contactPerson. The
// hourlytariff endpoints answer 404 unless the contract has dynamic prices.
// ---------------------------------------------------------------------------

/** Request a portal page, following redirects within the portal (e.g. to the contract's own page). */
export async function portal(session, path, init = {}) {
  let url = `${PORTAL}${path}`;
  for (let i = 0; ; i++) {
    const r = await http(url, {
      ...init,
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...init.headers, Cookie: session.cookie },
    });
    if (r.ok) return r;
    const next = r.status >= 300 && r.status < 400 && new URL(r.headers.get('location'), url);
    if (!next || next.origin !== PORTAL || i === 5) {
      throw new Error(`HTTP ${r.status} for ${init.method ?? 'GET'} ${path}${next ? ` (redirect to ${next.href})` : ''}`);
    }
    url = next.href;
  }
}

export async function api(session, path, base = API) {
  const r = await http(`${base}/${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${session.token}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${base}/${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// account / contracts / tariffs / termijnbedrag
//
// Untested: accounts with several addresses. The portal has kies-adres (choose
// address) routes for that; tariffs and termijnbedrag read whatever it shows first.
// ---------------------------------------------------------------------------

/** label -> value pairs from `<b>label</b> ... <div class="detail-value">value</div>` blocks. */
function detailPairs(html) {
  const out = {};
  for (const m of html.matchAll(/<div class="detail-description">([\s\S]*?)<\/div>\s*<div class="detail-value">([\s\S]*?)<\/div>/g)) {
    out[text(m[1].replace(/<span class="tooltip">[\s\S]*?<\/span>/g, ''))] = text(m[2]);
  }
  return out;
}

export async function account(session) {
  const html = await (await portal(session, '/energie/gegevens')).text();
  const d = detailPairs(html);
  if (!d.Klantnummer) throw new Error('Portal changed: no Klantnummer on /energie/gegevens');
  return {
    customerNumber: d.Klantnummer,
    salutation: d.Aanhef ?? null,
    name: d.Naam ?? null,
    firstName: d.Voornaam ?? null,
    address: d.Correspondentieadres ?? null,
    phone: d.Telefoonnummer ?? null,
    email: d['E-mailadres'] ?? null,
    iban: d.Rekeningnummer ?? null,
    accountHolder: d.Rekeninghouder ?? null,
  };
}

export async function contracts(session) {
  const { contractDetails } = await api(session, `contractees/${session.relationId}/contracts`);
  return contractDetails.map(c => {
    const a = c.supplyAddress ?? {};
    return {
      contractId: c.contractId,
      status: c.contractStatus,
      startDate: c.contractStartDate?.slice(0, 10) ?? null,
      durationMonths: c.contractDuration,
      address: [[a.street, a.houseNumber, a.houseNumberExtension].filter(Boolean).join(' '), a.zipCode, a.city]
        .filter(Boolean).join(', '),
    };
  });
}

const SECTIONS = {
  'Contractgegevens': 'contract',
  'Normaaltarief stroom': 'electricityNormal',
  'Daltarief stroom': 'electricityLow',
  'Enkeltarief stroom': 'electricitySingle',
  'Gastarief': 'gas',
  'Terugleververgoeding': 'feedIn',
  'Vaste leveringskosten': 'fixedMonthly',
};
const LABELS = {
  'Leveringsadres': 'address',
  'Contracttype': 'type',
  'Looptijd': 'durationMonths',
  'Startdatum': 'startDate',
  'Einddatum': 'endDate',
  'Tarief': 'supply',
  'Energiebelasting': 'energyTax',
  'Totaal': 'total',
  'Tarief (normaal)': 'normal',
  'Tarief (dal)': 'low',
  'Vaste leveringskosten stroom': 'electricity',
  'Vaste leveringskosten gas': 'gas',
};

function value(label, raw) {
  if (/^€/.test(raw)) return euros(raw);
  if (/^\d\d-\d\d-\d{4}$/.test(raw)) return isoDate(raw);
  if (label === 'durationMonths' && /^\d+$/.test(raw)) return +raw;
  return raw;
}

export async function tariffs(session) {
  const html = await (await portal(session, '/energie/contracten')).text();
  const spec = html.slice(html.indexOf('print-me'));
  if (spec.length === html.length) throw new Error('Portal changed: no tariff specification on /energie/contracten');

  // The printable "Tarievenspecificatie": <div class="details"><h3>section</h3> left/right pairs ...
  // Unknown sections keep their Dutch title, so a dynamic or electricity-only contract still comes through.
  const out = {};
  for (const block of spec.split('<div class="details">').slice(1)) {
    const title = text(block.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? '');
    if (!title) continue;
    const key = SECTIONS[title] ?? title;
    out[key] = {};
    for (const m of block.matchAll(/<div class="left">([\s\S]*?)<\/div>\s*<div class="right">([\s\S]*?)<\/div>/g)) {
      const label = text(m[1]).replace(/:$/, '');
      const k = LABELS[label] ?? label;
      out[key][k] = value(k, text(m[2]));
    }
  }

  // The "Jouw contract" box above it has the discount, renewal offer and exit fee.
  const box = html.slice(0, html.indexOf('print-me'));
  const discount = box.match(/Budget korting:\s*<\/div>\s*<div class="right">([\s\S]*?)<\/div>/);
  const fee = box.match(/Indicatie opzegvergoeding<\/h3>([\s\S]*?)<\/div>/);
  return {
    ...out,
    discount: discount ? euros(text(discount[1])) : null,
    canRenew: /Je kan verlengen!/.test(box),
    cancellationFee: fee ? text(fee[1]) : null,
    unit: 'EUR incl. btw; per kWh (electricity, feedIn), per m³ (gas), per month (fixedMonthly)',
  };
}

/**
 * /energie/termijnbedrag redirects to /energie/wijzigen-termijnbedrag/{contractId}. The slider's
 * data-hard-minimum/maximum are the allowed range. The form's amount input is pre-filled with the
 * advice, so the current amount comes from the "Je termijnbedrag" heading. Changing it would be a
 * plain form POST (advance_amount[amount] + advance_amount[_token]); the skill stays read-only.
 */
export async function termijnbedrag(session) {
  const html = await (await portal(session, '/energie/termijnbedrag')).text();
  const t = text(html);
  const num = (re, what) => {
    const m = t.match(re);
    if (!m) throw new Error(`Portal changed: could not find ${what} on /energie/termijnbedrag`);
    return m[1];
  };
  const opt = re => t.match(re)?.[1] ?? null;
  const optDate = re => { const d = opt(re); return d && isoDate(d); };
  return {
    current: euros(num(/Je termijnbedrag €\s*([\d.,]+)/, 'current amount')),
    advice: euros(num(/Ons advies €\s*([\d.,]+)/, 'advice')),
    minimum: +extract(html, /data-hard-minimum="(\d+)"/, 'minimum', 'Portal'),
    maximum: +extract(html, /data-hard-maximum="(\d+)"/, 'maximum', 'Portal'),
    message: opt(/(Je termijnbedrag (?:is|kan|moet)[^.]*\.(?:[^.]*dit is niet verplicht\.)?)/),
    adviceUpdated: optDate(/advies is bijgewerkt op:\s*(\d\d-\d\d-\d{4})/),
    basedOnKwh: +(opt(/(\d+) kWh stroom/) ?? NaN) || null,
    basedOnGasM3: +(opt(/(\d+) m³ gas/) ?? NaN) || null,
    remainingTerms: +(opt(/nog (\d+) termijnbedrag/) ?? NaN) || null,
    yearlyReadingDate: optDate(/Op (\d\d-\d\d-\d{4}) zullen we/),
  };
}

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

export async function invoices(session) {
  const res = await api(session, `contractees/${session.relationId}/invoices`);
  const list = (res.invoices ?? []).map(i => ({
    invoiceId: i.invoiceId,
    invoiceNumber: i.invoiceNumber,
    date: usDate(i.invoiceDate),
    dueDate: usDate(i.dueDate),
    description: i.description,
    amount: i.amount,
    balance: i.balance,
    status: i.status || null,
    actionNeeded: i.actionNeeded,
  })).sort((a, b) => b.date.localeCompare(a.date));
  return {
    actionNeeded: res.actionNeeded,
    openBalance: Math.round(list.reduce((s, i) => s + (i.balance || 0), 0) * 100) / 100,
    invoices: list,
  };
}

/**
 * Download link for an invoice, as listed on /energie/facturen (it embeds the contractId). Read
 * rather than built, so an account with several contracts gets the right one.
 */
export async function downloadInvoice(session, invoiceId, file = `${invoiceId}.pdf`) {
  if (!/^\d+$/.test(invoiceId)) throw new Error('invoiceId must be the numeric invoiceId from `invoices`');
  const html = await (await portal(session, '/energie/facturen')).text();
  const path = html.match(new RegExp(`/energie/invoice-download/\\d+/${invoiceId}(?=")`))?.[0];
  if (!path) throw new Error(`Invoice ${invoiceId} has no download on /energie/facturen (run \`invoices\` for ids)`);
  const r = await portal(session, path);
  const pdf = Buffer.from(await r.arrayBuffer());
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Invoice ${invoiceId}: download is not a PDF`);
  writeFileSync(file, pdf);
  return { file, bytes: pdf.length };
}

// ---------------------------------------------------------------------------
// usage
//
// The app's usage screen: GET /contract/{contractId}/usagecosts/details with
// PeriodDuration=Hour|Day|Week|Month|Year and PeriodFrom/PeriodTo (end exclusive).
// The API widens the range to whole periods (a Day request returns whole months,
// Month a whole year) and pads them with empty rows, so we trim and drop those.
//
// Hour returns one overview period per day (23 or 25 rows on DST days) and any
// range in one call (9 months ≈ 7 MB, ~9 s), starting on the first full day
// after the contract start. Hour, day and month totals agree to the Wh. Costs
// are usage × the all-in tariff; fixed costs have their own endpoint
// (fixedCostsPerPeriod, same parameters). The data is fresher than the website,
// which lags 2-3 days, and recent gas values are isInterpolated until the final
// reading.
//
// Fallback if this API goes away: the website's "Mijn verbruik" page reloads via
// POST /energie/verbruik/overzicht/data/{contractId}/day/{elk|gas|cost}/{YYYY-MM-01},
// which returns {"html": …} with the month's rows inline as amCharts
// `chart.data = [...]`. That has whole kWh/m³ and days only, an extra all-zero
// row repeating the last date of each finished month, and all-zero rows for
// days without a reading.
// ---------------------------------------------------------------------------

const RESOLUTIONS = { hour: 'Hour', day: 'Day', week: 'Week', month: 'Month' };

const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export async function usage(session, from, to, resolution = 'day', contractId) {
  if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to)) throw new Error('Dates must be YYYY-MM-DD');
  if (!RESOLUTIONS[resolution]) throw new Error(`Resolution must be one of ${Object.keys(RESOLUTIONS).join(', ')}`);
  if (!contractId) {
    const active = (await contracts(session)).filter(c => c.status === 'Active');
    if (active.length !== 1) throw new Error(`Pass a contractId; ${active.length} active contracts (run \`contracts\`)`);
    contractId = active[0].contractId;
  }
  const end = nextDay(to);
  const query = new URLSearchParams({ PeriodDuration: RESOLUTIONS[resolution], PeriodFrom: from, PeriodTo: end });
  const res = await api(session, `contract/${contractId}/usagecosts/details?${query}`, APP_API);

  const amount = x => x?.rawUsage ?? null;
  const eur = x => x?.totalRawCosts?.amountGross ?? null;
  const out = [];
  for (const r of (res.overviewPeriods ?? []).flatMap(p => p.usageCostsPerPeriod)) {
    // periodFrom/periodTo carry the Amsterdam offset, so their first 10 chars are local dates.
    // Keep rows starting in [from, to], plus a week/month that starts earlier but runs into `from`.
    const start = r.periodFrom.slice(0, 10);
    if (start > to || (start < from && r.periodTo.slice(0, 10) <= from)) continue;
    if (!r.usageElectricityConsumption && !r.usageGasConsumption) continue; // no reading (yet)
    const elk = r.usageElectricityConsumption ? 0 : null; // within a reading, a missing split is 0
    out.push({
      from: r.periodFrom,
      to: r.periodTo,
      kwh: amount(r.usageElectricityConsumption),
      kwhNormal: amount(r.usageElectricityNormalConsumption) ?? elk,
      kwhLow: amount(r.usageElectricityLowConsumption) ?? elk,
      kwhReturn: amount(r.usageElectricityProduction),
      kwhReturnNormal: amount(r.usageElectricityNormalProduction) ?? (r.usageElectricityProduction ? 0 : null),
      kwhReturnLow: amount(r.usageElectricityLowProduction) ?? (r.usageElectricityProduction ? 0 : null),
      gasM3: amount(r.usageGasConsumption),
      costElectricity: eur(r.costsElectricityConsumption),
      costReturn: eur(r.costsElectricityProduction),
      costGas: eur(r.costsGasConsumption),
      costTotal: eur(r.totalCosts),
      estimated: [r.usageElectricityConsumption, r.usageGasConsumption, r.totalCosts].some(x => x?.isInterpolated),
    });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/budgetthuis.mjs <command> [args]
  login                            email a login link to BUDGETTHUIS_LOGIN
  login <link>                     sign in with that link; saves BUDGETTHUIS_SESSION to .env
  account                          customer number, name, address, masked contact/bank details
  contracts                        contracts: id, status, start, duration, supply address
  tariffs                          current contract terms and tariffs
  termijnbedrag                    monthly instalment, advice and allowed range
  invoices                         invoices with amount, due date and open balance
  invoice <invoiceId> [file.pdf]   download an invoice PDF
  usage <from> <to> [hour|day|week|month] [contractId]
                                   electricity, feed-in, gas and costs, dates YYYY-MM-DD`;

async function main([cmd, ...args]) {
  const print = out => console.log(JSON.stringify(out, null, 2));
  if (cmd === 'login') {
    if (!args[0]) return print(await requestLink());
    const { session, expires } = await completeLink(args[0]);
    return print({ ok: true, expires, savedTo: saveSession(session) });
  }
  const commands = { // name: [required args, run]
    account: [0, s => account(s)],
    contracts: [0, s => contracts(s)],
    tariffs: [0, s => tariffs(s)],
    termijnbedrag: [0, s => termijnbedrag(s)],
    invoices: [0, s => invoices(s)],
    invoice: [1, s => downloadInvoice(s, args[0], args[1])],
    usage: [2, s => usage(s, args[0], args[1], args[2], args[3])],
  };
  if (!commands[cmd] || args.length < commands[cmd][0]) { console.error(USAGE); process.exit(1); }
  print(await commands[cmd][1](await login()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
