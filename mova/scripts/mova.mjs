#!/usr/bin/env node
/**
 * MOVA robot vacuum CLI — goes through the MOVAhome cloud, as the MOVAhome app does; logs in with
 * MOVA_EMAIL and MOVA_PASSWORD on every run
 *
 * Usage: node scripts/mova.mjs <command> [args]   (commands: see USAGE below)
 */

import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { inflateSync } from 'zlib';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const TZ = 'Europe/Amsterdam';

// ---------------------------------------------------------------------------
// Login and API (the Dreame IoT cloud, MOVA tenant, at eu.iot.mova-tech.com)
//
// MOVAhome is Dreame's app for its MOVA brand, on Dreame's cloud with its own
// tenant (000002) and hosts. Login is an OAuth password grant with the app's
// client credentials; the password goes as md5(password + the app's salt). The
// access token lasts 2 hours, so every run logs in again. Values are the app's,
// as used by matterbridge-mova and Tasshack's dreame-vacuum (Home Assistant).
//
// The robot listens on no port: it keeps an MQTT connection to the cloud, and
// device/sendCommand relays MIoT calls (get_properties, set_properties, action)
// to it and returns its answer. The command path names the robot's shard, the
// first label of its bindDomain.
// ---------------------------------------------------------------------------

const BASE = 'https://eu.iot.mova-tech.com:13267';
const HEADERS = {
  'User-Agent': 'Mova_Smarthome/1.2.4 (iPhone; iOS 18.4.1; Scale/3.00)',
  Authorization: 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=',
  'Tenant-Id': '000002',
};
const SALT = 'RAylYC%fmSKp7%Tq';

/** Log in; returns the session {token, uid, region}. */
export async function login(email = process.env.MOVA_EMAIL, password = process.env.MOVA_PASSWORD) {
  if (!email || !password) throw new Error('Set MOVA_EMAIL and MOVA_PASSWORD (the MOVAhome login).');
  const r = await fetch(`${BASE}/dreame-auth/oauth/token`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      platform: 'IOS', scope: 'all', grant_type: 'password', type: 'account', username: email,
      password: createHash('md5').update(password + SALT).digest('hex'),
    }),
  });
  const res = await r.json().catch(() => ({}));
  if (!res.access_token) {
    throw new Error(`MOVAhome login failed: ${res.error_description || res.msg || `HTTP ${r.status}`}. `
      + 'Check MOVA_EMAIL and MOVA_PASSWORD (an account made with Google or Apple sign-in needs a password set in the app).');
  }
  return { token: res.access_token, uid: String(res.uid), region: res.region || 'eu' };
}

