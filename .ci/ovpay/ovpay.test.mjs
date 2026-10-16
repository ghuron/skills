/**
 * Integration tests for ovpay.mjs
 * Run: node --test ovpay.test.mjs   (reads OVPAY_REFRESH_TOKEN from ovpay/.env)
 *
 * OVpay's offline token rotates and invalidates on every refresh, so the skill
 * persists the newest token to OVPAY_STATE (default ~/.ovpay/tokens.json). On a
 * fresh machine it seeds from OVPAY_REFRESH_TOKEN; this test pushes the rotated
 * token back to the vault so the next (fresh-machine) run keeps working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../ovpay/ovpay.mjs');
const STATE = process.env.OVPAY_STATE || join(homedir(), '.ovpay', 'tokens.json');

function parseEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const ENV = { ...parseEnvFile(join(DIR, '../../ovpay/.env')), ...process.env };

function runCLI(args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: ENV, timeout: 60_000 });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status ?? -1 };
}

const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

const haveToken = !!ENV.OVPAY_REFRESH_TOKEN || existsSync(STATE);

test('cards: returns at least one card with xtat + balance', { skip: !haveToken && 'no OVPAY_REFRESH_TOKEN' }, () => {
  const { stdout, stderr, status } = runCLI(['cards']);
  assert.equal(status, 0, stderr);
  const cards = JSON.parse(stdout);
  assert.ok(Array.isArray(cards) && cards.length > 0, 'expected a non-empty cards array');
  for (const c of cards) {
    assert.match(c.xtat, /^[0-9a-f-]{36}$/i);
    assert.ok(c.balance === null || typeof c.balance === 'number');
  }
});

test('customer: returns a profile with an email', { skip: !haveToken && 'no OVPAY_REFRESH_TOKEN' }, () => {
  const { stdout, status, stderr } = runCLI(['customer']);
  assert.equal(status, 0, stderr);
  assert.ok(typeof JSON.parse(stdout).email === 'string');
});

test('trips: returns well-formed rows for the first card', { skip: !haveToken && 'no OVPAY_REFRESH_TOKEN' }, () => {
  const first = JSON.parse(runCLI(['cards']).stdout)[0];
  const { stdout, status, stderr } = runCLI(['trips', first.xtat, daysAgo(120), today()]);
  assert.equal(status, 0, stderr);
  const trips = JSON.parse(stdout);
  assert.ok(Array.isArray(trips));
  for (const t of trips) {
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok('mode' in t && 'departure' in t && ('fareEur' in t));
    assert.ok(t.id != null && typeof t.status === 'string', JSON.stringify(t));
  }
});

// Read-only: a trip's correction options. `correct` itself is never run here, since each one is
// irreversible and uses up one of the card's few corrections.
test('correction: options for the first card\'s newest trip', { skip: !haveToken && 'no OVPAY_REFRESH_TOKEN' }, () => {
  const first = JSON.parse(runCLI(['cards']).stdout)[0];
  const [trip] = JSON.parse(runCLI(['trips', first.xtat]).stdout);
  if (!trip) return;
  const { stdout, status, stderr } = runCLI(['correction', first.xtat, String(trip.id)]);
  assert.equal(status, 0, stderr);
  const c = JSON.parse(stdout);
  assert.equal(c.trip.id, trip.id);
  assert.ok(c.status === null || typeof c.status === 'string');
  assert.ok(Array.isArray(c.stops));
  for (const s of c.stops) assert.ok(s.code && s.name, JSON.stringify(s));
});

// Keep the vault seed usable on the next fresh-machine run (best-effort).
test('persist rotated offline token back to the vault', { skip: !existsSync(STATE) && 'no state to persist' }, () => {
  const rt = JSON.parse(readFileSync(STATE, 'utf8')).refresh_token;
  assert.ok(rt, 'state file should contain a rotated refresh_token');
  const res = spawnSync('infisical', [
    'secrets', 'set', `OVPAY_REFRESH_TOKEN=${rt}`,
    '--projectId', 'd56a074c-446e-466b-a6ba-91284fe0a42b',
    '--domain', 'https://eu.infisical.com/api', '--env', 'dev', '--path', '/ovpay',
  ], { encoding: 'utf8' });
  if (res.status !== 0) console.warn('  (writeback skipped: infisical not available/authed)');
});
