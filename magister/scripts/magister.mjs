#!/usr/bin/env node
/**
 * Magister CLI wrapper — reads credentials from environment variables:
 *   MAGISTER_HOST, MAGISTER_USER, MAGISTER_PASSWORD
 *
 * Usage: node scripts/magister.mjs <command> [args]   (commands: see USAGE below)
 */

import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';

// Credentials may also sit in a .env in the skill folder; variables already set win.
const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// Normalize host: strip protocol and trailing slash so it is just the FQDN
const HOST = (process.env.MAGISTER_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const USER = process.env.MAGISTER_USER;
const PASS = process.env.MAGISTER_PASSWORD;

// ---------------------------------------------------------------------------
// Token acquisition (OIDC implicit flow against accounts.magister.net)
// ---------------------------------------------------------------------------

export async function acquireToken(host, user, pass) {
  const rand = () => randomBytes(16).toString('base64url');

  const jar = new Map();

  function saveCookies(r) {
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const eq   = kv.indexOf('=');
      jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
  const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  async function follow(url, init = {}) {
    const r = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...init.headers, Cookie: cookies() },
    });
    saveCookies(r);
    const loc = r.headers.get('location');
    if (!loc) return r;
    const next = new URL(loc, url);
    if (next.pathname.endsWith('redirect_callback.html')) return r;
    return follow(next.href);
  }

  const qs = new URLSearchParams({
    client_id:     `M6-${host}`,
    state:         rand(),
    redirect_uri:  `https://${host}/oidc/redirect_callback.html`,
    response_type: 'id_token token',
    acr_values:    `tenant:${host}`,
    nonce:         rand(),
    scope:         'openid profile attendance.overview calendar.user grades.read',
  });

  const login     = await follow(`https://accounts.magister.net/connect/authorize?${qs}`);
  const sessionId = login.url.match(/sessionId=([a-f0-9A-F-]+)/)[1];
  const returnUrl = decodeURIComponent(login.url.match(/returnUrl=([^&]+)/)[1]);
  const xsrf      = decodeURIComponent(jar.get('XSRF-TOKEN') ?? '');

  const challenge = async (path, body) => {
    const r = await fetch(`https://accounts.magister.net/challenges/${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, Cookie: cookies() },
      body:    JSON.stringify({ sessionId, returnUrl, ...body }),
    });
    saveCookies(r);
    return r.json();
  };

  await challenge('username', { username: user });
  const { redirectURL } = await challenge('password', { password: pass });

  const r     = await follow(`https://accounts.magister.net${redirectURL}`);
  const token = new URLSearchParams(new URL(r.headers.get('location')).hash.slice(1)).get('access_token');
  if (!token) throw new Error('Token not found in OIDC redirect');
  return token;
}

// One login per process
let token;
const getToken = () => token ??= acquireToken(HOST, USER, PASS);

export async function apiGet(path) {
  const url = `https://${HOST}${path}`;
  const r   = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

/** POST a JSON body; the error message includes Magister's omschrijving. */
export async function apiPost(path, body) {
  const url = `https://${HOST}${path}`;
  const r   = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.parse(text).omschrijving ?? ''; } catch {}
    throw new Error(`HTTP ${r.status} for ${url}${detail && `: ${detail}`}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// CLI (only when run directly)
// ---------------------------------------------------------------------------

const toLocal = iso => new Date(iso).toLocaleString('sv', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
}).replace(' ', 'T');

// Dates are YYYY-MM-DD in Europe/Amsterdam
const today   = () => new Date().toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' });
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isWeekday = date => [1, 2, 3, 4, 5].includes(new Date(`${date}T12:00Z`).getUTCDay());

// Local midnight of `date` as a UTC ISO string, which is what the web app sends
const amsterdamMidnight = date => {
  const offset = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Amsterdam', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T00:00Z`))
    .find(p => p.type === 'timeZoneName').value.slice(3) || '+00:00';
  return new Date(`${date}T00:00:00${offset}`).toISOString();
};

// Homework and message bodies are HTML
const htmlToText = html => html
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|h\d)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  .trim();

// Afspraak.InfoType: huiswerk, proefwerk, tentamen, schriftelijke overhoring, mondelinge overhoring,
// informatie, aantekening
const INFO_TYPES = { 1: 'homework', 2: 'test', 3: 'exam', 4: 'quiz', 5: 'oral', 6: 'info', 7: 'note' };

const USAGE = 'Commands: students | schedule <id> <from> <to> | grades <id> [top] | infractions <id> <from> <to> | messages [top] | message <id> | report-sick <id> <date> [note]';

