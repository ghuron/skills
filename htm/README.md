# htm

CLI for the "Mijn HTM" customer portal (Den Haag public transport). See [`skills/htm/SKILL.md`](../skills/htm/SKILL.md) for usage.

## Integration tests

```bash
node --test htm.test.mjs   # reads .env from repo root
```

## Publishing to clawhub.ai

`npm run publish` publishes `skills/htm/`: `htm.mjs`, `SKILL.md`, `regio-catalog.json`
(read by `regio-advies` at runtime), and `SKILL_CARD.md` (governance card for reviewers — see
https://docs.nvidia.com/skills/skill-cards). Test files and credentials stay in `htm/`.

## Non-trivial discoveries

The portal has no documented/public API. Everything below was reverse-engineered from the
production site (login page HTML + the Vite-bundled JS served under `/dist/assets/`) and
verified against the live site. It can change without notice — that's what `htm.test.mjs`
is for.

- **Login is Azure AD B2C, not a normal form.** `www.htm.nl/Account/Login` redirects to an
  Azure AD B2C "custom policy" (`htmnlb2c.b2clogin.com`, policy
  `B2C_1_ABT-SFA-SignUpSignIn-001`), which is OIDC authorization-code + PKCE with
  `response_mode=form_post`. It looks heavy but the B2C sign-in page itself is a plain HTML
  form — no JS execution needed, just two POSTs and a manual "auto-submit form" relay.

- **The credential field is `email`, not `signInName`.** Every public B2C example uses
  `signInName` as the POST field name for the self-asserted sign-in step. HTM's policy
  renders the field with `"ID":"email"` instead. Posting `signInName` (or omitting the
  `X-Requested-With: XMLHttpRequest` header) gets a generic
  `AADB2C90278 Unable to validate the information provided` — which looks like a CSRF or
  credentials problem but is actually just a wrong field name. Wrong *password* produces a
  different, clearer message ("One of the fields is not entered correctly...").

- **The HATEOAS `links` in the API response are a dead end.** `GetCustomer` /
  `OvPayToken` responses embed `links.get_Trips.href` etc. pointing at
  `https://services.api.htm.nl/abt/touchpoint/1.0/...` — a different host. That API is not
  reachable with the browser session cookie (different origin, no shared auth), and the
  frontend never actually calls it directly. Ignore those links; the frontend's own
  Swagger-generated client (`PortalCustomer`) calls relative paths on `www.htm.nl` itself
  (e.g. `/v1/PortalCustomer/Trips`), authenticated by the same ASP.NET Core session cookie
  set at the end of login. `www.htm.nl` is acting as its own backend-for-frontend; the
  `services.api.htm.nl` links look like leftovers from an older/parallel integration.

- **The JS bundle hardcodes API keys.** `my-HTM-tokens-*.js` and the product-ordering bundle
  send an `X-API-Key` header (value embedded in `api-*.js`, named
  `TEMP_EXPOSED_API_PORTAL_CUSTOMER_KEY` / `TEMP_EXPOSED_API_ORDER_V3_KEY` in the source — the
  "TEMP_EXPOSED" naming suggests HTM's own developers know this is a problem). None of the
  endpoints this CLI uses need either key when the session cookie is sent. Until ~Sep 2026 every
  `/v3/order/*` endpoint required `TEMP_EXPOSED_API_ORDER_V3_KEY`; that check is gone (verified
  on all of them), replaced by the antiforgery requirement below.

- **Mutating order calls need an ASP.NET Core antiforgery pair (since ~Sep 2026).** Every
  non-GET `/v3/order/*` and `/v3/pad/*` call now answers a bare `400` (no detail) unless it carries
  the `.AspNetCore.Antiforgery.*` cookie *and* the matching `RequestVerificationToken` header. Both
  come from any server-rendered page fetched with the session cookie: the cookie via `Set-Cookie`,
  the token embedded as `window.__PERPLEX_DATA__.umbCtx={key:'…',culture:'nl-NL',antiForgeryToken:'…'}`
  (a JS object literal, not JSON). The frontend also sends `X-UMB-KEY`/`X-UMB-CULTURE` from the same
  object, but the API doesn't check them. `orderApiCall()` fetches the pair from `/winkelwagen/`
  lazily, once per session, and only for non-GET calls.

- **Age-based products need the pass owner's birthdate on every order.** Products like Regio Vrij
  "Reductie" list `padBirthDate` in `mandatoryCustomerDataItems`. After the token is attached, the
  line carries a validation `OVPAY_TOKEN_PAD_BIRTHDATE_REQUIRED` — reported under `validations`
  (type `"Remark"`), **not** `validationErrors`, so checking only the latter misses it while the
  cart page refuses checkout (`validContents: false`). The birthdate is already registered on the
  card (OVpay "personal account data"), but it's encrypted: HTM can only read it back via an emailed
  OTP (`GET /v3/pad/generate-otp?xtat=…` then `GET /v3/pad/{xtat}?otp=…`), so each order re-asks
  and matches what you type against the card. Supplying it is
  `POST /v3/pad/customertokens/{customerTokenId}/personalaccountdata` `{"birthdate":"YYYY-MM-DD"}`
  (or `PATCH /v3/pad/customertokens/{personalAccountDataId}/personalaccountdata` once one exists).
  `reorder` does this automatically from `HTM_BIRTHDATE_<tokenId>`.

- **The order/cart API (`/v3/order/*`) is fully scriptable; only payment isn't.**
  `POST /v3/order/initialize` (`{orderLines:[{productId}]}`) creates a draft ("concept") order
  with `payments: []`. Attaching a pass is `POST /v3/order/orderline/{id}/token`
  `{tokenTypeId, ovPayTokenId}`. Both calls return full validation state, so you can confirm an
  order is well-formed before ever reaching a payment screen. The actual payment step is a
  separate, classic server-rendered checkout (`PostModel.PaymentMethod`/`PostModel.Issuer`)
  that hands off to Buckaroo for iDEAL/card — that part requires interactive bank
  authorization and cannot be scripted, so `reorder` stops at the cart and returns a
  `checkoutUrl` to finish manually. The cart page itself (`/winkelwagen/`) only renders contents
  after client-side JS calls this same API — a plain HTTP GET shows an empty shell even though
  the order is real (confirmed via the API directly).

- **A customer effectively has one persistent draft order.** `POST /v3/order/initialize` does
  *not* create a new order if the customer already has one in `concept` status — it just
  returns the existing one, ignoring the `orderLines` you passed. If the matching product isn't
  already on it, you have to explicitly `POST /v3/order/{orderId}/orderline` to add it.

- **Re-attaching a token doesn't replace it — it duplicates it.** Calling
  `POST /v3/order/orderline/{id}/token` a second time with the *same* `ovPayTokenId` adds a
  second `customerTokens` entry rather than being a no-op, and that duplicate then makes the
  next `PATCH` (e.g. changing the date) fail with an opaque `500 UpdateOrderLineOnOrder`. This
  matters because naively re-running an "add to cart" flow would have **silently produced
  multiple billable lines for the same product** if `reorder` always created a fresh line and
  always re-attached the token. `reorder` avoids both: it reuses any existing line for the same
  `productId` (rather than adding a new one) and skips the token-attach call if that exact
  token is already attached — making repeat calls (e.g. to change the date) fully idempotent
  with no risk of duplicate charges.

- **Start dates are capped at ~30 days out.** `PATCH /v3/order/orderline/{id}`
  `{"validFrom":"YYYY-MM-DD"}` lets you set a custom start date (the matching `validUntil` is
  computed automatically, exactly one product-period later) — but anything more than 30 days
  from today gets a `validations` remark `"The start date is too far in the future. The latest
  allowable date is <today+30>"` (the PATCH itself succeeds, so only checking
  `validationErrors` silently lets it through). There's no separate "renew/extend" endpoint and the discount
  product itself has `isRenewable: false` — "prolonging" a subscription is just ordering a new
  instance with `validFrom` set to the day the current one ends, and it can only be placed
  within that 30-day window, not arbitrarily far ahead.

- **Trip `fare` is in eurocents.** Values returned by `/v1/PortalCustomer/Trips` are small
  integers (e.g. `24`, `148`, `246`) — confirmed against an actual bank statement. The CLI
  divides by 100 so `reizen` output is in euros.

- **`reizen` date filtering is local-time, the API is UTC.** `start`/`end` query params are
  UTC instants, but a customer's "day" is Europe/Amsterdam local time. The CLI requests a
  one-day-padded UTC window and then filters precisely by the trip's local checkin date, so
  trips near midnight aren't dropped or duplicated.

- **The "Reisgebied bepalen" map tool's data is a plain, unauthenticated-looking endpoint —
  and it's bundled, not fetched live.** `GET /v1/wipkip/getdata` (session cookie only, no
  `X-API-Key`) returns everything behind the webshop's "Regio Vrij" area picker: `wipKipGeoData`
  (each area's polygon boundary as a list of `{latitude, longitude}` points) and `stopsData`
  (~1250 stops, each with a `stopId` and exact coordinates). That `stopId` is the same one trips
  carry in `checkinLocation`/`checkoutLocation`. Prices per area come from
  `GET /v3/order/product/regions/6` (productId 6 = Regio Vrij). Only 12 of the 25 priced areas have a polygon in `wipKipGeoData` — the
  Den Haag/Delft/Zoetermeer ones (`DH7x`/`HL6x`); the Rotterdam/Voorne-Putten ones
  (`R1x`/`VP8x`/`ZH9x`/`M99`) are presumably served from RET's/EBS's own copy of this tool. Since
  both endpoints only change on HTM's fixed annual pricing/network revision date, `regio-advies`
  reads a bundled `skills/htm/regio-catalog.json` snapshot instead of calling either endpoint per
  invocation — evaluating N family members' passes costs one trip-history fetch per pass, zero
  catalog fetches. A test re-fetches live and fails loudly on
  drift; run `node refresh-regio-catalog.mjs` to regenerate the snapshot when that happens.

- **Several of HTM's named regions are explicit combinations of smaller ones, so the catalog
  stores stop *membership*, not geometry.** All `coverageForTrips()` ever needs is "is this
  stopId inside this region" — coordinates and polygons are a means to compute that once at
  refresh time, not something the runtime path needs, so `regio-catalog.json` only contains each
  region's resolved stop membership. Comparing the 12 regions' stop sets pairwise shows a clean
  containment lattice matching their names (e.g. `DH70 | Den Haag Centrum` ⊆ `DH72 | Den Haag
  Centrum / Leidschendam / Voorburg / Leidschenveen` ⊆ `DH75 | … / Zoetermeer`), and the two
  broadest ones (`HL64`, `HL65`) each contain 10 of the other 11 regions plus 2 stops of their
  own. Repeating a ~1250-entry stop list for every region that's mostly-or-entirely a union of
  others would be ~4x the necessary size, so `buildRegioCatalog()` factors each region into
  `includes` (other regions it fully contains) + `extraStopIds` (its own stops not already
  covered by one of those) — shrinking the bundle from ~150KB (with coordinates/polygons) to
  ~40KB. Because `includes` is computed against *every* other region rather than just direct
  parents, it's already the full transitive closure, so resolving a region's effective stop set
  at runtime is one non-recursive union: its own `extraStopIds` plus the `extraStopIds` of
  everything in `includes` — no polygon math, and no walking a hierarchy.

- **Missed-checkout self-service ("Uitcheck gemist") doesn't work for OV-pas.** HTM's "Mijn
  reizen" page links a `CKO_MISSING`/`CKO_EXPECTED` trip to
  `https://zelfregelen.ovpay.nl/reisoverzicht` with no query parameters at all — you must find
  your own payment reference (`NLOV...`) and amount on your bank statement and enter them
  manually. That OVpay site's bundle (`api.zelfregelen.ovpay.nl`) does contain a full OV-pas
  path (`getPaymentsByOvPas`, `putTripCorrectionOvPas`, using the card's printed number +
  sequence code instead of a bank reference), but it's gated by a remote feature flag
  (`featureFlagOVPasSearchEnabled`) that's currently off, and the `PUT tripcorrection/{xbot}/…`
  call needs an `xbot` id that HTM's own `TripDetails` returns as `null` even for a live
  `CKO_EXPECTED` trip. Both the bank-card and OV-pas paths are also reCAPTCHA-gated. Net
  result: there's no working self-service or scriptable route for an OV-pas missed checkout
  right now — only HTM/OVpay customer service.
