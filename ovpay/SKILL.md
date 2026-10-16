---
name: ovpay
description: "Read an OVpay account (check in and out with a bank card or OV-pas on Dutch public transport: trains, trams, buses, metro; ovpay.nl): cards, balances, profile and full trip history with fares, and export trips to CSV, for example for expense claims or travel-cost overviews; can also turn on trip-history protection (SecureTat) for a card. Use when the user asks about Dutch public transport trips, OV costs, check-ins and check-outs, or OVpay travel history."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to api.ovpay.app and api.identity.ovpay.app (login.ovpay.nl for `login`). Env: OVPAY_REFRESH_TOKEN (seed token), OVPAY_STATE (token file, default ~/.ovpay/tokens.json), OVPAY_EMAIL and OVPAY_PASSWORD (optional, for `login`), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node ovpay.mjs cards                                 # name, xtat, balance (EUR), status
node ovpay.mjs customer                              # account profile
node ovpay.mjs trips <card> [from] [to]              # trips, newest first; no dates = full history
node ovpay.mjs export <card> <file.csv> [from] [to]  # trips to CSV; prints {file, trips}
node ovpay.mjs get <path>                            # raw GET against https://api.ovpay.app
node ovpay.mjs secure <card>                         # turn on trip-history protection (SecureTat; emailed code)
node ovpay.mjs login                                 # one-time login (emailed code)
```

`<card>` is a `name` (as personalised in the app, e.g. `Emma`) or `xtat` from `cards`. Dates are
YYYY-MM-DD, local (Europe/Amsterdam) and inclusive. Fares are in euros. Output is JSON.

# Auth

Uses the OVpay app's offline token, so calls need no email code. `login` creates it, or it is
seeded from `OVPAY_REFRESH_TOKEN`; either way it is kept in `OVPAY_STATE`. It **rotates on every
refresh** and the previous token stops working, so keep that file persistent.

`login` prompts for the emailed 6-digit code, and for email and password unless `OVPAY_EMAIL` and
`OVPAY_PASSWORD` are set. It revokes the previous offline session, so run it only on first use or
once the token has expired (~30 days idle).
