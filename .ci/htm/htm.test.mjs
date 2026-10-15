/**
 * Integration tests for htm.mjs
 * Run: node --test htm.test.mjs
 *
 * Picks up every *.env file in htm/ and runs the same battery
 * of tests against each set of credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  login, reorder, cancelOrderline, apiGet, orderApiCall, buildRegioCatalog, REGIO_VRIJ_PRODUCT_ID,
} from '../../htm/htm.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(DIR, '../../htm/htm.mjs');

// "HTM 20% Korting" — already an orderable product on the account these .env
// files belong to. Adjust if testing against a different account.
const DISCOUNT_PRODUCT_ID = 5;
// "Regio Vrij DH70 - Reductie" (Child/Teenager price) — needs the pass owner's birthdate.
const AGE_BASED_PRODUCT_ID = 10;

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

/** Spawn `node htm.mjs <args>` with the given env vars. */
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

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysFromNow = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fixtures — all *.env files in the skill folder
// ---------------------------------------------------------------------------

const SKILL = join(DIR, '../../htm');
const envFiles = readdirSync(SKILL)
  .filter(f => f.endsWith('.env'))
  .map(f => ({ name: f, env: parseEnvFile(join(SKILL, f)) }));

// ---------------------------------------------------------------------------
// Per-credentials tests
// ---------------------------------------------------------------------------

