# ah

CLI for Albert Heijn online orders. See [`skills/ah/SKILL.md`](../skills/ah/SKILL.md) for usage.

## TODO: login and factuur download

So far the skill only turns invoice PDFs that you downloaded yourself into CSV. Still to build in
`skills/ah/ah.mjs`: log in, list orders, and download an order's factuur, so that `csv` can run on what
it fetched.

## Invoice layout (`skills/ah/parse_invoice.py`)

`pypdf`'s layout mode keeps the columns aligned, and the parser relies on that.

- Page 1 is a VAT summary. The line items (Specificatie) start at the `Omschrijving` column header
  on page 2. Quantities are right-aligned under `Aantal`. A number that ends before that column is
  part of the name (`Iglo: gratis bezorging bij 15`).
- A Bonus multipack deal prints the deal's name (`… 3-pack`, `… 6 flessen`) on a line of its own
  above the product. Only the product is kept, and it must carry `BONUS`.
- After the groceries come `Overig` and `Verrekeningen`. Under them, `Statiegeld`,
  `Verpakkingsmateriaal`, `Statiegeld retour` and `Correcties artikelen vorige bestelling(en)` are
  headings with indented lines. Standalone lines there (`Bezorgkosten`, free-delivery offers) can
  wrap onto a second line.
- ` Inclusief SUP heffing 0,01` under a line is the single-use plastic levy included in it.
- The lines must add up to the `Totaal` of the specification and to `Totaal inclusief btw` on
  page 1. The iDEAL payments listed on the invoice can differ from that total: top-ups for items
  added later, and a refund for missing items and returned crates, are paid separately.

## Tests

```bash
npm test
```

Invoices are personal, so none are committed. Put real ones in `.fixtures/` (gitignored) and the
expected CSVs in `.fixtures/expected/<order number>.csv`. Without them the test is skipped.
