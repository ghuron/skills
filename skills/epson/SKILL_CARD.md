# Skill Card

## Description

Agent skill + Node.js CLI for reading ink cartridge levels from an Epson Expression (XP-xxxx) network printer. Requires Node.js with no additional dependencies; uses the printer's built-in unauthenticated HTTP embedded web server (EWS).

## Owner

ghuron — single maintainer, no team.

## License or terms

MIT-0.

## Use case

For Epson printer owners on a local network who want to check remaining ink levels without opening a browser or installing printer software:

- **Check ink before printing.** Quickly see which cartridges are low.
- **Alerting.** Claude or a cron job can call `epson.mjs ink` and notify when any level drops below a threshold.

## Deployment geography

Local network only — the Epson EWS is accessible only from the same LAN segment as the printer. Not internet-facing.

## Risks and mitigations

- **Risk:** The EWS HTML structure is reverse-engineered and can change with printer firmware updates.
  **Mitigation:** End-to-end integration tests run against the real printer with real credentials; regressions surface as test failures.

## References

- `SKILL.md` — command reference and output format.
- `README.md` — verify step required before `parseInkLevels` is usable.

## Skill output

`ink` returns JSON to stdout: array of `{ color, level }` objects where `level` is 0–100 or `null`.

## Skill version

1.0.0

## Ethical considerations

Only use against a printer you own or are authorised to access. The EWS is read-only — no printer settings are changed.
