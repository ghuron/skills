/**
 * Tests for brex.mjs
 * Run: node --test brex.test.mjs   (live tests read BREX_API_TOKEN from brex/.env)
 *
 * The offline tests feed made-up API pages to the commands. The live tests assert the shape of every
 * command's output against a real Brex account, and that windows, totals and statuses hold together,
 * so an API change fails loudly instead of returning wrong data. Without a token they skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../brex/scripts/brex.mjs');
const { client, money, instant, shape, expenses, expense, downloadReceipts, fileType } = await import(CLI);

const cli = (args, env = {}) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });

// ---------------------------------------------------------------------------
// Offline, made-up data
// ---------------------------------------------------------------------------

const RAW = {
  id: 'expense_a1', expense_type: 'CARD', status: 'APPROVED', payment_status: 'CLEARED',
  review: { compliance_status: 'APPROVED' },
  purchased_at: '2026-03-10T09:15:00Z', payment_posted_at: '2026-03-11T02:00:00.123456Z',
  submitted_at: '2026-03-10T10:00:00Z', approved_at: '2026-03-12T08:00:00Z', updated_at: '2026-03-12T08:00:00Z',
  user_id: 'cuuser_1', user: { id: 'cuuser_1', first_name: 'Alex', last_name: 'Example', department_id: 'dept_1' },
  department: { id: 'dept_1', name: 'Sales' }, budget: { id: 'budget_1', name: 'Travel' },
  merchant: { raw_descriptor: 'COFFEE BAR', mcc: '5814', country: 'NLD' }, category: 'RESTAURANTS',
  address: { city: 'Utrecht', state: 'UT', country: 'NL', postal_code: '0000', timezone: 'Europe/Amsterdam' },
  purchased_amount: { amount: 1250, currency: 'EUR' }, original_amount: { amount: 1250, currency: 'EUR' },
  billing_amount: { amount: 1371, currency: 'USD' }, usd_equivalent_amount: { amount: 1371, currency: 'USD' },
  memo: 'Coffee with a client',
  receipts: [{ id: 'receipt_1', download_uris: ['https://files.brex.example/r/abc.pdf?Expires=1773140400&Signature=x'] }],
  custom_fields: [{ key: 'cf_1', display_name: 'Project', value: { data: { option_id: 'o1', option_label: 'Apollo' }, data_type: 'OPTION_STRING', value_type: 'SINGLE_VALUE' } }],
  billing_entity_id: 'le_1', spending_entity_id: 'le_1', card_transaction_reference_id: 'ctr_1',
  dashboard_url: 'https://dashboard.brex.example/expenses/expense_a1',
};

/** A fake get that serves `pages` of items for /v1/expenses and records each call's params. */
function fake(pages, one) {
  const calls = [];
  const get = async (path, params = {}) => {
    calls.push({ path, params });
    if (path !== '/v1/expenses') return one(path);
    const i = params.cursor ? Number(params.cursor) : 0;
    return { items: pages[i], next_cursor: i + 1 < pages.length ? String(i + 1) : null };
  };
  return { get, calls };
}
const ex = (id, over = {}) => ({ ...RAW, id, ...over });

test('money: minor units by currency', () => {
  assert.equal(money({ amount: 12345, currency: 'USD' }), 123.45);
  assert.equal(money({ amount: -999, currency: 'EUR' }), -9.99);
  assert.equal(money({ amount: 1500, currency: 'JPY' }), 1500);
  assert.equal(money({ amount: 1234, currency: 'KWD' }), 1.234);
  assert.equal(money({ amount: 0, currency: 'USD' }), 0);
  assert.equal(money(null), null);
  assert.equal(money({ currency: 'USD' }), null);
});

