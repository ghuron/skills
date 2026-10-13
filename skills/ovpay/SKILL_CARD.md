# Skill Card

## Description

Agent skill + Node.js CLI for OVpay (nationwide Dutch public-transport pay-as-you-go) account
holders to read their cards, balances and trip history. Runtime requires Node.js with no
additional dependencies; uses the unofficial OVpay mobile-app API. The one-time `login` bootstrap
optionally uses `playwright`.

## Owner

ghuron — single maintainer, no team.

## License or terms

MIT-0.

## Use case

For an OVpay account holder managing pay-as-you-go cards for themselves and family members:

- **Cards & balances.** List every card on the account with its current balance and status.
- **Trip history.** Retrieve per-card travel history (date, stops, mode, operator, fare), optionally
  for a date range, and export to CSV.
- **Secure a card.** Enable OVpay's "SecureTat" protection on a card (needed before its trips can be
  read), via a one-time emailed code.

Only for cards the operator owns or is explicitly authorised to manage.

## Deployment geography

The Netherlands — OVpay is the national account-based ticketing system for Dutch public transport
(train, tram, bus, metro across all operators).

## Risks and mitigations

- **Risk:** OVpay has no public API; the reverse-engineered mobile endpoints can change without
  notice.
  **Mitigation:** An end-to-end test runs periodically against a real account and fails loudly on
  drift. The skill performs no payments or irreversible changes; its only state change is enabling
  SecureTat on a card the operator authorises (opt-in, via `secure`).
- **Risk:** The offline token is a ~30-day credential.
  **Mitigation:** Stored at mode 600; rotated on every use; never logged.

## References

- `SKILL.md` — command reference.

## Skill output

All commands return JSON to stdout. `export` additionally writes a CSV file. `secure` enables
SecureTat on the card (opt-in). No payments, orders, or deletions.

## Skill version

0.1.0

## Ethical considerations

Only use against an account you own or are authorised to manage. Compliance with OVpay's / Trans
Link Systems' terms of service is the operator's responsibility.