for (const { name, env } of envFiles) {
  test(`${name}: passes returns a valid list`, () => {
    const { stdout, stderr, status } = runCLI(['passes'], env);
    assert.equal(status, 0, `CLI exited ${status}: ${stderr}`);
    const data = JSON.parse(stdout);
    assert.ok(Array.isArray(data) && data.length > 0, 'Expected non-empty array');
  });

  test(`${name}: passes entries have numeric id and type`, () => {
    const { stdout, stderr, status } = runCLI(['passes'], env);
    assert.equal(status, 0, stderr);
    const data = JSON.parse(stdout);
    assert.ok(typeof data[0].id === 'number', 'Entry should have numeric id');
    assert.ok(typeof data[0].type === 'string', 'Entry should have type');
  });

  test(`${name}: products returns an array for the first pass`, () => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const { stdout, stderr, status } = runCLI(['products', String(passes[0].id)], env);
    assert.equal(status, 0, stderr);
    assert.ok(Array.isArray(JSON.parse(stdout)), 'Expected an array');
  });

  test(`${name}: reizen returns an array for the first pass over the last 7 days`, () => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const { stdout, stderr, status } = runCLI(['reizen', String(passes[0].id), daysAgo(7), today()], env);
    assert.equal(status, 0, stderr);
    const data = JSON.parse(stdout);
    assert.ok(Array.isArray(data), 'Expected an array');
    if (data.length > 0) {
      assert.ok(typeof data[0].id === 'number', 'Trip should have numeric id');
      assert.ok(typeof data[0].checkin === 'string', 'Trip should have checkin timestamp');
      assert.ok(typeof data[0].fare === 'number' && data[0].fare < 50, 'Trip fare should be in euros, not eurocents');
    }
  });

  test(`${name}: regio-advies returns priced regions for the first pass over the last 7 days`, () => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const { stdout, stderr, status } = runCLI(['regio-advies', String(passes[0].id), daysAgo(7), today()], env);
    assert.equal(status, 0, stderr);
    const data = JSON.parse(stdout);
    assert.ok(Array.isArray(data) && data.length === 1, 'Expected an array with one result per tokenId');
    const result = data[0];
    assert.equal(result.tokenId, passes[0].id);
    assert.equal(result.ageProfile, 'Adult');
    assert.ok(result.periodMonths >= 1, 'Expected at least one month in range');
    assert.ok(typeof result.totalFare === 'number' && result.totalFare < 1000, 'Total fare should be in euros, not eurocents');
    assert.ok(Array.isArray(result.regions) && result.regions.length > 0, 'Expected at least one priced region');
    const region = result.regions[0];
    assert.ok(typeof region.name === 'string' && region.name.length > 0);
    assert.ok(typeof region.price === 'number' && region.price > 0, 'Region should have a real subscription price');
    assert.ok(typeof region.worthIt === 'boolean');
  });

  test(`${name}: regio-advies accepts multiple comma-separated tokenIds in one call`, () => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const ids = passes.map(p => p.id).join(',');
    const { stdout, stderr, status } = runCLI(['regio-advies', ids, daysAgo(7), today()], env);
    assert.equal(status, 0, stderr);
    const data = JSON.parse(stdout);
    assert.equal(data.length, passes.length, 'Expected one result per tokenId');
    assert.deepEqual(data.map(r => r.tokenId), passes.map(p => p.id));
  });

  test(`${name}: reorder configures a product and is idempotent on repeat calls`, async () => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const tokenId = String(passes[0].id);
    let orderLineId;
    try {
      const first = runCLI(['reorder', tokenId, String(DISCOUNT_PRODUCT_ID), daysFromNow(20)], env);
      assert.equal(first.status, 0, first.stderr);
      const firstOrder = JSON.parse(first.stdout);
      assert.equal(firstOrder.totalAmount, 5);
      assert.equal(firstOrder.currency, 'EUR');
      assert.ok(firstOrder.checkoutUrl.startsWith('https://www.htm.nl/'));
      orderLineId = firstOrder.orderLineId;

      const second = runCLI(['reorder', tokenId, String(DISCOUNT_PRODUCT_ID), daysFromNow(21)], env);
      assert.equal(second.status, 0, second.stderr);
      const secondOrder = JSON.parse(second.stdout);
      assert.equal(secondOrder.orderLineId, orderLineId, 'Repeat calls should reuse the same orderline, not create a duplicate');
      assert.equal(secondOrder.totalAmount, 5, 'Total should not grow from repeated calls');
    } finally {
      if (orderLineId) {
        const session = await login(env.HTM_LOGIN, env.HTM_PASSWORD);
        await cancelOrderline(session, orderLineId).catch(() => {});
      }
    }
  });

  test(`${name}: reorder rejects a start date beyond the ~30 day window`, async () => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const tokenId = String(passes[0].id);
    try {
      const { stdout, stderr, status } = runCLI(['reorder', tokenId, String(DISCOUNT_PRODUCT_ID), daysFromNow(60)], env);
      assert.notEqual(status, 0, `Expected reorder to fail for a start date far in the future, got: ${stdout}`);
      assert.match(stderr, /too far in the future/i);
    } finally {
      // The rejected date still gets written server-side, leaving the line
      // invalid. Fix it with a valid date (reorder() is idempotent — same
      // orderline) and remove it so the account is left as it was found.
      const session = await login(env.HTM_LOGIN, env.HTM_PASSWORD);
      const fixed = await reorder(session, tokenId, DISCOUNT_PRODUCT_ID, today()).catch(() => null);
      if (fixed) await cancelOrderline(session, fixed.orderLineId).catch(() => {});
    }
  });

  test(`${name}: reorder fills in the pass owner's birthdate for age-based products`, async t => {
    const passes = JSON.parse(runCLI(['passes'], env).stdout);
    const pass = passes.find(p => env[`HTM_BIRTHDATE_${p.id}`]);
    if (!pass) return t.skip('no HTM_BIRTHDATE_<tokenId> set for any pass');
    let orderLineId;
    try {
      const { stdout, stderr, status } = runCLI(['reorder', String(pass.id), String(AGE_BASED_PRODUCT_ID), daysFromNow(20)], env);
      assert.equal(status, 0, stderr);
      orderLineId = JSON.parse(stdout).orderLineId;

      const withoutBirthdate = runCLI(['reorder', String(pass.id), String(AGE_BASED_PRODUCT_ID), daysFromNow(20)],
        { ...env, [`HTM_BIRTHDATE_${pass.id}`]: '' });
      assert.equal(withoutBirthdate.status, 0, 'A birthdate already on the line should not be asked for again');
    } finally {
      if (orderLineId) {
        const session = await login(env.HTM_LOGIN, env.HTM_PASSWORD);
        await cancelOrderline(session, orderLineId).catch(() => {});
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Error handling (not credential-specific)
// ---------------------------------------------------------------------------

test('missing credentials: exits with non-zero status', () => {
  const { status, stderr } = runCLI(['passes'], { HTM_LOGIN: '', HTM_PASSWORD: '' });
  assert.notEqual(status, 0);
  assert.ok(stderr.length > 0, 'Expected error message on stderr');
});

test('bad credentials: exits with non-zero status and a login error', { skip: envFiles.length === 0 }, () => {
  const { status, stderr } = runCLI(['passes'], { HTM_LOGIN: 'nobody@example.com', HTM_PASSWORD: 'wrong' });
  assert.notEqual(status, 0);
  assert.match(stderr, /login failed/i);
});

test('unknown command: exits with non-zero status', { skip: envFiles.length === 0 }, () => {
  const { status } = runCLI(['notacommand'], envFiles[0].env);
  assert.notEqual(status, 0);
});

test(
  'regio-advies: bundled region catalog matches live data',
  { skip: envFiles.length === 0 },
  async () => {
    const session = await login(envFiles[0].env.HTM_LOGIN, envFiles[0].env.HTM_PASSWORD);
    const [wipkip, regionPrices] = await Promise.all([
      apiGet(session, '/v1/wipkip/getdata'),
      orderApiCall(session, 'GET', `/v3/order/product/regions/${REGIO_VRIJ_PRODUCT_ID}`),
    ]);
    const live = buildRegioCatalog(wipkip, regionPrices);
    const bundled = JSON.parse(readFileSync(join(DIR, '../../htm/regio-catalog.json'), 'utf8'));
    assert.deepStrictEqual(
      live,
      bundled,
      'htm/regio-catalog.json is stale — run `node .ci/htm/refresh.mjs` and commit the diff.'
    );
  }
);
