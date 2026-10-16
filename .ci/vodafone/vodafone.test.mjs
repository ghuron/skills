/**
 * Integration tests for vodafone.mjs
 * Run: node --test vodafone.test.mjs   (reads VODAFONE_USERNAME and VODAFONE_PASSWORD from vodafone/.env)
 *
 * Asserts the shape of every command's output against a live account, so a
 * site or API change fails loudly instead of returning wrong data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../vodafone/vodafone.mjs');

function parseEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const ENV = { ...process.env, ...parseEnvFile(join(DIR, '../../vodafone/.env')) };
const skip = !(ENV.VODAFONE_USERNAME && ENV.VODAFONE_PASSWORD) && 'no VODAFONE_USERNAME / VODAFONE_PASSWORD';

function runCLI(args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: ENV, timeout: 120_000 });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+\d{10,15}$/;
const isNum = x => typeof x === 'number' && Number.isFinite(x);

// A made-up account, so the real one's failed-login counter is never touched.
test('wrong credentials: fails and says so', () => {
  const env = { ...ENV, VODAFONE_USERNAME: 'no-such-user-ci@example.invalid', VODAFONE_PASSWORD: 'wrong' };
  const r = spawnSync('node', [CLI, 'account'], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Vodafone rejected VODAFONE_USERNAME/);
});

test('account: username and a billing customer', { skip }, () => {
  const a = runCLI(['account']);
  assert.ok(a.username);
  assert.ok(a.billingCustomers.length > 0, 'expected a billing customer');
  for (const bc of a.billingCustomers) assert.match(bc.billingCustomerId, /^\d+$/);
});

let numbers;
test('products: subscriptions with number, plan and status', { skip }, () => {
  const list = runCLI(['products']);
  assert.ok(list.length > 0, 'expected a subscription');
  for (const p of list) {
    assert.match(p.number, PHONE);
    assert.match(p.productId, /^\d+$/);
    assert.ok(p.plan && p.status, JSON.stringify(p));
  }
  numbers = list.map(p => p.number);
});

test('product: contract dates and SIM, found by national number', { skip }, () => {
  const p = runCLI(['product', `0${numbers[0].slice(3)}`]);
  assert.equal(p.number, numbers[0]);
  assert.match(p.contract.start, ISO);
  assert.match(p.sim.iccid, /^\d{18,20}$/);
});

test('usage: bundles and usage per number, all numbers by default', { skip }, () => {
  const all = runCLI(['usage']);
  assert.deepEqual(all.map(u => u.number), numbers);
  for (const u of all) {
    assert.ok(u.bundles.length > 0, `${u.number}: no bundles`);
    for (const b of [...u.bundles, ...u.daily]) {
      assert.ok(['MB', 'min', 'count'].includes(b.unit), `unit ${b.unit}`);
      assert.ok(isNum(b.used), `${b.description}: used=${b.used}`);
      if (!b.unlimited) assert.ok(isNum(b.total) && isNum(b.remaining), JSON.stringify(b));
    }
    for (const x of u.usage) assert.ok(['voice', 'data', 'sms'].includes(x.type) && isNum(x.quantity) && isNum(x.cost), JSON.stringify(x));
    assert.ok(isNum(u.outOfBundleCost));
  }
});

let newest;
test('invoices: newest first, well-formed, and the newest downloads as a PDF', { skip }, () => {
  const res = runCLI(['invoices']);
  assert.ok(isNum(res.openBalance));
  assert.ok(res.invoices.length > 0, 'expected an invoice');
  for (const i of res.invoices) {
    assert.match(i.invoiceNumber, /^\d+$/);
    assert.match(i.month, /^\d{4}-\d{2}$/);
    for (const d of [i.date, i.dueDate, i.usagePeriod.from, i.usagePeriod.to]) assert.match(d, ISO);
    assert.ok(isNum(i.total) && isNum(i.due), JSON.stringify(i));
  }
  const dates = res.invoices.map(i => i.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'not newest first');
  newest = res.invoices[0];

  const tmp = mkdtempSync(join(tmpdir(), 'vodafone-'));
  try {
    const file = join(tmp, 'invoice.pdf');
    const out = runCLI(['pdf', newest.invoiceNumber, file]);
    assert.ok(out.bytes > 1000);
    assert.equal(readFileSync(file).subarray(0, 4).toString(), '%PDF');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

let onInvoice;
test('invoice: breakdown adds up to the invoice total', { skip }, () => {
  const b = runCLI(['invoice', newest.invoiceNumber]);
  assert.equal(b.total, newest.total);
  assert.match(b.subscriptions.period.from, ISO);
  const perNumber = b.perNumber.reduce((s, n) => s + n.total, 0);
  assert.ok(Math.abs(perNumber - b.total) < 0.01, `per-number totals ${perNumber} != ${b.total}`);
  for (const n of b.perNumber) assert.match(n.number, PHONE);
  onInvoice = b.perNumber[0].number;
});

test('events: billed records of one number on the newest invoice', { skip }, () => {
  const list = runCLI(['events', newest.invoiceNumber, onInvoice]);
  const times = list.map(e => e.time);
  assert.deepEqual(times, [...times].sort(), 'not sorted');
  for (const e of list) {
    assert.match(e.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.ok(['voice', 'data', 'sms'].includes(e.type), e.type);
    assert.ok(isNum(e.quantity) && isNum(e.cost), JSON.stringify(e));
  }
  const voice = runCLI(['events', newest.invoiceNumber, onInvoice, 'voice']);
  assert.deepEqual(voice, list.filter(e => e.type === 'voice'));
});
