# budgetthuis

CLI for the "MijnBudget" customer portal of Budget Thuis energy (formerly Budget Energie). See
[`skills/budgetthuis/SKILL.md`](../skills/budgetthuis/SKILL.md) for usage.

## Integration tests

```bash
node --test budgetthuis.test.mjs   # reads BUDGETTHUIS_LOGIN/PASSWORD from .env in this directory
```

## Publishing to clawhub.ai

`npm run publish` publishes `skills/budgetthuis/`: `budgetthuis.mjs`, `SKILL.md`, `SKILL_CARD.md`.
Test files and credentials stay in `budgetthuis/`.

## Non-trivial discoveries

There is no public API. Everything below was reverse-engineered from the live portal (server-rendered
Symfony pages under `mijn.budgetthuis.nl/energie/`, plus a Next.js "retention" app for renewals) and
the Android app (`nl.budgetthuis.app` 3.3.0), and verified against a real account. It can change
without notice, which is what the test is for.

- **Login is a plain form on Duende IdentityServer.** `accounts.budgetthuis.nl` is an
  IdentityServer with an ASP.NET Core login page (`/inloggen`: `Username`, `Password`, `Label`,
  `ReturnUrl`, antiforgery token). No JavaScript or PKCE is needed on our side. The portal is the
  confidential OIDC client (`online` for `/energie`, `onlineDashboard` for the root dashboard,
  `onlineReact` for the Next.js pages), so we just follow redirects: portal → `/connect/authorize` →
  `/inloggen` → POST → `/connect/authorize/callback` → `/energie/oidc/return` → `/energie/overzicht`.
  A wrong password returns the form again with HTTP 200 and a `div.validation-error`.

- **The portal's OIDC callback flakes.** In a few percent of logins, `/energie/oidc/return` answers 500
  ("Oeps! Er ging iets mis"), and requests occasionally die at the network level (`fetch failed`). Both go away on
  retry, so `login()` retries the whole flow up to three times and every request retries network
  errors. A credentials rejection is never retried, to avoid account lockout.

- **Each `/energie` page carries the customer id and an API token.** A hidden
  `<input id="relationId">` holds the "relation" id: the Klantnummer, *not* the `contact_person`
  claim in the JWT. The chat widget's config (`token: 'eyJ…'`) holds a one-hour access token for
  `api.budgetthuis.nl` (scopes include `mobileApi` and `webApi`, so it's the app's API too).

- **`api.budgetthuis.nl` is an Azure API Management gateway.** Unknown paths return a generic
  `{"statusCode":404,"message":"Resource not found"}` whatever the auth, so the API can't be explored
  by guessing. The base URLs (`/energy/v1`, `/home/v1`) come from the Next.js bundle's env config
  (`ENERGY_API_BASE_URL`, `HOME_API_BASE_URL`). Known working endpoints:
  `GET /energy/v1/contractees/{relationId}/contracts` (from the bundle) and
  `GET /energy/v1/contractees/{relationId}/invoices` (found by probing). Passing a contact-person or
  contract id instead of the relation id gives a descriptive 403. Usage, tariff and instalment
  endpoints exist for the app but weren't found, so those come from the HTML pages.
  Invoice dates in the API are US format (`2/1/2026 12:00:00 AM` = 1 February).

- **Daily usage is an AJAX fragment with inline chart data.** The "Mijn verbruik" page reloads via
  `POST /energie/verbruik/overzicht/data/{contractId}/day/{elk|gas|cost}/{YYYY-MM-01}` (the route
  list is public at `/energie/js/routing?callback=fos.Router.setData`), which returns
  `{"html": …}` with the month's rows inlined as `chart.data = [...]` for amCharts. The skill no
  longer uses this (see the app API below), but it is the fallback if that API goes away. Observations:
  - Values are whole kWh / m³. The daily `cost` matches those whole units times the tariff, plus a
    fixed daily share (gas costs about €1.05 even on a 0 m³ day), so the rounding is in the source
    data, not just the display.
  - The `return` usage type returns the same rows as `elk`, which already carries
    `normal_return`/`low_return`.
  - Every finished month has one extra, all-zero row duplicating its last date. We keep the first.
  - Days without a reading (the last 2 or 3 days, days before the contract) are all zero and are
    dropped. Months before the contract return no chart at all.
  - The `week`/`month` period types only render comparison text, no chart data, and hourly data is
    app-only (the page says so).