/** POST to the cloud; returns `data`, throws unless code is 0. */
async function api(s, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', 'Dreame-Auth': s.token },
    body: JSON.stringify(body),
  });
  const res = await r.json().catch(() => null);
  if (res?.code !== 0) throw new Error(`MOVAhome answered ${path.split('/').slice(-2).join('/')} with ${res?.msg ?? `HTTP ${r.status}`}`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Robots: iotuserbind/device/listV2. Only robot vacuums (model mova.vacuum.*).
// ---------------------------------------------------------------------------

async function robotList(s) {
  const data = await api(s, '/dreame-user-iot/iotuserbind/device/listV2', { page: 1, pageSize: 100 });
  return (data?.page?.records ?? []).filter(d => d.model?.startsWith('mova.vacuum.'));
}

const label = bot => bot.customName || bot.deviceInfo?.displayName || bot.model;

export async function robots(s) {
  return (await robotList(s)).map(d => ({ name: label(d), model: d.model, id: d.did, online: !!d.online }));
}

/** The robot to talk to: the only one on the account, or the one MOVA_ROBOT names (name or id). */
async function robot(s) {
  const all = await robotList(s);
  const want = process.env.MOVA_ROBOT;
  const found = want ? all.filter(d => [label(d), d.did].includes(want)) : all;
  if (found.length !== 1) {
    const names = all.map(label).join(', ') || 'none';
    throw new Error(want ? `No robot "${want}" on the account (robots: ${names})`
      : all.length ? `The account has several robots (${names}): set MOVA_ROBOT to one name or id.`
        : 'The MOVAhome account has no robot vacuums.');
  }
  return found[0];
}

let messageId = 0;

/** A MIoT call to the robot; returns its result. */
async function send(s, bot, method, params) {
  if (!bot.online) throw new Error(`${label(bot)} is offline.`);
  const id = ++messageId;
  const shard = bot.bindDomain?.split('.', 1)[0] || s.region;
  const data = await api(s, `/dreame-iot-com-${shard}/device/sendCommand`,
    { did: bot.did, id, data: { did: bot.did, id, method, params } });
  return data?.result;
}

/** Property values by "siid.piid", for the ones the robot has. */
async function properties(s, bot, ids) {
  const result = await send(s, bot, 'get_properties', ids.map(id => {
    const [siid, piid] = id.split('.').map(Number);
    return { did: bot.did, siid, piid };
  }));
  return Object.fromEntries((result ?? []).filter(p => p.code === 0).map(p => [`${p.siid}.${p.piid}`, p.value]));
}

const action = (s, bot, siid, aiid, input = []) => send(s, bot, 'action', { did: bot.did, siid, aiid, in: input });

// ---------------------------------------------------------------------------
// Property and value meanings: the Dreame vacuum spec as Tasshack's
// dreame-vacuum maps it, checked against a MOVA E50 Pro Ultra (mova.vacuum.r6710h).
//   2.1 state, 2.2 error · 3.1 battery, 3.2 charging · 4.1 status, 4.2 minutes and
//   4.3 m² of the current or last job, 4.4 suction, 4.5 water, 4.25 station ·
//   27.1-3 station's clean water tank, dirty water tank and dust bag
// ---------------------------------------------------------------------------

const STATES = {
  1: 'sweeping', 2: 'idle', 3: 'paused', 4: 'error', 5: 'returning', 6: 'charging', 7: 'mopping', 8: 'drying',
  9: 'washing', 10: 'returning to wash', 11: 'mapping', 12: 'sweeping and mopping', 13: 'charged', 14: 'updating',
  15: 'summoned', 16: 'station reset', 17: 'returning to fit mop', 18: 'returning to remove mop', 19: 'water check',
  20: 'adding water', 21: 'washing paused', 22: 'emptying', 23: 'remote control', 24: 'smart charging',
  25: 'second cleaning', 26: 'following', 27: 'spot cleaning', 28: 'returning to empty', 29: 'waiting for task',
  30: 'station cleaning', 31: 'returning to drain', 32: 'draining', 33: 'draining water', 34: 'emptying',
  35: 'drying dust bag', 36: 'dust bag drying paused', 37: 'heading to extra cleaning', 38: 'extra cleaning',
  97: 'shortcut', 98: 'monitoring', 99: 'monitoring paused',
};

// Robot and station errors, from dreame-vacuum's table. 0 means none.
const ERRORS = {
  1: 'Robot lifted or wheel dropped', 2: 'Cliff sensor error', 3: 'Bumper stuck', 4: 'Robot tilted',
  5: 'Bumper stuck again', 6: 'Wheel dropped again', 7: 'Optical flow sensor error', 8: 'Dust bin not installed',
  9: 'Water tank not installed', 10: 'Water tank empty', 11: 'Dust bin full', 12: 'Main brush tangled',
  13: 'Side brush tangled', 14: 'Fan error', 15: 'Left wheel motor error', 16: 'Right wheel motor error',
  17: 'Stuck while turning', 18: 'Stuck going forward', 19: 'Cannot find the station', 20: 'Battery low',
  21: 'Charging error', 22: 'Battery level error', 23: 'Laser distance sensor error', 24: 'Camera blocked',
  25: 'Camera error', 26: 'Battery temperature error', 27: 'Forward-looking sensor error', 28: 'Gyroscope error',
  29: 'Wheel jammed', 101: 'Station dust bin full', 102: 'Station dust bin open', 103: 'Station dust bin open',
  104: 'Station dust bin full', 105: 'Station clean water tank missing', 106: 'Station dirty water tank full or missing',
  107: 'Station clean water tank empty', 108: 'Station dirty water tank full or missing', 109: 'Station dirty water tank blocked',
  1000: 'Could not return to the station',
};

const SUCTION = ['quiet', 'standard', 'strong', 'max'];
const WATER = [null, 'low', 'medium', 'high'];
const STATION = { 0: 'idle', 1: 'washing', 2: 'drying', 3: 'returning', 4: 'paused', 5: 'adding water', 6: 'returning to drain' };
const CLEAN_TANK = { 0: 'ok', 1: 'missing', 2: 'low', 3: 'checking' };
const DIRTY_TANK = { 0: 'ok', 1: 'full or missing' };
const DUST_BAG = { 0: 'ok', 1: 'missing', 2: 'check' };

const named = (table, v) => v === undefined ? null : table[v] ?? v;
const error = code => ({ code, message: ERRORS[code] ?? null });

export async function status(s) {
  const bot = await robot(s);
  if (!bot.online) return { robot: label(bot), online: false };
  const p = await properties(s, bot, ['2.1', '2.2', '3.1', '3.2', '4.2', '4.3', '4.4', '4.5', '4.18', '4.25', '27.1', '27.2', '27.3']);
  // 4.18 lists all current faults ("107,105"), 2.2 only the main one
  const codes = new Set([p['2.2'], ...String(p['4.18'] ?? '').split(',').map(Number)].filter(c => c > 0));
  return {
    robot: label(bot),
    online: true,
    state: named(STATES, p['2.1']),
    battery: p['3.1'] ?? null,
    charging: p['3.2'] === 1,
    errors: [...codes].map(error),
    suction: named(SUCTION, p['4.4']),
    water: named(WATER, p['4.5']),
    job: p['4.2'] === undefined ? null : { minutes: p['4.2'], area: p['4.3'] ?? null },
    station: p['4.25'] === undefined ? null : {
      state: named(STATION, p['4.25']),
      cleanWater: named(CLEAN_TANK, p['27.1']),
      dirtyWater: named(DIRTY_TANK, p['27.2']),
      dustBag: named(DUST_BAG, p['27.3']),
    },
  };
}

// ---------------------------------------------------------------------------
// consumables: one service per part with the percentage left and the hours of
// cleaning left, in an order that differs per part. Parts the robot lacks answer
// with an error code and are left out.
// ---------------------------------------------------------------------------

const PARTS = [ // [siid, name, piid of percent, piid of hours]
  [9, 'main brush', 2, 1], [10, 'side brush', 2, 1], [11, 'filter', 1, 2], [16, 'sensors', 1, 2],
  [17, 'tank filter', 1, 2], [18, 'mop pad', 1, 2], [19, 'silver ion', 2, 1], [20, 'detergent', 1, 2],
  [24, 'squeegee', 2, 1], [25, 'dirty water channel', 2, 1], [26, 'onboard dirty water tank', 2, 1],
  [29, 'deodorizer', 2, 1], [30, 'wheel', 2, 1],
];

export async function consumables(s) {
  const bot = await robot(s);
  const p = await properties(s, bot, PARTS.flatMap(([siid, , pct, hrs]) => [`${siid}.${pct}`, `${siid}.${hrs}`]));
  return PARTS.filter(([siid, , pct]) => p[`${siid}.${pct}`] !== undefined).map(([siid, part, pct, hrs]) => ({
    part, percent: p[`${siid}.${pct}`], hoursLeft: p[`${siid}.${hrs}`] ?? null,
  }));
}

// ---------------------------------------------------------------------------
// history: the cloud keeps the robot's events. Each end of a job is an event on
// the status property (siid 4, eiid 1) whose `history` lists properties of that
// job: 8 start (epoch s), 2 minutes, 3 m², 13 1 when the job was completed.
// ---------------------------------------------------------------------------

const LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
});

