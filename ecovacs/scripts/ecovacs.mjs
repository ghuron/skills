#!/usr/bin/env node
/**
 * Ecovacs DEEBOT robot vacuum CLI — goes through the Ecovacs cloud, as the ECOVACS HOME
 * app does; reads the session from ECOVACS_SESSION (set by `login`); ECOVACS_EMAIL is the
 * account's email address, used only by `login`
 *
 * Usage: node scripts/ecovacs.mjs <command> [args]
 *
 * Commands:
 *   login                    email a verification code to ECOVACS_EMAIL
 *   login <code>             verify with that code; saves ECOVACS_SESSION to .env
 *   robots                   robots on the account: name, model, online
 *   status                   state, battery, errors, suction, water, current or last job, station
 *   consumables              brushes, filter, mop pads, dust bag: percent and hours left
 *   history [count]          recent cleaning jobs, newest first (default 10)
 *   rooms                    rooms on the map in use
 *   clean [room,...]         start cleaning the whole home, or only the listed rooms
 *   pause | resume | stop    pause, resume or end the job
 *   dock                     go back to the station
 *   locate                   say "I'm here"
 *   suction <level>          quiet, standard, max or max+
 *   water <level>            low, medium, high or ultrahigh mopping water
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash, createPublicKey, publicEncrypt, constants } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const EMAIL = process.env.ECOVACS_EMAIL;
const TZ = 'Europe/Amsterdam';

// Accounts registered in the Netherlands: other countries log in at gl-<country>-api and
// use their continent's portal (portal-na, portal-as, …).
const COUNTRY = 'nl';
const LOGIN_API = 'https://gl-nl-api.ecovacs.com';
const AUTH_API = 'https://gl-nl-openapi.ecovacs.com';
const PORTAL = 'https://portal-eu.ecouser.net';
const REALM = 'ecouser.net';
const UA = 'Dalvik/2.1.0 (Linux; U; Android 5.1.1; A5010 Build/LMY48Z)';

// ---------------------------------------------------------------------------
// Login (Ecovacs account API at gl-nl-api.ecovacs.com, then the IoT portal at
// portal-eu.ecouser.net)
//
// The robot listens on no port: it keeps an MQTT connection to Ecovacs, and the
// app reaches it through the portal. Keys and request signing are the app's
// ("global_e"), as used by deebot-client, the library behind Home Assistant.
//
// Since mid-2026 user/login answers 1013 "Please update to the latest version to
// continue" for a deviceId (our client's id) it hasn't verified, whatever
// appVersion it claims. A device is verified with an emailed code:
// user/sendEmailVerifyCode, then user/verifyDevice, both with the email address
// RSA-encrypted under the key from common/getConfig. verifyDevice needs no
// password and returns the account's uid and accessToken, and that is all later
// runs need: getAuthCode trades them for a one-time code, and users.do
// loginByItToken trades that for a portal token valid 7 days.
//
// ECOVACS_SESSION is deviceId:uid:accessToken, and every run mints a new portal
// token from it (two requests). Both login steps derive the deviceId from the
// email address, so they present the same device. An accessToken that stopped
// working gets 0004 ("user login expired") from getAuthCode.
// ---------------------------------------------------------------------------

const CLIENT = { key: '1520391301804', secret: '6c319b2a5cd3e66e39159c2e28f2fce9' };
const AUTH_CLIENT = { key: '1520391491841', secret: '77ef58ce3afbe337da74aa8c5ab963a9' };
const META = { lang: 'EN', appCode: 'global_e', appVersion: '3.14.0', channel: 'google_play', deviceType: '1' };

const md5 = s => createHash('md5').update(s).digest('hex');
const sha256 = s => createHash('sha256').update(s).digest('hex');

/** fetch, retrying network-level failures and the portal's occasional 502 a couple of times. */
async function http(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, init);
      if (r.status !== 502 || attempt === 3) return r;
    } catch (e) {
      if (!(e instanceof TypeError) || attempt === 3) throw e;
    }
    await sleep(2000 * attempt);
  }
}

