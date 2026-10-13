# epson

CLI for reading ink cartridge levels from an Epson Expression XP-xxxx network printer. See [`skills/epson/SKILL.md`](../skills/epson/SKILL.md) for usage.

## How the levels are read

`parseInkLevels()` in `skills/epson/epson.mjs` reads the printer's EWS page
(`/PRESENTATION/HTML/TOP/PRTINFO.HTML`, falling back to `/PRESENTATION/ADVANCED/INFO_MENTINFO/TOP`).
Each cartridge is an `<li class='tank'>` with the colour code in `.clrname` and the fill level as the
second stop of a CSS `linear-gradient`. The maintenance box has no `.clrname` and is skipped. The
unit test runs against an XP-8700 fixture.

## Integration tests

```bash
cd epson && npm test
```

Reads `epson/.env` automatically. Run `bash pull-secrets.sh` first to create it.

## Publishing

```bash
cd epson && npm run publish
```

## Non-trivial discoveries

- **Primary EWS URL:** `/PRESENTATION/HTML/TOP/PRTINFO.HTML` (unauthenticated GET, LAN-only).
  A secondary URL exists at `/PRESENTATION/ADVANCED/INFO_MENTINFO/TOP` on some firmware versions.
  The skill tries the primary first and falls back automatically.

- **No auth required:** On typical home/office Epson inkjet configurations the EWS status pages are
  open — no username/password. If the printer has been locked down via the EWS admin settings,
  the fetch will return non-ok and the skill will error clearly.

- **HTML-only, no JSON/XML API:** Consumer Epson inkjet EWS pages have no machine-readable endpoint
  for ink levels. Scraping the HTML is the only option without SNMP.

- **Level encoding varies by firmware:** Some pages report 0-100 integers directly; others encode the
  level as a pixel width of a progress-bar image (requiring a divisor based on the full-width value).
  The 0-100 range assertion in the test detects the latter case during the verify step.
