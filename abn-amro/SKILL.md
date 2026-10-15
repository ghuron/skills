---
name: abn-amro
description: "Convert an ABN AMRO (Dutch bank) transaction export (.TAB, the TXT download from Internet Banking) into a clean CSV with date, amount, balance, type (direct debit, iDEAL, transfer, card payment, ATM withdrawal) and the counterparty name, IBAN and description split out of the SEPA text. Can append only the new rows to an existing CSV and keep your own extra columns. Use when the user has an ABN AMRO export, wants to categorise or analyse Dutch bank transactions, or keeps a spending spreadsheet."
license: MIT-0
compatibility: "Requires Node.js 22+. Works offline on a downloaded export; no bank login."
---
# Commands

```bash
node abn-amro.mjs <export.TAB> [--account <number>]                     # CSV to stdout
node abn-amro.mjs <export.TAB> [--account <number>] --append <file.csv> # add rows the file doesn't have
```

Download transactions in Internet Banking in the TXT format; the file is named `TXT<timestamp>.TAB`. An export can hold several
accounts; `--account` picks one (the first column of the file).

`--append` matches rows on Date, Amount and Balance After, adds the new ones at the end, and leaves
any extra columns of the file (your own Category, Note, …) empty for them. It creates the file if
it doesn't exist. Rows in a description format it doesn't know get an empty Type and a warning.

# Output

UTF-8, CRLF, oldest row first, dot decimals, signed amounts (negative = money out):

| Column | |
|---|---|
| `Date`, `Value Date` | ISO dates |
| `Amount (EUR)`, `Balance After (EUR)` | |
| `Type` | `Direct debit`, `iDEAL`, `Transfer`, `Card payment`, `Card payment (Google Pay)`, `ATM withdrawal`, `Bank fee` |
| `Counterparty`, `Counterparty IBAN` | From the SEPA name and IBAN, or the card merchant. Direct debits without an IBAN get the collector ID. OVpay trips paid by card show `OVpay` |
| `Description` | SEPA remittance text; for cards the place, date and time |
| `Raw Description` | The export's description with whitespace collapsed |
