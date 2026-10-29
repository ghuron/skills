#!/usr/bin/env node
/**
 * ICS (International Card Services, icscards.nl) credit card CLI wrapper — reads the
 * session from ICSCARDS_SESSION (set by `login`, which needs approval in the ICS app)
 *
 * Usage: node scripts/icscards.mjs <command> [args]
 *
 * Commands:
 *   login                                  log in; approve in the ICS app; saves ICSCARDS_SESSION to .env
 *   account                                cards, credit limit, balance, spending left, last statement
 *   statements                             monthly statement periods with opening and closing balance
 *   statement <period> [file.pdf]          download a monthly statement PDF (period YYYY-MM)
 *   transactions [period [untilPeriod]]    transactions of the current period, or of statement periods
 *
 * --account <accountNumber> picks an account other than the default one.
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const BASE = 'https://www.icscards.nl';
const API = `${BASE}/api/nl`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Login (the /web/consumer Angular app; every login needs approval in the ICS app)
//
//   1. GET  argus.arcot.com/scripts/proxyid.js  -> a fresh device id (did_proxy) for Broadcom's
//      risk engine; the web app sends it as caDeviceId and as a cookie
//   2. POST /pub/authentication/usertoken      {username, password, action: LOGIN, virtualPortal,
//      caDeviceId, locale, sessionId} -> {jwt, authenticationMethod: PUSH | SMS}. A card from a
//      partner brand fails with 00007 and names its portal (e.g. ICS-ABNAMRO); retry with that.
//      PUSH sends an approval request to the ICS app.
//   3. POST /pub/authentication/usertoken/authentication/verify (Bearer jwt), polled: 00218
//      while waiting, then {token}. The web app polls every 10 s and gives up after 5 min.
//   4. POST /pub/authentication/login           {virtualPortal, loginType: SCA} (Bearer token)
//      -> AUTH_TOKEN and XSRF-TOKEN cookies, the session
//
// /sec calls need both cookies and the XSRF token in X-XSRF-TOKEN; without a session they
// fail with 403 {"errorCode":"00025"}. Five wrong passwords in a row block the login for a
// while, so a failed login is never retried. SMS (for accounts without the app) isn't supported.
// ---------------------------------------------------------------------------

const PORTAL = 'ICS-VISA';
const APPROVAL_TIMEOUT = 5 * 60_000;
const POLL_INTERVAL = 5_000;

const LOGIN_ERRORS = {
  '00006': 'wrong username or password',
  '00008': 'the login is blocked; reset the password on icscards.nl',
  '00018': 'this card has no ICS online account yet; activate one on icscards.nl',
  '00026': 'the account is temporarily blocked after too many failed logins',
  '00192': 'ICS turned the login down (risk check)',
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

/** POST JSON to /pub; returns {status, body, cookies}. */
async function pub(path, body, { jwt, cookies = new Map() } = {}) {
  const r = await http(`${API}/pub/${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(jwt && { 'x-ics-authorization': `Bearer ${jwt}` }),
    },
    body: JSON.stringify(body),
  });
  for (const sc of r.headers.getSetCookie()) {
    const kv = sc.split(';', 1)[0];
    const eq = kv.indexOf('=');
    cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  return { status: r.status, body: await r.json().catch(() => ({})), cookies };
}

const sessionId = () => Array.from({ length: 15 },
  () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

/**
 * Log in with username and password and wait for approval in the ICS app. `onWaiting` is
 * called once the approval request is sent. Returns {session, portal, previousLoginDate}.
 */
export async function login({
  username = process.env.ICSCARDS_USERNAME,
  password = process.env.ICSCARDS_PASSWORD,
  onWaiting = () => {},
  timeout = APPROVAL_TIMEOUT,
} = {}) {
  if (!username || !password) throw new Error('Set ICSCARDS_USERNAME and ICSCARDS_PASSWORD (the icscards.nl login).');

  // Step 1: a device id, as Broadcom's collectddna script would set it.
  const proxy = await (await http('https://argus.arcot.com/scripts/proxyid.js', { headers: { 'User-Agent': UA } })).text();
  const did = proxy.match(/return "([^"]+)"/)?.[1];
  if (!did) throw new Error('Login flow changed: no device id from argus.arcot.com');
  const cookies = new Map([['did_proxy', did]]);

  // Step 2: the password; a partner card names its own portal.
  const credentials = { username, password, action: 'LOGIN', caDeviceId: did, locale: 'nl', sessionId: sessionId() };
  let portal = PORTAL;
  let r = await pub('authentication/usertoken', { ...credentials, virtualPortal: portal }, { cookies });
  if (r.body.errorCode === '00007' && r.body.details?.virtualPortal) {
    portal = r.body.details.virtualPortal;
    r = await pub('authentication/usertoken', { ...credentials, virtualPortal: portal }, { cookies });
  }
  if (r.status !== 200 || !r.body.jwt) {
    const code = r.body.errorCode;
    throw new Error(`Login failed: ${LOGIN_ERRORS[code] ?? `HTTP ${r.status}`}${code ? ` (error ${code})` : ''}. `
      + 'Check ICSCARDS_USERNAME and ICSCARDS_PASSWORD before trying again; five failures in a row block the login.');
  }
  if (r.body.authenticationMethod !== 'PUSH') {
    throw new Error(`Login needs ${r.body.authenticationMethod} verification; only approval in the ICS app is supported.`);
  }

  // Step 3: wait for the approval.
  onWaiting();
  let token;
  for (const end = Date.now() + timeout; !token;) {
    if (Date.now() > end) throw new Error(`Not approved in the ICS app within ${timeout / 60_000} minutes; run \`login\` again.`);
    await new Promise(res => setTimeout(res, POLL_INTERVAL));
    const v = await pub('authentication/usertoken/authentication/verify', {}, { jwt: r.body.jwt, cookies });
    if (v.body.token) token = v.body.token;
    else if (v.body.errorCode !== '00218' && v.status < 500) {
      throw new Error(`Login not approved (error ${v.body.errorCode ?? `HTTP ${v.status}`}); was it declined in the app?`);
    }
  }

  // Step 4: the session.
  const done = await pub('authentication/login', { virtualPortal: portal, loginType: 'SCA' }, { jwt: token, cookies });
  const auth = cookies.get('AUTH_TOKEN'), xsrf = cookies.get('XSRF-TOKEN');
  if (done.status !== 200 || !auth || !xsrf) throw new Error(`Login flow changed: no session after approval (HTTP ${done.status})`);
  return { session: `${xsrf}:${auth}`, portal, previousLoginDate: done.body.previousLoginDate ?? null };
}

