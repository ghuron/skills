/**
 * Integration tests for budgetthuis.mjs
 * Run: node --test budgetthuis.test.mjs   (reads BUDGETTHUIS_LOGIN/PASSWORD from .env next to this file)
 *
 * Asserts the shape of every command's output against a live account, so a
 * portal or API change fails loudly instead of returning wrong data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../skills/budgetthuis/budgetthuis.mjs');

function parseEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const ENV = { ...process.env, ...parseEnvFile(join(DIR, '.env')) };
const skip = !(ENV.BUDGETTHUIS_LOGIN && ENV.BUDGETTHUIS_PASSWORD) && 'no BUDGETTHUIS_LOGIN/PASSWORD';

function runCLI(args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: ENV, timeout: 60_000 });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test('account: customer number and name', { skip }, () => {
  const a = runCLI(['account']);
  assert.match(a.customerNumber, /^\d+$/);
  assert.ok(a.name, 'expected a name');
});

test('contracts: at least one active contract with an address', { skip }, () => {
  const list = runCLI(['contracts']);
  assert.ok(Array.isArray(list) && list.length > 0);
  for (const c of list) {
    assert.equal(typeof c.contractId, 'number');
    assert.match(c.startDate, ISO);
    assert.ok(c.address);
  }
  assert.ok(list.some(c => c.status === 'Active'), 'expected an Active contract');
});

test('tariffs: contract terms and per-unit prices', { skip }, () => {
  const t = runCLI(['tariffs']);
  assert.match(t.contract.startDate, ISO);
  assert.ok(t.contract.type);
  const electricity = t.electricityNormal ?? t.electricitySingle;
  assert.ok(electricity, `no electricity tariff in ${Object.keys(t)}`);
  for (const k of ['supply', 'energyTax', 'total']) assert.equal(typeof electricity[k], 'number', k);
  assert.ok(electricity.total > 0 && electricity.total < 2, 'implausible EUR/kWh');
  assert.equal(typeof t.fixedMonthly?.electricity, 'number');
  assert.equal(typeof t.canRenew, 'boolean');
});

test('termijnbedrag: current amount within the allowed range', { skip }, () => {
  const t = runCLI(['termijnbedrag']);
  for (const k of ['current', 'advice', 'minimum', 'maximum']) assert.equal(typeof t[k], 'number', k);
  assert.ok(t.minimum <= t.current && t.current <= t.maximum, JSON.stringify(t));
});

test('invoices: well-formed list, and the newest one downloads as a PDF', { skip }, () => {
  const res = runCLI(['invoices']);
  assert.equal(typeof res.actionNeeded, 'boolean');
  assert.equal(typeof res.openBalance, 'number');
  assert.ok(res.invoices.length > 0, 'expected at least one invoice');
  for (const i of res.invoices) {
    assert.match(i.date, ISO);
    assert.match(i.dueDate, ISO);
    assert.equal(typeof i.amount, 'number');
    assert.equal(typeof i.balance, 'number');
  }

  const tmp = mkdtempSync(join(tmpdir(), 'budgetthuis-'));
  try {
    const file = join(tmp, 'invoice.pdf');
    const out = runCLI(['invoice', String(res.invoices[0].invoiceId), file]);
    assert.ok(out.bytes > 1000);
    assert.equal(readFileSync(file).subarray(0, 4).toString(), '%PDF');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('usage: daily rows across a month boundary, unique and in range', { skip }, () => {
  const from = daysAgo(45), to = daysAgo(0);
  const rows = runCLI(['usage', from, to]);
  assert.ok(rows.length >= 30, `expected a month of readings, got ${rows.length}`);
  const days = rows.map(r => r.from.slice(0, 10));
  assert.equal(new Set(days).size, days.length, 'duplicate days');
  assert.deepEqual(days, [...days].sort(), 'not sorted');
  for (const r of rows) {
    const day = r.from.slice(0, 10);
    assert.ok(day >= from && day <= to, r.from);
    for (const k of ['kwh', 'kwhNormal', 'kwhLow', 'gasM3', 'costElectricity', 'costTotal']) {
      assert.ok(r[k] === null || typeof r[k] === 'number', `${k}=${r[k]}`);
    }
    if (r.kwh !== null) assert.ok(Math.abs(r.kwhNormal + r.kwhLow - r.kwh) < 0.01, `normal+low != total on ${r.from}`);
  }
  assert.ok(rows.some(r => r.kwh > 0), 'no electricity usage at all');
});

test('usage hour: 23-25 rows per day that add up to the daily totals', { skip }, () => {
  const from = daysAgo(10), to = daysAgo(4); // readings lag a day or two
  const hours = runCLI(['usage', from, to, 'hour']);
  const days = runCLI(['usage', from, to, 'day']);
  assert.equal(days.length, 7, 'expected 7 days of readings');
  for (const d of days) {
    const day = d.from.slice(0, 10);
    const h = hours.filter(r => r.from.slice(0, 10) === day);
    assert.ok(h.length >= 23 && h.length <= 25, `${day}: ${h.length} hourly rows`);
    const kwh = h.reduce((t, r) => t + r.kwh, 0);
    assert.ok(Math.abs(kwh - d.kwh) < 0.01, `${day}: hours sum to ${kwh} kWh, day says ${d.kwh}`);
  }
});
