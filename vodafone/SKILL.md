---
name: vodafone
description: "Read a Vodafone Netherlands mobile account (My Vodafone, VodafoneZiggo): subscriptions, bundles and usage left, costs per number, invoices with PDF and call records, PUK and contract end date; switch mobile internet off or on per number. Use when the user asks about their Vodafone bill, data or minutes left, a number's usage or costs, a PUK code, their contract or whether to change it, or wants mobile data off or on for a phone (a child's, say)."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to www.vodafone.nl and account.vodafoneziggo.nl. Env: VODAFONE_USERNAME (the My Vodafone login, usually an email address) and VODAFONE_PASSWORD, from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/vodafone.mjs account                                # online account, billing customers, contact details
node scripts/vodafone.mjs products                               # subscriptions: number, productId, plan, status
node scripts/vodafone.mjs product <number>                       # contract start/end, SIM (ICCID, state, PUK)
node scripts/vodafone.mjs usage [number]                         # current period: bundles, daily allowances, usage; all numbers by default
node scripts/vodafone.mjs invoices                               # invoices, newest first, with open balance and payment method
node scripts/vodafone.mjs invoice <invoiceNumber>                # breakdown: subscriptions, usage charges, total per number
node scripts/vodafone.mjs invoice <invoiceNumber> <number>       # one number's lines: subscriptions, usage per kind, credits
node scripts/vodafone.mjs pdf <invoiceNumber> [file.pdf]         # download the invoice PDF (default <invoiceNumber>.pdf)
node scripts/vodafone.mjs events <invoiceNumber> <number> [voice|data|sms]
                                                                 # billed calls, data sessions and texts, oldest first
node scripts/vodafone.mjs internet [number]                      # whether mobile internet is on; all numbers by default
node scripts/vodafone.mjs internet <number> on|off               # switch a number's mobile internet on or off
```

`<number>` is a phone number in any notation (`0612345678`, `+31612345678`) or a `productId`
from `products`. Every command prints JSON. Only `internet <number> on|off` changes the account, so
run it only when the user asks.

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
`perNumber` totals plus `other` (charges on the account rather than a number, such as a VAT-free
"Overige kosten") add up to the invoice `total`.

`invoice <invoiceNumber> <number>` itemises one number, as the invoice PDF's detail pages do:
its subscription lines (pro rata ones when a plan changed mid-month), its `usage` per kind of call,
data or text with `events`, `inBundle` and `billed` quantities and the `cost`, and its `oneOff`,
`discounts`, `credits` and `undisclosed` charges. All the amounts add up to its `total`.

`events` lists one number's records on one invoice. `bundle` is `in`, `partly` or `outside` the
bundle; `from` is the country the phone was in.

`internet` is the "Mobiel internet" switch on the Blokkeren page: `off` blocks mobile data on the
network until it is switched back `on` (calls, texts and Wi-Fi keep working). A switch prints the
new state as Vodafone reports it. `changeable` is false for 10-20 seconds after a change,
while Vodafone processes it; switching again in that window fails with "try again in a minute".
