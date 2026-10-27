/**
 * Integration tests for magister.mjs
 * Run: node --test magister.test.mjs
 *
 * Picks up every *.env file in magister/ and runs the same battery
 * of tests against each set of credentials.
 */

import { test } from 'node:test';
import assert            from 'node:assert/strict';
import { spawnSync }     from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR     = dirname(fileURLToPath(import.meta.url));
const CLI     = join(DIR, '../../magister/scripts/magister.mjs');
const DRY_RUN = join(DIR, 'dry-run.mjs');

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

/** YYYY-MM-DD in Europe/Amsterdam, `offsetDays` from today. */
const amsterdamDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' });

const isWeekday = date => [1, 2, 3, 4, 5].includes(new Date(`${date}T12:00Z`).getUTCDay());

/** Spawn `node [nodeArgs] magister.mjs <args>` with the given env vars. */
function runCLI(args, envVars = {}, nodeArgs = []) {
  const result = spawnSync('node', [...nodeArgs, CLI, ...args], {
    encoding: 'utf8',
    env:      { ...process.env, ...envVars },
    timeout:  30_000,
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

const SKILL = join(DIR, '../../magister');
const envFiles = readdirSync(SKILL)
  .filter(f => f.endsWith('.env'))
  .map(f => ({ name: f, env: parseEnvFile(join(SKILL, f)) }));

// ---------------------------------------------------------------------------
// Per-credentials tests
// ---------------------------------------------------------------------------

for (const { name, env } of envFiles) {
  test(`${name}: students returns a valid list`, () => {
    const { stdout, stderr, status } = runCLI(['students'], env);
    assert.equal(status, 0, `CLI exited ${status}: ${stderr}`);
    const data = JSON.parse(stdout);
    assert.ok(Array.isArray(data) && data.length > 0, 'Expected non-empty array');
  });

  test(`${name}: students entries have numeric id and name`, () => {
    const { stdout, stderr, status } = runCLI(['students'], env);
    assert.equal(status, 0, stderr);
    const data = JSON.parse(stdout);
    assert.ok(Array.isArray(data) && data.length > 0, 'Expected non-empty array');
    assert.ok(typeof data[0].id === 'number', 'Entry should have numeric id');
    assert.ok(typeof data[0].name === 'string', 'Entry should have name');
  });

  test(`${name}: schedule lessons carry homework as null or {type, text, done}`, () => {
    const students = JSON.parse(runCLI(['students'], env).stdout);
    const { stdout, stderr, status } = runCLI(['schedule', String(students[0].id), amsterdamDate(-7), amsterdamDate(7)], env);
    assert.equal(status, 0, stderr);
    // No non-empty check: the window can fall in a school holiday
    for (const { homework } of JSON.parse(stdout)) {
      if (homework === null) continue;
      assert.ok(typeof homework.text === 'string' && !/<\w/.test(homework.text), 'Expected plain-text homework');
      assert.equal(typeof homework.done, 'boolean');
    }
  });

  test(`${name}: messages lists the inbox and message reads one`, () => {
    const list = runCLI(['messages', '5'], env);
    assert.equal(list.status, 0, list.stderr);
    const messages = JSON.parse(list.stdout);
    assert.ok(messages.length > 0, 'Expected a non-empty inbox');
    assert.ok(typeof messages[0].id === 'number' && typeof messages[0].subject === 'string');

    const one = runCLI(['message', String(messages[0].id)], env);
    assert.equal(one.status, 0, one.stderr);
    const message = JSON.parse(one.stdout);
    assert.equal(message.id, messages[0].id);
    assert.ok(typeof message.body === 'string' && !/<\w/.test(message.body), 'Expected plain-text body');
    assert.ok(Array.isArray(message.attachments));
  });
}

// ---------------------------------------------------------------------------
// Error handling (not credential-specific)
// ---------------------------------------------------------------------------

test('missing credentials: exits with non-zero status', () => {
  const { status, stderr } = runCLI(['students'], {
    MAGISTER_HOST: '', MAGISTER_USER: '', MAGISTER_PASSWORD: '',
  });
  assert.notEqual(status, 0);
  assert.ok(stderr.length > 0, 'Expected error message on stderr');
});

test('unknown command: exits with non-zero status', { skip: envFiles.length === 0 }, () => {
  const { status } = runCLI(['notacommand'], envFiles[0].env);
  assert.notEqual(status, 0);
});

// ---------------------------------------------------------------------------
// report-sick — never submits: argument checks exit before any request, and the
// end-to-end test runs under dry-run.mjs, which refuses every non-login POST.
// ---------------------------------------------------------------------------

test('report-sick: rejects a date other than today or tomorrow', { skip: envFiles.length === 0 }, () => {
  const { status, stderr } = runCLI(['report-sick', '1', '2000-01-03'], envFiles[0].env, ['--import', DRY_RUN]);
  assert.notEqual(status, 0);
  assert.match(stderr, /today or tomorrow/);
  assert.doesNotMatch(stderr, /DRY-RUN/);
});

test('report-sick: rejects a missing date', { skip: envFiles.length === 0 }, () => {
  const { status, stderr } = runCLI(['report-sick', '1'], envFiles[0].env, ['--import', DRY_RUN]);
  assert.notEqual(status, 0);
  assert.match(stderr, /Usage/);
});

const sickDate = [amsterdamDate(0), amsterdamDate(1)].find(isWeekday);

test('report-sick: posts a full-day melding for at least one student (dry run)', { skip: !sickDate && 'no weekday today or tomorrow' }, () => {
  const posts = [];
  for (const { env } of envFiles) {
    const { stdout, stderr, status } = runCLI(['students'], env);
    assert.equal(status, 0, stderr);
    for (const { id } of JSON.parse(stdout)) {
      const r = runCLI(['report-sick', String(id), sickDate, 'test'], env, ['--import', DRY_RUN]);
      const line = r.stderr.split('\n').find(l => l.startsWith('DRY-RUN '));
      if (line) posts.push({ id, request: JSON.parse(line.slice(8)), ...r });
    }
  }
  assert.ok(posts.length > 0, 'No student offers the absentiemelding link');
  for (const { id, request, status, stdout } of posts) {
    assert.equal(status, 0);
    assert.match(request.url, new RegExp(`/api/leerlingen/${id}/absentiemeldingen$`));
    const { begin, einde, opmerking } = request.body;
    assert.equal(new Date(begin).toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' }), sickDate);
    assert.ok(new Date(einde) - new Date(begin) >= 23 * 3_600_000, 'Expected a full day');
    assert.equal(opmerking, 'test');
    assert.deepEqual(JSON.parse(stdout), { reported: true, id, date: sickDate, note: 'test' });
  }
});
