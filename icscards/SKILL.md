---
name: icscards
description: "Read an ICS credit card account (International Card Services, icscards.nl, which also issues the ABN AMRO, ANWB and Bijenkorf credit cards): balance, credit limit and spending left, pending payments, the last statement and its direct debit, transactions per statement period with merchant category and foreign amounts, and monthly statement PDFs. Use when the user asks about their credit card balance, bill or limit, what they spent with the credit card, a card transaction, or the monthly ICS statement (rekeningoverzicht)."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to www.icscards.nl and argus.arcot.com (a device id at login). `login` needs the cardholder to approve it in the ICS app on their phone. Env: ICSCARDS_USERNAME and ICSCARDS_PASSWORD (the icscards.nl login, for `login`) and ICSCARDS_SESSION (set by `login`), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/icscards.mjs login                              # log in, approved in the ICS app; saves the session
node scripts/icscards.mjs account                            # cards, limit, balance, spending left, last statement
node scripts/icscards.mjs statements                         # statement periods with opening and closing balance
node scripts/icscards.mjs statement <period> [file.pdf]      # download a statement PDF (default ics-<period>.pdf)
node scripts/icscards.mjs transactions [period [untilPeriod]]
                                                     # transactions, newest first; default the current period
```

Periods are `YYYY-MM`, as listed by `statements`. Add `--account <accountNumber>` to use an account
other than the default one; `account` lists them in `otherAccounts`. Every command prints JSON; none
changes the account.

# Auth

ICS asks for approval in the ICS app on every login. Before running `login`, tell the user to approve
the request the ICS app is about to show on their phone. `login` waits up to 5 minutes, so run it with
a timeout of at least 6 minutes or in the background. It saves the session as `ICSCARDS_SESSION` in
the skill's `.env`. The session ends after a few minutes without use (less than four), so log in
right before the work and run the commands back to back. Once the session has ended, commands fail
with "The ICS session has expired: run `node scripts/icscards.mjs login`". Ask the user before
logging in again, since each login needs their phone.

A wrong password isn't retried: five failures in a row block the login, so fix the credentials first.
Accounts that log in with an SMS code instead of the app aren't supported.

# Output notes

Amounts are in euros.

`account`: `balance` is what's owed now, `pending` is card payments authorised but not yet booked, and
`available` is `creditLimit` minus both. `lastStatement` is the last monthly statement: `amountDue`,
what's left of it (`remainingDue`), and the `directDebitDate` on which ICS collects it from `iban`
(masked). `payPercentage` is the share of the statement collected each month.

`statements`: a statement period runs for a month between fixed days (for example the 8th to the 7th)
and is named after the month it ends in. `openingBalance` and `closingBalance` are what was owed at its start and end. The
`current` period has no closing balance or PDF yet.

`transactions`: without a period, the current period, including `pending` authorisations. A range
of periods comes in one list. `amount` is positive for spending, negative for refunds and payments.
The `payment` rows are ICS collecting the previous statement ("GEINCASSEERD VORIG SALDO"). For closed
periods, `openingBalance` + `spent` + `paid` = `closingBalance`. `originalAmount` and
`originalCurrency` appear for payments in another currency. `category` is the merchant category.
`purchase` is `online`, `cash` (ATM) or null. `date` is when the card was used, which can fall before
the period's `from` when the merchant booked the payment late.
