#!/usr/bin/env node
/**
 * Evening school digest for a Magister parent account, sent by a Hermes cron job on the CI box (see
 * PLAN.md). Per child: tomorrow's first and last lesson, a sportswear reminder when there's LO or
 * fitness, and grades and absences not reported before. Prints plain text for WhatsApp.
 *
 * What was reported is kept in $MAGISTER_DIGEST_STATE (default ~/.local/state/magister-digest.json).
 * On the first run, only grades from the last 24 hours and absences from today on count as new.
 *
 * Usage: node .ci/magister/digest.mjs   (reads magister/.env, like magister.mjs)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { apiGet } from '../../magister/scripts/magister.mjs';

const STATE = process.env.MAGISTER_DIGEST_STATE || join(homedir(), '.local', 'state', 'magister-digest.json');
const TZ    = 'Europe/Amsterdam';

// Afspraak.Type of a timetabled lesson, and the Afspraak.Status values of a cancelled one (by hand, by
// the timetable)
const LESSON    = 13;
const CANCELLED = new Set([4, 5]);
// Lessons that need sportswear, matched on the subject code or name
const SPORT     = /^(lo|fit)\b|lichamelijke opvoeding|fitness|gym|sport/i;

const date    = d => new Date(d).toLocaleDateString('sv', { timeZone: TZ });
const time    = d => new Date(d).toLocaleTimeString('nl', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayName = day => new Date(`${day}T12:00Z`)
  .toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

/** [1, 2, 3, 6] → "1–3, 6" */
function ranges(numbers) {
  const sorted = [...new Set(numbers.filter(n => n != null))].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/** " (hours 5–6)" for the lesson hours (lesuren) that `list` covers, or "" when they're unknown. */
const hours   = list => {
  const r = ranges(list.flatMap(l => (l.LesuurVan == null ? [] :
    Array.from({ length: (l.LesuurTotMet ?? l.LesuurVan) - l.LesuurVan + 1 }, (_, n) => l.LesuurVan + n))));
  return r && ` (hour${/[–,]/.test(r) ? 's' : ''} ${r})`;
};
const code    = afspraak => (afspraak?.Omschrijving ?? '').split(' - ')[0].trim();
const subject = afspraak => afspraak?.Vakken?.[0]?.Naam ?? code(afspraak);

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${STATE}.tmp`, STATE);
}

/** Tomorrow's lesson hours, sportswear and other appointments, as message lines. */
async function tomorrowLines(id, day) {
  const items = (await apiGet(`/api/personen/${id}/afspraken?van=${day}&tot=${addDays(day, 1)}`)).Items
    .filter(i => date(i.Start) === day && !CANCELLED.has(i.Status))
    .sort((a, b) => a.Start.localeCompare(b.Start));
  const lessons = items.filter(i => i.Type === LESSON && !i.DuurtHeleDag);
  const first   = lessons[0];
  const last    = lessons.reduce((a, b) => (a.Einde > b.Einde ? a : b), first);
  const span    = first?.LesuurVan != null && last.LesuurTotMet != null
    ? (first.LesuurVan === last.LesuurTotMet ? ` (hour ${first.LesuurVan})` : ` (hours ${first.LesuurVan}–${last.LesuurTotMet})`)
    : '';
  const lines   = [first
    ? `📅 ${dayName(day)}: ${time(first.Start)}–${time(last.Einde)}${span}`
    : `📅 ${dayName(day)}: no lessons`];

  const sport = Map.groupBy(lessons.filter(l => SPORT.test(code(l)) || SPORT.test(subject(l))), subject);
  if (sport.size) lines.push(`👟 Sportswear: ${[...sport].map(([name, list]) => `${name}${hours(list)}`).join(', ')}`);

  for (const i of items.filter(i => !lessons.includes(i))) {
    lines.push(`ℹ️ ${subject(i) || 'Appointment'}${i.DuurtHeleDag ? ' (all day)' : ` ${time(i.Start)}–${time(i.Einde)}`}`);
  }
  return lines;
}

/** Grades not reported before, as message lines; updates `seen`. */
async function gradeLines(id, seen, firstRun) {
  const grades = (await apiGet(`/api/personen/${id}/cijfers/laatste?top=50&skip=0`)).items;
  const key    = g => `${g.kolomId}@${g.ingevoerdOp}`;
  const since  = Date.now() - 86_400_000;
  const fresh  = grades.filter(g => !seen.has(key(g)) && !(firstRun && Date.parse(g.ingevoerdOp) < since));
  seen.clear();
  for (const g of grades) seen.add(key(g));
  return fresh.map(g => {
    const name   = g.vak?.omschrijving ?? g.vak?.code ?? '';
    const note   = [g.omschrijving, g.weegfactor && `weight ${g.weegfactor}`, g.teltMee === false && "doesn't count"]
      .filter(Boolean).join(', ');
    return `📝 ${name} ${g.waarde}${g.isVoldoende === false ? ' ❗' : ''}${note && ` (${note})`}`;
  });
}

/** Absences not reported before, one line per day and kind; updates `seen`. */
async function absenceLines(id, seen, firstRun, today) {
  const absences = (await apiGet(`/api/personen/${id}/absenties?van=${addDays(today, -30)}&tot=${addDays(today, 2)}`)).Items;
  const fresh    = absences.filter(a => !seen.has(a.Id) && !(firstRun && date(a.Start) < today));
  seen.clear();
  for (const a of absences) seen.add(a.Id);
  const groups = Map.groupBy(fresh, a => `${date(a.Start)}\n${a.Omschrijving}\n${a.Geoorloofd}`);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => {
    const [{ Start, Omschrijving, Geoorloofd }] = list;
    const where = ranges(list.map(a => a.Lesuur));
    const what  = [...new Set(list.map(a => code(a.Afspraak)).filter(Boolean))].join(', ');
    return `🚫 ${dayName(date(Start))}: ${Omschrijving}${Geoorloofd ? ' (excused)' : ''}` +
      `${where ? `, hour${/[–,]/.test(where) ? 's' : ''} ${where}` : ''}${what ? ` (${what})` : ''}`;
  });
}

const today    = date(Date.now());
const tomorrow = addDays(today, 1);
const state    = readState();
const out      = [];

try {
  const account = await apiGet('/api/account');
  const kids    = (await apiGet(`/api/ouders/${account.Persoon.Id}/kinderen`)).items;
  for (const kid of kids) {
    out.push('', `*${kid.roepnaam}*`);
    try {
      const firstRun = !state[kid.id];
      const seen     = { grades: new Set(state[kid.id]?.grades), absences: new Set(state[kid.id]?.absences) };
      const lines    = [
        ...await tomorrowLines(kid.id, tomorrow),
        ...await gradeLines(kid.id, seen.grades, firstRun),
        ...await absenceLines(kid.id, seen.absences, firstRun, today),
      ];
      out.push(...lines);
      state[kid.id] = { grades: [...seen.grades], absences: [...seen.absences] };
    } catch (e) {
      out.push(`⚠️ Could not read Magister: ${e.message}`);
    }
  }
  writeState(state);
} catch (e) {
  out.push(`⚠️ Could not log in to Magister: ${e.message}`);
}

console.log(`🏫 School, ${dayName(tomorrow)}\n${out.join('\n')}`);
