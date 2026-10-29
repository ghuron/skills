---
name: dunea
description: "Read a Dunea drinking water account (Mijn Dunea; water in the Den Haag, Leiden and Zoetermeer region): customer and payment details, the advance payment (voorschot) with its allowed range, advance invoices and yearly bills (periodeafrekening) with PDF, and meter readings with water use per year. Use when the user asks about their water bill, the Dunea voorschot or periodeafrekening, how much water they use, or past water meter readings."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to www.dunea.nl and mijndunea.b2clogin.com (login). Env: DUNEA_EMAIL and DUNEA_PASSWORD (the Mijn Dunea login), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/dunea.mjs account                              # customer number, contact details, payment method, contracts
node scripts/dunea.mjs invoices                             # advance invoices and yearly bills, open and paid
node scripts/dunea.mjs invoice <invoiceNumber> [file.pdf]   # download an invoice PDF (default <invoiceNumber>.pdf)
node scripts/dunea.mjs voorschot [agreementId]              # advance payment: amount, term, allowed range
node scripts/dunea.mjs usage [agreementId]                  # meter readings and water use per yearly period
```

Every command logs in with `DUNEA_EMAIL` and `DUNEA_PASSWORD`, prints JSON and changes nothing.
`agreementId` (e.g. `L000123456`) is a contract from `account`, needed only if the account has more
than one address; without it the first one is used. Accounts with two-step verification turned on
can't log in.

A failed login (wrong password) isn't retried. After a few failures in a row Mijn Dunea makes the
account wait, so fix the credentials before trying again.

# Output notes

`account`: `iban` is masked like on Dunea's invoices. `contracts` lists each address with its
`agreementId`; `active: false` is an ended contract.

`invoices`: the last ~550 days (`historyDays`). A `Voorschotfactuur` is an advance; a
`Periodeafrekening` is the yearly bill, which settles the advances against the metered use and sets
the next advance. `date` is when it was or will be debited, a few weeks after the invoice date on the
PDF. For `open` invoices `amount` is what's left to pay, and `openBalance` is their sum. The PDF of a
periodeafrekening has the meter readings, tariffs per m³, fixed charge (vastrecht) and tap water tax.

`voorschot`: `amount` is charged per `term` (`monthly` or `quarterly`); `perMonth` and `perQuarter`
are the same advance in both terms. `minimum` and `maximum` bound what it can be set to in the
current term. Changing it is done in Mijn Dunea, not here.

`usage`: per water meter, one row per billing period, newest first, from the yearly readings
(Dunea asks for one reading a year). `reading` is the meter at the end of the period, `m3` the use in
it, and `litresPerDay` the average per day. `contractStart` and `startReading` are where the first
period began. Submitting a reading isn't supported: Dunea takes those on a separate site with the
code from its reading request.
