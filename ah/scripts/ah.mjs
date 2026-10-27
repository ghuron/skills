#!/usr/bin/env node
/**
 * Albert Heijn CLI.
 *
 * Usage: node scripts/ah.mjs <command> [args]
 *
 * Commands:
 *   csv [--force] [--out <dir>] <pdf|dir>...   invoice (factuur) PDFs -> <order number>.csv
 *
 * Not yet: log in, list orders, and download an order's factuur, so that `csv` can run on what
 * it fetched. Until then it only converts invoices you downloaded yourself.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));

/** Invoice PDFs -> one CSV per order, via parse_invoice.py (needs python3 with pypdf). Returns the exit code. */
export function invoiceCsv(args) {
  return spawnSync('python3', [join(DIR, 'parse_invoice.py'), ...args], { stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'csv':
      process.exit(invoiceCsv(rest));
    default:
      console.error('Usage: node scripts/ah.mjs csv [--force] [--out <dir>] <pdf|dir>...');
      process.exit(1);
  }
}
