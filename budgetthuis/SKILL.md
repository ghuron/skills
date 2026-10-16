---
name: budgetthuis
description: "Read a Budget Thuis energy account (Budget Energie, budgetthuis.nl 'MijnBudget', Dutch electricity and gas supplier): contracts, tariffs per kWh and m³ with energy tax and fixed monthly costs, contract end date and exit fee, the monthly instalment (termijnbedrag) and Budget Thuis's advice, invoices with open balance and PDF download, and hourly to monthly electricity, feed-in and gas usage with costs. Use when the user asks about their energy bill, energy prices or contract, gas or electricity consumption (also per hour or time of day), the termijnbedrag, or whether to renew or switch energy supplier."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to mijn.budgetthuis.nl, accounts.budgetthuis.nl, api.budgetthuis.nl and app.api.nutsservices.nl (the Budget Thuis app's backend). Credentials: BUDGETTHUIS_LOGIN and BUDGETTHUIS_PASSWORD (the MijnBudget account), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node budgetthuis.mjs account                          # customer number, name, address (contact and bank details masked)
node budgetthuis.mjs contracts                        # contractId, status, start date, duration, address
node budgetthuis.mjs tariffs                          # contract terms, tariffs, renewal offer, exit fee
node budgetthuis.mjs termijnbedrag                    # monthly instalment, advice, allowed range
node budgetthuis.mjs invoices                         # invoices, newest first, with open balance
node budgetthuis.mjs invoice <invoiceId> [file.pdf]   # download an invoice PDF (default <invoiceId>.pdf)
node budgetthuis.mjs usage <from> <to> [hour|day|week|month] [contractId]
                                                      # usage and costs; dates YYYY-MM-DD, inclusive; default day
```

Every command prints JSON; none changes the account.

# Output notes

`tariffs`: `supply` is Budget Thuis's own price, `total` adds energy tax. `cancellationFee` is the
portal's sentence on what leaving today would cost; `canRenew` means a renewal offer is waiting in the
portal. Grid operator costs and the yearly energy tax refund are not included.

`termijnbedrag`: `minimum`/`maximum` bound what the instalment can be set to, `basedOnKwh`/`basedOnGasM3`
is the yearly usage behind `advice`, and `remainingTerms` is the instalments left before the yearly
bill (jaarnota).

`invoices`: `balance` is what's still unpaid, `openBalance` the sum. Pass `invoiceId`, not
`invoiceNumber`, to `invoice`.

`usage`: smart-meter rows. `to` is exclusive, `kwhLow` is off-peak, `kwhReturn` is fed back to the
grid. Costs (EUR incl. VAT and energy tax) leave out the fixed monthly costs. `estimated: true` marks
an interpolated value (typically gas for the last day or two) that may still change.

Readings lag a day or two, and hours or days without one are left out. A daylight-saving day has 23
or 25 hourly rows. `week` and `month` rows cover whole calendar weeks and months, so the first and
last row can extend past `from`/`to`. A year of hourly rows takes about 10 seconds. `contractId`
(from `contracts`) is needed only if the account has more than one active contract.
