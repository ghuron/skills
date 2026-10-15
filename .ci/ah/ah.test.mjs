/**
 * Tests for ah.mjs
 * Run: node --test ah.test.mjs
 *
 * Runs `csv` on the invoice PDFs in .fixtures/ (gitignored) and compares the result with
 * .fixtures/expected/<order number>.csv. Skipped when there are none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(DIR, '.fixtures');
const hasInvoices = existsSync(FIXTURES) && readdirSync(FIXTURES).some(f => f.endsWith('.pdf'));

test('invoice PDFs turn into the expected CSVs', { skip: !hasInvoices && 'no invoices in .fixtures/' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'ah-'));
  const r = spawnSync(process.execPath, [join(DIR, '../../ah/ah.mjs'), 'csv', '--out', out, FIXTURES], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of readdirSync(join(FIXTURES, 'expected'))) {
    assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(FIXTURES, 'expected', f), 'utf8'), f);
  }
});
