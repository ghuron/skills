/**
 * Integration tests for mova.mjs
 * Run: node --test mova.test.mjs   (reads MOVA_EMAIL and MOVA_PASSWORD from mova/.env)
 *
 * Read-only: nothing here makes the robot move, talk or change a setting. Asserts
 * the shape of every reading command's output against the live account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../mova/scripts/mova.mjs');

function parseEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const ENV = { ...process.env, ...parseEnvFile(join(DIR, '../../mova/.env')) };
const skip = !(ENV.MOVA_EMAIL && ENV.MOVA_PASSWORD) && 'no MOVA_EMAIL/MOVA_PASSWORD';

function run(args, env = ENV) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 });
}

function runCLI(args) {
  const r = run(args);
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// For commands the robot itself answers: skips the test (returns undefined) while it is offline.
function runOnRobot(t, args) {
  const r = run(args);
  if (r.status === 1 && /is offline\.\s*$/.test(r.stderr)) return t.skip('robot offline');
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const isNum = x => typeof x === 'number' && Number.isFinite(x);

test('no credentials: fails and names the variables', () => {
  const r = run(['status'], { ...ENV, MOVA_EMAIL: '', MOVA_PASSWORD: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MOVA_EMAIL and MOVA_PASSWORD/);
});

test('unknown command: prints usage', () => {
  const r = run(['notacommand']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: node scripts\/mova\.mjs/);
});

test('robots: at least one, with name, model, id and online', { skip }, () => {
  const list = runCLI(['robots']);
  assert.ok(list.length > 0, 'expected a robot');
  for (const r of list) {
    assert.equal(typeof r.name, 'string');
    assert.match(r.model, /^mova\.vacuum\./);
    assert.ok(r.id);
    assert.equal(typeof r.online, 'boolean');
  }
});

test('status: state, battery, errors, settings, job and station', { skip }, () => {
  const s = runCLI(['status']);
  assert.equal(typeof s.robot, 'string');
  if (!s.online) return; // nothing else to check on an offline robot
  assert.equal(typeof s.state, 'string', `unknown state ${s.state}`);
  assert.ok(s.battery >= 0 && s.battery <= 100);
  assert.equal(typeof s.charging, 'boolean');
  for (const e of s.errors) assert.ok(isNum(e.code) && e.code > 0);
  assert.ok(['quiet', 'standard', 'strong', 'max'].includes(s.suction), `unexpected suction ${s.suction}`);
  assert.ok(['low', 'medium', 'high'].includes(s.water), `unexpected water ${s.water}`);
  if (s.job) assert.ok(isNum(s.job.minutes));
  if (s.station) assert.ok(['ok', 'low', 'missing', 'checking'].includes(s.station.cleanWater), `cleanWater ${s.station.cleanWater}`);
});

test('consumables: brushes and filter with percent and hours left', { skip }, t => {
  const parts = runOnRobot(t, ['consumables']);
  if (!parts) return;
  for (const name of ['main brush', 'side brush', 'filter']) assert.ok(parts.some(p => p.part === name), `no ${name}`);
  for (const p of parts) {
    assert.ok(p.percent >= 0 && p.percent <= 100, `${p.part}: percent ${p.percent}`);
    assert.ok(isNum(p.hoursLeft) && p.hoursLeft >= 0, `${p.part}: hoursLeft ${p.hoursLeft}`);
  }
});

test('history: newest first, with start, minutes, area and completed', { skip }, () => {
  const jobs = runCLI(['history', '5']);
  assert.ok(jobs.length <= 5, `expected at most 5 jobs, got ${jobs.length}`);
  for (const j of jobs) {
    assert.match(j.start, LOCAL_TIME);
    assert.ok(isNum(j.minutes) && isNum(j.area));
    assert.equal(typeof j.completed, 'boolean');
  }
  const starts = jobs.map(j => Date.parse(j.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'expected newest first');
});

test('rooms: numeric ids and names, once a map is saved', { skip }, t => {
  const r = run(['rooms']);
  if (r.status === 1 && /no saved map yet/.test(r.stderr)) return t.skip('no saved map');
  if (r.status === 1 && /is offline\.\s*$/.test(r.stderr)) return t.skip('robot offline');
  assert.equal(r.status, 0, r.stderr);
  const rooms = JSON.parse(r.stdout);
  assert.ok(rooms.length > 0, 'expected rooms on the saved map');
  for (const room of rooms) {
    assert.ok(Number.isInteger(room.id));
    assert.ok(room.name === null || typeof room.name === 'string');
  }
});

// Fail on the argument checks, before anything is sent to the robot.
test('clean with a room name: rejected, robot not started', () => {
  const r = run(['clean', 'kitchen']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Rooms are ids from `rooms`/);
});

test('suction with an unknown level: rejected', () => {
  const r = run(['suction', 'loud']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /suction is one of quiet, standard, strong, max/);
});