/** epoch s -> "2026-11-07T10:09:56+01:00" (Amsterdam) */
const localTime = sec => sec ? LOCAL.format(sec * 1000).replace(' ', 'T').replace(' GMT', '') : null;

export async function history(s, count = '10') {
  if (!/^\d+$/.test(count) || +count < 1) throw new Error('count is a positive number of jobs');
  const bot = await robot(s);
  const data = await api(s, '/dreame-user-iot/iotstatus/history', {
    uid: s.uid, did: bot.did, from: 1, limit: +count, siid: '4', eiid: '1', region: s.region, type: 3,
  });
  return (data?.list ?? []).map(e => {
    const v = Object.fromEntries(JSON.parse(e.history ?? e.value ?? '[]').map(i => [i.piid, i.value ?? i.val]));
    return { start: localTime(v[8]), minutes: v[2] ?? null, area: v[3] ?? null, completed: v[13] === 1 };
  });
}

// ---------------------------------------------------------------------------
// rooms: property 6.8 names the cloud file with the saved maps: {"mapstr":
// [{map, name, ...}], "curr_id": <id of the map in use>}. Each `map` is
// base64url of zlib-compressed binary: a 27-byte header (map id at 0, int16 LE),
// the pixels, then JSON whose seg_inf holds the rooms: {"<id>": {name: base64 of
// the name given in the app, type: preset room type}}. A robot that hasn't saved
// a map yet has an empty mapstr.
// ---------------------------------------------------------------------------

const ROOM_TYPES = {
  1: 'Living Room', 2: 'Primary Bedroom', 3: 'Study', 4: 'Kitchen', 5: 'Dining Hall', 6: 'Bathroom', 7: 'Balcony',
  8: 'Corridor', 9: 'Utility Room', 10: 'Closet', 11: 'Meeting Room', 12: 'Office', 13: 'Fitness Area',
  14: 'Recreation Area', 15: 'Secondary Bedroom',
};

