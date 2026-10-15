#!/usr/bin/env node
/**
 * ABN AMRO transaction export (.TAB) -> CSV.
 *
 * Usage: node abn-amro.mjs <export.TAB> [--account <number>] [--append <file.csv>]
 *
 * Without --append the rows go to stdout. With --append, only rows the file doesn't have yet
 * (same Date, Amount and Balance After) are added at its end. Columns the file has beyond the
 * ones below (your own Category, Note, ...) are left empty for them.
 * An export can hold several accounts; --account picks one.
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

export const COLUMNS = ['Date', 'Value Date', 'Amount (EUR)', 'Balance After (EUR)', 'Type',
  'Counterparty', 'Counterparty IBAN', 'Description', 'Raw Description'];

const squash = s => (s ?? '').replace(/\s+/g, ' ').trim();
const isoDate = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const amount = a => a.replace(',', '.');

// ---------------------------------------------------------------------------
// Description formats
//
// /TRTP/<type>/NAME/<name>/REMI/<text>/IBAN/<iban>/...   SEPA, tagged (from mid-2026)
// SEPA <type> Naam: <name> Omschrijving: <text> IBAN: …  SEPA, labelled 32-character blocks (before)
// BEA, Betaalpas <merchant>,PAS291 NR:…, 31.12.25/17:44 <place>        card payment
// GEA, Betaalpas <atm>,PAS291 NR:…, 31.12.25/17:44 <place>             cash withdrawal
// ABN AMRO Bank N.V. <fee lines>                                       bank fees
//
// Tagged values keep the bank's padding ("WATERBEDRIJF   NV") and can end in a space. A labelled
// block that fills its 32 characters runs straight into the next label, and words can wrap
// mid-word ("verze kering"). Phone payments say "Google Pay" instead of "Betaalpas", a card
// reversal adds TERUGBOEKING-BEA-TRANSACTIE after the place, and a payment in another currency
// shows its 1.75% + €0.15 surcharge: "USD 10,00 1EUR=1,1002 USD ECB Koers=1,1194 OPSLAG=1,75%".
// ---------------------------------------------------------------------------

const TAGS = 'TRTP|CSID|NAME|MARF|REMI|IBAN|BIC|EREF|ORDP|BENM|ADDR|ISDT|RTRN|CNTP|PURP|ULTC|ULTD|IREF|SVCL';
// A label can run into the text before it without a space ("…Europe SCAOmschrijving:").
// Case matters: descriptions use the same words ("… ( kenmerk: 5200-…)").
const LABELS = /(Incassant|Naam|Machtiging|Omschrijving|IBAN|BIC|Kenmerk|Voor|Betalingskenm\.|ID begunstigde)\s*:/g;

function sepaType(t) {
  if (/incasso/i.test(t)) return 'Direct debit';
  if (/ideal/i.test(t)) return 'iDEAL';
  if (/overb|instant/i.test(t)) return 'Transfer';
  return squash(t);
}

/** Split `/KEY/value/KEY/value…` on known keys only: values themselves contain slashes. */
function tagged(raw) {
  const re = new RegExp(`/(${TAGS})/`, 'g');
  const marks = [...raw.matchAll(re)];
  const out = {};
  marks.forEach((m, i) => {
    out[m[1]] ??= raw.slice(m.index + m[0].length, marks[i + 1]?.index ?? raw.length);
  });
  return out;
}

/**
 * Split `<head> Label: value Label: value…` on its labels. A label's last non-empty value wins:
 * some debits nest their own labels in Omschrijving ("Omschrijving: Kenmerk: … Omschrijving: Pakket").
 */
function labelled(text) {
  const marks = [...text.matchAll(LABELS)];
  const out = { head: text.slice(0, marks[0]?.index ?? text.length) };
  marks.forEach((m, i) => {
    const value = text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length).trim();
    if (value) out[m[1].toLowerCase()] = value;
  });
  return out;
}

