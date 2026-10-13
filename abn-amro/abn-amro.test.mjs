/**
 * Tests for abn-amro.mjs
 * Run: node --test abn-amro.test.mjs
 *
 * The export lines below are made up, in the layouts ABN AMRO uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseDescription, parseTab, parseCsv, appendRows } from '../skills/abn-amro/abn-amro.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../skills/abn-amro/abn-amro.mjs');
const pad = s => s.padEnd(32);

const TAB = [
  ['123456789', 'EUR', '20260901', '1000,00', '900,00', '20260901', '-100,00',
    '/TRTP/SEPA Incasso algemeen doorlopend/CSID/NL00ZZZ000000000000/NAME/ENERGIE   BV/MARF/42/REMI/Termijn oktober (kenmerk: 1-2/3)/IBAN/NL00BANK0123456789 /BIC/BANKNL2A/EREF/7      '],
  ['123456789', 'EUR', '20260902', '900,00', '880,50', '20260902', '-19,50',
    pad('BEA, Google Pay') + pad('Bakkerij De Korst,PAS123') + pad('NR:AB1234, 02.09.26/10:15') + pad('DEN HAAG')],
  ['123456789', 'EUR', '20260903', '880,50', '1880,50', '20260903', '1000,00',
    '/TRTP/SEPA OVERBOEKING/IBAN/NL00BANK0987654321/BIC/BANKNL2A/NAME/Werkgever BV/REMI/SALARIS 9/EREF/NOTPROVIDED     '],
].map(f => f.join('\t')).join('\r\n') + '\r\n';

test('tagged SEPA debit', () => {
  assert.deepEqual(parseDescription(TAB.split('\r\n')[0].split('\t')[7]), {
    Type: 'Direct debit', Counterparty: 'ENERGIE BV', 'Counterparty IBAN': 'NL00BANK0123456789', Description: 'Termijn oktober (kenmerk: 1-2/3)',
  });
});

test('tagged iDEAL payment', () => {
  const p = parseDescription('/TRTP/iDEAL/Wero/IBAN/NL00BANK0000000001/BIC/BANKNL2A/NAME/Webshop via Mollie/REMI/Order 77 webshop.nl/EREF/01-09-2026 10:00 1');
  assert.equal(p.Type, 'iDEAL');
  assert.equal(p.Counterparty, 'Webshop via Mollie');
  assert.equal(p.Description, 'Order 77 webshop.nl');
});

test('card payment, ATM withdrawal and OVpay trip', () => {
  assert.deepEqual(parseDescription(pad('BEA, Betaalpas') + pad('Gamma Laakhaven,PAS291') + pad('NR:KW5708, 09.05.26/12:02') + "'S-GRAVENHAGE"), {
    Type: 'Card payment', Counterparty: 'Gamma Laakhaven', 'Counterparty IBAN': '', Description: "'S-GRAVENHAGE 09.05.26 12:02",
  });
  assert.equal(parseDescription('GEA, Betaalpas Geldmaat Centrum 1,PAS291 NR:123456, 19.04.26/09:43 Den Haag').Type, 'ATM withdrawal');
  assert.deepEqual(parseDescription('BEA, Google Pay NLOVAAAABBBBCCCCDD,PAS581 NR:PT30AAAA, 21.01.26/20:44 www.ovpay.nl'), {
    Type: 'Card payment (Google Pay)', Counterparty: 'OVpay', 'Counterparty IBAN': '', Description: 'www.ovpay.nl NLOVAAAABBBBCCCCDD 21.01.26 20:44',
  });
});

test('labelled SEPA: labels run into names, nested labels, missing IBAN', () => {
  const p = parseDescription('SEPA Incasso algemeen doorlopend Incassant: NL00ZZZ111111110000 Naam: Payments Europe SCAOmschrijving: Kenmerk: 1 Omschrijving: Pakket, polisnr.: 5 Kenmerk: 99');
  assert.deepEqual(p, { Type: 'Direct debit', Counterparty: 'Payments Europe SCA', 'Counterparty IBAN': 'NL00ZZZ111111110000', Description: 'Pakket, polisnr.: 5' });
  const t = parseDescription('SEPA Overboeking IBAN: NL00BANK0222222222 BIC: BANKNL2A Naam: Gemeente Den HaagBetalingskenm.: 1234');
  assert.deepEqual(t, { Type: 'Transfer', Counterparty: 'Gemeente Den Haag', 'Counterparty IBAN': 'NL00BANK0222222222', Description: 'Betalingskenmerk 1234' });
});

test('bank fees', () => {
  assert.deepEqual(parseDescription(pad('ABN AMRO Bank N.V.') + pad('BasisPakket Betalen         4,30') + 'Credit Card 2,55'), {
    Type: 'Bank fee', Counterparty: 'ABN AMRO Bank N.V.', 'Counterparty IBAN': '', Description: 'BasisPakket Betalen 4,30Credit Card 2,55',
  });
});

test('TAB rows: dates, amounts, balance', () => {
  const [r] = parseTab(TAB);
  assert.equal(r.Date, '2026-09-01');
  assert.equal(r['Amount (EUR)'], '-100.00');
  assert.equal(r['Balance After (EUR)'], '900.00');
  assert.match(r['Raw Description'], /^\/TRTP\/SEPA Incasso .*\/EREF\/7$/);
});

test('--append adds only new rows and keeps extra columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abn-'));
  const tab = join(dir, 'export.TAB');
  const csv = join(dir, 'me.csv');
  writeFileSync(tab, TAB, 'latin1');
  writeFileSync(csv, 'Date,Value Date,Amount (EUR),Balance After (EUR),Type,Counterparty,Counterparty IBAN,Description,Category,Note,Raw Description\r\n'
    + '2026-09-01,2026-09-01,-100.00,900.00,Direct debit,ENERGIE BV,NL00BANK0123456789,Termijn,Utilities,my note,x\r\n');

  const r = spawnSync(process.execPath, [CLI, tab, '--append', csv], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /2 new rows/);
  const [header, ...rows] = parseCsv(readFileSync(csv, 'utf8'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0][9], 'my note');
  assert.equal(rows[1][header.indexOf('Counterparty')], 'Bakkerij De Korst');
  assert.equal(rows[2][header.indexOf('Category')], '');

  assert.equal(appendRows(csv, parseTab(TAB)).length, 0);
});
