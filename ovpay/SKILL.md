---
name: ovpay
description: "Read an OVpay account (check in and out with a bank card or OV-pas on Dutch public transport: trains, trams, buses, metro; ovpay.nl): cards, balances, profile and full trip history with fares, and export trips to CSV, for example for expense claims or travel-cost overviews. Use when the user asks about Dutch public transport trips, OV costs, check-ins and check-outs, or OVpay travel history."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to api.ovpay.app and api.identity.ovpay.app (login.ovpay.nl for `login`). Seed token via OVPAY_REFRESH_TOKEN; the rotating token is kept in OVPAY_STATE (default ~/.ovpay/tokens.json). Variables can also go in a .env file in the skill folder; variables already set in the environment take precedence."
---
# Commands

```bash
node ovpay.mjs cards                               # cards: name, balance (EUR), status, xtat
node ovpay.mjs customer                            # account profile
node ovpay.mjs trips <card> [from] [to]            # trips; card = name or xtat; dates YYYY-MM-DD (inclusive)
node ovpay.mjs export <card> <file.csv> [from] [to]  # trips to CSV
node ovpay.mjs get <path>                          # raw GET against https://api.ovpay.app
node ovpay.mjs secure <card>                        # enable SecureTat on a card (one-time email OTP)
node ovpay.mjs login                               # one-time login (asks for the emailed code)
```

All commands print JSON to stdout (`export` writes the file and prints `{file, trips}`).

# Flow

Run `cards` first — each card has a `name` (as personalised in the app, e.g. `Emma`) and an
`xtat` id. Use either as `<card>` for `trips`/`export`/`secure`.

`trips` dates are local (Europe/Amsterdam) calendar dates, inclusive, newest first. Omit them for
the full history. Fares are in euros.

# Auth

Uses the OVpay mobile app's **offline** token: log in once, then every call is headless with no
email code. The token lives in `OVPAY_STATE` (default `~/.ovpay/tokens.json`); on first use it is
seeded from `OVPAY_REFRESH_TOKEN`. It **rotates on every refresh** (the previous token is
invalidated), so the newest one is always written back to `OVPAY_STATE` — keep that file persistent.
`login` (re)creates it when it finally expires (~30 days idle): it signs in with `OVPAY_EMAIL` and
`OVPAY_PASSWORD` over plain HTTP and asks for the emailed 6-digit code.

# SecureTat (trips of secured cards)

A card you secured in the OVpay app needs an extra step-up token to read its trips — `trips`
fetches it automatically with **no** email code. For an unsecured card, trips work with no extra
step. `secure <card>` turns security on for a card (one-time emailed code).
