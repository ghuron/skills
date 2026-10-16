---
name: htm
description: "Manage an HTM account (The Hague / Den Haag public transport, htm.nl 'Mijn HTM'): list passes (OV-pas and contactless bank cards), active and expired products and subscriptions, and trip history; check whether a Regio Vrij flat-rate subscription would pay off given past trips; put a product such as HTM 20% Korting in the cart to renew it (payment stays manual). Use for HTM tram and bus subscriptions, travel costs or trip history in Den Haag."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to www.htm.nl and htmnlb2c.b2clogin.com (login). Credentials: HTM_LOGIN and HTM_PASSWORD (the Mijn HTM account), optional HTM_BIRTHDATE_<tokenId> for age-based products, from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node htm.mjs passes                                                  # passes (bank cards and OV-passen)
node htm.mjs products <tokenId>                                      # a pass's active and inactive products
node htm.mjs reizen <tokenId> <from> <to>                            # a pass's trips
node htm.mjs regio-advies <tokenId>[,<tokenId>...] <from> <to> [age] # would a Regio Vrij area pass pay off?
node htm.mjs reorder <tokenId> <productId> [validFrom]               # put a product in the cart
```

`<tokenId>` is a pass's `id` from `passes`. Dates are YYYY-MM-DD, local (Europe/Amsterdam) and
inclusive.

`regio-advies` compares, for each Regio Vrij area, the monthly fares of the trips that both start
and end inside it with the area's monthly price. Only the DH7x and HL6x areas are included, not
the Rotterdam ones. `age` picks the price tier: `Adult` (default), `Senior`, `Teenager` or
`Child`. Several comma-separated `tokenId`s (e.g. the whole family) give one result per pass, in
order.

`reorder` puts a product (an `id` from `products` or `regio-advies`, e.g. `5` = HTM 20% Korting) in
the HTM cart for that pass. It never pays: the user finishes checkout in a browser at the
`checkoutUrl` it prints. `totalAmount` is the whole cart's. `validFrom` can be at most ~30 days
ahead; without it a new cart line starts today. Re-running for the same pass and product updates
that line instead of adding another; lines for other passes are left alone.

Age-based products (e.g. Regio Vrij "Reductie") need the pass owner's birthdate on every order: set
`HTM_BIRTHDATE_<tokenId>=YYYY-MM-DD`, or `reorder` fails and names the variable.
