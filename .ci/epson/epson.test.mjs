/**
 * Integration tests for epson.mjs
 * Run: node --test epson.test.mjs
 *
 * Picks up every *.env file in skills/epson/ and runs the same battery
 * of tests against each set of credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseInkLevels } from '../../skills/epson/epson.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../skills/epson/epson.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .env file into an object, stripping surrounding quotes from values. */
function parseEnvFile(path) {
  const vars = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([^=#][^=]*)=(.*)$/);
    if (m) {
      const val = m[2].trim();
      vars[m[1].trim()] = val.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return vars;
}

/** Spawn `node epson.mjs <args>` with the given env vars. */
function runCLI(args, envVars = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envVars },
    timeout: 30_000,
  });
  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    status: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Fixtures — all *.env files in the skill folder
// ---------------------------------------------------------------------------

const SKILL = join(DIR, '../../skills/epson');
const envFiles = readdirSync(SKILL)
  .filter(f => f.endsWith('.env'))
  .map(f => ({ name: f, env: parseEnvFile(join(SKILL, f)) }));

// ---------------------------------------------------------------------------
// Unit test for parseInkLevels — fixture from XP-8700 EWS (PRTINFO.HTML)
// ---------------------------------------------------------------------------

const FIXTURE = `
<ul class="inksection">
<li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #ED008C 0%, #ED008C 35%, #FFFFFF 35%, #FFFFFF 100%);'></div>
<div class='clrname'>M</div>
</li><!--
--><li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #000000 0%, #000000 55%, #FFFFFF 55%, #FFFFFF 100%);'></div>
<div class='clrname'>BK</div>
</li><!--
--><li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #8ED8F8 0%, #8ED8F8 1%, #FFFFFF 1%, #FFFFFF 100%);'><img class='inkst' src='../../IMAGE/Icn_No.PNG' height='22' width='22'>
</div>
<div class='clrname'>LC</div>
</li><!--
--><li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #00AEEF 0%, #00AEEF 9%, #FFFFFF 9%, #FFFFFF 100%);'><img class='inkst' src='../../IMAGE/Icn_low.PNG' height='22' width='22'>
</div>
<div class='clrname'>C</div>
</li><!--
--><li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #FFF200 0%, #FFF200 56%, #FFFFFF 56%, #FFFFFF 100%);'></div>
<div class='clrname'>Y</div>
</li><!--
--><li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #F7AECD 0%, #F7AECD 90%, #FFFFFF 90%, #FFFFFF 100%);'></div>
<div class='clrname'>LM</div>
</li><!--
--><li class='tank'>
<div class='tank' style='background:linear-gradient(to top, #636311 0%, #636311 79%, #FFFFFF 79%, #FFFFFF 100%);'></div>
<div class='mbicn'><img src='../../IMAGE/Icn_Mb.PNG' height='18' width='18'></div>
</li>
</ul>`;

test('parseInkLevels: parses XP-8700 fixture correctly', () => {
  const result = parseInkLevels(FIXTURE);
  assert.equal(result.length, 6); // 6 ink cartridges, maintenance box excluded
  assert.deepEqual(result, [
    { color: 'Magenta',       level: 35 },
    { color: 'Black',         level: 55 },
    { color: 'Light Cyan',    level: 1  },
    { color: 'Cyan',          level: 9  },
    { color: 'Yellow',        level: 56 },
    { color: 'Light Magenta', level: 90 },
  ]);
});

test('parseInkLevels: throws on unrecognised HTML', () => {
  assert.throws(() => parseInkLevels('<html></html>'), /Could not parse/);
});

// ---------------------------------------------------------------------------
// Per-credentials integration tests
// ---------------------------------------------------------------------------

for (const { name, env } of envFiles) {
  test(`${name}: ink exits 0 and returns a non-empty JSON array`, () => {
    const { stdout, stderr, status } = runCLI(['ink'], env);
    assert.equal(status, 0, `CLI exited ${status}: ${stderr}`);
    const data = JSON.parse(stdout);
    assert.ok(Array.isArray(data) && data.length > 0, 'Expected non-empty array');
  });

  test(`${name}: each cartridge has string color and numeric-or-null level`, () => {
    const { stdout, stderr, status } = runCLI(['ink'], env);
    assert.equal(status, 0, stderr);
    for (const item of JSON.parse(stdout)) {
      assert.equal(typeof item.color, 'string', `color should be string, got ${typeof item.color}`);
      assert.ok(
        item.level === null || typeof item.level === 'number',
        `level should be number or null, got ${typeof item.level}`
      );
    }
  });

  test(`${name}: level values are in range 0-100 when not null`, () => {
    const { stdout, stderr, status } = runCLI(['ink'], env);
    assert.equal(status, 0, stderr);
    for (const item of JSON.parse(stdout)) {
      if (item.level !== null) {
        assert.ok(
          item.level >= 0 && item.level <= 100,
          `level ${item.level} is out of 0-100 range (may be raw pixel value rather than percent)`
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Error-handling tests (no credentials needed)
// ---------------------------------------------------------------------------

test('missing EPSON_HOST: exits 1 with message mentioning EPSON_HOST', () => {
  const { status, stderr } = runCLI(['ink'], { EPSON_HOST: '' });
  assert.notEqual(status, 0);
  assert.match(stderr, /EPSON_HOST/);
});

test('unknown command: exits 1', { skip: envFiles.length === 0 }, () => {
  const { status } = runCLI(['notacommand'], envFiles[0].env);
  assert.notEqual(status, 0);
});

test('unreachable host: exits 1 with error message on stderr', () => {
  // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed unreachable.
  // AbortSignal.timeout(10_000) in fetchPage bounds the wait; allow 15s here.
  const result = spawnSync('node', [CLI, 'ink'], {
    encoding: 'utf8',
    env: { ...process.env, EPSON_HOST: '192.0.2.1' },
    timeout: 15_000,
  });
  const status = result.status ?? -1;
  const stderr = result.stderr?.trim() ?? '';
  assert.notEqual(status, 0);
  assert.ok(stderr.length > 0, 'Expected error message on stderr');
});