/** Adds authAppkey and authSign: md5 over key, the sorted k=v pairs of params and `extra`, and secret. */
function sign(params, extra, { key, secret }) {
  const all = { ...extra, ...params };
  const text = Object.keys(all).sort().map(k => `${k}=${all[k]}`).join('');
  return { ...params, authAppkey: key, authSign: md5(key + text + secret) };
}

const ACCOUNT_ERRORS = {
  '0004': 'The Ecovacs session has expired: run `node scripts/ecovacs.mjs login`.',
  1012: 'Ecovacs rejected the verification code (wrong or older than 24 hours): run `node scripts/ecovacs.mjs login` for a new one.',
  1013: 'Ecovacs wants this device verified again: run `node scripts/ecovacs.mjs login`.',
};

/** GET on the account API; returns `data`, throws on any code but 0000. */
async function accountApi(url, params) {
  const r = await http(`${url}?${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).pathname}`);
  const res = await r.json(); // served as text/plain
  if (res.code === '0000') return res.data;
  if (ACCOUNT_ERRORS[res.code]) throw Object.assign(new Error(ACCOUNT_ERRORS[res.code]), { rejected: true });
  throw new Error(`Ecovacs answered ${res.code} "${res.msg}" to ${new URL(url).pathname.split('/').slice(-2).join('/')}`);
}

/** A signed call to the account API's /v1/private/<country>/… endpoints, as device `deviceId`. */
function privateApi(deviceId, endpoint, params) {
  const meta = { ...META, country: COUNTRY, deviceId };
  const path = [COUNTRY, META.lang, deviceId, META.appCode, META.appVersion, META.channel, META.deviceType, endpoint];
  const now = Date.now();
  const query = { ...params, requestId: md5(String(now)), authTimespan: now, authTimeZone: 'GMT-8' };
  return accountApi(`${LOGIN_API}/v1/private/${path.join('/')}`, sign(query, meta, CLIENT));
}

const loginDevice = email => md5(`ecovacs-skill:${email.trim().toLowerCase()}`);

/** The email address RSA-encrypted (PKCS#1 v1.5) under Ecovacs' published key, base64. */
async function encryptEmail(deviceId, email) {
  const config = await privateApi(deviceId, 'common/getConfig', { keys: 'PUBLIC.KEY.CONFIG' });
  const value = Array.isArray(config) && config.find(e => e.key === 'PUBLIC.KEY.CONFIG')?.value;
  if (!value) throw new Error('Login flow changed: common/getConfig returned no PUBLIC.KEY.CONFIG');
  const key = createPublicKey({ key: Buffer.from(JSON.parse(value).publicKey, 'base64'), format: 'der', type: 'spki' });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(email)).toString('base64');
}

/** `login`, step 1: have Ecovacs email a verification code to `email`. */
export async function requestCode(email = EMAIL) {
  if (!email) throw new Error("Set ECOVACS_EMAIL to the Ecovacs account's email address.");
  const deviceId = loginDevice(email);
  await privateApi(deviceId, 'user/sendEmailVerifyCode', {
    encryptEmail: await encryptEmail(deviceId, email),
    verifyType: 'EMAIL_VERIFY_DEVICE',
    supportChar: 'N',
    isForce: 'N',
  });
  return { sent: email, next: 'run `login <code>` with the code from the email "ECOVACS verification code" (valid 24 hours)' };
}

/** `login`, step 2: verify this device with the emailed code; returns the session string. */
export async function verifyCode(code, email = EMAIL) {
  if (!email) throw new Error("Set ECOVACS_EMAIL to the Ecovacs account's email address.");
  if (!/^\d+$/.test(code.trim())) throw new Error('Pass the numeric code from the email "ECOVACS verification code".');
  const deviceId = loginDevice(email);
  const data = await privateApi(deviceId, 'user/verifyDevice', {
    encryptAccount: await encryptEmail(deviceId, email),
    backUpEmail: '',
    verifyCode: code.trim(),
    model: 'Pixel 7',
    system: 'Android 14',
  });
  if (!data?.uid || !data?.accessToken) throw new Error('Login flow changed: user/verifyDevice returned no uid/accessToken');
  return [deviceId, data.uid, data.accessToken].join(':');
}

