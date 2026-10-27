# Agent skills for Dutch everyday services

[Agent Skills](https://agentskills.io) for a household in the Netherlands. Each is a small Node.js 22+ CLI without
npm dependencies, plus a `SKILL.md` that tells the agent how to use it.

| Skill | What it does |
|---|---|
| [magister](magister/SKILL.md) | Magister school portal: timetable with homework and tests, grades, absences, messages; reports a child sick |
| [ovpay](ovpay/SKILL.md) | OVpay public transport: cards, balances, trip history with fares, CSV export; corrects missed check-outs; turns on trip-history protection |
| [htm](htm/SKILL.md) | HTM (Den Haag) public transport: passes, products, trips, Regio Vrij advice; puts a product in the cart, you pay |
| [budgetthuis](budgetthuis/SKILL.md) | Budget Thuis energy: tariffs, contract, monthly instalment, invoices (PDF), usage with costs |
| [vodafone](vodafone/SKILL.md) | Vodafone mobile: numbers, bundles left, usage and costs, invoices (PDF) with per-number breakdown and call records, PUK; switches mobile internet off and on per number |
| [abn-amro](abn-amro/SKILL.md) | ABN AMRO transaction export (.TAB) to CSV, offline |
| [ah](ah/SKILL.md) | Albert Heijn: online orders, invoices (PDF), in-store receipts with Bonus discounts; invoices to CSV |
| [epson](epson/SKILL.md) | Ink levels of an Epson Expression XP-series network printer |
| [ecovacs](ecovacs/SKILL.md) | Ecovacs DEEBOT robot vacuum: status, consumables, cleaning history, rooms; starts, pauses, stops and docks it |

## Install

```bash
npx skills add ghuron/skills                    # any agent; pick skills interactively
npx skills add ghuron/skills --skill magister   # just one
```

In Claude Code: `/plugin install magister --marketplace ghuron/skills` (before 2.1.275:
`/plugin marketplace add ghuron/skills`, then `/plugin install magister@ghuron-skills`).

Credentials come from environment variables or a `.env` in the skill's folder; its `.env.example` lists them.
Updating with `npx skills` replaces the folder, `.env` included.

## Disclaimer

Unofficial tools, not affiliated with or endorsed by Magister, OVpay, HTM, Budget Thuis, Vodafone, ABN AMRO, Albert
Heijn, Epson or Ecovacs. They use the same undocumented APIs as the services' own websites and apps, which can change without
notice.

## License

[MIT-0](LICENSE)