/** Writes ICSCARDS_SESSION into the skill folder's .env, keeping its other lines. */
function saveSession(session) {
  const file = fileURLToPath(ENV_FILE);
  const lines = (existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [])
    .filter(l => l && !l.startsWith('ICSCARDS_SESSION='));
  writeFileSync(file, [...lines, `ICSCARDS_SESSION=${session}`].join('\n') + '\n', { mode: 0o600 });
  return file;
}

/** A `get(path, params)` for /api/nl/sec that carries the session. */
export function client(session = process.env.ICSCARDS_SESSION) {
  if (!session) throw new Error('No ICSCARDS_SESSION: run `node scripts/icscards.mjs login` (needs approval in the ICS app).');
  const colon = session.indexOf(':');
  const xsrf = session.slice(0, colon), auth = session.slice(colon + 1);
  return async (path, params = {}, as = 'json') => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    const r = await http(`${API}/sec/${path}${query ? `?${query}` : ''}`, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: as === 'json' ? 'application/json' : '*/*',
        'X-XSRF-TOKEN': xsrf,
        Cookie: `XSRF-TOKEN=${xsrf}; AUTH_TOKEN=${auth}`,
      },
    });
    if (r.status === 401 || r.status === 403) {
      throw new Error('The ICS session has expired: run `node scripts/icscards.mjs login` (needs approval in the ICS app).');
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(`${path} -> HTTP ${r.status}${body.errorCode ? ` (error ${body.errorCode})` : ''}`);
    }
    return as === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
  };
}