async function cloudFile(s, bot, filename) {
  const url = await api(s, '/dreame-user-iot/iotfile/getDownloadUrl', { did: bot.did, model: bot.model, filename, region: s.region });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} downloading the map file`);
  return r.text();
}

function decodeMap(raw) {
  const bin = inflateSync(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const text = bin.toString('latin1');
  const at = text.indexOf('{"');
  return { id: bin.readInt16LE(0), json: at >= 0 ? JSON.parse(Buffer.from(bin.subarray(at)).toString('utf8')) : {} };
}

async function roomList(s, bot) {
  const list = (await properties(s, bot, ['6.8']))['6.8'];
  const object = list && (JSON.parse(list).object_name ?? JSON.parse(list).obj_name);
  const saved = object && JSON.parse(await cloudFile(s, bot, object));
  const maps = (saved?.mapstr ?? []).filter(m => m.map).map(m => decodeMap(m.map));
  const map = maps.find(m => m.id === saved.curr_id) ?? (maps.length === 1 ? maps[0] : null);
  if (!map) throw new Error(`${label(bot)} has no saved map yet: let it map the home and save the map in the MOVAhome app.`);
  return Object.entries(map.json.seg_inf ?? {}).map(([id, r]) => ({
    id: Number(id),
    name: r.name ? Buffer.from(r.name, 'base64').toString('utf8') : ROOM_TYPES[r.type] ?? null,
  }));
}

export async function rooms(s) {
  return roomList(s, await robot(s));
}

// ---------------------------------------------------------------------------
// Actions: 2.1 start (also resumes), 2.2 pause, 4.2 stop, 3.1 back to the
// station, 7.1 "I'm here". Rooms: 4.1 start custom with piid 1 = 18 (segment
// cleaning) and piid 10 = {"selects": [[room, passes, suction, water, order], ...]}.
// Settings: set_properties 4.4 suction, 4.5 water.
// ---------------------------------------------------------------------------

export async function clean(s, list) {
  const ids = list?.split(',').map(x => x.trim());
  if (ids && !ids.every(x => /^\d+$/.test(x))) throw new Error('Rooms are ids from `rooms`, comma-separated: clean 1,3');
  const bot = await robot(s);
  if (!ids) {
    await action(s, bot, 2, 1);
    return { ok: true, cleaning: 'all' };
  }
  const known = (await roomList(s, bot)).map(r => r.id);
  const unknown = ids.map(Number).filter(id => !known.includes(id));
  if (unknown.length) throw new Error(`No room ${unknown.join(', ')} on the map in use (rooms: ${known.join(', ')})`);
  const p = await properties(s, bot, ['4.4', '4.5']);
  const selects = ids.map((id, i) => [Number(id), 1, p['4.4'] ?? 1, p['4.5'] ?? 2, i + 1]);
  await action(s, bot, 4, 1, [{ piid: 1, value: 18 }, { piid: 10, value: JSON.stringify({ selects }) }]);
  return { ok: true, cleaning: ids.map(Number) };
}

const act = (siid, aiid) => async s => {
  await action(s, await robot(s), siid, aiid);
  return { ok: true };
};

const SETTINGS = { suction: { piid: 4, levels: SUCTION }, water: { piid: 5, levels: WATER } };

async function set(s, setting, level) {
  const { piid, levels } = SETTINGS[setting];
  const value = levels.indexOf(level);
  if (!level || value < 0) throw new Error(`${setting} is one of ${levels.filter(Boolean).join(', ')}`);
  const bot = await robot(s);
  await send(s, bot, 'set_properties', [{ did: bot.did, siid: 4, piid, value }]);
  return { ok: true, [setting]: level };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/mova.mjs <command> [args]
  robots                   robots on the account: name, model, online
  status                   state, battery, errors, suction, water, current or last job, station
  consumables              brushes, filter, sensors, mop pad: percent and hours left
  history [count]          recent cleaning jobs, newest first (default 10)
  rooms                    rooms on the saved map in use
  clean [room,...]         start cleaning the whole home, or only the listed rooms
  pause | resume | stop    pause, resume or end the job
  dock                     go back to the station
  locate                   say "I'm here"
  suction <level>          ${SUCTION.join(', ')}
  water <level>            ${WATER.filter(Boolean).join(', ')} mopping water`;

async function main([cmd, ...args]) {
  const commands = { // name: [required args, run]
    robots: [0, s => robots(s)],
    status: [0, s => status(s)],
    consumables: [0, s => consumables(s)],
    history: [0, s => history(s, args[0])],
    rooms: [0, s => rooms(s)],
    clean: [0, s => clean(s, args[0])],
    pause: [0, act(2, 2)],
    resume: [0, act(2, 1)],
    stop: [0, act(4, 2)],
    dock: [0, act(3, 1)],
    locate: [0, act(7, 1)],
    suction: [1, s => set(s, 'suction', args[0])],
    water: [1, s => set(s, 'water', args[0])],
  };
  if (!Object.hasOwn(commands, cmd) || args.length < commands[cmd][0]) { console.error(USAGE); process.exit(1); }
  console.log(JSON.stringify(await commands[cmd][1](await login()), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