const commands = {
  async students() {
    const account = await apiGet('/api/account');
    const id      = account.Persoon?.Id;
    if (account.Groep?.[0]?.Naam === 'Leerling') {
      const aanmeldingen = await apiGet(`/api/leerlingen/${id}/aanmeldingen`);
      return aanmeldingen.items
        .filter(a => a.isHoofdAanmelding)
        .map(a => ({
          id,
          name:          `${account.Persoon.Roepnaam} ${account.Persoon.Achternaam}`.trim(),
          aanmelding_id: a.id,
        }));
    }
    const raw = await apiGet(`/api/ouders/${id}/kinderen`);
    return raw.items.map(c => ({
      id:            c.id,
      name:          `${c.roepnaam} ${c.achternaam}`.trim(),
      aanmelding_id: +((c.actieveAanmeldingen?.[0]?.links?.self?.href ?? '').split('/').at(-1)),
    }));
  },
  async schedule(id, from, to) {
    const raw = await apiGet(`/api/personen/${id}/afspraken?van=${from}&tot=${to}`);
    return raw.Items
      .filter(i => i.Status !== 5)
      .map(i => ({
        start:   toLocal(i.Start),
        end:     toLocal(i.Einde),
        subject: i.Vakken?.[0]?.Naam ?? i.Omschrijving,
        teacher: i.Docenten?.[0]?.Naam ?? null,
        room:    i.Lokatie ?? null,
        homework: i.InfoType || i.Inhoud ? {
          type: INFO_TYPES[i.InfoType] ?? null,
          text: htmlToText(i.Inhoud ?? ''),
          done: i.Afgerond,
        } : null,
      }));
  },
  async grades(id, top = '50') {
    const raw = await apiGet(`/api/aanmeldingen/${id}/cijfers?top=${top}`);
    return raw.items.map(g => ({
      subject:     g.kolom.naam,
      description: g.kolom.omschrijving,
      grade:       g.waarde,
      weight:      g.kolom.weegfactor,
      passing:     g.isVoldoende,
      type:        g.kolom.type,
    }));
  },
  async infractions(id, from, to) {
    const raw = await apiGet(`/api/personen/${id}/absenties?van=${from}&tot=${to}`);
    return raw.Items.map(i => ({
      type:    i.Omschrijving,
      code:    i.Code,
      excused: i.Geoorloofd,
      lesson:  i.Afspraak?.Omschrijving ?? null,
    }));
  },
  // Messages belong to the logged-in account, not to a student. The web app's messages page is a
  // separate Angular app at /magister-berichten/; folders with unread counts are at
  // /api/berichten/mappen/alle. Reading is GET-only: the web app marks a message read with a
  // separate PATCH /api/berichten/berichten, so these commands never change read status.
  async messages(top = '25') {
    const raw = await apiGet(`/api/berichten/postvakin/berichten?top=${top}&skip=0`);
    return raw.items.map(m => ({
      id:          m.id,
      subject:     m.onderwerp,
      from:        m.afzender?.naam ?? null,
      sent:        toLocal(m.verzondenOp),
      read:        m.isGelezen,
      priority:    m.heeftPrioriteit,
      attachments: m.heeftBijlagen,
    }));
  },
  async message(id) {
    if (!/^\d+$/.test(id ?? '')) throw new Error('Usage: message <id>');
    const m           = await apiGet(`/api/berichten/berichten/${id}`);
    const attachments = m.links?.bijlagen ? (await apiGet(m.links.bijlagen.href)).items : [];
    const names       = list => (list ?? []).map(r => r.weergavenaam);
    return {
      id:          m.id,
      subject:     m.onderwerp,
      from:        m.afzender?.naam ?? null,
      to:          names(m.ontvangers),
      cc:          names(m.kopieOntvangers),
      sent:        toLocal(m.verzondenOp),
      read:        m.isGelezen,
      priority:    m.heeftPrioriteit,
      body:        htmlToText(m.inhoud ?? ''),
      attachments: attachments.map(a => ({ name: a.naam, type: a.contentType, size: a.grootte })),
    };
  },
  // Mirrors the web app's "Ziek melden" (ziekmeldenController in its aanwezigheid chunk): parents
  // only, for today or tomorrow, weekdays only. The regular attendance.overview scope suffices.
  async 'report-sick'(id, date, note = '') {
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('Usage: report-sick <id> <YYYY-MM-DD> [note]');
    if (![today(), addDays(today(), 1)].includes(date) || !isWeekday(date)) {
      throw new Error(`Can only report sick for today or tomorrow, on a weekday (today is ${today()}).`);
    }
    if (note.length > 255) throw new Error('Note must be at most 255 characters.');
    // The school decides per student whether parents may report absence; the absenties
    // response carries the POST link only when it is allowed.
    const absences = await apiGet(`/api/personen/${id}/absenties?van=${date}&tot=${date}`);
    const link     = absences.Links?.find(l => l.Rel === 'absentiemelding')?.Href;
    if (!link) {
      throw new Error('Reporting sick is not available for this student (needs parent credentials, and the school must allow it).');
    }
    await apiPost(link, {
      begin:     amsterdamMidnight(date),
      einde:     amsterdamMidnight(addDays(date, 1)),
      opmerking: note.trim(),
    });
    return { reported: true, id: +id, date, note: note.trim() };
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fail = msg => { console.error(msg); process.exit(1); };
  if (!HOST || !USER || !PASS) fail('Set MAGISTER_HOST, MAGISTER_USER, MAGISTER_PASSWORD before running.');
  if (!HOST.endsWith('.magister.net') && HOST !== 'magister.net') fail('MAGISTER_HOST must be a *.magister.net domain.');
  if (!Object.hasOwn(commands, cmd)) fail(USAGE);
  commands[cmd](...rest).then(out => console.log(JSON.stringify(out)), e => fail(e.message));
}
