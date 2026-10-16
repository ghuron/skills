---
name: ah
description: "Turn Albert Heijn (Dutch supermarket, ah.nl) online-order invoices (factuur PDFs) into one CSV per order with a row per product: item, quantity, VAT, total, Bonus flag, deposits (statiegeld) and bags. Checks that the lines add up to the invoice total. Use when the user wants to analyse Albert Heijn grocery spending, split a grocery bill or track what they buy."
license: MIT-0
compatibility: "Requires Node.js 22+, Python 3 and pypdf (pip install pypdf). Works offline on downloaded invoice PDFs."
---
# Commands

```bash
node ah.mjs csv [--force] [--out <dir>] <pdf|dir>...   # invoice PDFs -> <order number>.csv
```

A directory means every `*.pdf` in it. Each order goes to `<order number>.csv` in `--out`, or next to
its PDF. An existing CSV is skipped so notes added to it survive; `--force` rewrites it. Stops on an
invoice line it doesn't recognise, or when the lines don't add up to the invoice total.

# Output

UTF-8, CRLF, dot decimals, one row per invoice line; `Total (EUR)` includes VAT. Deposits, bags and
corrections have their heading in front of `Item` (`Statiegeld: AH Klapkrat`, `Statiegeld retour:
Petfles 0.25`, `Verpakkingsmateriaal: Plastic tasje(s)`). `Note` holds the single-use plastic levy a
line includes, if any, and is free for your own notes.

There are no date or order-number columns: the order number is the file name, and the bank row that
paid for the order carries it.
