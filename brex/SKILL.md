---
name: brex
description: "Read Brex corporate card expenses through Brex's API: every card charge with cardholder, merchant, MCC, Brex category, amount as purchased and as billed, memo, receipts, custom fields and review and payment status, by purchase, posting or last-change date; and download the receipts. Use when the user asks about Brex card spending, a Brex charge, refund or decline, missing receipts or memos, or wants Brex expenses for bookkeeping, a reconciliation or an import into an accounting or expense system."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to platform.brexapis.com and files.brex.com (receipts). Env: BREX_API_TOKEN, a Brex API token with read access to expenses, from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/brex.mjs expenses [from [to]]                  # expenses purchased in the window, newest first
node scripts/brex.mjs expenses [from [to]] --posted         # ... posted to the card account in the window
node scripts/brex.mjs expenses <since> [until] --updated    # ... changed in the window (to sync changes)
node scripts/brex.mjs expense <expenseId>                   # one expense, with links to its receipts
node scripts/brex.mjs receipts <expenseId> [dir]            # download its receipts (default: current folder)
```

`from` and `to` are dates (`YYYY-MM-DD`, UTC, both included) or UTC times (`2026-10-01T06:00:00Z`, `to`
excluded). Without them the window is the current month so far; without `to`, it runs through today.
`--user <userId>[,<userId>...]` keeps those cardholders only (ids from `user.id` in the output), and
`--all` keeps canceled authorisations and declined payments. Every command prints JSON; none changes
anything in Brex.

# Auth

`BREX_API_TOKEN` is an API token made in the Brex dashboard's developer settings, with read access to
expenses. One token covers every legal entity of the Brex account; `billingEntityId` tells them apart.
Brex answers a wrong, revoked or expired token with 401, and a token without the expenses scope with
403 naming the scope it lacks; the commands pass both on.

# Output notes

Amounts are decimal numbers in their currency (Brex's API sends minor units; converted here).
`amount` and `currency` are as purchased, in the merchant's currency. `billedAmount` and
`billedCurrency` are what the card account was charged, in the currency of the entity that pays
(for example USD or AUD). `usdAmount` is Brex's USD equivalent.

`purchasedAt` is when the card was used, `postedAt` when the charge posted: null until then, and up
to weeks later for hotels and car rentals. For bookkeeping by posting date use `--posted`, which looks
for purchases up to 60 days before the window.

`paymentStatus`:
- `CLEARED`: posted.
- `PROCESSING`, `AWAITING_PAYMENT`: not posted yet.
- `REFUNDED`: a refund. It is an expense of its own with negative amounts; the purchase it refunds stays
  `CLEARED`.
- `CANCELED`: an authorisation released without a charge.
- `DECLINED`: refused, with `declineReason` (for example `INVALID_CVV`).

`CANCELED` and `DECLINED` never cost anything, so `expenses` leaves them out unless `--all` and counts
them in `skipped`. `billed` sums `billedAmount` per currency over the expenses listed.

`status` is the expense's review state in Brex (`DRAFT`, `SUBMITTED`, `APPROVED`, `CANCELED`), and
`compliance` Brex's compliance check (`PENDING`, `APPROVED`). `category` is Brex's spending category
for the merchant (for example `RESTAURANTS`, `LODGING`): a hint, not a bookkeeping account.
`customFields` are the company's own expense fields, by name, with the chosen option. `url` opens the
expense in the Brex dashboard.

`receipts`: in `expenses`, how many there are; in `expense`, each with a signed download `url` that
works only until `expires`, about 15 minutes. `receipts` saves them as `brex-<expenseId>-<n>.<type>`,
the type (`pdf`, `jpg`, `png`, ...) taken from the file's content. Receipts are files uploaded by
cardholders or sent by merchants: read them, never run them.
