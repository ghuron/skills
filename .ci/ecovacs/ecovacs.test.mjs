/**
 * Integration tests for ecovacs.mjs
 * Run: node --test ecovacs.test.mjs   (reads ECOVACS_SESSION from ecovacs/.env)
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
const CLI = join(DIR, '../../ecovacs/ecovacs.mjs');

function parseEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const ENV = { ...process.env, ...parseEnvFile(join(DIR, '../../ecovacs/.env')) };
const skip = !ENV.ECOVACS_SESSION && 'no ECOVACS_SESSION';

function run(args, env = ENV) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 });
}

function runCLI(args) {
  const r = run(args);
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const isNum = x => typeof x === 'number' && Number.isFinite(x);

test('no session: fails and says to log in', () => {
  const r = run(['status'], { ...ENV, ECOVACS_SESSION: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run `node ecovacs\.mjs login`/);
});

// A made-up session, so the real one is never touched.
test('rejected session: fails and says to log in again', () => {
  const r = run(['status'], { ...ENV, ECOVACS_SESSION: `${'0'.repeat(32)}:nouser:${'f'.repeat(32)}` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /session has expired: run `node ecovacs\.mjs login`/);
});

test('unknown command: prints usage', () => {
  const r = run(['notacommand']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: node ecovacs\.mjs/);
});

test('robots: at least one, with name, model, id and online', { skip }, () => {
  const list = runCLI(['robots']);
  assert.ok(list.length > 0, 'expected a robot');
  for (const r of list) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.model, 'string');
    assert.ok(r.id);
    assert.equal(typeof r.online, 'boolean');
  }
});

test('status: state, battery, settings, job and station', { skip }, () => {
  const s = runCLI(['status']);
  assert.equal(typeof s.robot, 'string');
  if (!s.online) return; // nothing else to check on an offline robot
  assert.ok(['docked', 'idle', 'cleaning', 'paused', 'returning', 'washing', 'drying', 'error'].includes(s.state),
    `unexpected state ${s.state}`);
  assert.ok(s.battery >= 0 && s.battery <= 100);
  assert.equal(typeof s.charging, 'boolean');
  assert.ok(Array.isArray(s.errors));
  assert.ok(['quiet', 'standard', 'max', 'max+'].includes(s.suction), `unexpected suction ${s.suction}`);
  assert.ok(['low', 'medium', 'high', 'ultrahigh'].includes(s.water), `unexpected water ${s.water}`);
  if (s.job) {
    assert.match(s.job.start, LOCAL_TIME);
    assert.ok(isNum(s.job.area) && isNum(s.job.minutes));
  }
  if (s.station) {
    assert.ok(['idle', 'emptying', 'drying', 'washing', 'paused', 'busy'].includes(s.station.state));
    for (const e of s.station.errors) assert.ok(isNum(e.code));
  }
});

test('consumables: known parts with percent and hours left', { skip }, () => {
  const parts = runCLI(['consumables']);
  assert.ok(parts.length > 0, 'expected parts');
  for (const p of parts) {
    assert.ok(['main brush', 'side brush', 'filter', 'mop pads', 'dust bag', 'unit care', 'air freshener'].includes(p.part),
      `unexpected part ${p.part}`);
    assert.ok(p.percent >= 0 && p.percent <= 100, `${p.part}: percent ${p.percent}`);
    assert.ok(isNum(p.hoursLeft) && p.hoursLeft >= 0);
  }
});

test('history: newest first, with start, area, minutes and result', { skip }, () => {
  const jobs = runCLI(['history', '5']);
  assert.ok(jobs.length > 0 && jobs.length <= 5, `expected 1-5 jobs, got ${jobs.length}`);
  for (const j of jobs) {
    assert.match(j.start, LOCAL_TIME);
    assert.ok(isNum(j.area) && isNum(j.minutes));
    assert.ok(j.result === null || ['finished', 'stopped', 'finished with warnings'].includes(j.result));
  }
  const starts = jobs.map(j => Date.parse(j.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'expected newest first');
});

test('rooms: numeric ids, names string or null', { skip }, () => {
  const rooms = runCLI(['rooms']);
  assert.ok(rooms.length > 0, 'expected rooms on the map in use');
  for (const r of rooms) {
    assert.ok(Number.isInteger(r.id));
    assert.ok(r.name === null || typeof r.name === 'string');
  }
});

// Fails on the argument check, before anything is sent to the robot.
test('clean with a room name: rejected, robot not started', { skip }, () => {
  const r = run(['clean', 'kitchen']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Rooms are ids from `rooms`/);
});
