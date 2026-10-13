# magister

CLI for the [Magister](https://magister.net) school portal (🇳🇱). See [`skills/magister/SKILL.md`](../skills/magister/SKILL.md) for usage.

## Integration tests

```bash
node --test magister.test.mjs   # reads .parent.env and .child.env from this directory
```

The `report-sick` test runs under `dry-run.mjs`, which refuses every non-login POST, so the suite
never actually reports anyone sick.

## report-sick

Mirrors the web app's *Afwezigheid → Meld afwezigheid* (`ziekmeldenController` in the `aanwezigheid` chunk):

- `GET /api/personen/{id}/absenties` carries a `Links` entry with `Rel: "absentiemelding"` only when
  the school lets parents report absence for that student. No link, no ziekmelding.
- `POST` to that link (`/api/leerlingen/{id}/absentiemeldingen`) with
  `{ begin, einde, opmerking }`: `begin` is local midnight of the chosen day, `einde` the next
  midnight, both as UTC ISO strings. `opmerking` is max 255 characters.
- The web app only offers today or tomorrow, weekdays only. The CLI enforces the same rule.
- The regular token scope (`attendance.overview`) is enough. Errors come back as 400 with an
  `omschrijving`, which the CLI shows.

## schedule homework

Homework lives on the lessons from `/api/personen/{id}/afspraken`: `Inhoud` (HTML), `InfoType`
(1 huiswerk, 2 proefwerk, 3 tentamen, 4 schriftelijke overhoring, 5 mondelinge overhoring,
6 informatie, 7 aantekening) and `Afgerond`.

## messages

The web app's messages page is a separate Angular app at `/magister-berichten/`:

- Inbox: `GET /api/berichten/postvakin/berichten?top=&skip=`. Folders with unread counts: `/api/berichten/mappen/alle`.
- One message: `GET /api/berichten/berichten/{id}`, attachments via its `links.bijlagen`
  (each has a `links.download`).
- The web app marks a message read with a separate
  `PATCH /api/berichten/berichten` (`{berichten: [{berichtId, operations: [{op: "replace", path: "/IsGelezen", value: true}]}]}`)
  after opening it, so the GETs leave read status alone.

## Publishing to clawhub.ai

```bash
npm run publish
```

Publishes `skills/magister/`. Test files and credentials stay in `magister/`.
