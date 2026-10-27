# Weekly self-healing test run on a home box

Goal: every Monday around 03:00, a Linux box at home runs **all** integration tests, including the ones
that need the owner's mailbox. When a skill breaks because a service changed, Claude (on the owner's
subscription) fixes it and opens a pull request. Anything it can't fix, or that needs a human, becomes
a GitHub issue.

Status: the design is agreed, nothing in it is built yet. The repo is public, so nothing in this file, in
issues or in pull requests may contain personal data (see `AGENTS.md`).

## Why not GitHub Actions

`.github/workflows/integration.yml` ran the tests on every push until 2026-10-26, when it was deleted.
It worked, but it couldn't cover enough:

- **IP blocks.** `mijn.budgetthuis.nl` answers GitHub's runners (Microsoft network, US) with
  `403 Forbidden – Request forbidden by administrative rules`. Its login server and APIs answer
  normally. Other Dutch services may follow.
- **Home network.** The Epson printer is only reachable on the LAN.
- **Mailbox.** Login flows need emailed links or codes.
- **OVpay's token** can't be shared with an ephemeral runner (see below).

Until the box runs, nothing runs the integration tests automatically. GitHub only runs
`.github/workflows/spec.yml`, which checks each `SKILL.md` against the Agent Skills spec.

## Decisions

| Topic | Decision |
|---|---|
| Where | A Linux box at home (residential Dutch IP, on the LAN) |
| When | Mondays ~03:00 Europe/Amsterdam, systemd timer |
| Claude | `claude -p` on the owner's subscription, via `claude setup-token` |
| Fixes | On a branch, as a pull request; never pushed to `main` unreviewed |
| Mailbox | Gmail API, read-only scope, through a helper script; Claude never reads mail itself |
| OVpay | The skill owns the session; the OVpay phone app is not used |
| Day-to-day use | Claude sessions on another machine use the skills too, for now |

## What the services do (findings, 2026-10)

### Budget Thuis: email link, then a shareable 90-day session

- No password login any more. `/inloggen` redirects to `/inloglink-aanvragen`, which emails a link.
  A password POST to `/inloggen` is redirected there too, and appears to trigger a link email.
- The email comes from `noreply@budgetthuis.nl`, subject "Uw persoonlijke inloglink". Its
  "Direct inloggen" button is a `links.budgetthuis.nl` click-tracking redirect to
  `mijn.budgetthuis.nl/autologin/general_auto_login/?token=…&email=…`. The link works for 30 days,
  more than once, and without cookies from the request.
- Following it sets `.AspNetCore.Identity.Application` on `accounts.budgetthuis.nl`, persistent for
  90 days. That cookie alone gets through the portal's OIDC round trip with no form. Newer logins
  don't end older sessions, so copies can be shared between machines.
- **Done:** `budgetthuis.mjs` has `login` (request link) and `login <link>` (save
  `BUDGETTHUIS_SESSION` to `.env`). The session is in Infisical at `/budgetthuis`. The current one
  expires on 2027-01-14.

### OVpay: one rotating token, one session

- The skill uses the Android app's offline refresh token. **Every refresh issues a new one and
  invalidates the old one**, and it dies after ~30 days unused.
- A new login ends the previous session (one per client). On 2026-10-16 a login in the phone app
  revoked the skill's token: refresh returned 401 well before expiry. **The token on the
  day-to-day machine is dead now.**
- `ovpay.mjs` exports `login({ email, password, codeCb })`. `codeCb` is called with no arguments
  and returns the emailed 6-digit code, so a script can log in unattended. The code email's
  sender and subject are not known yet: find them on the first login.

### Everything else

| Skill | Credentials | Notes |
|---|---|---|
| htm | password | Tests add a product to the cart and remove it. `.ci/htm/refresh.mjs` refreshes the bundled region catalogue |
| magister | password (parent and child accounts) | Sick report runs as a dry run (`.ci/magister/dry-run.mjs`) |
| epson | none | Needs `EPSON_HOST`; there's no `/epson` folder in Infisical yet |
| ecovacs | emailed code once, then a session | `login` / `login <code>` save `ECOVACS_SESSION`; tests only read, never move the robot; no `/ecovacs` folder in Infisical yet |
| ah | browser sign-in once (captcha), then a session | `login` / `login <code>` save `AH_SESSION`; its refresh token changes on every renewal (about weekly), so like OVpay each machine signs in on its own and it doesn't go in Infisical. The `csv` test needs invoice PDFs in `.ci/ah/.fixtures/` (gitignored); `parse_invoice.py` needs `python3` with `pypdf` |
| abn-amro | none | Offline |

