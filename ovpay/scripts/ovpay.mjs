#!/usr/bin/env node
/**
 * OVpay (ovpay.nl, Dutch public transport) CLI wrapper.
 *
 * Reuses the long-lived (~30-day) *offline* token the OVpay mobile app uses, so
 * you log in once and then read your account with no browser and no email code.
 *
 * Credentials / state:
 *   OVPAY_REFRESH_TOKEN   seed offline refresh token (from `login`, stored in a vault)
 *   OVPAY_STATE           path for the live token (default ~/.ovpay/tokens.json)
 *   OVPAY_EMAIL/PASSWORD  only used by `login`
 *
 * The offline refresh token ROTATES and the previous one is invalidated on use,
 * so the newest token is always persisted to OVPAY_STATE. Seed from
 * OVPAY_REFRESH_TOKEN is used only when no state file exists yet. A fresh `login`
 * revokes the previous offline session (one per client), so only log in again
 * once the token has actually expired.
 *
 * There is no public API; this follows the OVpay Android app. Identity is
 * Keycloak (realm ovpay-crm-b2c). The website's client (ovpayWebClient,
 * api.ovpay.nl) gets a 60-minute token with no working refresh; the app's
 * (ovpayAppClient, api.ovpay.app) gets an offline token valid ~30 days that
 * slides and rotates. A token for one host is rejected (403) by the other.
 * Keycloak's own /token answers 502 to everyone but OVpay's backend, so token
 * exchange and refresh go through api.identity.ovpay.app. Everything, `login`
 * included, is plain fetch: no browser.
 *
 * Usage: node scripts/ovpay.mjs <command> [args]
 *   cards                              list cards (name, balance, status, xtat)
 *   customer                           account profile
 *   trips <card> [from] [to]           trips (card = name or xtat; dates YYYY-MM-DD, inclusive)
 *   export <card> <file.csv> [from] [to]   write trips to CSV
 *   get <path>                         raw GET against https://api.ovpay.app
 *   correction <card> <tripId>         can a missed check-out be corrected, until when, to which stops
 *   correct <card> <tripId> <stop>     correct a missed check-out (uses one of a limited number)
 *   secure <card>                      enable SecureTat on a card (one-time email OTP)
 *   login                              one-time login (email code) -> stores the offline token
 */
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createInterface } from 'readline';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// Token exchange and refresh go through this identity proxy, which makes the
// Keycloak /token call server-side.
const IDENTITY = 'https://api.identity.ovpay.app/api/external/v1/Identity';
const API = 'https://api.ovpay.app';
const FLOW = 'App';
const SKEW = 90;
const MODE = { TRAM: 'Tram', BUS: 'Bus', RAIL: 'Rail', METRO: 'Metro', FERRY: 'Ferry' };

const STATE = process.env.OVPAY_STATE || join(homedir(), '.ovpay', 'tokens.json');

// --------------------------------------------------------------------------- //
// token storage + refresh
// --------------------------------------------------------------------------- //
function loadTokens() {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, 'utf8'));
  if (process.env.OVPAY_REFRESH_TOKEN) return { refresh_token: process.env.OVPAY_REFRESH_TOKEN };
  throw new Error('Not logged in. Run `node scripts/ovpay.mjs login`, or set OVPAY_REFRESH_TOKEN.');
}

function saveTokens(tok) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(tok, null, 2));
  try { chmodSync(STATE, 0o600); } catch {}
}

function jwtExp(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString()).exp || 0;
  } catch { return 0; }
}

export async function refresh(tok = loadTokens()) {
  const rt = tok.refresh_token;
  if (!rt) throw new Error('No refresh token. Run `node scripts/ovpay.mjs login`.');
  const r = await fetch(`${IDENTITY}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken: rt, authorizationFlow: FLOW }),
  });
  if (r.status !== 200) {
    throw new Error(`Refresh failed (${r.status}); the offline token expired or was `
      + `revoked. Run \`node scripts/ovpay.mjs login\`.`);
  }
  const nw = await r.json();
  if (!nw.refresh_token) nw.refresh_token = rt;
  saveTokens(nw);
  return nw;
}

