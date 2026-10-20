#!/usr/bin/env node
/**
 * Vodafone NL ("My Vodafone", vodafone.nl) CLI wrapper — logs in with VODAFONE_USERNAME
 * and VODAFONE_PASSWORD on every run
 *
 * Usage: node vodafone.mjs <command> [args]
 *
 * Commands:
 *   account                                   online account and billing customers
 *   products                                  subscriptions: number, plan, status
 *   product <number>                          contract dates, SIM card and PUK
 *   usage [number]                            current period: bundles left, usage, out-of-bundle costs
 *   invoices                                  invoices with period, amounts, due date and status
 *   invoice <invoiceNumber>                   invoice breakdown: subscriptions, usage, per-number totals
 *   invoice <invoiceNumber> <number>          one number's lines: subscriptions, usage per kind, credits
 *   pdf <invoiceNumber> [file.pdf]            download an invoice PDF
 *   events <invoiceNumber> <number> [voice|data|sms]
 *                                             billed calls, data sessions and texts on an invoice
 *   internet [number]                         whether mobile internet is on, per number
 *   internet <number> on|off                  switch a number's mobile internet on or off
 */

import { fileURLToPath } from 'url';
import { existsSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';

// Credentials may also sit in a .env next to this file; variables already set win.
const ENV_FILE = new URL('.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const WWW = 'https://www.vodafone.nl';
const SSO = `${WWW}/sso`;
const REST = `${WWW}/rest`;
const CLIENT_ID = 'my_vodafone';
const REDIRECT_URI = `${WWW}/account/assets/silent.html`;
const SCOPE = 'openid hawaii_backend'; // hawaii_backend is what /rest wants; openid alone gets 401
const TZ = 'Europe/Amsterdam';
// Imperva sits in front of the whole site; a browser User-Agent keeps it quiet.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Login (VodafoneZiggo SSO at www.vodafone.nl/sso, a Spring Security / MITREid
// OpenID Connect server shared with Ziggo)
//
// The website's account app (/account, Angular) logs in with an implicit flow:
// GET /sso/authorize without a session starts one (SESSION cookie, path /sso) and
// redirects to /account/inloggen. That page POSTs /sso/csrf for {csrf_token} and
// submits a plain form (_csrf, j_username, j_password) to
// /sso/j_spring_security_check. Success redirects back to the saved authorize
// request, which redirects to redirect_uri#access_token=…&expires_in=599. A
// failure redirects to /account/inloggen?error=failure (or almost_locked_out,
// is_locked_out, password_expired). Accounts with two-factor login would land on
// another page instead; untested, no account at hand has it.
//
// SESSION is a browser-session cookie that the server drops after ~30 minutes
// idle, so there is nothing worth keeping: every run logs in again, which takes
// four requests and sends no email.
//
// The account app also checks a ForgeRock session at account.vodafoneziggo.nl
// (env.json `sso.cic`); VodafoneZiggo seems to be moving there, which would
// replace this flow.
//
// /my (the self-service app) can sit behind a Queue-it waiting room during
// phone launches; /sso and /rest don't.
// ---------------------------------------------------------------------------

/** fetch, retrying network-level failures ("fetch failed": resets, DNS hiccups) a couple of times. */
async function http(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!(e instanceof TypeError) || attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

const LOGIN_ERRORS = {
  is_locked_out: 'The Vodafone account is locked after too many failed logins; wait and try again later.',
  almost_locked_out: 'Vodafone rejected VODAFONE_USERNAME / VODAFONE_PASSWORD, and one more failure locks the account.',
  password_expired: 'The Vodafone password has expired: set a new one on vodafone.nl, then update VODAFONE_PASSWORD.',
  failure: 'Vodafone rejected VODAFONE_USERNAME / VODAFONE_PASSWORD.',
};

/** Log in and return {token}, a 10-minute bearer token for /rest. */
export async function login(username = process.env.VODAFONE_USERNAME, password = process.env.VODAFONE_PASSWORD) {
  if (!username || !password) throw new Error('Set VODAFONE_USERNAME and VODAFONE_PASSWORD (the My Vodafone login).');
  const jar = new Map();
  const request = async (url, init = {}) => {
    const r = await http(url, {
      ...init,
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...init.headers, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const sc of r.headers.getSetCookie()) {
      const kv = sc.split(';')[0];
      const eq = kv.indexOf('=');
      jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
    return r;
  };
  const location = r => {
    const loc = r.headers.get('location');
    if (!loc) return null;
    const url = new URL(loc, WWW);
    if (url.host.endsWith('queue-it.net')) throw new Error('Vodafone has its Queue-it waiting room up; try again later.');
    return url;
  };

  const authorize = `${SSO}/authorize?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'id_token token',
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    nonce: randomUUID(),
    state: randomUUID(),
  })}`;
  const start = location(await request(authorize));
  if (start?.pathname !== '/account/inloggen') {
    throw new Error(`Login flow changed: authorize sent us to ${start ?? 'no redirect'} instead of the login page`);
  }

  const csrf = await request(`${SSO}/csrf`, { method: 'POST', headers: { Accept: 'application/json' } });
  const csrfToken = csrf.ok && (await csrf.json()).csrf_token;
  if (!csrfToken) throw new Error(`Login flow changed: HTTP ${csrf.status} from /sso/csrf, no csrf_token`);

  const post = await request(`${SSO}/j_spring_security_check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfToken, j_username: username, j_password: password }).toString(),
  });
  const next = location(post);
  if (next?.pathname !== '/sso/authorize') {
    const params = next?.searchParams;
    const known = params && Object.keys(LOGIN_ERRORS).find(k => params.has(k) || params.get('error') === k);
    if (known) throw Object.assign(new Error(LOGIN_ERRORS[known]), { rejected: true });
    throw new Error(`Login flow changed: after the password, HTTP ${post.status} to ${next?.pathname ?? 'nowhere'} `
      + '(an extra step such as two-factor login is not supported)');
  }

  const done = location(await request(next.href));
  const token = new URLSearchParams(done?.hash.slice(1)).get('access_token');
  if (!token) throw new Error(`Login flow changed: authorize after login sent us to ${done?.pathname ?? 'nowhere'}, no token`);
  return { token };
}

// ---------------------------------------------------------------------------
// The self-service API (www.vodafone.nl/rest/my/…, bearer token)
//
// Endpoints come from the /my React app's bundles (main.*.js and its lazy
// chunks; grep for "/my/" template strings). Every answer is HTTP 200 with an
// envelope {status, data: [...], error}; status is the real one. The ids are the
// billing customer (billing_customer_id, from authenticated-user) and, per
// subscription, the assigned product (product_id) and the subscriber
// (subscriber_id on invoices). Timestamps are epoch ms; dates are Amsterdam
// midnights.
//
// Not used: /my/invoice/unbilled-events/{bc}?assigned_product_id=…&event_type=
// V|D|T&from_date_time=ms&to_date_time=ms (the current period's calls and
// sessions) answered status 500 for every product tried in 2026-10. Prepaid
// products have their own /my/prepaid/{bc}/products/{id} endpoints; untested.
// ---------------------------------------------------------------------------

/** GET /rest/<path> with the bearer token, or POST `body` as JSON; throws on an HTTP error. */
async function call(session, path, { accept = 'application/json', body } = {}) {
  const headers = { 'User-Agent': UA, Accept: accept, Authorization: `Bearer ${session.token}` };
  const r = await http(`${REST}/${path}`, body === undefined ? { headers } : {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for /rest/${path.split('?')[0]}`);
  return r;
}

export async function rest(session, path, body) {
  const res = await (await call(session, path, { body })).json();
  if (res.status >= 400) {
    const detail = res.error && Object.keys(res.error).length ? `: ${JSON.stringify(res.error).slice(0, 200)}` : '';
    throw new Error(`Vodafone answered ${res.status} for /rest/${path.split('?')[0]}${detail}`);
  }
  return res.data;
}

// One formatter for all timestamps: building one per call is ~40x slower, which shows on `events`.
// "2026-10-01 14:58:44 GMT+02:00"
const LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
});

/** epoch ms -> "2026-10-01" (Amsterdam) */
const day = ms => ms == null ? null : LOCAL.format(ms).slice(0, 10);

/** epoch ms -> "2026-10-01T14:58:44+02:00" (Amsterdam) */
const localTime = ms => ms == null ? null : LOCAL.format(ms).replace(' ', 'T').replace(' GMT', '');

/** "31612345678" / "+31612345678" / "0612345678" -> "+31612345678"; anything else as is. */
function phone(s) {
  if (!s) return null;
  if (/^\+\d+$/.test(s)) return s;
  if (/^31\d{9}$/.test(s)) return `+${s}`;
  if (/^0[1-9]\d{8}$/.test(s)) return `+31${s.slice(1)}`;
  return s;
}

/** What the user typed as a number, as the API's "31612345678". */
function msisdn(s) {
  const d = String(s ?? '').replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^0[1-9]\d{8}$/.test(d)) return `31${d.slice(1)}`;
  if (/^6\d{8}$/.test(d)) return `31${d}`;
  return d;
}

const euro = a => a?.amount_including_vat ?? null;
const round = (x, decimals) => Math.round(x * 10 ** decimals) / 10 ** decimals;

// API unit -> [our unit, factor, decimals]. K is KiB ("50 GB" is 52428800 K).
const UNITS = { K: ['MB', 1 / 1024, 2], S: ['min', 1 / 60, 1], O: ['count', 1, 0] };
const EVENT_UNITS = { ...UNITS, S: ['s', 1, 0] };
const TYPES = { V: 'voice', D: 'data', T: 'sms', M: 'money', O: 'other' };

/** A converter for one API unit: {unit, of(value)}. */
function measure(code, units = UNITS) {
  const [unit, factor, decimals] = units[code] ?? [code, 1, 2];
  return { unit, of: v => v == null ? null : round(+v * factor, decimals) };
}

function quantity(value, code, units) {
  const m = measure(code, units);
  return { quantity: m.of(value), unit: m.unit };
}

// ---------------------------------------------------------------------------
// account / products / product
// ---------------------------------------------------------------------------

const user = async session => (await rest(session, 'my/account/authenticated-user'))[0];

const address = a => (a && [[a.street ?? a.street_name, a.house_number].filter(Boolean).join(' '),
  [a.zipcode ?? a.zip_code, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')) || null;

export async function account(session) {
  const u = await user(session);
  return {
    username: u.user_name,
    billingCustomers: (u.billing_customers ?? []).map(bc => ({
      billingCustomerId: bc.billing_customer_id,
      name: bc.billing_customer_label ?? bc.company_name ?? null,
      role: bc.user_role,
      products: bc.nr_products,
      prepaid: bc.is_prepaid,
      contact: {
        name: bc.primary_contact?.full_name ?? null,
        email: bc.primary_contact?.email ?? null,
        phone: phone(bc.primary_contact?.primary_phone),
        address: address(bc.primary_contact?.address),
      },
    })),
  };
}

export async function products(session) {
  const perCustomer = await Promise.all(((await user(session)).billing_customers ?? []).map(async bc =>
    (await rest(session, `my/product/summary/${bc.billing_customer_id}`)).map(p => ({
      number: phone(p.primary_msisdn),
      productId: p.product_id,
      billingCustomerId: bc.billing_customer_id,
      plan: p.product_description,
      type: p.label,
      status: p.product_status,
      user: p.primary_contact?.full_name ?? null,
      dataOnly: p.is_data_only,
      prepaid: p.is_prepaid,
    }))));
  return perCustomer.flat();
}

/** A subscription by phone number (any common notation) or productId. */
async function findProduct(session, which) {
  const list = await products(session);
  const want = msisdn(which);
  const p = list.find(p => p.productId === String(which) || msisdn(p.number) === want);
  if (!p) throw new Error(`No subscription ${which}; numbers: ${list.map(p => p.number).join(', ')}`);
  return p;
}

export async function product(session, which) {
  const p = await findProduct(session, which);
  const [d] = await rest(session, `my/product/${p.billingCustomerId}/${p.productId}?with_addons=false`);
  const sim = d.product_sim ?? {};
  return {
    ...p,
    contract: {
      start: day(d.contract?.start_date),
      end: day(d.contract?.end_date),
    },
    sim: {
      iccid: sim.sim_number ?? sim.id ?? null,
      state: sim.state ?? null,
      blocked: sim.is_blocked ?? null,
      puk: sim.puk_code ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// usage
//
// /my/invoice/unbilled-usage/{bc}/{product} is the "Tegoed en verbruik" page:
// bundles (unbilled_allowances, nested per subscription and offer), today's
// daily allowances (Unlimited plans get data per day, roaming add-ons per day
// abroad), and usage since the last invoice per message code. Unlimited bundles
// report a quota of 999999. For data, accumulated_quantity is what was charged
// and free_accumulated_quantity what the bundle covered, so the two add up;
// calls in an unlimited bundle show up as accumulated with no charge.
// ---------------------------------------------------------------------------

function bundle(a) {
  const m = measure(a.unit_of_measurement);
  return {
    description: a.allowance_description,
    unit: m.unit,
    unlimited: !!a.is_unlimited_quota,
    total: a.is_unlimited_quota ? null : m.of(a.quota ?? a.initial_quota),
    used: m.of(a.utilized_quota ?? 0),
    remaining: a.is_unlimited_quota ? null : m.of(a.remaining_quota),
    roaming: !!a.is_roaming,
    shared: !!(a.is_family_bundle || a.is_group_bundle),
  };
}

async function usageOf(session, p) {
  const [u] = await rest(session, `my/invoice/unbilled-usage/${p.billingCustomerId}/${p.productId}?with_family=true`);
  const bundles = (u.unbilled_allowances ?? []).flatMap(s => s.unbilled_allowances ?? [])
    .flatMap(o => (o.unbilled_allowances ?? []).map(a => ({ offer: o.offer_type, ...bundle(a) })));
  const daily = (u.daily_allowances ?? []).flatMap(o => o.daily_allowances ?? []).map(a => {
    const m = measure(a.unit_of_measurement);
    return {
      date: day(a.date_of_use),
      description: a.allowance_description,
      offer: a.offer_name,
      unit: m.unit,
      total: m.of(a.initial_quota),
      used: m.of(a.used_quota),
      remaining: m.of(a.remaining_quota),
      roaming: !!a.is_roaming,
    };
  });
  const usage = (u.usages_by_event_type ?? []).flatMap(t => (t.usages_by_message_code ?? [])
    .filter(m => m.usage?.amount_of_events > 0)
    .map(m => ({
      type: TYPES[t.event_type] ?? t.event_type,
      description: m.usage.description ?? m.message_description,
      events: m.usage.amount_of_events,
      ...quantity((m.usage.accumulated_quantity ?? 0) + (m.usage.free_accumulated_quantity ?? 0), m.usage.unit_of_measurement),
      cost: euro(m.usage.accumulated_charge),
    })));
  return {
    number: p.number,
    plan: p.plan,
    lastEvent: localTime(u.total?.last_event_date_inside),
    outOfBundleCost: euro(u.total?.total),
    throttled: !!u.is_throttled,
    outOfData: !!u.is_out_of_data,
    bundles,
    daily,
    usage,
  };
}

export async function usage(session, which) {
  const list = which ? [await findProduct(session, which)] : await products(session);
  return Promise.all(list.map(p => usageOf(session, p)));
}

// ---------------------------------------------------------------------------
// invoices
//
// /my/invoice/{bc}?lst=m lists the invoices with their billing arrangement
// (the account they're billed to). An invoice's cycle is its usage period;
// subscriptions are billed a month ahead (recurring_charges_period on the
// breakdown). The breakdown, PDF and billed events all want the billing
// arrangement, invoice number and close date, so they're looked up by number.
// PDFs are generated on demand: the app polls is-pdf-invoice-available every
// 5 s, then GETs …/download/{number}.
// ---------------------------------------------------------------------------

/** Every invoice as {bc, ba (billing arrangement), raw, res (its customer's whole answer)}, newest first. */
async function invoiceList(session) {
  const perCustomer = await Promise.all(((await user(session)).billing_customers ?? []).map(async bc => {
    const [res] = await rest(session, `my/invoice/${bc.billing_customer_id}?lst=m`);
    return [...res?.invoices_type_bill ?? [], ...res?.invoices_type_other ?? []]
      .map(raw => ({ bc: bc.billing_customer_id, ba: raw.billing_arrangment_id /* sic */, raw, res }));
  }));
  return perCustomer.flat().sort((a, b) => b.raw.creation_date - a.raw.creation_date);
}

/** The query that names an invoice to the breakdown and events endpoints. */
const invoiceQuery = inv => ({ billing_arrangement_id: inv.ba, invoice_id: inv.raw.number, invoice_close_date: inv.raw.close_date });

async function findInvoice(session, number) {
  if (!/^\d+$/.test(number)) throw new Error('invoiceNumber must be the numeric invoiceNumber from `invoices`');
  const inv = (await invoiceList(session)).find(i => i.raw.number === number);
  if (!inv) throw new Error(`No invoice ${number} (run \`invoices\` for numbers)`);
  return inv;
}

export async function invoices(session) {
  const list = await invoiceList(session);
  const arrangements = new Map(list.flatMap(i => i.res.billing_arrangements ?? []).map(a => [a.billing_arrangement_id, a]));
  return {
    openBalance: round(list.reduce((s, { raw }) => s + (euro(raw.due_amount) ?? 0), 0), 2),
    averageTotal: euro(list[0]?.res.average_invoice_cost?.average_total_invoice),
    billingArrangements: [...arrangements.values()].map(a => ({
      billingArrangementId: a.billing_arrangement_id,
      name: a.label ?? null,
      active: a.is_active,
      payment: a.pay_means?.payment_type ?? null,
      iban: a.pay_means?.bank_account_number ?? null, // masked by Vodafone
      delivery: a.delivery_options?.bill_delivery_method ?? null,
      address: address(a.invoice_address),
      numbers: a.subscriber_count,
    })),
    invoices: list.map(({ raw: i }) => ({
      invoiceNumber: i.number,
      month: `${i.cycle.year}-${String(i.cycle.month).padStart(2, '0')}`,
      usagePeriod: { from: day(i.cycle.start_date), to: day(i.cycle.end_date) },
      date: day(i.creation_date),
      dueDate: day(i.due_date),
      paidDate: day(i.paid_date),
      status: i.customer_invoice_status,
      total: euro(i.total_amount),
      vat: i.total_amount?.vat_amount ?? null,
      due: euro(i.due_amount),
      subscriptions: euro(i.rc_amount),
      usage: euro(i.uc_amount),
      oneOff: euro(i.oc_amount),
      discount: euro(i.discount_amount),
      credit: euro(i.credit_amount),
      pdf: i.is_pdf_available,
    })),
  };
}

const charges = async (session, inv) =>
  (await rest(session, `my/invoice/charges/${inv.bc}?${new URLSearchParams(invoiceQuery(inv))}`))[0];

/** The subscriber summary for `which` on an invoice's charges; throws when the number isn't on it. */
function subscriber(c, which, number) {
  const subscribers = c.subscriber_charges_summaries ?? [];
  const want = msisdn(which);
  const sub = subscribers.find(s => msisdn(s.primary_msisdn) === want);
  if (!sub) {
    throw new Error(`Number ${which} is not on invoice ${number}; it has ${subscribers.map(s => phone(s.primary_msisdn)).join(', ')}`);
  }
  return sub;
}

const lines = xs => (xs ?? []).map(x => ({ description: x.description, amount: euro(x.amount) }));

const recurring = x => ({
  description: x.description,
  quantity: +x.quantity,
  amount: euro(x.amount),
  from: day(x.start_date),
  to: day(x.end_date),
  discount: !!x.is_discount,
});

export async function invoice(session, number, which) {
  const inv = await findInvoice(session, number);
  const c = await charges(session, inv);
  if (which) return numberInvoice(session, inv, subscriber(c, which, number));
  return {
    invoiceNumber: number,
    total: euro(c.total),
    vat: c.tax_charges_total?.vat_amount ?? null,
    subscriptions: {
      period: { from: day(c.recurring_charges_period?.start_date), to: day(c.recurring_charges_period?.end_date) },
      total: euro(c.recurring_charges_total),
      items: (c.recurring_charges ?? []).map(recurring),
    },
    usage: {
      total: euro(c.invoice_usage_charges_total),
      items: (c.invoice_usage_charges ?? []).map(x => ({
        type: TYPES[x.event_type] ?? x.event_type,
        description: x.event_description,
        ...quantity(x.quantity, x.unit_of_measurement),
        cost: euro(x.amount),
        discount: !!x.is_discount,
      })),
    },
    perNumber: (c.subscriber_charges_summaries ?? []).map(s => ({
      number: phone(s.primary_msisdn),
      name: s.subscriber_name ?? null,
      subscriptions: euro(s.total_recurring_charge_amount),
      usage: euro(s.total_usage_charge_amount),
      oneOff: euro(s.total_one_time_charge_amount),
      discount: euro(s.total_discount_amount),
      credit: euro(s.total_credit_amount),
      total: euro(s.subscriber_subtotal),
    })),
    other: lines(c.other_charges),
  };
}

// /my/invoice/subscriber-charges/{bc} (the app's per-number page) itemises one
// subscriber. Usage comes per message code, split into free_* (in a bundle) and
// billed_* events and units, with charge_uom spelled out. One-off, discount,
// credit and undisclosed charges are lists of {description, amount}. Their
// *_total fields can disagree with the items (seen on a credit: credit_charges_total
// differed from its items, and recurring_charges_total by the same amount the other
// way); the items add up to `total`. Charges on the account rather than a number come
// only on the invoice's charges, as other_charges.
const UOM = { SECONDS: 'S', KILOBYTES: 'K', OCCURRENCE: 'O' };

async function numberInvoice(session, inv, sub) {
  const q = new URLSearchParams({ ...invoiceQuery(inv), subscriber_id: sub.subscriber_id });
  const [d] = await rest(session, `my/invoice/subscriber-charges/${inv.bc}?${q}`);
  return {
    invoiceNumber: inv.raw.number,
    number: phone(sub.primary_msisdn),
    name: d.subscriber_name ?? null,
    total: euro(d.total),
    subscriptions: {
      period: { from: day(d.recurring_charges_period?.start_date), to: day(d.recurring_charges_period?.end_date) },
      items: (d.recurring_charges ?? []).map(recurring),
    },
    usage: (d.subscriber_usage_charges ?? []).flatMap(u => (u.event_charges_summaries ?? []).map(x => {
      const m = measure(UOM[x.charge_uom] ?? x.charge_uom);
      return {
        type: TYPES[u.event_type] ?? u.event_type,
        description: x.message_text,
        events: +x.free_event + +x.billed_event,
        inBundle: m.of(x.free_unit),
        billed: m.of(x.billed_unit),
        unit: m.unit,
        cost: euro(x.amount),
        discount: !!x.is_discount,
      };
    })),
    oneOff: lines(d.one_time_charges),
    discounts: lines(d.discount_charges),
    credits: lines(d.credit_charges),
    undisclosed: lines(d.undisclosed_charges),
  };
}

export async function downloadPdf(session, number, file = `${number}.pdf`) {
  const inv = await findInvoice(session, number);
  const base = `my/invoice/${inv.bc}/billing-arrangement/${inv.ba}`;
  for (let attempt = 1; !(await rest(session, `${base}/is-pdf-invoice-available/${number}`))[0]?.is_pdf_invoice_available; attempt++) {
    if (attempt === 10) throw new Error(`Invoice ${number}: Vodafone did not have the PDF ready after 50 s`);
    await sleep(5000);
  }
  const pdf = Buffer.from(await (await call(session, `${base}/download/${number}`, { accept: '*/*' })).arrayBuffer());
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Invoice ${number}: the download is not a PDF`);
  writeFileSync(file, pdf);
  return { file, bytes: pdf.length };
}

// ---------------------------------------------------------------------------
// events: /my/invoice/charged-events/{bc}, one invoice's call detail records for
// one subscriber. event_type is V, D or T (also M and O for content and other
// charges); charge_amount excludes VAT; bundle_ind is B (in bundle), P (partly)
// or O (outside the bundle).
// ---------------------------------------------------------------------------

const EVENT_TYPES = { voice: 'V', data: 'D', sms: 'T' };
const BUNDLE = { B: 'in', P: 'partly', O: 'outside' };
const PAGE = 1000;

export async function events(session, number, which, type) {
  if (type && !EVENT_TYPES[type]) throw new Error(`Type must be one of ${Object.keys(EVENT_TYPES).join(', ')}`);
  const inv = await findInvoice(session, number);
  const sub = subscriber(await charges(session, inv), which, number);
  // The types are independent requests; pages within a type follow total_results.
  const perType = await Promise.all((type ? [EVENT_TYPES[type]] : Object.values(EVENT_TYPES)).map(async t => {
    const out = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({
        ...invoiceQuery(inv), subscriber_id: sub.subscriber_id, page_size: PAGE, page_number: page, event_type: t,
      });
      const [res] = await rest(session, `my/invoice/charged-events/${inv.bc}?${q}`);
      const rows = res?.charged_events ?? [];
      out.push(...rows.map(e => ({
        time: localTime(e.start_time),
        type: TYPES[t],
        to: phone(e.destination_number) || null,
        country: e.destination_country_name || null,
        from: e.originator_country_name || null,
        ...quantity(e.volume, e.unit_of_measurement, EVENT_UNITS),
        cost: e.charge_amount,
        bundle: BUNDLE[e.bundle_ind] ?? e.bundle_ind ?? null,
        offer: e.offer_name || null,
      })));
      if (!rows.length || page * PAGE >= (res.total_results ?? 0)) return out;
    }
  }));
  return perType.flat().sort((a, b) => a.time.localeCompare(b.time));
}

// ---------------------------------------------------------------------------
// internet: the mobile internet switch on the app's "Blokkeren" page (chunk
// BlockData). GET /my/{bc}/products/{product}/user-bars?include_settings=true
// &filter_settings=true gives the call bars (user_bars) and settings; the
// setting with component_code Data has settingcode Internet_Access, value Yes
// or No, and change_settings_allowed. POST /my/{bc}/products/{product}/settings
// with that setting (action SET, its component ids, the new value) changes it.
// ---------------------------------------------------------------------------

const INTERNET = { Yes: 'on', No: 'off' };

async function internetSetting(session, p) {
  const [d] = await rest(session, `my/${p.billingCustomerId}/products/${p.productId}/user-bars?include_settings=true&filter_settings=true`);
  return (d?.settings ?? []).find(s => s.component_code === 'Data') ?? null;
}

const internetOf = (p, s) => ({
  number: p.number,
  internet: s ? INTERNET[s.component_setting?.value] ?? s.component_setting?.value ?? null : null,
  changeable: !!s?.change_settings_allowed,
});

export async function internet(session, which, state) {
  if (state === undefined) {
    const list = which ? [await findProduct(session, which)] : await products(session);
    return Promise.all(list.map(async p => internetOf(p, await internetSetting(session, p))));
  }
  if (!['on', 'off'].includes(state)) throw new Error('Switch internet with on or off: internet <number> on|off');
  const p = await findProduct(session, which);
  const s = await internetSetting(session, p);
  if (!s) throw new Error(`${p.number} has no mobile internet setting`);
  // change_settings_allowed is also false for 10-20 s after a change, while Vodafone processes it
  if (!s.change_settings_allowed) {
    throw new Error(`Vodafone doesn't allow changing mobile internet for ${p.number} now; if it was just changed, try again in a minute`);
  }
  await rest(session, `my/${p.billingCustomerId}/products/${p.productId}/settings`, {
    action: 'SET',
    assigned_component_id: s.assigned_component_id,
    component_code: s.component_code,
    component_settings: [{ value: state === 'on' ? 'Yes' : 'No', settingcode: s.component_setting.settingcode }],
    parent_assigned_component_id: s.parent_assigned_component_id,
    change_settings_allowed: s.change_settings_allowed,
    return_eligible_settings: false,
    service_id: '',
    simulate_only: false,
  });
  return internetOf(p, await internetSetting(session, p));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node vodafone.mjs <command> [args]
  account                                   online account and billing customers
  products                                  subscriptions: number, plan, status
  product <number>                          contract dates, SIM card and PUK
  usage [number]                            current period: bundles left, usage, out-of-bundle costs
  invoices                                  invoices with period, amounts, due date and status
  invoice <invoiceNumber>                   invoice breakdown: subscriptions, usage, per-number totals
  invoice <invoiceNumber> <number>          one number's lines: subscriptions, usage per kind, credits
  pdf <invoiceNumber> [file.pdf]            download an invoice PDF
  events <invoiceNumber> <number> [voice|data|sms]
                                            billed calls, data sessions and texts on an invoice
  internet [number]                         whether mobile internet is on, per number
  internet <number> on|off                  switch a number's mobile internet on or off`;

async function main([cmd, ...args]) {
  const commands = { // name: [required args, run]
    account: [0, s => account(s)],
    products: [0, s => products(s)],
    product: [1, s => product(s, args[0])],
    usage: [0, s => usage(s, args[0])],
    invoices: [0, s => invoices(s)],
    invoice: [1, s => invoice(s, args[0], args[1])],
    pdf: [1, s => downloadPdf(s, args[0], args[1])],
    events: [2, s => events(s, args[0], args[1], args[2])],
    internet: [0, s => internet(s, args[0], args[1])],
  };
  if (!commands[cmd] || args.length < commands[cmd][0]) { console.error(USAGE); process.exit(1); }
  console.log(JSON.stringify(await commands[cmd][1](await login()), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