test('instant: dates are UTC days, times pass through, nonsense fails', () => {
  assert.equal(instant('2026-03-01').toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(instant('2026-03-31', true).toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(instant('2026-03-01T06:30:00Z', true).toISOString(), '2026-03-01T06:30:00.000Z');
  assert.throws(() => instant('2026-02-30'), /No such date/);
  assert.throws(() => instant('01-03-2026'), /YYYY-MM-DD/);
  assert.throws(() => instant('2026-03-01T06:30:00'), /UTC time/);
});

test('shape: a raw expense as printed', () => {
  const s = shape(RAW);
  assert.deepEqual(s, {
    id: 'expense_a1', type: 'CARD', status: 'APPROVED', paymentStatus: 'CLEARED', compliance: 'APPROVED',
    purchasedAt: '2026-03-10T09:15:00Z', postedAt: '2026-03-11T02:00:00.123456Z', submittedAt: '2026-03-10T10:00:00Z',
    approvedAt: '2026-03-12T08:00:00Z', updatedAt: '2026-03-12T08:00:00Z',
    user: { id: 'cuuser_1', name: 'Alex Example' }, department: 'Sales', budget: 'Travel',
    merchant: 'COFFEE BAR', mcc: '5814', merchantCountry: 'NLD', category: 'RESTAURANTS',
    location: { city: 'Utrecht', state: 'UT', country: 'NL' },
    amount: 12.5, currency: 'EUR', billedAmount: 13.71, billedCurrency: 'USD', usdAmount: 13.71,
    memo: 'Coffee with a client', receipts: 1, customFields: { Project: 'Apollo' },
    billingEntityId: 'le_1', spendingEntityId: 'le_1', cardTransactionId: 'ctr_1',
    url: 'https://dashboard.brex.example/expenses/expense_a1',
  });
  assert.deepEqual(shape(RAW, { links: true }).receipts, [{
    id: 'receipt_1', url: RAW.receipts[0].download_uris[0], expires: '2026-03-10T11:00:00.000Z',
  }]);
  const declined = shape({ ...RAW, payment_status: 'DECLINED', payment: { status_reason: 'INVALID_CVV' } });
  assert.equal(declined.declineReason, 'INVALID_CVV');
  assert.ok(!('declineReason' in s));
  const bare = shape({ id: 'expense_b', user_id: 'cuuser_2' });
  assert.deepEqual(bare.user, { id: 'cuuser_2', name: null });
  assert.equal(bare.receipts, 0);
  assert.deepEqual(bare.customFields, {});
});

test('expenses by purchase: query, paging, skipped charges, totals, order', async () => {
  const { get, calls } = fake([
    [ex('e1', { purchased_at: '2026-03-02T10:00:00Z', billing_amount: { amount: 10, currency: 'USD' } }),
     ex('e2', { purchased_at: '2026-03-05T10:00:00Z', payment_status: 'CANCELED' })],
    [ex('e3', { purchased_at: '2026-03-04T10:00:00Z', billing_amount: { amount: 20, currency: 'USD' } }),
     ex('e4', { purchased_at: '2026-03-03T10:00:00Z', billing_amount: { amount: 500, currency: 'AUD' } }),
     ex('e5', { purchased_at: '2026-03-06T10:00:00Z', payment_status: 'DECLINED' }),
     ex('e6', { purchased_at: '2026-04-01T00:00:00Z' })],
  ]);
  const r = await expenses(get, { from: '2026-03-01', to: '2026-03-31', users: ['cuuser_1'] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, {
    'expand[]': ['merchant', 'user', 'budget', 'department', 'payment', 'receipts.download_uris'], load_custom_fields: true,
    'user_id[]': ['cuuser_1'], purchased_at_start: '2026-03-01T00:00:00Z', purchased_at_end: '2026-04-01T00:00:00Z',
    limit: 100, cursor: undefined,
  });
  assert.equal(calls[1].params.cursor, '1');
  assert.deepEqual(r.expenses.map(e => e.id), ['e3', 'e4', 'e1'], 'newest first, outside the window left out');
  assert.deepEqual(r.skipped, { CANCELED: 1, DECLINED: 1 });
  assert.deepEqual(r.billed, { USD: 0.3, AUD: 5 });
  assert.equal(r.count, 3);
  assert.equal(r.from, '2026-03-01T00:00:00Z');
  assert.equal(r.to, '2026-04-01T00:00:00Z');

  const all = await expenses(fake([[ex('e2', { purchased_at: '2026-03-05T10:00:00Z', payment_status: 'CANCELED' })]]).get,
    { from: '2026-03-01', to: '2026-03-31', all: true });
  assert.equal(all.count, 1);
  assert.ok(!('skipped' in all));
});

test('expenses by posting: fetched from 60 days earlier, filtered by postedAt', async () => {
  const { get, calls } = fake([[
    ex('late', { purchased_at: '2026-02-10T10:00:00Z', payment_posted_at: '2026-03-02T01:00:00Z' }),
    ex('notyet', { purchased_at: '2026-03-30T10:00:00Z', payment_posted_at: undefined, payment_status: 'PROCESSING' }),
    ex('before', { purchased_at: '2026-02-27T10:00:00Z', payment_posted_at: '2026-02-28T23:59:59Z' }),
  ]]);
  const r = await expenses(get, { from: '2026-03-01', to: '2026-03-31', by: 'posted' });
  assert.equal(calls[0].params.purchased_at_start, '2025-12-31T00:00:00Z');
  assert.equal(calls[0].params.purchased_at_end, '2026-04-01T00:00:00Z');
  assert.deepEqual(r.expenses.map(e => e.id), ['late']);
});

test('expenses by change, and the default window', async () => {
  const { get, calls } = fake([[ex('u1', { updated_at: '2026-03-05T07:00:00Z' })]]);
  const r = await expenses(get, { from: '2026-03-05T06:00:00Z', by: 'updated', now: new Date('2026-03-05T12:00:00Z') });
  assert.equal(calls[0].params.updated_at_start, '2026-03-05T06:00:00Z');
  assert.equal(calls[0].params.updated_at_end, '2026-03-06T00:00:00Z');
  assert.ok(!('purchased_at_start' in calls[0].params));
  assert.equal(r.count, 1);

  const d = await expenses(fake([[]]).get, { now: new Date('2026-03-17T12:00:00Z') });
  assert.equal(d.from, '2026-03-01T00:00:00Z');
  assert.equal(d.to, '2026-03-18T00:00:00Z');
  await assert.rejects(expenses(fake([[]]).get, { from: '2026-03-31', to: '2026-03-01' }), /window is empty/);
  await assert.rejects(expenses(fake([[]]).get, { by: 'booked' }), /purchased, posted or updated/);
});

test('fileType: by the first bytes', () => {
  assert.equal(fileType(Buffer.from('%PDF-1.7\n')), 'pdf');
  assert.equal(fileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.equal(fileType(Buffer.from('\x89PNG\r\n\x1a\n....', 'latin1')), 'png');
  assert.equal(fileType(Buffer.from('GIF89a')), 'gif');
  assert.equal(fileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(fileType(Buffer.from('\0\0\0\x18ftypheic', 'latin1')), 'heic');
  assert.equal(fileType(Buffer.from('<html>')), null);
});

test('receipts: named by expense and position, typed by content', async () => {
  const png = Buffer.from('\x89PNG\r\n\x1a\nmade-up', 'latin1');
  const raw = ex('expense_r', { receipts: [
    { id: 'receipt_a', download_uris: ['https://files.brex.example/r/a.pdf?Expires=1'] },
    { id: 'receipt_b', download_uris: ['https://files.brex.example/r/b.jpeg?Expires=1'] },
  ] });
  const { get } = fake([], () => raw);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(String(url).includes('/a.pdf') ? png : Buffer.from('unknown'));
  const tmp = mkdtempSync(join(tmpdir(), 'brex-'));
  try {
    const r = await downloadReceipts(get, 'expense_r', tmp);
    assert.deepEqual(r.files.map(f => [f.receiptId, f.type, f.bytes]), [['receipt_a', 'png', png.length], ['receipt_b', 'jpg', 7]]);
    assert.deepEqual(readdirSync(tmp).sort(), ['brex-expense_r-1.png', 'brex-expense_r-2.jpg']);
    assert.deepEqual(readFileSync(join(tmp, 'brex-expense_r-1.png')), png);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(tmp, { recursive: true, force: true });
  }
  await assert.rejects(downloadReceipts(get, '../x'), /Not a Brex expense id/);
});

test('CLI: usage, missing token, bad dates', () => {
  for (const args of [[], ['nope'], ['expense'], ['expense', 'a', 'b'], ['expense', 'a', '--all'], ['expenses', '--posted', '--updated'],
    ['expenses', '--user'], ['expenses', '--bogus'], ['expenses', '2026-01-01', '2026-01-02', '2026-01-03']]) {
    const r = cli(args, { BREX_API_TOKEN: 'unused' });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^Usage:/, args.join(' '));
  }
  const noToken = cli(['expenses'], { BREX_API_TOKEN: '' });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /Set BREX_API_TOKEN/);
  const badDate = cli(['expenses', '2026-13-01'], { BREX_API_TOKEN: 'unused' });
  assert.equal(badDate.status, 1);
  assert.match(badDate.stderr, /No such date: 2026-13-01/);
});

test('a wrong token gets 401 from Brex', () => {
  const r = cli(['expenses'], { BREX_API_TOKEN: 'not-a-real-token' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rejected BREX_API_TOKEN \(401\)/);
});

// ---------------------------------------------------------------------------
// Live, against the account of BREX_API_TOKEN
// ---------------------------------------------------------------------------

const skip = !process.env.BREX_API_TOKEN && 'no BREX_API_TOKEN';
const get = skip ? null : client();
const now = new Date();
const day = d => d.toISOString().slice(0, 10);
const FROM = day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
const TO = day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CUR = /^[A-Z]{3}$/;
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.005, `${what}: ${a} vs ${b}`);
let month; // last month by posting date, shared by the live tests

test('CLI expenses --posted: last month posted in the window, statuses and totals hold', { skip }, () => {
  const r = cli(['expenses', FROM, TO, '--posted']);
  assert.equal(r.status, 0, r.stderr);
  month = JSON.parse(r.stdout);
  assert.equal(month.by, 'posted');
  assert.equal(month.from, `${FROM}T00:00:00Z`);
  assert.ok(month.count > 0, 'no expenses posted last month');
  assert.equal(month.count, month.expenses.length);
  const sums = {};
  for (const e of month.expenses) {
    assert.match(e.id, /^\S+$/);
    assert.match(e.postedAt, ISO_TIME);
    assert.match(e.purchasedAt, ISO_TIME);
    assert.ok(e.postedAt >= month.from && e.postedAt < month.to, `${e.id} posted ${e.postedAt}`);
    assert.ok(Date.parse(e.purchasedAt) <= Date.parse(e.postedAt) + 864e5, `${e.id} posted before it was bought`);
    assert.ok(['CLEARED', 'REFUNDED'].includes(e.paymentStatus), `${e.id}: ${e.paymentStatus}`);
    assert.equal(e.paymentStatus === 'REFUNDED', e.amount < 0, `${e.id}: refunds and only refunds are negative`);
    for (const k of ['amount', 'billedAmount', 'usdAmount']) assert.equal(typeof e[k], 'number', `${e.id} ${k}`);
    assert.match(e.currency, CUR);
    assert.match(e.billedCurrency, CUR);
    if (e.billedCurrency === 'USD') near(e.usdAmount, e.billedAmount, `${e.id} USD equivalent of a USD bill`);
    if (e.currency === e.billedCurrency) near(e.amount, e.billedAmount, `${e.id} same-currency bill`);
    assert.ok(e.user?.id && e.user.name, `${e.id} has no cardholder`);
    assert.equal(typeof e.receipts, 'number');
    assert.equal(typeof e.customFields, 'object');
    assert.match(e.url ?? '', /^https:\/\//);
    sums[e.billedCurrency] = (sums[e.billedCurrency] ?? 0) + e.billedAmount;
  }
  assert.deepEqual(Object.keys(month.billed).sort(), Object.keys(sums).sort());
  for (const c in sums) near(month.billed[c], sums[c], `billed ${c}`);
});

test('expenses by purchase: --all adds exactly what skipped counted', { skip }, async () => {
  const r = await expenses(get, { from: FROM, to: TO });
  const all = await expenses(get, { from: FROM, to: TO, all: true });
  for (const e of r.expenses) assert.ok(e.purchasedAt >= r.from && e.purchasedAt < r.to, `${e.id} bought ${e.purchasedAt}`);
  assert.ok(r.expenses.every(e => !['CANCELED', 'DECLINED'].includes(e.paymentStatus)));
  assert.equal(all.count, r.count + Object.values(r.skipped ?? {}).reduce((a, b) => a + b, 0));
  for (const e of all.expenses.filter(e => e.paymentStatus === 'DECLINED')) assert.ok('declineReason' in e);
});

test('expenses --user: that cardholder only', { skip }, async () => {
  assert.ok(month, 'needs the --posted test');
  const user = month.expenses[0].user.id;
  const r = await expenses(get, { from: FROM, to: TO, by: 'posted', users: [user] });
  assert.ok(r.count > 0);
  assert.ok(r.expenses.every(e => e.user.id === user));
  assert.equal(r.count, month.expenses.filter(e => e.user.id === user).length);
});

test('expenses --updated: changed in the window', { skip }, async () => {
  const since = new Date(now.getTime() - 7 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
  const r = await expenses(get, { from: since, by: 'updated', all: true });
  assert.equal(r.from, since);
  for (const e of r.expenses) assert.ok(Date.parse(e.updatedAt) >= Date.parse(since), `${e.id} changed ${e.updatedAt}`);
});

test('expense: as in the list, with receipt links; receipts download', { skip }, async t => {
  assert.ok(month, 'needs the --posted test');
  const listed = month.expenses.find(e => e.receipts > 0);
  if (!listed) return t.skip('no expense with receipts last month');
  const one = await expense(get, listed.id);
  const { receipts, ...rest } = one;
  const { receipts: count, ...listedRest } = listed;
  assert.deepEqual(rest, listedRest);
  assert.equal(receipts.length, count);
  for (const r of receipts) {
    assert.match(r.url, /^https:\/\//);
    assert.ok(Date.parse(r.expires) > Date.now(), 'receipt link already expired');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'brex-'));
  try {
    const d = await downloadReceipts(get, listed.id, tmp);
    assert.equal(d.files.length, count);
    for (const f of d.files) {
      assert.ok(f.bytes > 100, `${f.file} is ${f.bytes} bytes`);
      assert.ok(['pdf', 'jpg', 'png', 'gif', 'webp', 'heic'].includes(f.type), `unrecognised receipt type ${f.type}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  await assert.rejects(expense(get, 'expense_does_not_exist'), /No Brex expense expense_does_not_exist/);
});