/** The parsed fields of a TAB description. Type is empty when the format is unknown. */
export function parseDescription(raw) {
  if (raw.trimStart().startsWith('/TRTP/')) {
    const t = tagged(raw.trim());
    return { Type: sepaType(t.TRTP), Counterparty: squash(t.NAME), 'Counterparty IBAN': squash(t.IBAN), Description: squash(t.REMI) };
  }
  const text = squash(raw);
  if (text.startsWith('SEPA ')) {
    const l = labelled(text);
    // a direct debit without an IBAN is identified by its collector (Incassant) ID
    const description = l.omschrijving ?? (l['betalingskenm.'] && `Betalingskenmerk ${l['betalingskenm.']}`);
    return { Type: sepaType(l.head), Counterparty: squash(l.naam), 'Counterparty IBAN': squash(l.iban ?? l.incassant), Description: squash(description) };
  }
  const card = text.match(/^(BEA|GEA), (Betaalpas|\w+ Pay) (.+?),PAS\d+ NR:\S+?,? (\d\d\.\d\d\.\d\d)\/(\d\d[.:]\d\d) ?(.*)$/);
  if (card) {
    const [, kind, means, merchant, date, hhmm, place] = card;
    const time = hhmm.replace('.', ':');
    const type = kind === 'GEA' ? 'ATM withdrawal' : means === 'Betaalpas' ? 'Card payment' : `Card payment (${means})`;
    // OVpay trips show a token (NLOV…) where the merchant would be
    if (/^NLOV\w+$/.test(merchant)) {
      return { Type: type, Counterparty: 'OVpay', 'Counterparty IBAN': '', Description: `${place} ${merchant} ${date} ${time}`.trim() };
    }
    return { Type: type, Counterparty: merchant, 'Counterparty IBAN': '', Description: `${place} ${date} ${time}`.trim() };
  }
  if (text.startsWith('ABN AMRO Bank N.V. ')) {
    return { Type: 'Bank fee', Counterparty: 'ABN AMRO Bank N.V.', 'Counterparty IBAN': '', Description: text.slice(19) };
  }
  return { Type: '', Counterparty: '', 'Counterparty IBAN': '', Description: text };
}

/**
 * Rows of a .TAB export (tab-separated, no header, Latin-1):
 * account, currency, date, balance before, balance after, value date, amount, description.
 * Dates are YYYYMMDD; amounts have a decimal comma and no thousands separator.
 */
export function parseTab(text) {
  return text.split(/\r?\n/).filter(l => l.trim()).map(line => {
    const [account, currency, date, , after, valueDate, amt, ...desc] = line.split('\t');
    const raw = desc.join('\t');
    if (currency !== 'EUR') throw new Error(`Unexpected currency ${currency} in: ${line}`);
    return {
      account,
      Date: isoDate(date), 'Value Date': isoDate(valueDate),
      'Amount (EUR)': amount(amt), 'Balance After (EUR)': amount(after),
      ...parseDescription(raw),
      'Raw Description': squash(raw),
    };
  });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const cell = v => /[",\r\n]/.test(v ?? '') ? `"${v.replace(/"/g, '""')}"` : (v ?? '');
export const toCsvLine = (cols, row) => cols.map(c => cell(row[c])).join(',') + '\r\n';

/** RFC 4180 rows (arrays of strings). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const key = r => `${r.Date}|${r['Amount (EUR)']}|${r['Balance After (EUR)']}`;

/** Append the rows `file` doesn't have yet; creates it with COLUMNS if missing. Returns the rows added. */
export function appendRows(file, rows) {
  if (!existsSync(file)) writeFileSync(file, toCsvLine(COLUMNS, Object.fromEntries(COLUMNS.map(c => [c, c]))));
  const text = readFileSync(file, 'utf8');
  const [header, ...existing] = parseCsv(text);
  for (const c of ['Date', 'Amount (EUR)', 'Balance After (EUR)']) {
    if (!header.includes(c)) throw new Error(`${file} has no "${c}" column`);
  }
  const have = new Set(existing.map(r => key(Object.fromEntries(header.map((c, i) => [c, r[i]])))));
  const added = rows.filter(r => !have.has(key(r)));
  if (added.length) {
    appendFileSync(file, (text.endsWith('\n') ? '' : '\r\n') + added.map(r => toCsvLine(header, r)).join(''));
  }
  return added;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const account = opt('--account');
  const target = opt('--append');
  const [file] = args;
  if (!file) {
    console.error('Usage: node abn-amro.mjs <export.TAB> [--account <number>] [--append <file.csv>]');
    process.exit(1);
  }

  let rows = parseTab(readFileSync(file, 'latin1'));
  const accounts = [...new Set(rows.map(r => r.account))];
  if (account) rows = rows.filter(r => r.account === account);
  else if (accounts.length > 1) {
    console.error(`${file} holds accounts ${accounts.join(', ')}: pick one with --account`);
    process.exit(1);
  }
  for (const r of rows.filter(r => !r.Type)) console.error(`Unknown description format: ${r['Raw Description']}`);

  if (!target) {
    process.stdout.write(toCsvLine(COLUMNS, Object.fromEntries(COLUMNS.map(c => [c, c]))) + rows.map(r => toCsvLine(COLUMNS, r)).join(''));
  } else {
    const added = appendRows(target, rows);
    console.error(`${added.length} new rows appended to ${target} (${rows.length - added.length} already there)`);
  }
}