/** Writes ECOVACS_SESSION into the skill folder's .env, keeping its other lines. */
function saveSession(session) {
  const file = fileURLToPath(ENV_FILE);
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
    .filter(l => !l.startsWith('ECOVACS_SESSION='));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  writeFileSync(file, [...lines, `ECOVACS_SESSION=${session}`].join('\n') + '\n', { mode: 0o600 });
  return file;
}

/** POST to the portal's /api/<path>, with the session's auth block when `s` is given. */
async function portal(path, body, s, query) {
  const url = `${PORTAL}/api/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const r = await http(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(s ? { ...body, auth: auth(s) } : body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from the Ecovacs portal (${path})`);
  return r.json();
}

const auth = s => ({ with: 'users', userid: s.userid, realm: REALM, token: s.token, resource: s.resource });

/** Turn the session into a portal token; returns {userid, token, resource}. */
export async function login(session = process.env.ECOVACS_SESSION) {
  const [deviceId, uid, accessToken] = session?.split(':') ?? [];
  if (!accessToken) throw new Error('No ECOVACS_SESSION: run `node scripts/ecovacs.mjs login`.');
  const { authCode } = await accountApi(`${AUTH_API}/v1/global/auth/getAuthCode`, sign(
    { uid, accessToken, bizType: 'ECOVACS_IOT', deviceId, authTimespan: Date.now() }, { openId: 'global' }, AUTH_CLIENT));
  for (let attempt = 1; ; attempt++) {
    const r = await portal('users/user.do', {
      todo: 'loginByItToken', edition: 'ECOGLOBLE', userId: uid, token: authCode, realm: REALM,
      resource: deviceId, org: 'ECOWW', last: '', country: COUNTRY.toUpperCase(),
    });
    // The userId it returns is a shorter one; the portal wants that from here on.
    if (r.result === 'ok') return { userid: r.userId, token: r.token, resource: deviceId };
    // "set token error." is transient; deebot-client retries it too
    if (r.error !== 'set token error.' || attempt === 3) {
      throw new Error(`Ecovacs portal login failed: ${r.error ?? `errno ${r.errno}`}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Robots: appsvr/app.do GetGlobalDeviceList. company "eco-ng" robots (2018 on)
// speak JSON over MQTT; "eco-legacy" ones (Deebot 900, Ozmo 930 and older) speak
// XML over XMPP, which this skill doesn't do. status is 1 when online.
//
// Robot commands go to iot/devmanager.do, which relays them and waits for the
// robot's answer: {ret: "ok", resp: {body: {code, msg, data}}}. An offline robot
// gives errno 4200. No answer within ~20 s gives errno 500, and so does a command
// or argument the robot doesn't know (getLifeSpan with a part it lacks, say).
// ---------------------------------------------------------------------------

async function robotList(s) {
  const r = await portal('appsvr/app.do', { userid: s.userid, todo: 'GetGlobalDeviceList' }, s);
  if (!Array.isArray(r.devices)) throw new Error(`Ecovacs returned no robot list: ${r.msg ?? r.error ?? JSON.stringify(r)}`);
  return r.devices;
}

const label = bot => bot.nick || bot.deviceName;

export async function robots(s) {
  return (await robotList(s)).map(d => ({ name: label(d), model: d.deviceName, id: d.did, online: d.status === 1 }));
}

/** The robot to talk to: the only one on the account, or the one ECOVACS_ROBOT names. */
async function robot(s) {
  const all = await robotList(s);
  const want = process.env.ECOVACS_ROBOT;
  const found = want ? all.filter(d => [d.nick, d.deviceName, d.did].includes(want)) : all;
  if (found.length !== 1) {
    const names = all.map(label).join(', ') || 'none';
    throw new Error(want ? `No robot "${want}" on the account (robots: ${names})`
      : all.length ? `The account has several robots (${names}): set ECOVACS_ROBOT to one name or id.`
        : 'The Ecovacs account has no robots.');
  }
  if (found[0].company !== 'eco-ng') throw new Error(`${label(found[0])} speaks the older XMPP protocol, which this skill doesn't support.`);
  return found[0];
}

/** Send `cmdName` (with `data` as body.data) to the robot; returns the answer's data. */
async function send(s, bot, cmdName, data) {
  const payload = { header: { pri: '1', ts: Date.now() / 1000, tzm: 480, ver: '0.0.50' } };
  if (data !== undefined) payload.body = { data };
  const r = await portal('iot/devmanager.do',
    { cmdName, payload, payloadType: 'j', td: 'q', toId: bot.did, toRes: bot.resource, toType: bot.class }, s,
    { mid: bot.class, did: bot.did, td: 'q', u: s.userid, cv: '1.67.3', t: 'a', av: '1.3.1' });
  if (r.ret !== 'ok') {
    if (r.errno === 4200) throw new Error(`${label(bot)} is offline.`);
    if (r.errno === 500) throw Object.assign(new Error(`${label(bot)} did not answer ${cmdName}.`), { noAnswer: true });
    throw new Error(`Ecovacs answered ${cmdName} with ${r.error ?? `errno ${r.errno}`}`);
  }
  const body = r.resp?.body;
  if (body?.code !== 0) {
    throw Object.assign(new Error(`${label(bot)} refused ${cmdName}: ${body?.msg || JSON.stringify(r.resp)}`), { refused: true });
  }
  return body.data;
}

// One formatter for all timestamps. "2026-10-01 14:58:44 GMT+02:00"
const LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
});

/** epoch s -> "2026-10-01T14:58:44+02:00" (Amsterdam) */
const localTime = s => s ? LOCAL.format(Number(s) * 1000).replace(' ', 'T').replace(' GMT', '') : null;

const SUCTION = new Map([[1000, 'quiet'], [0, 'standard'], [1, 'max'], [2, 'max+']]);
const WATER = new Map([[1, 'low'], [2, 'medium'], [3, 'high'], [4, 'ultrahigh']]);
const JOB_TYPES = { auto: 'all', spotArea: 'rooms', customArea: 'zone' };
const MOTION = { working: 'cleaning', pause: 'paused', goCharging: 'returning' };
const STATION_TYPES = { 1: 'emptying', 2: 'drying', 3: 'washing' };
const STOP_REASONS = { 1: 'finished', 2: 'stopped', 3: 'finished with warnings' };

// Robot and station error codes, from deebot-client's table. 0 and 100 mean no error.
const ERRORS = {
  101: 'Battery low', 102: 'Robot is off the floor', 103: 'Driving wheel malfunction',
  104: 'Anti-drop sensors dirty', 105: 'Robot is stuck', 106: 'Side brushes worn out',
  107: 'Dust bin filter worn out', 108: 'Side brushes tangled', 109: 'Main brush tangled',
  110: 'Dust bin not installed', 111: 'Bump sensor stuck', 112: 'Laser distance sensor (LDS) malfunction',
  113: 'Main brush worn out', 114: 'Dust bin full', 115: 'Battery error', 116: 'Forward-looking sensor error',
  117: 'Gyroscope error', 118: 'Strainer blocked', 119: 'Fan error', 120: 'Water tank error',
  121: 'Mop plate jammed', 125: 'Water tank malfunction', 126: 'Water tank not installed',
  128: 'Mop plates not both installed', 129: 'Mop plate tangled',
  201: 'Air filter not installed', 202: 'Ultrasonic sensor malfunction', 203: 'Small wheel error', 204: 'Wheel stuck',
  205: 'Ion sterilizer worn out', 206: 'Ion sterilizer abnormal', 207: 'Ion sterilizer fault', 209: 'D-ToF sensor malfunction',
  301: 'Clean water tank empty', 302: 'Dirty water tank full', 303: 'Clean water tank missing',
  304: 'Dirty water tank missing', 305: 'Dirty water tank full', 306: 'Cleaning sink filter not installed',
  307: 'Station malfunction', 308: 'Station communication malfunction', 310: 'Station lid open',
  311: 'Replace the dust bag', 312: 'Dust bag full',
  314: 'Water supply or silver ion module not installed (normal without the auto-water kit)',
  315: 'Water supply module not installed', 316: 'Station dust collector full', 317: 'Clean water tank refill malfunction',
  318: 'Dirty water tank full', 319: 'Cleaning solution running low', 322: 'Clean water tank empty or not installed',
  323: 'Dirty water tank full or not installed',
};

const errorList = codes => (codes ?? []).filter(c => c !== 0 && c !== 100).map(code => ({ code, message: ERRORS[code] ?? null }));

// ---------------------------------------------------------------------------
// status: getCleanInfo (state, and cleanState.motionState while a job runs),
// getChargeState, getBattery, getError, getSpeed, getWaterInfo (enable = mop
// attached), getStats (the running job once under way, else the last one) and
// getStationState (state 0 idle; 1 busy with content.type 1 emptying, 2 drying
// or 3 washing the mop, content.motionState 2 when paused).
//
// An OMNI station starts every job by washing the mop, a minute or more on the
// dock; getCleanInfo state is then "washing", and "drying" for hours after a job.
// While the station is busy the X1 OMNI refuses getCleanInfo (20003 "task type
// did not support") but answers getCleanInfo_V2, which older robots lack.
// ---------------------------------------------------------------------------

function robotState(info, charge) {
  const motion = info.cleanState?.motionState;
  if (info.trigger === 'alert') return 'error';
  if (info.state === 'clean') return MOTION[motion] ?? 'cleaning';
  if (info.state === 'washing') return motion === 'pause' ? 'paused' : 'washing';
  if (info.state === 'goCharging') return 'returning';
  if (info.state === 'idle') return charge.isCharging === 1 ? 'docked' : 'idle';
  return info.state ?? null; // "drying", …
}

function stationState(station) {
  if (station.state === 0) return 'idle';
  if (station.content?.motionState === 2) return 'paused';
  return STATION_TYPES[station.content?.type] ?? 'busy';
}

export async function status(s) {
  const bot = await robot(s);
  if (bot.status !== 1) return { robot: label(bot), online: false };
  const ask = name => send(s, bot, name);
  const cleanInfo = () => ask('getCleanInfo').catch(e => { if (!e.refused) throw e; return ask('getCleanInfo_V2'); });
  // Robots without a station don't answer getStationState
  const [info, charge, battery, error, speed, water, stats, station] = await Promise.all([
    cleanInfo(), ask('getChargeState'), ask('getBattery'), ask('getError'),
    ask('getSpeed'), ask('getWaterInfo'), ask('getStats'), ask('getStationState').catch(e => { if (!e.noAnswer) throw e; }),
  ]);
  return {
    robot: label(bot),
    online: true,
    state: robotState(info, charge),
    battery: battery.value,
    charging: charge.isCharging === 1,
    errors: errorList(error.code),
    suction: SUCTION.get(speed.speed) ?? speed.speed,
    water: WATER.get(water.amount) ?? water.amount,
    mopAttached: water.enable === 1,
    job: stats?.start ? {
      start: localTime(stats.start),
      type: JOB_TYPES[stats.type] ?? stats.type,
      area: stats.area,
      minutes: Math.round(stats.time / 60),
    } : null,
    station: station ? {
      state: stationState(station),
      errors: errorList(station.content?.error),
    } : null,
  };
}

// ---------------------------------------------------------------------------
// consumables: getLifeSpan, left and total in minutes of cleaning. Asked one
// part at a time, because a part the robot lacks makes the whole request go
// unanswered.
// ---------------------------------------------------------------------------

const PARTS = {
  brush: 'main brush', sideBrush: 'side brush', heap: 'filter', roundMop: 'mop pads',
  dustBag: 'dust bag', unitCare: 'unit care', dModule: 'air freshener',
};

export async function consumables(s) {
  const bot = await robot(s);
  const parts = await Promise.all(Object.keys(PARTS).map(part =>
    send(s, bot, 'getLifeSpan', [part]).catch(e => { if (!e.noAnswer) throw e; return []; })));
  return parts.flat().map(p => ({
    part: PARTS[p.type] ?? p.type,
    percent: Math.round(100 * p.left / p.total),
    hoursLeft: Math.round(p.left / 60),
  }));
}

// ---------------------------------------------------------------------------
// history: the app's clean log at portal …/app/dln/api/log/clean_result/list
// (the older lg/log.do GetCleanLogs now answers ok with no logs). Signed with
// sha256("ecovacs" + app secret + ts) in headers; ts in seconds, last (duration)
// in seconds, area in m².
// ---------------------------------------------------------------------------

const APP = { id: 'ecovacs', secret: '2ea31cf06e6711eaa0aff7b9558a534e' };

export async function history(s, count = '10') {
  if (!/^\d+$/.test(count) || +count < 1) throw new Error('count is a positive number of jobs');
  const bot = await robot(s);
  const ts = Date.now();
  const q = new URLSearchParams({
    auth: JSON.stringify(auth(s)), channel: 'google_play', did: bot.did, et1: ts, defaultLang: 'EN',
    logType: 'clean', res: bot.resource, size: count, version: 'v2',
  });
  const r = await http(`${PORTAL}/app/dln/api/log/clean_result/list?${q}`, {
    headers: {
      appid: APP.id, plat: 'android', userid: s.userid, token: s.token, country: COUNTRY.toUpperCase(),
      v: '2.3.7', signType: 'sha256', sign: sha256(APP.id + APP.secret + ts),
    },
  });
  const res = r.ok && await r.json();
  if (res?.code !== 0 || !Array.isArray(res.data)) throw new Error(`Ecovacs clean log failed: HTTP ${r.status} ${res?.message ?? ''}`.trim());
  return res.data.map(l => ({
    start: localTime(l.ts),
    type: JOB_TYPES[l.type] ?? l.type,
    area: l.area,
    minutes: Math.round(l.last / 60),
    result: STOP_REASONS[l.stopReason] ?? null,
  }));
}

// ---------------------------------------------------------------------------
// rooms: getCachedMapInfo lists the saved maps (floors), using=1 is the one in
// use; getMapSet type "ar" lists its rooms (subsets, by mssid), and getMapSubSet
// gives each room's name, or a subtype for the app's preset names.
// ---------------------------------------------------------------------------

const ROOM_TYPES = {
  1: 'Living Room', 2: 'Dining Room', 3: 'Bedroom', 4: 'Study', 5: 'Kitchen', 6: 'Bathroom', 7: 'Laundry',
  8: 'Lounge', 9: 'Storeroom', 10: 'Kids Room', 11: 'Sunroom', 12: 'Corridor', 13: 'Balcony', 14: 'Gym',
};

async function roomSet(s, bot) {
  const maps = await send(s, bot, 'getCachedMapInfo');
  const map = maps.info?.find(m => m.using === 1);
  if (!map) throw new Error(`${label(bot)} has no map yet: let it map the home first.`);
  return send(s, bot, 'getMapSet', { mid: map.mid, type: 'ar' });
}

export async function rooms(s) {
  const bot = await robot(s);
  const set = await roomSet(s, bot);
  const subsets = await Promise.all((set.subsets ?? []).map(r =>
    send(s, bot, 'getMapSubSet', { mid: set.mid, msid: set.msid, type: 'ar', mssid: r.mssid })));
  return subsets.map(r => ({ id: Number(r.mssid), name: r.name || ROOM_TYPES[r.subtype] || null }));
}

// ---------------------------------------------------------------------------
// Actions: clean {act: start, type: auto} or {act: start, type: spotArea,
// content: "<id>,<id>", count}, clean {act: pause|resume|stop}, charge
// {act: go}, playSound sid 30 ("I'm here"), setSpeed, setWaterInfo. Newer
// models use clean_V2 instead of clean; not handled.
// ---------------------------------------------------------------------------

export async function clean(s, list) {
  const ids = list?.split(',').map(x => x.trim());
  if (ids && !ids.every(x => /^\d+$/.test(x))) throw new Error('Rooms are ids from `rooms`, comma-separated: clean 0,2');
  const bot = await robot(s);
  if (!ids) {
    await send(s, bot, 'clean', { act: 'start', type: 'auto' });
    return { ok: true, cleaning: 'all' };
  }
  // Room jobs take the number of passes, which the app sends from its "cleaning times" setting
  const [set, passes] = await Promise.all([
    roomSet(s, bot),
    send(s, bot, 'getCleanCount').then(d => d.count, e => { if (e.noAnswer) return 1; throw e; }),
  ]);
  const known = (set.subsets ?? []).map(r => r.mssid);
  const unknown = ids.filter(id => !known.includes(id));
  if (unknown.length) throw new Error(`No room ${unknown.join(', ')} on the map in use (rooms: ${known.join(', ')})`);
  await send(s, bot, 'clean', { act: 'start', type: 'spotArea', content: ids.join(','), count: passes });
  return { ok: true, cleaning: ids.map(Number), passes };
}

const act = (cmdName, data) => async s => {
  await send(s, await robot(s), cmdName, data);
  return { ok: true };
};

const SETTINGS = {
  suction: { cmdName: 'setSpeed', key: 'speed', levels: SUCTION },
  water: { cmdName: 'setWaterInfo', key: 'amount', levels: WATER },
};

async function set(s, setting, level) {
  const { cmdName, key, levels } = SETTINGS[setting];
  const value = [...levels].find(([, name]) => name === level)?.[0];
  if (value === undefined) throw new Error(`${setting} is one of ${[...levels.values()].join(', ')}`);
  await send(s, await robot(s), cmdName, { [key]: value });
  return { ok: true, [setting]: level };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/ecovacs.mjs <command> [args]
  login                    email a verification code to ECOVACS_EMAIL
  login <code>             verify with that code; saves ECOVACS_SESSION to .env
  robots                   robots on the account: name, model, online
  status                   state, battery, errors, suction, water, current or last job, station
  consumables              brushes, filter, mop pads, dust bag: percent and hours left
  history [count]          recent cleaning jobs, newest first (default 10)
  rooms                    rooms on the map in use
  clean [room,...]         start cleaning the whole home, or only the listed rooms
  pause | resume | stop    pause, resume or end the job
  dock                     go back to the station
  locate                   say "I'm here"
  suction <level>          ${[...SUCTION.values()].join(', ')}
  water <level>            ${[...WATER.values()].join(', ')}`;

async function main([cmd, ...args]) {
  const print = out => console.log(JSON.stringify(out, null, 2));
  if (cmd === 'login') {
    if (!args[0]) return print(await requestCode());
    return print({ ok: true, savedTo: saveSession(await verifyCode(args[0])) });
  }
  const commands = { // name: [required args, run]
    robots: [0, s => robots(s)],
    status: [0, s => status(s)],
    consumables: [0, s => consumables(s)],
    history: [0, s => history(s, args[0])],
    rooms: [0, s => rooms(s)],
    clean: [0, s => clean(s, args[0])],
    pause: [0, act('clean', { act: 'pause' })],
    resume: [0, act('clean', { act: 'resume' })],
    stop: [0, act('clean', { act: 'stop' })],
    dock: [0, act('charge', { act: 'go' })],
    locate: [0, act('playSound', { count: 1, sid: 30 })],
    suction: [1, s => set(s, 'suction', args[0])],
    water: [1, s => set(s, 'water', args[0])],
  };
  if (!commands[cmd] || args.length < commands[cmd][0]) { console.error(USAGE); process.exit(1); }
  print(await commands[cmd][1](await login()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