## Design

### OVpay with two holders: self-healing logins

The day-to-day machine and the box each keep their own `~/.ovpay/tokens.json`. Whichever finds its
token dead logs in again with the emailed code, which ends the other's session. The other side does
the same next time it runs. That costs about one email per switch and needs no lock and no shared
state. So:

- Remove `OVPAY_REFRESH_TOKEN` from Infisical, and the test "persist rotated offline token back to the
  vault" from `.ci/ovpay/ovpay.test.mjs`.
- Never run two OVpay logins at once on one machine. The weekly job takes a `flock`.

### Mail helper

`.ci/mail.mjs`, Node with no npm dependencies, like the skills:

- `node .ci/mail.mjs budgetthuis-link --since <epoch>` prints the "Direct inloggen" URL.
- `node .ci/mail.mjs ovpay-code --since <epoch>` prints the 6 digits.

It polls for up to ~3 minutes, filters on sender and arrival time, and prints only a value that
matches a strict pattern (`https://links.budgetthuis.nl/…`, `^\d{6}$`). No mail content reaches
Claude or the logs. That narrows prompt injection through email, and doesn't depend on whether
claude.ai connectors exist in headless mode (unverified).

- **OAuth:** a Desktop OAuth client with scope `https://www.googleapis.com/auth/gmail.readonly`.
  Exchange the refresh token at `https://oauth2.googleapis.com/token`.
- **Search:** `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:<sender> after:<epoch>`,
  then `…/messages/<id>?format=full`. Bodies are base64url; the link is in the HTML part.
- **Credentials:** `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` in Infisical at
  `/gmail`. `pull-secrets.sh` writes them to `.ci/.env`, which `.*` in `.gitignore` already ignores
  (check with `git check-ignore`).
- **One-time setup:** `.ci/gmail-auth.mjs` runs a loopback redirect on 127.0.0.1, opens the consent
  page, exchanges the code and writes `GMAIL_REFRESH_TOKEN` to Infisical.
- **Lifetime:** the refresh token lasts until revoked, until the Google password changes, or 6
  months unused. In "Testing" publishing status Google expires it after **7 days**, so the app must
  be published ("In production"). It stays unverified, with a one-time warning screen; that's fine
  for personal use.

### Renewals

- **`.ci/budgetthuis/renew.mjs`:** when the session expires within 30 days (keep
  `BUDGETTHUIS_SESSION_EXPIRES` next to it in Infisical), or the portal rejects it:
  1. `requestLink()`
  2. `mail.mjs budgetthuis-link`
  3. `completeLink()`
  4. write `BUDGETTHUIS_SESSION` and `_EXPIRES` to Infisical with `infisical secrets set … --type=shared`

  Other machines pick the new session up on their next `pull-secrets.sh`; their old one keeps working
  until it expires.
- **`.ci/ovpay/relogin.mjs`:** if `refresh()` fails, `login({ codeCb })` with `codeCb` calling
  `mail.mjs ovpay-code`. Usable on both machines; the day-to-day agent can run it whenever ovpay
  says "run login".

### The weekly job (evolve `.ci/run.sh`)

1. `flock` so runs never overlap. `git checkout main && git pull --ff-only`.
2. `source .ci/pull-secrets.sh`. Machine identity credentials come from the systemd
   `EnvironmentFile`.
3. Renewals: `budgetthuis/renew.mjs`, `ovpay/relogin.mjs`.
4. Run every skill's tests and keep the results per skill.
5. For each failing skill:
   - static-data refresh if there is one (HTM)
   - otherwise Claude on branch `ci/fix-<skill>-<YYYY-MM-DD>`
   - re-run its tests; if green, push the branch and run `gh pr create`
   - if not, open or update an issue for that skill with test names only (public!)
6. Post a summary (skill: pass/fail/renewed/fixed) as a comment on one pinned "Weekly run" issue.
   A week with no comment means the box didn't run.

The Claude fix step today (`--allowedTools "Edit,Bash" --max-turns 10`) is too small for real
breakage. The Budget Thuis fix took probing the login server, an emailed link and a redesign. Give it:

