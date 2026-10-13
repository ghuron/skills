# abn-amro

CLI for ABN AMRO transaction exports. See [`skills/abn-amro/SKILL.md`](../skills/abn-amro/SKILL.md) for usage.

## The .TAB export

Tab-separated, no header, Latin-1: account number, currency, transaction date (`YYYYMMDD`),
balance before, balance after, value date, amount (comma decimals, no thousands separator),
description. The description comes in several layouts:

- `/TRTP/<type>/CSID/…/NAME/<name>/MARF/…/REMI/<text>/IBAN/<iban>/BIC/…/EREF/…`: SEPA transfers,
  debits and iDEAL from mid-2026 on. Values contain slashes themselves (`Termijn 3/12`,
  `example.nl/factuur.`), so split on the known keys only. They also keep the bank's padding
  (`WATERBEDRIJF   NV`), and a value can end in a space (`NL00BANK0123456789 `).
- `SEPA <type> Incassant: … Naam: … Omschrijving: … IBAN: … Kenmerk: …`: the same before mid-2026,
  in fixed-width 32-character blocks. A block that fills its 32 characters runs straight into
  the next label (`Webwinkel Betalingen Europa BVOmschrijving:`, `Gemeente Den Haag Betalingskenm.:`),
  so split on the labels themselves, not on spaces. Labels are capitalised, and the same words
  in lower case occur in the text (`( kenmerk: 1234-…)`). Some debits nest a second
  `Omschrijving:` inside the first. Words can wrap mid-word (`verze kering`).
- `BEA, Betaalpas <merchant>,PAS123 NR:…, 31.12.25/17:44 <place>`: card payments, `Google Pay`
  instead of `Betaalpas` for phone payments, and `GEA` for cash withdrawals. A reversal adds
  `TERUGBOEKING-BEA-TRANSACTIE` after the place. OVpay public-transport trips show a trip token
  (`NLOV…`) instead of a merchant name.
- `ABN AMRO Bank N.V. BasisPakket Betalen 4,30Credit Card 2,55`: monthly fees.

Card payments in other currencies cost 1.75% plus €0.15. The description shows it:
`USD 10,00 1EUR=1,1002 USD ECB Koers=1,1194 OPSLAG=1,75%`.

## Tests

```bash
npm test
```

The test exports are made up. Real ones stay out of the repo.