// ---------------------------------------------------------------------------
// API (/api/nl/sec/frontendservices, all GET with accountNumber unless noted)
//
//   allaccountsv3              accounts with their cards (no accountNumber)
//   determineaccount           the account the portal opens on (no accountNumber)
//   accountv5                  limit, balance, credit left, pending, last statement, IBAN (masked)
//   periods                    statement periods (YYYY-MM): dates, balance brought/carried forward
//   transactionsv4             without fromPeriod: the current period plus pending authorisations;
//                              with fromPeriod/untilPeriod: booked transactions of those periods
//   statement/pdf              period=YYYY-MM -> the monthly statement PDF (octet-stream)
//
// typeOfTransaction: T booked, A authorisation not yet booked, P payment (the direct debit).
// billingAmount is in EUR, positive for spending and negative for payments and refunds;
// sourceAmount/sourceCurrency is the original amount abroad.
// ---------------------------------------------------------------------------

/** The account asked for, or the default one. An unknown accountNumber gets an HTTP 500, so check first. */
async function accountNumber(get, wanted) {
  if (!wanted) return String((await get('frontendservices/determineaccount')).accountNumber);
  const accounts = await get('frontendservices/allaccountsv3');
  if (!accounts.some(a => String(a.accountNumber) === wanted)) {
    throw new Error(`No account ${wanted} (run \`account\` for the account numbers)`);
  }
  return wanted;
}

const TYPES = { T: 'booked', A: 'pending', P: 'payment' };
const PURCHASE = { ONLINE: 'online', CASHWITHDRAWAL: 'cash' };
const PAYMENT_METHODS = { A: 'direct debit' };
const clean = s => s?.replace(/\s+/g, ' ').trim() || null;

function transaction(t) {
  return {
    date: t.transactionDate,
    time: t.processingTime || null,
    description: clean(t.description),
    amount: t.billingAmount,
    ...(t.sourceCurrency && t.sourceCurrency !== t.billingCurrency
      && { originalAmount: t.sourceAmount, originalCurrency: t.sourceCurrency }),
    type: TYPES[t.typeOfTransaction] ?? t.typeOfTransaction,
    category: clean(t.merchantCategoryCodeDescription),
    country: clean(t.countryCode),
    purchase: PURCHASE[t.typeOfPurchase] ?? null,
    card: t.lastFourDigits,
    cardholder: t.embossingName,
    wallet: t.walletProvider,
  };
}

