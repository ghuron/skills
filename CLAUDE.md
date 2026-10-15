This repo will be public. Keep personal data out of it, test fixtures included: real exports and
invoices go in `<skill>/.fixtures/`, which is gitignored like every dotfile.

## Layout

- `skills/<name>/`: the skill itself, which is what agents install. `SKILL.md` plus the files it runs. Nothing else
  goes here: aggregators and `npx skills add` copy the whole directory.
- `<name>/`: tests, `package.json`, dev notes (`README.md`) and refresh scripts for that skill.
- `README.md`, `.claude-plugin/marketplace.json`, `skills.sh.json`: what aggregators and users read. They list
  every skill.

`SKILL.md` frontmatter follows the Agent Skills spec (agentskills.io/specification): `name` equals the directory
name, `description` says what the skill does and when to use it (≤1024 chars), `license: MIT-0`, and
`compatibility` lists runtime, network access and env vars. `metadata`, if any, maps strings to strings.

## Bootstrap (fresh machine)

```bash
bash bootstrap.sh        # installs infisical/clawhub/claude, logs in, pulls secrets
```

Infisical project: UUID `d56a074c-446e-466b-a6ba-91284fe0a42b`, domain `eu.infisical.com`.

Root path (`/`) of the `dev` environment must have:
`CLAWHUB_TOKEN`, `GITHUB_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`

Per-skill secret paths:
- `/htm` → `HTM_LOGIN`, `HTM_PASSWORD`
- `/magister_parent` → parent account credentials
- `/magister_child` → child account credentials
- `/budgetthuis` → `BUDGETTHUIS_LOGIN`, `BUDGETTHUIS_PASSWORD`
- `/ovpay` → `OVPAY_REFRESH_TOKEN` (seed offline token; `ovpay`'s test rotates it and writes the new one back here), `OVPAY_EMAIL`, `OVPAY_PASSWORD` (only used by `node ovpay.mjs login`)

To refresh credentials at any time: `bash pull-secrets.sh`

## Running tests

```bash
cd <name> && npm test     # e.g. cd magister && npm test
```

## Publishing

Aggregators (skills.sh, SkillsMP, Claude Code marketplaces) read the default branch of the public repo, so pushing
is publishing. clawhub still needs an explicit upload:

```bash
cd <name> && npm run publish
```

Version is read from `package.json` automatically via `$npm_package_version`.

## CI

`run.sh` is the cron entry point. It:
1. `git pull` + `pull-secrets.sh`
2. For each skill: runs `npm test`
3. On failure: runs `npm run refresh` (if the skill has one), re-tests
4. Still failing: asks Claude to fix, re-tests
5. On success after a fix: bumps patch version, commits, pushes, publishes to clawhub

## Adding a new skill

1. Create `skills/<name>/<name>.mjs` and `skills/<name>/SKILL.md`
2. Create `<name>/<name>.test.mjs`
3. Create `<name>/package.json` with `test` and `publish` (`clawhub publish ../skills/<name> …`) scripts, and
   `refresh` if the skill bundles static data
4. Add credential paths to Infisical and to `pull-secrets.sh`
5. Add a `<name>/README.md` with any non-trivial implementation notes
6. List the skill in `README.md`, `.claude-plugin/marketplace.json` and `skills.sh.json`

## Skill with static data (HTM pattern)

Skills that bundle a snapshot of external data follow this pattern:
- `skills/<name>/<data>.json` — the bundled snapshot
- `<name>/refresh.mjs` (or similar) — fetches live data and regenerates the snapshot
- `package.json` has `"refresh": "node refresh-*.mjs"`
- A test asserts the bundled snapshot matches live data; when it fails, `npm run refresh` regenerates it

`run.sh` detects the `refresh` script and runs it automatically before escalating to Claude.
