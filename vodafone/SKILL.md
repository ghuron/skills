---
name: vodafone
description: "Read a Vodafone Netherlands mobile account (My Vodafone, vodafone.nl, VodafoneZiggo): subscriptions per phone number with plan, contract end date, SIM card and PUK code; bundles left this period (data, minutes, SMS, EU roaming and daily allowances) with usage and out-of-bundle costs; invoices with amounts, due dates and PDF download, an invoice's breakdown per number, and its billed calls, data sessions and texts. Use when the user asks about their Vodafone bill, mobile data or minutes left, phone usage or costs per number, a PUK code, contract end date, or whether to change or cancel a Vodafone subscription."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to www.vodafone.nl. Env: VODAFONE_USERNAME (the My Vodafone login, usually an email address) and VODAFONE_PASSWORD, from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node vodafone.mjs account                                # online account, billing customers, contact details
node vodafone.mjs products                               # subscriptions: number, productId, plan, status
node vodafone.mjs product <number>                       # contract start/end, SIM (ICCID, state, PUK)
node vodafone.mjs usage [number]                         # current period: bundles, daily allowances, usage; all numbers by default
node vodafone.mjs invoices                               # invoices, newest first, with open balance and payment method
node vodafone.mjs invoice <invoiceNumber>                # breakdown: subscriptions, usage charges, total per number
node vodafone.mjs pdf <invoiceNumber> [file.pdf]         # download the invoice PDF (default <invoiceNumber>.pdf)
node vodafone.mjs events <invoiceNumber> <number> [voice|data|sms]
                                                         # billed calls, data sessions and texts, oldest first
```

`<number>` is a phone number in any notation (`0612345678`, `+31612345678`) or a `productId`
from `products`. Every command prints JSON; none changes the account.

# Auth

Logs in with `VODAFONE_USERNAME` and `VODAFONE_PASSWORD` on every run; there is no session to keep.
A wrong password fails with "Vodafone rejected …" and is not retried, because repeated failures lock
the account. Two-factor login is not supported.

# Output notes

Money is EUR including VAT, except `cost` in `events`, which excludes VAT (as Vodafone shows it).
Data is in MB (1024 KB), voice in minutes (`events`: seconds), texts as a count.

`usage` covers what is not invoiced yet: since the end of the last invoice's `usagePeriod`.
`bundles` are the period's allowances; unlimited ones have `total`/`remaining` null. `daily` are
today's per-day allowances: Unlimited plans get their NL data per day, and roaming add-ons such as
"Alles in 1 op Reis" give minutes, texts and MB per day abroad. `usage` sums events per kind, with
`cost` the out-of-bundle charge; `lastEvent` is the newest event counted.

`invoices`: `usagePeriod` is the month whose usage is billed; subscriptions are billed a month
ahead (`invoice` → `subscriptions.period`). `due` is what's still unpaid, `openBalance` the sum.
`perNumber` totals add up to the invoice `total`.

`events` lists one number's records on one invoice. `bundle` is `in`, `partly` or `outside` the
bundle; `from` is the country the phone was in.
