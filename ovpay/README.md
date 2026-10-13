# ovpay

CLI for **OVpay** (ovpay.nl — the Netherlands' account-based public-transport ticketing).
See [`skills/ovpay/SKILL.md`](../skills/ovpay/SKILL.md) for usage. Reads/stores an offline token (`OVPAY_REFRESH_TOKEN` seed →
`~/.ovpay/tokens.json`); no browser or email code after the one-time `login`.

## Integration tests

```bash
node --test ovpay.test.mjs      # reads OVPAY_REFRESH_TOKEN from repo-root .env
```

## Publishing to clawhub.ai

`npm run publish` publishes `skills/ovpay/`: `ovpay.mjs`, `SKILL.md`, `SKILL_CARD.md`. Test
files, credentials and state stay out of it.

## Non-trivial discoveries

No public API. Everything below was reverse-engineered from the OVpay .NET MAUI Android app and
the ovpay.nl web app, and verified live. It can change without notice — that's what the test is for.

- **Two clients, two API hosts.** OVpay identity is **Keycloak** (realm `ovpay-crm-b2c`). The
  website uses client `ovpayWebClient` against `api.ovpay.nl`; the **mobile app** uses
  `ovpayAppClient` against **`api.ovpay.app`**. A token minted for one host is rejected (403) by the
  other. This skill is the mobile client, so it talks to `api.ovpay.app`.

- **The web token is useless for automation; the mobile token is the whole point.** The web
  (`ovpayWebClient`) access token is a 60-minute Keycloak JWT with **no working refresh** (NextAuth
  hands back the same token until it dies, +5 min ASP.NET clock-skew ⇒ a hard ~65-minute ceiling).
  The mobile (`ovpayAppClient`) flow issues an **offline** refresh token valid ~30 days that
  **slides** (every refresh resets the 30 days) and **rotates**.

- **A WAF (Link11) fronts the login/web hosts, but not the API hosts.** `login.ovpay.nl` and
  `www.ovpay.nl` reject any non-browser TLS fingerprint with `473`, and Keycloak's own `/token`
  endpoint returns `502` for everyone but OVpay's backend — so you cannot do the OAuth token
  exchange directly. **`api.ovpay.app` and `api.identity.ovpay.app` are NOT behind the WAF**: plain
  Node `fetch` works against them, which is why the entire runtime here is dependency-free.

- **Token exchange/refresh go through an identity proxy, not Keycloak directly.**
  `api.identity.ovpay.app/api/external/v1/Identity/{generate-authorization-url, retrieve-token,
  refresh-token}` is a backend-for-frontend that performs the WAF-blocked Keycloak `/token` call
  server-side. The decisive detail: `retrieve-token` is **multipart/form-data** with
  `authorization_flow=App`, `code`, `code_verifier` (no `redirect_uri`); `generate-authorization-url`
  and `refresh-token` are JSON with `authorizationFlow: "App"`. Omitting `authorization_flow` makes
  the proxy exchange as the wrong Keycloak client and Keycloak answers `Found different client_id in
  clientSession` — which looks like a PKCE/redirect bug but is just the missing flow field.

- **The offline token rotates *and invalidates the previous one*.** Each `refresh-token` returns a
  new `refresh_token`; reusing the old one gives `401`. So the newest token must be persisted every
  time (the skill writes it to `OVPAY_STATE`), and the CI test pushes it back to the vault.

- **A fresh `login` revokes the prior offline session.** OVpay keeps one offline session per client,
  so logging in again invalidates the existing `~/.ovpay/tokens.json`. Only `login` when the token
  has actually expired, not casually.

- **Login must use a real (headless) browser.** The WAF runs a JavaScript "passive challenge" on the
  login page that a plain HTTP client can't satisfy, so `login` drives headless Chromium
  (`playwright`). The Keycloak `#emailCode` field **auto-submits on the 6th digit**, navigating the
  page — the fill/submit must tolerate "execution context destroyed". This is the only place a
  browser (and the only extra dependency) is needed; everything else is plain `fetch`.

- **Trips of a "secured" card need a SecureTat step-up token, obtainable with no OTP.** Cards the
  owner secured in the app return `403 "A valid SecureTat access token is required"` on
  `/api/v3/Trips/{xtat}`; for an *already-secured* card the token is minted on demand via
  `POST /api/v1/SecureTat/token/refresh-token {xtat}` (main bearer only — **no email code**) and sent
  as the header **`SecureTatAccessToken: Bearer <token>`** alongside the normal `Authorization`.
  *Unsecured* cards return trips with just the main bearer. Enabling SecureTat on an unsecured card
  (`secure`) is the one flow that needs a one-time emailed code
  (`generate-otp` → `validate-otp {key, otp}` → `token/auth-code {authCode, xtat}`).

- **Trips paginate and fares are eurocents.** `GET /api/v3/Trips/{xtat}?offset=&limit=50`; keep
  requesting until `endOfListReached`. `trip.fare` is an integer in cents; `trip.checkInTimestamp`
  carries the Europe/Amsterdam offset, so date filtering is on the local calendar date.
