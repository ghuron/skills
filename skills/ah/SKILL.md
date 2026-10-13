---
name: ah
description: "Turn Albert Heijn (Dutch supermarket, ah.nl) online-order invoices (factuur PDFs) into one CSV per order with a row per product: item, quantity, VAT, total, Bonus flag, deposits (statiegeld) and bags. Checks that the lines add up to the invoice total. Use when the user wants to analyse Albert Heijn grocery spending, split a grocery bill or track what they buy."
license: MIT-0
compatibility: "Requires Node.js 20+, Python 3 and pypdf (pip install pypdf). Works offline on downloaded invoice PDFs."
---
# Commands

```bash
node ah.mjs csv [--force] [--out <dir>] <pdf|dir>...   # invoice PDFs -> <order number>.csv
```

Needs `pypdf` (`pip install pypdf`).

Writes each order to `<order number>.csv` in `--out`, or next to its PDF. An order that already has a
CSV is skipped so notes added to it survive; `--force` rewrites it. Stops on any invoice line it
does not recognise, and when the lines don't add up to the invoice total.

# Output

UTF-8, CRLF, one row per invoice line, dot decimals:

| Column | |
|---|---|
| `Item` | Product name as printed, without the `BONUS` marker. Deposits, bags and corrections are prefixed with their heading: `Statiegeld: AH Klapkrat`, `Statiegeld retour: Petfles 0.25`, `Verpakkingsmateriaal: Plastic tasje(s)` |
| `Quantity` | Count, or empty when the invoice prints none (delivery costs) |
| `VAT (%)` | `9`, `21`, or `0` for lines without VAT (`Geen`) |
| `Total (EUR)` | Line total including VAT. Deposit refunds and free-delivery offers are negative |
| `Bonus` | `Yes` when the line was a Bonus offer |
| `Note` | The single-use plastic levy a line includes, if any. Free for your own notes |

The order number is the file name, not a column. The invoice's payment and delivery dates are left
out: the bank rows that pay for the order carry its number.
