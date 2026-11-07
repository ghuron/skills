#!/usr/bin/env node
/**
 * Epson EWS ink-level CLI — reads the printer's embedded web server (no auth, LAN only).
 *
 * Usage: node scripts/epson.mjs <command>
 *
 * Commands:
 *   ink   list remaining ink cartridge levels as JSON
 *
 * Requires: EPSON_HOST env var (printer IP or hostname)
 */

import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { once } from 'events';
import { text } from 'stream/consumers';
import https from 'https';

// EPSON_HOST may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const HOST = process.env.EPSON_HOST;

// ---------------------------------------------------------------------------
// httpsGet — plain HTTPS GET with self-signed cert tolerance
//
// Epson printers redirect http → https and present a self-signed certificate.
// Node's built-in fetch rejects self-signed certs with no escape hatch, so we
// use the https module with rejectUnauthorized: false. Justified here because
// we connect by raw IP on the local LAN — there's no hostname to verify against.
// ---------------------------------------------------------------------------

const AGENT = new https.Agent({ rejectUnauthorized: false });

async function httpsGet(url) {
  const req = https.get(url, { agent: AGENT, signal: AbortSignal.timeout(10_000) });
  const [res] = await once(req, 'response');
  return { status: res.statusCode, body: await text(res) };
}

// ---------------------------------------------------------------------------
// fetchPage — GET the EWS status page, fall back to secondary URL on non-ok
//
// Consumer Epson inkjets have no JSON/XML endpoint for ink levels, so the HTML
// status page is the only source short of SNMP. It needs no login on a typical
// home setup; a printer locked down in the EWS admin settings answers non-ok.
// The secondary URL exists on some firmware versions only.
// ---------------------------------------------------------------------------

const PRIMARY  = host => `https://${host}/PRESENTATION/HTML/TOP/PRTINFO.HTML`;
const FALLBACK = host => `https://${host}/PRESENTATION/ADVANCED/INFO_MENTINFO/TOP`;

export async function fetchPage(host) {
  // A timeout's AbortError carries "aborted due to timeout" in its cause.
  const get = url => httpsGet(url).catch(e => { throw new Error(`Cannot reach printer at ${host}: ${(e.cause ?? e).message}`); });
  const ok = r => r.status >= 200 && r.status < 300;
  const r = await get(PRIMARY(host));
  if (ok(r)) return r.body;
  const r2 = await get(FALLBACK(host));
  if (ok(r2)) return r2.body;
  throw new Error(`Printer returned HTTP ${r.status} and fallback HTTP ${r2.status}`);
}

// ---------------------------------------------------------------------------
// parseInkLevels — extract cartridge colors and levels from EWS HTML
//
// Each cartridge is a <li class='tank'> block containing:
//   - A .tank div with a CSS gradient whose second stop is the fill percentage
//   - A .clrname div with the color abbreviation (BK, M, C, LC, Y, LM)
// The maintenance box uses .mbicn instead of .clrname and is skipped.
// Some firmware encodes the level as the pixel width of a progress bar instead
// of 0-100; the test's range check catches that.
// ---------------------------------------------------------------------------

const COLOR_NAME = {
  BK: 'Black',
  M:  'Magenta',
  C:  'Cyan',
  LC: 'Light Cyan',
  Y:  'Yellow',
  LM: 'Light Magenta',
};

export function parseInkLevels(html) {
  const results = [];

  for (const block of html.matchAll(/<li class='tank'>([\s\S]*?)<\/li>/g)) {
    const inner = block[1];

    const colorMatch = inner.match(/<div class='clrname'>([^<]+)<\/div>/);
    if (!colorMatch) continue; // maintenance box (.mbicn) — skip

    const levelMatch = inner.match(/linear-gradient\(to top,\s*\S+\s+0%,\s*\S+\s+(\d+)%/);
    const abbr = colorMatch[1].trim();

    results.push({
      color: COLOR_NAME[abbr] ?? abbr,
      level: levelMatch ? Number(levelMatch[1]) : null,
    });
  }

  if (results.length === 0) {
    throw new Error('Could not parse ink levels — EWS HTML structure may have changed');
  }

  return results;
}

export async function inkLevels(host = HOST) {
  return parseInkLevels(await fetchPage(host));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!HOST) {
    console.error('Set EPSON_HOST before running.');
    process.exit(1);
  }

  if (process.argv[2] !== 'ink') {
    console.error('Commands: ink');
    process.exit(1);
  }
  inkLevels().then(levels => console.log(JSON.stringify(levels)), e => { console.error(e.message); process.exit(1); });
}
