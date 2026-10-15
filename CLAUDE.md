This repo will be public. Keep personal data out of it, test fixtures included: credentials go in
`skills/<name>/.env` and real exports and invoices in `.ci/<name>/.fixtures/`, both gitignored like every dotfile.

## Layout

- `skills/<name>/`: the skill itself, which is what agents install. `SKILL.md` plus the files it runs. Nothing else
  goes here: aggregators and `npx skills add` copy the whole directory. Implementation notes (how a login works,
  API quirks found by reverse engineering) are code comments next to the code they explain.
- `.ci/`: what only the maintainer needs. `bootstrap.sh`, `pull-secrets.sh`, `run.sh`, and per skill `.ci/<name>/`
  with its tests, test helpers and `refresh.mjs` if the skill bundles static data.
- `README.md`, `.claude-plugin/marketplace.json`, `skills.sh.json`: what aggregators and users read. They list
  every skill.

`SKILL.md` frontmatter follows the Agent Skills spec (agentskills.io/specification): `name` equals the directory
name, `description` says what the skill does and when to use it (≤1024 chars), `license: MIT-0`, and
`compatibility` lists runtime, network access and env vars. `metadata`, if any, maps strings to strings.

## Credentials

Skills read credentials from environment variables. A skill that needs them first loads the `.env` in its own
folder with `process.loadEnvFile()`; variables already set in the environment take precedence. Never load a `.env`
from the working directory: it could point a skill at another host and send the user's password there.

Tests read the same files: every `skills/<name>/*.env`, running once per file. Magister has `.env` (parent account)
and `.child.env`.

## Bootstrap (fresh machine)

```bash
bash .ci/bootstrap.sh    # installs infisical/claude, logs in, pulls secrets
```

Infisical project: UUID `d56a074c-446e-466b-a6ba-91284fe0a42b`, domain `eu.infisical.com`.

Root path (`/`) of the `dev` environment must have:
`GITHUB_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`

Per-skill secret paths, pulled into `skills/<name>/.env`:
- `/htm` → `HTM_LOGIN`, `HTM_PASSWORD`, optional `HTM_BIRTHDATE_<tokenId>`
- `/magister_parent` → parent account credentials (`.env`)
- `/magister_child` → child account credentials (`.child.env`)
- `/budgetthuis` → `BUDGETTHUIS_LOGIN`, `BUDGETTHUIS_PASSWORD`
- `/epson` → `EPSON_HOST`
- `/ovpay` → `OVPAY_REFRESH_TOKEN` (seed offline token; `ovpay`'s test rotates it and writes the new one back here), `OVPAY_EMAIL`, `OVPAY_PASSWORD` (only used by `node ovpay.mjs login`)

To refresh credentials at any time: `bash .ci/pull-secrets.sh`

## Running tests

```bash
cd .ci && node --test                  # every skill
node --test .ci/magister/*.test.mjs    # one skill
```

Node's test runner skips dot folders, so `node --test` from the repo root finds nothing.

## Publishing

Aggregators (skills.sh, SkillsMP, Claude Code marketplaces) read the default branch of the public repo, so pushing
is publishing.

## CI

`.ci/run.sh` is the cron entry point. It:
1. `git pull` + `pull-secrets.sh`
2. For each `.ci/<name>/`: runs its tests
3. On failure: runs `.ci/<name>/refresh.mjs` (if there is one), re-tests
4. Still failing: asks Claude to fix, re-tests
5. On success after a refresh or fix: commits and pushes

## Adding a new skill

1. Create `skills/<name>/<name>.mjs` and `skills/<name>/SKILL.md`
2. Create `.ci/<name>/<name>.test.mjs`
3. Add credential paths to Infisical and to `.ci/pull-secrets.sh`
4. List the skill in `README.md`, `.claude-plugin/marketplace.json` and `skills.sh.json`

## Skill with static data (HTM pattern)

Skills that bundle a snapshot of external data follow this pattern:
- `skills/<name>/<data>.json` — the bundled snapshot
- `.ci/<name>/refresh.mjs` — fetches live data and regenerates the snapshot
- A test asserts the bundled snapshot matches live data; when it fails, `refresh.mjs` regenerates it

`run.sh` runs `refresh.mjs` automatically before escalating to Claude.
