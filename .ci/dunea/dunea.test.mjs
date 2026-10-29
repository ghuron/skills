/**
 * Integration tests for dunea.mjs
 * Run: node --test dunea.test.mjs   (reads DUNEA_EMAIL and DUNEA_PASSWORD from dunea/.env)
 *
 * Asserts the shape of every command's output against a live account, so a portal
 * change fails loudly instead of returning wrong data. Logs in once for the
 * module-level tests, plus once through the CLI.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../dunea/scripts/dunea.mjs');
const { login, account, invoices, downloadInvoice, voorschot, usage } = await import(CLI);

const skip = !(process.env.DUNEA_EMAIL && process.env.DUNEA_PASSWORD) && 'no DUNEA_EMAIL/DUNEA_PASSWORD';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

let get;
before(async () => { if (!skip) get = await login(); });

test('missing credentials: fails and names the variables', () => {
  const r = spawnSync('node', [CLI, 'account'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, DUNEA_EMAIL: '', DUNEA_PASSWORD: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DUNEA_EMAIL and DUNEA_PASSWORD/);
});

test('CLI account: customer number and at least one active contract', { skip }, () => {
  const r = spawnSync('node', [CLI, 'account'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(r.stdout);
  assert.match(a.customerNumber, /^K\d+$/);
  assert.ok(a.name);
  assert.ok(a.iban === null || /^[A-Z]{2}\*{4}\d{4}$/.test(a.iban), 'IBAN not masked');
  assert.ok(a.contracts.some(c => c.active && /^L\d+$/.test(c.agreementId)), JSON.stringify(a.contracts));
});

test('invoices: well-formed list, and the newest downloads as a PDF', { skip }, async () => {
  const res = await invoices(get);
  assert.equal(typeof res.openBalance, 'number');
  assert.ok(res.invoices.length > 0, 'expected at least one invoice');
  for (const i of res.invoices) {
    assert.match(i.invoiceNumber, /^F\d+$/);
    assert.match(i.date, ISO);
    assert.equal(typeof i.amount, 'number');
    assert.ok(['open', 'paid'].includes(i.status));
    assert.ok(i.type);
  }
  const withPdf = res.invoices.find(i => i.pdf);
  assert.ok(withPdf, 'no invoice with a PDF');
  const tmp = mkdtempSync(join(tmpdir(), 'dunea-'));
  try {
    const file = join(tmp, 'invoice.pdf');
    const out = await downloadInvoice(get, withPdf.invoiceNumber, file);
    assert.ok(out.bytes > 1000);
    assert.equal(readFileSync(file).subarray(0, 4).toString(), '%PDF');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  await assert.rejects(downloadInvoice(get, 'F0'), /No invoice F0/);
});

test('voorschot: amount within the allowed range, both terms consistent', { skip }, async () => {
  const v = await voorschot(get);
  assert.match(v.agreementId, /^L\d+$/);
  assert.ok(['monthly', 'quarterly'].includes(v.term), v.term);
  for (const k of ['amount', 'perMonth', 'perQuarter', 'minimum', 'maximum']) assert.equal(typeof v[k], 'number', k);
  assert.ok(v.minimum <= v.amount && v.amount <= v.maximum, JSON.stringify(v));
  assert.equal(v.term === 'monthly' ? v.perMonth : v.perQuarter, v.amount);
  assert.ok(Math.abs(v.perMonth * 3 - v.perQuarter) < 0.05, JSON.stringify(v));
  await assert.rejects(voorschot(get, 'L0'), /No contract L0/);
});

test('usage: yearly periods that chain and add up', { skip }, async () => {
  const u = await usage(get);
  assert.match(u.agreementId, /^L\d+$/);
  assert.ok(u.meters.length > 0, 'no meters');
  for (const m of u.meters) {
    assert.ok(m.meter);
    assert.match(m.contractStart, ISO);
    assert.equal(typeof m.startReading, 'number');
    for (const p of m.periods) {
      assert.match(p.from, ISO);
      assert.match(p.to, ISO);
      assert.ok(p.from < p.to, JSON.stringify(p));
      for (const k of ['reading', 'm3', 'litresPerDay']) assert.equal(typeof p[k], 'number', k);
    }
    // Newest first: each period starts where the next (older) one ended, at that reading.
    const rows = [...m.periods].reverse();
    let reading = m.startReading;
    for (const p of rows) {
      assert.equal(p.reading - reading, p.m3, `${p.from}: readings don't add up to m3`);
      reading = p.reading;
    }
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].from, rows[i - 1].to);
    if (rows.length) assert.equal(rows[0].from, m.contractStart);
  }
  await assert.rejects(usage(get, 'L0'), /No contract L0/);
});
