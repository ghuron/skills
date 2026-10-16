---
name: abn-amro
description: "Convert an ABN AMRO (Dutch bank) transaction export (.TAB, the TXT download from Internet Banking) into CSV, with the type (direct debit, iDEAL, transfer, card payment, ATM withdrawal) and the counterparty name, IBAN and description split out of the SEPA text. Can append only the new rows to an existing CSV and keep your own extra columns. Use when the user has an ABN AMRO export, wants to categorise or analyse Dutch bank transactions, or keeps a spending spreadsheet."
license: MIT-0
compatibility: "Requires Node.js 22+. Works offline on a downloaded export; no bank login."
---
# Commands

```bash
node abn-amro.mjs <export.TAB> [--account <number>]                     # CSV to stdout
node abn-amro.mjs <export.TAB> [--account <number>] --append <file.csv> # add rows the file doesn't have
```

The export is named `TXT<timestamp>.TAB`. If it holds several accounts, `--account` (the file's first
column) is required.

`--append` creates the file if needed, matches rows on Date, Amount and Balance After, and adds the
new ones at the end with your extra columns (Category, Note, …) empty. Rows in a description format
it doesn't know get an empty `Type` and a warning on stderr.

# Output

UTF-8, CRLF, ISO dates, dot decimals, signed amounts (negative = money out), in the export's order.

- `Type`: `Direct debit`, `iDEAL`, `Transfer`, `Card payment`, `Card payment (Google Pay)`, `ATM withdrawal`, `Bank fee`.
- `Counterparty`: the SEPA name or card merchant; OVpay trips paid by card show `OVpay`.
- `Counterparty IBAN`: for a direct debit without an IBAN, the collector ID.
- `Description`: the SEPA remittance text; for cards, the place, date and time.