const sum = rows => Math.round(rows.reduce((s, t) => s + t.amount, 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function account(get, wanted) {
  const number = await accountNumber(get, wanted);
  const [accounts, a] = await Promise.all([
    get('frontendservices/allaccountsv3'),
    get('frontendservices/accountv5', { accountNumber: number }),
  ]);
  const listed = accounts.find(x => String(x.accountNumber) === number) ?? {};
  return {
    accountNumber: number,
    otherAccounts: accounts.map(x => String(x.accountNumber)).filter(n => n !== number),
    product: listed.productId,
    brand: { M: 'Mastercard', V: 'Visa' }[listed.brand] ?? listed.brand,
    cards: (listed.cards ?? []).map(c => ({
      lastFourDigits: c.lastFourDigits,
      cardholder: c.embossingName,
      extraCard: c.indicatorExtraCard !== 'H',
      wallets: c.eligibleWallets ?? [],
    })),
    creditLimit: a.creditLimit,
    balance: a.currentBalance,
    pending: a.authorizedBalance,
    available: a.creditLeftToUse,
    lastStatement: {
      closedOn: a.lastDayOfStatementToBePaid,
      amountDue: a.amountDue,
      remainingDue: a.remainingAmountDue,
      dueDate: a.dueDate,
      directDebitDate: a.paymentMethod === 'A' ? a.incassoDate : null,
      state: a.paymentState,
    },
    paymentMethod: PAYMENT_METHODS[a.paymentMethod] ?? a.paymentMethod,
    payPercentage: a.paymentCondition,
    iban: a.iban,
    inArrears: a.inArrears,
  };
}

export async function statements(get, wanted) {
  const number = await accountNumber(get, wanted);
  const periods = await get('frontendservices/periods', { accountNumber: number });
  return {
    accountNumber: number,
    statements: periods.map(p => ({
      period: p.period,
      from: p.startDatePeriod,
      to: p.endDatePeriod,
      current: p.currentPeriod,
      openingBalance: p.balanceBroughtForward,
      closingBalance: p.balanceCarriedForward,
      pdf: p.showStatement,
    })),
  };
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function downloadStatement(get, period, file = `ics-${period}.pdf`, wanted) {
  if (!PERIOD.test(period)) throw new Error(`Period must be YYYY-MM, not ${period}`);
  const number = await accountNumber(get, wanted);
  const p = (await get('frontendservices/periods', { accountNumber: number })).find(x => x.period === period);
  if (!p) throw new Error(`No statement period ${period} (run \`statements\` for the periods)`);
  if (!p.showStatement) throw new Error(`Period ${period} has no statement yet`);
  const pdf = await get('frontendservices/statement/pdf', { accountNumber: number, period }, 'buffer');
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Statement ${period}: download is not a PDF`);
  writeFileSync(file, pdf);
  return { file, bytes: pdf.length };
}

export async function transactions(get, from, until = from, wanted) {
  for (const p of [from, until]) if (p && !PERIOD.test(p)) throw new Error(`Period must be YYYY-MM, not ${p}`);
  const number = await accountNumber(get, wanted);
  const periods = await get('frontendservices/periods', { accountNumber: number });
  const current = periods.find(p => p.currentPeriod)?.period;
  from ??= current;
  until ??= from;
  if (from > until) [from, until] = [until, from];
  const first = periods.find(p => p.period === from), last = periods.find(p => p.period === until);
  if (!first || !last) throw new Error(`No statement period ${first ? until : from} (run \`statements\` for the periods)`);

  // The current period comes only from the call without periods, which adds pending
  // authorisations; asked for by period it is empty. Closed periods come in one call.
  const raw = [];
  if (until === current) raw.push(...await get('frontendservices/transactionsv4', { accountNumber: number, flushCache: true }));
  const lastClosed = periods.map(p => p.period).filter(p => p !== current && p >= from && p <= until).sort().at(-1);
  if (lastClosed) {
    raw.push(...await get('frontendservices/transactionsv4',
      { accountNumber: number, flushCache: false, fromPeriod: from, untilPeriod: lastClosed }));
  }
  const rows = raw.map(transaction);
  return {
    accountNumber: number,
    fromPeriod: from,
    untilPeriod: until,
    from: first.startDatePeriod,
    to: last.endDatePeriod,
    openingBalance: first.balanceBroughtForward,
    closingBalance: last.balanceCarriedForward,
    spent: sum(rows.filter(t => t.type === 'booked')),
    paid: sum(rows.filter(t => t.type === 'payment')),
    pending: sum(rows.filter(t => t.type === 'pending')),
    transactions: rows,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/icscards.mjs <command> [args] [--account <accountNumber>]
  login                                log in; approve in the ICS app; saves ICSCARDS_SESSION to .env
  account                              cards, credit limit, balance, spending left, last statement
  statements                           monthly statement periods with opening and closing balance
  statement <period> [file.pdf]        download a monthly statement PDF (period YYYY-MM)
  transactions [period [untilPeriod]]  current period with pending payments, or statement periods`;

async function main(argv) {
  const at = argv.indexOf('--account');
  const wanted = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0) argv.splice(at, 2);
  const [cmd, ...args] = argv;
  const print = o => console.log(JSON.stringify(o, null, 2));

  if (cmd === 'login') {
    const r = await login({ onWaiting: () => console.error('Approve the login in the ICS app (waiting up to 5 minutes)...') });
    return print({ ok: true, portal: r.portal, previousLoginDate: r.previousLoginDate, savedTo: saveSession(r.session) });
  }
  const commands = { // name: [required args, run]
    account: [0, g => account(g, wanted)],
    statements: [0, g => statements(g, wanted)],
    statement: [1, g => downloadStatement(g, args[0], args[1], wanted)],
    transactions: [0, g => transactions(g, args[0], args[1], wanted)],
  };
  if (!commands[cmd] || args.length < commands[cmd][0] || (at >= 0 && !wanted)) { console.error(USAGE); process.exit(1); }
  print(await commands[cmd][1](client()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