- Read/Edit/Write/Bash/WebFetch, around 40 turns.
- A prompt with the failing output (local only), `AGENTS.md`, the mail helper's usage, and an
  instruction to explain the change in the PR description without personal data.
- Its output is a pull request, so a human reviews everything before it reaches `main`.

Run the whole job as a dedicated user on the box that has only this repo and these secrets.

### systemd (`.ci/systemd/`)

- **`skills-weekly.service`:** `Type=oneshot`, `EnvironmentFile=%h/.config/skills-ci/env`
  (`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN`, mode 600),
  `ExecStart=%h/skills/.ci/run.sh`, `TimeoutStartSec=2h`.
- **`skills-weekly.timer`:** `OnCalendar=Mon *-*-* 03:00:00 Europe/Amsterdam`, `Persistent=true`, so
  a run missed while the box was off happens at the next boot.
- Install as user units, with `loginctl enable-linger <user>` so they run without a login session.

## Credentials

| Credential | Where | Lifetime | Renewal |
|---|---|---|---|
| Claude (`claude setup-token`) | box env file | long-lived (check what it prints) | owner, about yearly |
| Infisical machine identity (Universal Auth) | box env file | no expiry (client secret TTL 0) | none |
| GitHub fine-grained PAT: contents, pull requests, issues (read/write), this repo only | Infisical `/` `GITHUB_TOKEN` (`pull-secrets.sh` already sets up git; export `GH_TOKEN` for `gh`) | up to 1 year | owner |
| Gmail OAuth client and refresh token | Infisical `/gmail` | until revoked (app must be "In production") | none |
| Budget Thuis session | Infisical `/budgetthuis` | 90 days | `renew.mjs`, automatic |
| OVpay offline token | `~/.ovpay/tokens.json` on each machine | rotates every use; ~30 days idle | `relogin.mjs`, automatic |
| HTM, Magister passwords | Infisical | until changed | none |

## Steps

**Owner, now:**
1. Google Cloud Console: create a project, enable the Gmail API, configure the OAuth consent
   screen (External) and **publish it**, then create a Desktop OAuth client. Put its ID and secret in
   Infisical at `/gmail`.
2. Infisical cleanup: delete `BUDGETTHUIS_PASSWORD` (unused since the email-link login). Delete
   `OVPAY_REFRESH_TOKEN` once step 4 below is done. Add `/epson` with `EPSON_HOST` for the box.

**Build, testable on any machine:**

3. `.ci/gmail-auth.mjs` and `.ci/mail.mjs`; `pull-secrets.sh` writes `/gmail` to `.ci/.env`.
   Done when `mail.mjs budgetthuis-link` returns a link after `budgetthuis.mjs login`.
4. `.ci/ovpay/relogin.mjs`; drop the vault write-back test. Done when ovpay works again on the
   day-to-day machine and the code email's sender is recorded in `mail.mjs`.
5. `.ci/budgetthuis/renew.mjs`. Done when a forced renewal updates Infisical and the tests pass
   with the new session.
6. The weekly `run.sh`: PRs, issues and the summary comment. Done when a deliberately broken skill
   on a test branch produces a pull request, and an unfixable one an issue.

**Owner, on the box:**

7. Install Node 22+, git, `gh`, `python3` with `pypdf`. Clone the repo, run `.ci/bootstrap.sh`, run
   `claude setup-token`, write `~/.config/skills-ci/env`, copy the AH invoice PDFs and their
   expected CSVs to `.ci/ah/.fixtures/`.

**Build:**

8. `.ci/systemd/` units and `bootstrap.sh` installing them. Done when
   `systemctl --user start skills-weekly` runs end to end and the timer shows next Monday.
9. Delete the GitHub secrets `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `_SECRET`: nothing has used
   them since `integration.yml` went.

## Gotchas met so far

- `infisical secrets delete` deletes a *personal* secret unless given `--type=shared`.
- The Infisical CLI reads `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `_SECRET` itself. For the EU
  instance pass `--domain=https://eu.infisical.com/api`.
- `.gitignore` starts with `.*`: any new dotfolder that should be committed needs a `!` line.
- `gh secret set NAME` reads an empty value without complaint when there's no terminal, for
  example through `!` in Claude Code. Set secrets on the web, or in a real terminal.
- `node --test` failure output contains real account data (assertion values, CLI stderr). Keep it
  out of anything public: issues, PR descriptions, Actions logs.
