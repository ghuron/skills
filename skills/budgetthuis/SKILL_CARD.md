# Skill Card

## Description

Agent skill + Node.js CLI for Budget Thuis (Budget Energie) customers to read their energy
contract, tariffs, monthly instalment, invoices and hourly usage. Requires Node.js with no
additional dependencies; uses the unofficial "MijnBudget" customer portal and the APIs behind it
and the Budget Thuis app.

## Owner

ghuron — single maintainer, no team.

## License or terms

MIT-0.

## Use case

For a Budget Thuis energy customer (electricity and/or gas):

- **Contract and prices.** Current tariffs per kWh and m³ including energy tax, fixed monthly
  costs, contract end date, renewal offer and the indicative exit fee.
- **Monthly instalment.** The current termijnbedrag next to Budget Thuis's advice, to spot a
  shortfall or surplus before the yearly bill.
- **Invoices.** List invoices with open balance and download them as PDF.
- **Usage.** Hourly, daily, weekly or monthly electricity, feed-in and gas usage with costs, for
  any date range.

Only for accounts the operator owns or is explicitly authorised to manage.

## Deployment geography

The Netherlands — Budget Thuis supplies households in the Netherlands.

## Risks and mitigations

- **Risk:** Budget Thuis has no public API; the portal pages and endpoints can change without
  notice.
  **Mitigation:** End-to-end tests run periodically against a real account and fail loudly on
  drift. The skill is read-only: it changes no settings and makes no payments.

## References

- `SKILL.md` — command reference.

## Skill output

All commands return JSON to stdout. `invoice` additionally writes the invoice PDF to a file.

## Skill version

0.1.0

## Ethical considerations

Only use against an account you own or are authorised to manage. Usage and cost figures are the
portal's own estimates; the yearly bill is authoritative. Compliance with Budget Thuis's terms of
service is the operator's responsibility.
