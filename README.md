# Agent skills for Dutch everyday services

[Agent Skills](https://agentskills.io) that let an AI agent (Claude Code, Codex, Cursor, Gemini CLI,
OpenClaw and other `SKILL.md`-compatible agents) work with the school portal, public transport, energy, bank
and supermarket accounts of a household in the Netherlands. Each skill is a small Node.js CLI without npm
dependencies that prints JSON or writes CSV, plus a `SKILL.md` that tells the agent how to use it.

| Skill | What the agent can do | Needs |
|---|---|---|
| [magister](magister/SKILL.md) | Magister school portal: timetable with homework and tests, grades, absences, messages, report a child sick | School host, username, password |
| [ovpay](ovpay/SKILL.md) | OVpay public transport: cards, balances, trip history with fares, CSV export | OVpay token (one-time login with email code) |
| [htm](htm/SKILL.md) | HTM (Den Haag) public transport: passes, products, trips, Regio Vrij advice, renew a product into the cart | Mijn HTM login |
| [budgetthuis](budgetthuis/SKILL.md) | Budget Thuis energy: tariffs, contract, monthly instalment and advice, invoices (PDF), hourly to monthly electricity and gas usage with costs | MijnBudget login |
| [abn-amro](abn-amro/SKILL.md) | ABN AMRO transaction export (.TAB) to CSV, counterparty and IBAN split out | Nothing, works offline |
| [ah](ah/SKILL.md) | Albert Heijn online-order invoices (PDF) to CSV, one row per product | Python 3 + `pypdf` |
| [epson](epson/SKILL.md) | Ink levels of an Epson Expression XP-series network printer | Printer on the local network |

## Install

All skills need Node.js 22 or later. With the [skills CLI](https://skills.sh), for any agent:

```bash
npx skills add ghuron/skills                    # pick skills and agents interactively
npx skills add ghuron/skills --skill magister   # just one
```

In Claude Code, from this repo's plugin marketplace, where each skill is a plugin of the same name:

```
/plugin install magister --marketplace ghuron/skills
```

On Claude Code older than 2.1.275, first run `/plugin marketplace add ghuron/skills`, then
`/plugin install magister@ghuron-skills`.

Or copy `<name>/` into your agent's skills directory, such as `~/.claude/skills/<name>/`.

## Credentials

Skills that log in read credentials from environment variables. If your agent runs the skills from
a clone of this repo, they can also go in a `.env` in the skill's folder (`htm/.env`); the
environment wins. A `.env` in an installed copy is lost when `npx skills` updates the skill.

| Skill | Variables |
|---|---|
| magister | `MAGISTER_HOST` (your school, e.g. `myschool.magister.net`), `MAGISTER_USER`, `MAGISTER_PASSWORD` |
| ovpay | `OVPAY_REFRESH_TOKEN` (seed token, or run `login` once instead), optional `OVPAY_STATE`, `OVPAY_EMAIL`, `OVPAY_PASSWORD` |
| htm | `HTM_LOGIN`, `HTM_PASSWORD`, optional `HTM_BIRTHDATE_<tokenId>` |
| budgetthuis | `BUDGETTHUIS_LOGIN`, `BUDGETTHUIS_PASSWORD` |
| epson | `EPSON_HOST` |

Credentials are sent only to the service's own login and API hosts. The only state the skills keep
is the rotating OVpay token, in `~/.ovpay/tokens.json` by default.

## What the skills change

The skills only read from the services, except:

- `magister report-sick` reports a child sick at school (parent accounts, today or tomorrow only).
- `htm reorder` puts a product in the HTM cart. It never pays; you finish checkout in a browser.
- `ovpay secure` turns on the extra trip-history protection for a card.

## Disclaimer

These are unofficial tools, not affiliated with or endorsed by Magister, OVpay, HTM, Budget Thuis,
ABN AMRO, Albert Heijn or Epson. They use the same undocumented APIs as the services' own websites
and apps, which can change without notice; integration tests against real accounts catch that.

## Repository layout

- `<name>/`: the installable skill, `SKILL.md` plus the files it runs. Implementation notes
  are comments in the code.
- `.ci/`: tests and CI scripts. Integration tests log in with the same `<name>/.env` files.

```bash
cd .ci && node --test
```

## License

[MIT-0](LICENSE)
