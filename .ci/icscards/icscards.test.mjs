/**
 * Integration tests for icscards.mjs
 * Run: node --test icscards.test.mjs   (reads ICSCARDS_SESSION from icscards/.env)
 *
 * Asserts the shape of every reading command's output against a live account, and that the
 * balances add up, so a portal change fails loudly instead of returning wrong data. `login`
 * isn't tested: it needs approval in the ICS app. The session lasts only a short while, so
 * without a live one the live tests skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../icscards/scripts/icscards.mjs');
const { client, account, statements, downloadStatement, transactions } = await import(CLI);

let get, skip = !process.env.ICSCARDS_SESSION && 'no ICSCARDS_SESSION';
if (!skip) {
  get = client();
  try {
    await get('frontendservices/determineaccount');
  } catch (e) {
    if (!/session has expired/.test(e.message)) throw e;
    skip = 'ICS session expired';
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}$/;
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.005, `${what}: ${a} vs ${b}`);

test('missing credentials: login fails and names the variables', () => {
  const r = spawnSync('node', [CLI, 'login'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, ICSCARDS_USERNAME: '', ICSCARDS_PASSWORD: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ICSCARDS_USERNAME and ICSCARDS_PASSWORD/);
});

test('no session: commands ask for login', () => {
  const r = spawnSync('node', [CLI, 'account'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, ICSCARDS_SESSION: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /icscards\.mjs login/);
});

test('CLI account: limit, balance and what is left add up', { skip }, () => {
  const r = spawnSync('node', [CLI, 'account'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(r.stdout);
  assert.match(a.accountNumber, /^\d+$/);
  assert.ok(a.cards.length > 0, 'no cards');
  for (const c of a.cards) assert.match(c.lastFourDigits, /^\d{4}$/);
  for (const k of ['creditLimit', 'balance', 'pending', 'available']) assert.equal(typeof a[k], 'number', k);
  near(a.available, a.creditLimit - a.balance - a.pending, 'available');
  assert.match(a.lastStatement.closedOn, ISO);
  assert.equal(typeof a.lastStatement.amountDue, 'number');
  assert.ok(a.iban === null || /\*{4}/.test(a.iban), 'IBAN not masked');
});

test('statements: one current period, and each opens where the previous closed', { skip }, async () => {
  const { statements: s } = await statements(get);
  assert.ok(s.length > 1, 'expected a closed period');
  assert.equal(s.filter(p => p.current).length, 1);
  assert.ok(s[0].current, 'newest first');
  for (const p of s) {
    assert.match(p.period, PERIOD);
    assert.match(p.from, ISO);
    assert.match(p.to, ISO);
    assert.equal(p.to.slice(0, 7), p.period, `${p.period} is named after the month it ends in`);
  }
  for (let i = 1; i < s.length; i++) near(s[i - 1].openingBalance, s[i].closingBalance, `${s[i - 1].period} opening`);
});

test('transactions: the current period adds up to the balance', { skip }, async () => {
  const [a, t] = await Promise.all([account(get), transactions(get)]);
  assert.equal(t.closingBalance, null);
  near(t.openingBalance + t.spent + t.paid, a.balance, 'opening + spent + paid');
  near(t.pending, a.pending, 'pending');
  for (const x of t.transactions) {
    assert.match(x.date, ISO);
    assert.equal(typeof x.amount, 'number');
    assert.ok(['booked', 'pending', 'payment'].includes(x.type), x.type);
    assert.ok(x.description);
  }
});

test('transactions: a closed period adds up, and its statement downloads as a PDF', { skip }, async () => {
  const { statements: s } = await statements(get);
  const closed = s.find(p => p.pdf);
  assert.ok(closed, 'no statement with a PDF');
  const t = await transactions(get, closed.period);
  assert.ok(t.transactions.length > 0);
  assert.equal(t.pending, 0);
  near(t.openingBalance + t.spent + t.paid, t.closingBalance, 'opening + spent + paid');
  for (const x of t.transactions.filter(x => x.originalCurrency)) {
    assert.match(x.originalCurrency, /^[A-Z]{3}$/);
    assert.equal(typeof x.originalAmount, 'number');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'icscards-'));
  try {
    const file = join(tmp, 'statement.pdf');
    const out = await downloadStatement(get, closed.period, file);
    assert.ok(out.bytes > 1000);
    assert.equal(readFileSync(file).subarray(0, 4).toString(), '%PDF');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  await assert.rejects(downloadStatement(get, '2000-01'), /No statement period 2000-01/);
  await assert.rejects(transactions(get, '2000-13'), /YYYY-MM/);
});
