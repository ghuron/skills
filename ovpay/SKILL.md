---
name: ovpay
description: "Read an OVpay account (checking in and out with a bank card or OV-pas on Dutch trains, trams, buses and metro): cards, balances, trip history with fares, CSV export; finds and corrects missed check-outs (uitchecken vergeten); turns on trip-history protection. Use when the user asks about Dutch public transport trips or costs, travel expense claims, a forgotten check-out or a too-high fare, or OVpay history."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to api.ovpay.app and api.identity.ovpay.app (login.ovpay.nl for `login`). Env: OVPAY_REFRESH_TOKEN (seed token), OVPAY_STATE (token file, default ~/.ovpay/tokens.json), OVPAY_EMAIL and OVPAY_PASSWORD (optional, for `login`), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/ovpay.mjs cards                                 # name, xtat, balance (EUR), status
node scripts/ovpay.mjs customer                              # account profile
node scripts/ovpay.mjs trips <card> [from] [to]              # trips, newest first; no dates = full history
node scripts/ovpay.mjs export <card> <file.csv> [from] [to]  # trips to CSV; prints {file, trips}
node scripts/ovpay.mjs get <path>                            # raw GET against https://api.ovpay.app
node scripts/ovpay.mjs correction <card> <tripId>            # can a missed check-out be corrected; stops to choose
node scripts/ovpay.mjs correct <card> <tripId> <stop>        # correct it to that stop (name or code); see below
node scripts/ovpay.mjs secure <card>                         # turn on trip-history protection (SecureTat; emailed code)
node scripts/ovpay.mjs login                                 # one-time login (emailed code)
```

`<card>` is a `name` (as personalised in the app, e.g. `Emma`) or `xtat` from `cards`. Dates are
YYYY-MM-DD, local (Europe/Amsterdam) and inclusive. Fares are in euros. Output is JSON. Each trip
has an `id` and a `status`: `complete`, `missingCheckOut` or `corrected` (with `originalFareEur`).

# Missed check-outs

A trip with `status: missingCheckOut` was charged without a check-out; on bus, tram and metro
that is usually the €4 boarding fare. `correction` says whether it can still be fixed: `status`
is `Correctable`, `Expired` (the `window` closed, about two months after the trip) or
`NotSupported` (NS trains, among others, go through the operator). `remaining` is how many
corrections are left in the operator group until its end date (3 per year for bus/tram/metro),
and `stops` are the check-out stops to choose from.

`correct` sets the check-out to that stop and OVpay recalculates the fare. It can't be undone and
uses one of the limited corrections, so first ask the user which stop they got off at and confirm
the card, trip and stop. Don't correct a trip that cost nothing (`fareEur: 0`, e.g. covered by a
subscription): nothing comes back and a correction is gone. "Halte Onbekend" (unknown stop) is a
last resort.

# Auth

Uses the OVpay app's offline token, so calls need no email code. `login` creates it, or it is
seeded from `OVPAY_REFRESH_TOKEN`; either way it is kept in `OVPAY_STATE`. It **rotates on every
refresh** and the previous token stops working, so keep that file persistent.

`login` prompts for the emailed 6-digit code, and for email and password unless `OVPAY_EMAIL` and
`OVPAY_PASSWORD` are set. It revokes the previous offline session, so run it only on first use or
once the token has expired (~30 days idle).