let _access = null;
export async function accessToken(force = false) {
  if (!force) {
    const tok = loadTokens();
    if (tok.access_token && Date.now() / 1000 < jwtExp(tok.access_token) - SKEW) {
      return tok.access_token;
    }
  }
  return (await refresh())['access_token'];
}

// --------------------------------------------------------------------------- //
// HTTP
// --------------------------------------------------------------------------- //
export async function api(path, { method = 'GET', secureTat = null, body = null, json = null } = {}) {
  const url = path.startsWith('http') ? path : API + '/' + path.replace(/^\//, '');
  const call = async (force) => {
    const headers = { Authorization: 'Bearer ' + (await accessToken(force)), Accept: 'application/json' };
    if (secureTat) headers.SecureTatAccessToken = 'Bearer ' + secureTat;
    if (json != null) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    return fetch(url, { method, headers, body });
  };
  let r = await call(false);
  if (r.status === 401) r = await call(true);
  return r;
}

async function apiJson(path, opts) {
  const r = await api(path, opts);
  if (r.status >= 400) throw new Error(`${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// --------------------------------------------------------------------------- //
// SecureTat (per-card step-up for trip history of secured cards)
//
// Trips of a card its owner secured answer 403 "A valid SecureTat access token
// is required". For an already secured card the token is minted on demand with
// the main bearer alone, no email code, and sent as `SecureTatAccessToken:
// Bearer <token>` next to Authorization. Unsecured cards need nothing extra;
// securing one (`secure`) is the only flow that needs an emailed code.
// --------------------------------------------------------------------------- //
async function secureTatToken(xtat) {
  const r = await api('/api/v1/SecureTat/token/refresh-token', { method: 'POST', json: { xtat } });
  if (r.status !== 200) {
    throw new Error(`No SecureTat token for ${xtat} (${r.status}). If this card is not yet `
      + `secured, run \`node scripts/ovpay.mjs secure <card>\` (or secure it in the OVpay app).`);
  }
  return (await r.json()).accessToken.token;
}

// --------------------------------------------------------------------------- //
// account
// --------------------------------------------------------------------------- //
export async function customer() { return apiJson('/api/v1/Customers'); }

export async function cards() {
  const list = await apiJson('/api/v1/TransitAccounts');
  return list.map(t => ({
    name: (t.personalization || {}).name || null,
    xtat: t.xtat, xbot: t.xbot, medium: t.mediumType, status: t.status,
    balance: typeof t.balance === 'number' ? t.balance / 100 : null,
    cardNumber: t.cardNumber || null,
  }));
}

async function resolve(card) {
  if (/^[0-9a-f-]{36}$/i.test(card)) return card;
  const match = (await cards()).find(c => c.name && c.name.toLowerCase() === card.toLowerCase());
  if (!match) throw new Error(`No card named ${JSON.stringify(card)}. Use \`cards\` to list names/xtats.`);
  return match.xtat;
}

const STATUS = { COMPLETE: 'complete', CKOMISSING: 'missingCheckOut', CORRECTED: 'corrected' };
const eur = cents => typeof cents === 'number' ? cents / 100 : null;

// Fares are eurocents. checkInTimestamp carries the Europe/Amsterdam offset, so
// its first 10 characters are the local date that from/to filter on. `it` is a
// trip-history item ({trip, correctedFrom, ...}) or a trip-details answer.
function toTrip(it) {
  const t = it.trip, ci = t.checkInTimestamp || '', co = t.checkOutTimestamp || '';
  return {
    id: t.id,
    date: ci.slice(0, 10),
    departureTime: ci.slice(11, 16), departure: t.checkInLocation || '',
    arrivalTime: co.slice(11, 16), arrival: t.checkOutLocation || '',
    mode: MODE[t.transport] || (t.transport || ''), operator: t.organisationName || '',
    fareEur: eur(t.fare),
    status: STATUS[t.status] || t.status || null,
    ...(it.correctedFrom ? { originalFareEur: eur(it.correctedFrom.fare) } : {}),
  };
}

/** A card's raw trip-history items, with the SecureTat token they needed (null if none). */
async function tripItems(card) {
  const xtat = await resolve(card);
  let st = null;
  const fetchPage = (offset) =>
    api(`/api/v3/Trips/${xtat}?offset=${offset}&limit=50`, { secureTat: st });
  let r = await fetchPage(0);
  if (r.status === 403) { st = await secureTatToken(xtat); r = await fetchPage(0); }
  const items = [], seen = new Set();
  let offset = 0;
  while (true) {
    if (r.status !== 200) throw new Error(`trips -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const batch = j.items || [];
    const fresh = batch.filter(it => !seen.has(it.trip?.id));
    fresh.forEach(it => seen.add(it.trip?.id));
    items.push(...fresh);
    if (j.endOfListReached || fresh.length === 0) break;
    offset += batch.length || 50;
    r = await fetchPage(offset);
  }
  return { st, items };
}

export async function trips(card, from = null, to = null) {
  let out = (await tripItems(card)).items.map(toTrip);
  if (from) out = out.filter(t => t.date >= from);
  if (to) out = out.filter(t => t.date <= to);
  out.sort((a, b) => (a.date + a.departureTime < b.date + b.departureTime ? 1 : -1));
  return out;
}

export function tripsCsv(list) {
  const esc = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const rows = [['Date', 'Departure_Time', 'Departure_Stop', 'Arrival_Time', 'Arrival_Stop',
    'Transport_Mode', 'Operator', 'Fare_EUR'].join(',')];
  for (const t of list) {
    rows.push([t.date, t.departureTime, t.departure, t.arrivalTime, t.arrival, t.mode,
      t.operator, t.fareEur == null ? '' : t.fareEur.toFixed(2)].map(esc).join(','));
  }
  return rows.join('\n') + '\n';
}

// --------------------------------------------------------------------------- //
// Missed check-out correction (from the ovpay.nl web app's API client; the app
// API takes the same calls)
//
// GET /api/v3/Trips/{xbot}/{tripId} is a trip's details: correctionOptions has
// correctableStatus (Correctable, Expired, NotSupported, ...), the window, and
// the stops to pick as the check-out (privateCode + names, "Halte Onbekend" =
// 65533 among them); correctionAvailability counts the corrections left in the
// operator group (BusTramMetro) until its end date. PUT
// /api/v1/TripCorrection/{xbot}/{tripId}?stopPrivateCode= submits one; the trip
// keeps its id, gets version 2, status CORRECTED and the recalculated fare, and
// correctedFrom holds the original. The trip's own xbot is needed, which differs
// from the card's current one for trips made before a card was replaced.
// --------------------------------------------------------------------------- //
const stopName = s => (s.localizedNames || []).find(n => n.language === 'nl-NL')?.text
  || s.localizedNames?.[0]?.text || s.privateCode;

async function tripDetails(card, tripId) {
  const { st, items } = await tripItems(card);
  const it = items.find(i => String(i.trip?.id) === String(tripId));
  if (!it) throw new Error(`No trip ${tripId} for ${card}; \`trips\` lists the ids.`);
  const r = await api(`/api/v3/Trips/${it.trip.xbot}/${it.trip.id}`, { secureTat: st });
  if (r.status !== 200) throw new Error(`trip details -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { st, trip: it.trip, details: await r.json() };
}

export async function correction(card, tripId) {
  const { details: d } = await tripDetails(card, tripId);
  const o = d.correctionOptions || {}, a = d.correctionAvailability;
  return {
    trip: toTrip(d),
    status: o.correctableStatus || null,
    window: { from: o.correctionWindowStart || null, until: o.correctionWindowEnd || null },
    remaining: a ? {
      group: a.correctionGroup, left: a.numberOfRemainingCorrections,
      max: a.maximumNumberOfCorrections, until: a.enddate,
    } : null,
    stops: (o.stops || []).map(s => ({ code: s.privateCode, name: stopName(s) })),
  };
}

/** Correct a missed check-out to `stop` (a name or code from `correction`). Uses up one correction. */
export async function correct(card, tripId, stop) {
  const { st, trip, details: d } = await tripDetails(card, tripId);
  const o = d.correctionOptions || {};
  if (o.correctableStatus !== 'Correctable') {
    throw new Error(`Trip ${tripId} can't be corrected: ${o.correctableStatus || 'no correction options'}`
      + (o.correctionWindowEnd ? ` (window until ${o.correctionWindowEnd})` : ''));
  }
  const stops = o.stops || [];
  const want = String(stop).toLowerCase();
  const hits = stops.filter(s => s.privateCode === String(stop)
    || (s.localizedNames || []).some(n => n.text.toLowerCase() === want));
  if (hits.length !== 1) {
    const list = stops.map(s => `${stopName(s)} (${s.privateCode})`).join(', ');
    throw new Error(hits.length ? `Stop ${stop} is ambiguous; pass its code: ${hits.map(s => s.privateCode).join(', ')}`
      : `No stop ${stop} on this trip; choose one of: ${list}`);
  }
  const code = hits[0].privateCode;
  const r = await api(`/api/v1/TripCorrection/${trip.xbot}/${trip.id}?stopPrivateCode=${encodeURIComponent(code)}`,
    { method: 'PUT', secureTat: st });
  if (r.status >= 400) throw new Error(`correction -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const after = await api(`/api/v3/Trips/${trip.xbot}/${trip.id}`, { secureTat: st });
  return {
    corrected: true,
    stop: { code, name: stopName(hits[0]) },
    trip: after.status === 200 ? toTrip(await after.json()) : null,
  };
}

// --------------------------------------------------------------------------- //
// SecureTat enrollment + login (interactive bootstrap)
// --------------------------------------------------------------------------- //
function ask(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(res => rl.question(prompt, a => { rl.close(); res(a.trim()); }));
}

export async function secure(card, codeCb = () => ask('6-digit email code: ')) {
  const xtat = await resolve(card);
  const status = (await apiJson(`/api/v1/SecureTat/status/${xtat}`)).tatSecurityStatus;
  if (status === 'Secured') return { already: true };
  const key = (await apiJson(`/api/v1/SecureTat/${xtat}/generate-otp`, { method: 'POST' })).key;
  const otp = await codeCb();
  const authCode = (await apiJson('/api/v1/SecureTat/validate-otp', { method: 'POST', json: { key, otp } })).authCode;
  await apiJson('/api/v1/SecureTat/token/auth-code', { method: 'POST', json: { authCode, xtat } });
  return { secured: true };
}

// Keycloak's login pages are plain HTML forms, so this is fetch with a cookie
// jar: GET the authorization URL, POST e-mail and password, POST the emailed
// code, and read the code from the final redirect to ovpay://auth. The login
// host sits behind a WAF (Link11), but plain fetch passes it; the WAF adds a
// passive JavaScript challenge only to the page after a failed attempt. The
// proxy's retrieve-token is multipart/form-data and needs authorization_flow=App:
// without it the proxy exchanges as the web client and Keycloak answers "Found
// different client_id in clientSession", which looks like a PKCE or redirect bug.
const unescape = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// The form whose HTML contains `marker` (an input id), as {action, fields}:
// every named input with its default value, as a browser would submit it.
// Submit buttons are left out like a script's form.submit() does: the code
// form has a hidden <input name="resend" type="submit">, and sending it makes
// Keycloak mail a new code instead of checking this one.
function parseForm(html, marker) {
  const form = (html.match(/<form[\s\S]*?<\/form>/g) || []).find(f => f.includes(`id="${marker}"`));
  if (!form) return null;
  const fields = {};
  for (const tag of form.match(/<input[^>]*>/g) || []) {
    const name = attr(tag, 'name');
    if (name && attr(tag, 'type') !== 'submit') fields[name] = unescape(attr(tag, 'value') || '');
  }
  const codeName = attr(form.match(new RegExp(`<input[^>]*id="${marker}"[^>]*>`))[0], 'name');
  return { action: unescape(attr(form.match(/<form[^>]*>/)[0], 'action')), fields, codeName };
}

function pageError(html) {
  for (const re of [/kc-feedback-text">([^<]*)/, /input-error[^>]*>\s*([^<]*)/, /<title>([^<]*)/]) {
    const m = html.match(re);
    if (m && m[1].trim()) return unescape(m[1].trim());
  }
  return 'unexpected page';
}

export async function login({ email, password, codeCb } = {}) {
  email ||= process.env.OVPAY_EMAIL || await ask('OVpay email: ');
  password ||= process.env.OVPAY_PASSWORD || await ask('OVpay password: ');
  codeCb ||= () => ask('6-digit email code: ');

  const b64 = b => Buffer.from(b).toString('base64url');
  const { randomBytes, createHash } = await import('node:crypto');
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());

  const authz = (await (await fetch(`${IDENTITY}/generate-authorization-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorizationFlow: FLOW, codeChallenge: challenge, codeChallengeMethod: 'S256' }),
  })).json()).redirectUri;

  // Every page is on login.ovpay.nl, so one name -> value map is the whole jar.
  const jar = new Map();
  // Follows redirects by hand to keep cookies and to stop at ovpay://, which
  // fetch cannot follow. Returns {code} at the app redirect, else {html, url}.
  async function step(url, form) {
    let init = form && { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form) };
    for (let hops = 0; hops < 10; hops++) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await fetch(url, { ...init, headers: { ...init?.headers, Cookie: cookie }, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) {
        const [, k, v] = c.match(/^([^=]+)=([^;]*)/);
        if (v && !/max-age=0/i.test(c)) jar.set(k, v); else jar.delete(k);
      }
      const loc = r.headers.get('location');
      if (!loc) return { html: await r.text(), url };
      if (loc.startsWith('ovpay://')) {
        const u = new URL(loc);
        const code = u.searchParams.get('code');
        if (!code) throw new Error(`login failed: ${u.searchParams.get('error_description') || loc}`);
        return { code };
      }
      url = new URL(loc, url).href;
      init = undefined;
    }
    throw new Error('login failed: too many redirects');
  }

  let res = await step(authz);
  const creds = res.html && parseForm(res.html, 'username');
  if (!creds) throw new Error(`login failed: no login form (${pageError(res.html || '')})`);
  res = await step(new URL(creds.action, res.url).href, { ...creds.fields, username: email, password });
  if (!res.code) {
    const otp = parseForm(res.html, 'emailCode');
    if (!otp) throw new Error(`login failed: ${pageError(res.html)}`);
    res = await step(new URL(otp.action, res.url).href, { ...otp.fields, [otp.codeName]: await codeCb() });
    if (!res.code) throw new Error(`login failed: ${pageError(res.html)}`);
  }

  const body = new FormData();
  Object.entries({ authorization_flow: FLOW, code: res.code, code_verifier: verifier })
    .forEach(([k, v]) => body.append(k, v));
  const r = await fetch(`${IDENTITY}/retrieve-token`, { method: 'POST', body });
  if (r.status !== 200) throw new Error(`login failed: retrieve-token -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const tok = await r.json();
  saveTokens(tok);
  return tok;
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //
async function main(argv) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case 'cards': return cards();
    case 'customer': return customer();
    case 'trips': return trips(a[0], a[1], a[2]);
    case 'export': {
      const list = await trips(a[0], a[2], a[3]);
      writeFileSync(a[1], tripsCsv(list));
      return { file: a[1], trips: list.length };
    }
    case 'get': { const r = await api(a[0]); return { status: r.status, body: await r.json().catch(() => null) }; }
    case 'correction':
      if (a.length < 2) throw new Error('Usage: correction <card> <tripId>');
      return correction(a[0], a[1]);
    case 'correct':
      if (a.length < 3) throw new Error('Usage: correct <card> <tripId> <stop>');
      return correct(a[0], a[1], a.slice(2).join(' '));
    case 'secure': return secure(a[0]);
    case 'login': { await login(); return { ok: true, note: 'offline token stored in ' + STATE }; }
    default:
      throw new Error('commands: cards | customer | trips | export | get | correction | correct | secure | login');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(out => { if (out !== undefined) console.log(JSON.stringify(out, null, 2)); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
