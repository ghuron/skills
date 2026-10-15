---
name: budgetthuis
description: "Read a Budget Thuis energy account (Budget Energie, budgetthuis.nl 'MijnBudget', Dutch electricity and gas supplier): contracts, current tariffs per kWh and m³ with energy tax and fixed monthly costs, contract end date and exit fee, the monthly instalment (termijnbedrag) with Budget Thuis's advice, invoices with open balance and PDF download, and hourly, daily, weekly or monthly electricity, feed-in and gas usage with costs. Use when the user asks about their energy bill, energy prices or contract, gas or electricity consumption (also per hour or time of day), the termijnbedrag, or whether to renew or switch energy supplier."
license: MIT-0
compatibility: "Requires Node.js 20+ and network access to mijn.budgetthuis.nl, accounts.budgetthuis.nl, api.budgetthuis.nl and app.api.nutsservices.nl (the Budget Thuis app's backend). Credentials via BUDGETTHUIS_LOGIN and BUDGETTHUIS_PASSWORD (the MijnBudget account)."
---
# Commands

```bash
node budgetthuis.mjs account                          # customer number, name, address (contact and bank details masked)
node budgetthuis.mjs contracts                        # contracts: contractId, status, startDate, durationMonths, address
node budgetthuis.mjs tariffs                          # contract terms, tariffs, renewal offer, exit fee
node budgetthuis.mjs termijnbedrag                    # monthly instalment, advice, allowed range
node budgetthuis.mjs invoices                         # invoices, newest first, with open balance
node budgetthuis.mjs invoice <invoiceId> [file.pdf]   # download an invoice PDF (default <invoiceId>.pdf)
node budgetthuis.mjs usage <from> <to> [hour|day|week|month] [contractId]
                                                      # usage and costs, dates YYYY-MM-DD inclusive, default day
```

All commands print JSON to stdout. Everything is read-only.

# Output notes

`tariffs`: amounts in EUR including VAT. `electricityNormal` / `electricityLow` / `gas` each have
`supply` (Budget Thuis's price), `energyTax` and `total`, per kWh or m³. `feedIn` is the
compensation per kWh returned to the grid, and `fixedMonthly` the fixed supply costs per month.
`cancellationFee` is the portal's own sentence on what leaving today would cost. `canRenew` means a
renewal offer is waiting in the portal. Grid operator costs and the yearly energy tax refund aren't
shown on this page and aren't included.

`termijnbedrag`: `current` is the monthly instalment, `advice` is what Budget Thuis recommends, and
`minimum`/`maximum` bound what can be set. `basedOnKwh`/`basedOnGasM3` is the yearly usage the
advice assumes. `remainingTerms` is how many instalments are left before the yearly bill
(`jaarnota`), whose meter reading is on `yearlyReadingDate`.

`invoices`: `amount` is the invoice total and `balance` what's still unpaid. `openBalance` sums
the unpaid amounts. Use `invoiceId`, not `invoiceNumber`, for `invoice`.

`usage`: one row per hour, day, week or month, from the smart meter. Each row has `from`/`to`
(local time with offset; `to` is exclusive), `kwh` with its `kwhNormal`/`kwhLow` (off-peak) split,
`kwhReturn` (fed back) with the same split, `gasM3`, and costs in EUR incl. VAT: `costElectricity`,
`costReturn`, `costGas`, `costTotal`. Costs are variable costs only (usage × tariff incl. energy
tax); fixed monthly costs aren't in them. `estimated: true` means Budget Thuis interpolated the
value (typically gas for the last day or two) and it may still change.

Readings arrive with a delay of a day or two; hours and days without a reading are left out. A
daylight-saving day has 23 or 25 hourly rows. `week` and `month` rows cover whole calendar weeks
and months, so the first and last row can extend past `from`/`to`. A year of hourly rows takes
about 10 seconds. Pass `contractId` (from `contracts`) only if the account has more than one
active contract.
