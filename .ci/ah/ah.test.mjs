/**
 * Tests for ah.mjs
 * Run: node --test ah.test.mjs   (reads AH_SESSION from ah/.env)
 *
 * Read-only: asserts the shape of every reading command's output against the live account.
 * The CLI reads ah/.env itself rather than getting AH_SESSION passed in, because it rewrites
 * the session there when AH renews it, and a copy taken at the start would go stale.
 *
 * `csv` runs on the invoice PDFs in .fixtures/ (gitignored) and compares the result with
 * .fixtures/expected/<order number>.csv; skipped when there are none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../ah/scripts/ah.mjs');
const FIXTURES = join(DIR, '.fixtures');
const hasInvoices = existsSync(FIXTURES) && readdirSync(FIXTURES).some(f => f.endsWith('.pdf'));

function parseEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const skip = !(process.env.AH_SESSION || parseEnvFile(join(DIR, '../../ah/.env')).AH_SESSION) && 'no AH_SESSION';
const hasPypdf = spawnSync('python3', ['-c', 'import pypdf']).status === 0;

function run(args, env = process.env) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 });
}

function runCLI(args) {
  const r = run(args);
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const cents = x => Math.round(x * 100);

test('invoice PDFs turn into the expected CSVs', { skip: !hasInvoices && 'no invoices in .fixtures/' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'ah-'));
  const r = run(['csv', '--out', out, FIXTURES]);
  assert.equal(r.status, 0, r.stderr);
  for (const f of readdirSync(join(FIXTURES, 'expected'))) {
    assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(FIXTURES, 'expected', f), 'utf8'), f);
  }
});

test('login: gives the sign-in address', () => {
  const r = runCLI(['login']);
  assert.match(r.url, /^https:\/\/login\.ah\.nl\/.*redirect_uri=appie:\/\/login-exit/);
});

test('login <code>: a made-up code is refused', () => {
  const r = run(['login', 'appie://login-exit?code=00000000-0000-0000-0000-000000000000']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AH did not accept the code/);
});

test('no session: fails and says to log in', () => {
  const r = run(['orders'], { ...process.env, AH_SESSION: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run `node scripts\/ah\.mjs login`/);
});

// A made-up session, so the real one is never touched.
test('made-up session: fails and says to log in', () => {
  const r = run(['orders'], { ...process.env, AH_SESSION: '00000000-0000-0000-0000-000000000000' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AH no longer accepts AH_SESSION/);
});

let delivered;
test('orders: recent online orders with state, date and total', { skip }, () => {
  const list = runCLI(['orders']);
  assert.ok(list.length > 0, 'expected an order');
  for (const o of list) {
    assert.ok(Number.isInteger(o.orderId), JSON.stringify(o));
    assert.ok(o.state, JSON.stringify(o));
    assert.match(o.date, ISO);
    assert.ok(isNum(o.total), JSON.stringify(o));
    if (o.changeableUntil !== null) assert.match(o.changeableUntil, LOCAL_TIME);
  }
  delivered = list.find(o => o.state === 'DELIVERED')?.orderId;
});

test('order: products and, once delivered, an invoice id', { skip }, t => {
  if (!delivered) return t.skip('no delivered order');
  const o = runCLI(['order', String(delivered)]);
  assert.equal(o.orderId, delivered);
  assert.ok(o.invoiceId, 'a delivered order has an invoiceId');
  assert.ok(o.products.length > 0, 'expected products');
  for (const p of o.products) {
    assert.ok(Number.isInteger(p.productId) && p.title && p.category, JSON.stringify(p));
    assert.ok(p.quantity > 0, JSON.stringify(p));
  }
});

test('invoice: downloads a PDF that csv can read', { skip }, t => {
  if (!delivered) return t.skip('no delivered order');
  const out = mkdtempSync(join(tmpdir(), 'ah-'));
  try {
    const file = join(out, `${delivered}.pdf`);
    const r = runCLI(['invoice', String(delivered), file]);
    assert.equal(r.file, file);
    assert.equal(readFileSync(file).subarray(0, 5).toString(), '%PDF-');
    if (!hasPypdf) return;
    const c = run(['csv', file]);
    assert.equal(c.status, 0, c.stderr);
    assert.ok(existsSync(join(out, `${delivered}.csv`)), c.stdout);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

let receiptId;
test('receipts: newest first, with time, total and store', { skip }, () => {
  const list = runCLI(['receipts', '5']);
  assert.ok(list.length > 0 && list.length <= 5, `expected 1-5 receipts, got ${list.length}`);
  for (const r of list) {
    assert.match(r.id, /^AH/);
    assert.match(r.time, LOCAL_TIME);
    assert.ok(isNum(r.total), JSON.stringify(r));
  }
  assert.deepEqual(list.map(r => r.time), list.map(r => r.time).toSorted().reverse());
  receiptId = list[0].id;
});

test('receipt: lines, discounts and deposits add up to the total', { skip }, t => {
  if (!receiptId) return t.skip('no receipt');
  const r = runCLI(['receipt', receiptId]);
  assert.equal(r.id, receiptId);
  assert.match(r.time, LOCAL_TIME);
  assert.ok(r.products.length > 0, 'expected products');
  const sum = r.products.reduce((a, p) => a + cents(p.amount) + cents(p.deposit ?? 0), 0)
    + r.discounts.reduce((a, d) => a + cents(d.amount), 0);
  assert.equal(sum, cents(r.total));
  assert.equal(r.payments.reduce((a, p) => a + cents(p.amount), 0), cents(r.total));
});

test('receipt: an unknown id says so', { skip }, () => {
  const r = run(['receipt', 'AH0000000000']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AH has no receipt/);
});
