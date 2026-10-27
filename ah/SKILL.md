---
name: ah
description: "Read an Albert Heijn account (Dutch supermarket, ah.nl, the Appie app): online orders with their products and delivery slot, invoice (factuur) PDFs, and in-store receipts (kassabonnen) with products, Bonus discounts, payments and VAT; turn invoices into one CSV per order with a row per product. Use when the user asks what they bought or spent at Albert Heijn, about a grocery order or delivery, wants an AH invoice or receipt, or wants to analyse or split grocery spending."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to api.ah.nl (the Albert Heijn app's backend); `login` needs a person to sign in once at login.ah.nl in a web browser. `csv` needs Python 3 with pypdf (pip install pypdf) and works offline. Env: AH_SESSION (set by `login`, and rewritten by the skill as it renews), in the .env in the skill folder."
---
# Commands

```bash
node scripts/ah.mjs login                                    # the address to sign in at
node scripts/ah.mjs login <code>                             # the appie://login-exit?code=… address; saves the session
node scripts/ah.mjs orders                                   # the 25 most recent online orders, newest first
node scripts/ah.mjs order <orderId>                          # its products, delivery slot and invoiceId
node scripts/ah.mjs invoice <orderId> [file.pdf]             # download its invoice PDF (default <orderId>.pdf)
node scripts/ah.mjs receipts [count|all]                     # in-store receipts, newest first (default 20)
node scripts/ah.mjs receipt <id>                             # products, discounts, payments, VAT
node scripts/ah.mjs csv [--force] [--out <dir>] <pdf|dir>... # invoice PDFs -> <order number>.csv
```

Every command but `csv` prints JSON; none changes the account.

# Auth

AH's sign-in page has a captcha, so a person signs in once in a browser, and the skill keeps the
session. Run `login`, give the user its `url`, and ask them to:

1. open a new browser tab, open the developer tools (F12) on the Console tab, then open the `url`
   in that tab;
2. sign in to Albert Heijn (and enter a verification code if AH asks for one);
3. copy the `appie://login-exit?code=…` address from the console message "Failed to launch
   'appie://login-exit?code=…'" (or from the Network tab: the last request's Location header).

Then run `login` with that address straight away: the code works once, for a few minutes. The
session goes into the skill's `.env` as `AH_SESSION`. AH replaces it about once a week, and the
skill writes the new one back to `.env`, so keep it there rather than in the environment, and don't
copy it to another machine: sign in there separately. Once AH stops accepting it, commands fail with
"run `node scripts/ah.mjs login`".

# Output notes

Money is EUR including VAT; times are Amsterdam local.

`orders`: `state` is `CONFIRMED` while an order can still be changed (until `changeableUntil`), then
`DELIVERED`; `slot` is the delivery window on `date`. `total` is what the order showed; the invoice
can differ, because items that weren't delivered, returned deposits and later top-ups are settled on
it. AH lists only the 25 most recent orders.

`order`: `quantity` is how many were ordered. `price` and `bonus` are today's price and Bonus offer,
not what a delivered order cost: that is on its invoice. `invoiceId` is null until the order is
delivered, and `invoice` fails until then.

`receipts`: every till purchase with the account's Bonus card, about two years back; `store` is the
shop's address. `receipt` gives its lines with the till's abbreviated names. `amount` is the line
before discounts; `bonus` marks Bonus products, whose discount is a line in `discounts` (negative
amounts). Products' `amount` plus `deposit`, plus `discounts`, add up to `total`. `plasticLevy` is
the single-use plastic levy included in `amount`; `vat` is per rate, `net` without VAT.

# CSV

`csv` reads invoice PDFs (from `invoice`, or downloaded from ah.nl) and writes each order to
`<order number>.csv` in `--out`, or next to its PDF; a directory means every `*.pdf` in it. An
existing CSV is skipped so notes added to it survive; `--force` rewrites it. It stops on an invoice
line it doesn't recognise, or when the lines don't add up to the invoice total.

UTF-8, CRLF, dot decimals, one row per invoice line; `Total (EUR)` includes VAT. Deposits, bags and
corrections have their heading in front of `Item` (`Statiegeld: AH Klapkrat`, `Statiegeld retour:
Petfles 0.25`, `Verpakkingsmateriaal: Plastic tasje(s)`). `Note` holds the single-use plastic levy a
line includes, if any, and is free for your own notes.

There are no date or order-number columns: the order number is the file name, and the bank row that
paid for the order carries it.