- **The app's backend is `app.api.nutsservices.nl`, and it takes the portal's token.** The Android
  app is native Kotlin (Retrofit, obfuscated by R8). Its `BaseUrlConfig` string names
  `apiUrl=https://app.api.nutsservices.nl/` (Nuts is Budget Thuis's parent) and
  `authorisationApiUrl=https://accounts.budgetthuis.nl`. No API key or extra header: the bearer
  token scraped from any `/energie` page (it has the `mobileApi` scope) works as is. To list the
  endpoints, extract the DEX string tables for the paths (`energy/v1/contract/{contractId}/…`),
  then walk the DEX method annotations. R8 renamed Retrofit's `@GET`/`@Query`/`@Path` classes, so
  match on annotation *values* that look like API paths. That gives each endpoint's query
  parameter names, e.g. `usagecosts/details(@Path contractId, @Query PeriodDuration,
  @Query PeriodFrom, @Query PeriodTo)`. Sending an invalid value makes the API list the valid
  ones: `PeriodDuration` is `Hour, Day, Week, Month, Year`.

- **`GET /energy/v1/contract/{contractId}/usagecosts/details` is the usage source.** It returns
  `overviewPeriods[].usageCostsPerPeriod[]` with decimal kWh/m³ (`rawUsage`), normal/off-peak
  split, feed-in, and net/VAT/gross costs, with `periodFrom`/`periodTo` in local time with offset.
  `PeriodTo` is exclusive. Behaviour per `PeriodDuration`:
  - `Hour`: one overview period per day (23/25 rows on DST days), any range in one call
    (9 months ≈ 7 MB, ~9 s). Starts on the first full day after the contract start.
  - `Day`/`Week`/`Month`/`Year`: the range is widened to whole months/half-years/years and padded
    with rows whose usage fields are all `null`; the skill trims to the requested dates and drops
    empty rows.
  - Hour, day and month totals agree to the Wh. Costs are usage × all-in tariff only; fixed costs
    have their own endpoint (`fixedCostsPerPeriod`, same parameters).
  - It is fresher than the website (yesterday is usually there; the website lags 2–3 days), and
    recent gas values are `isInterpolated: true` until the final reading.
  Other endpoints that work with the same token: `customer/{contractId}/contract-info` (tariffs as
  JSON), `energy/v2/contract/{contractId}/monthlyAmount` (termijnbedrag and advice as JSON),
  `energy/v2/contract/{contractId}/houseHoldUsage?PeriodFrom&PeriodTo` (average households),
  `home/v1/contactPerson`. The `hourlytariff` endpoints answer 404 unless the contract has dynamic
  (hourly) prices.

- **`/energie/termijnbedrag` redirects to `/energie/wijzigen-termijnbedrag/{contractId}`.** The
  slider's `data-hard-minimum`/`data-hard-maximum` attributes are the allowed range. The form's
  `advance_amount[amount]` input is pre-filled with the *advice*, not the current amount, which is
  only in the `<h1>` next to "Je termijnbedrag". Changing the amount is a plain form POST
  (`advance_amount[amount]` + `advance_amount[_token]`). This skill doesn't do it, to stay read-only.

- **Tariffs only appear in HTML.** `/energie/contracten` has a printable "Tarievenspecificatie" with
  a `div.details` per section (`h3` title, `div.left`/`div.right` pairs). The parser maps the
  section titles it knows to English keys and keeps any other section under its Dutch title, so a
  dynamic or electricity-only contract still comes through, just with Dutch keys.

- **Invoice PDFs are at `/energie/invoice-download/{contractId}/{invoiceId}`.** `invoice` reads
  the exact link from `/energie/facturen` rather than building it, so the right contract is used
  when an account has several.

- **Untested: accounts with several addresses.** The portal has `kies-adres` (choose address)
  routes for that case. `contracts`, `invoices` and `usage` (with a `contractId`) should work, but
  `tariffs` and `termijnbedrag` read whatever the portal shows first.
