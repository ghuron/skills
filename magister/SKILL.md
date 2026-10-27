---
name: magister
description: "Read a Dutch secondary-school student's Magister (magister.net) data as JSON: timetable (rooster) with homework (huiswerk) and tests (toetsen), grades (cijfers), absences, and inbox messages (berichten); and report a child sick (ziekmelding) with parent credentials. Works with parent (ouder) and student (leerling) accounts. Use when the user asks about a child's school schedule, homework, upcoming tests, grades, absences or school messages, or wants to call a child in sick."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to accounts.magister.net and the school's host. Credentials: MAGISTER_HOST (the school's *.magister.net host), MAGISTER_USER and MAGISTER_PASSWORD, from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/magister.mjs students                       # each student's id and aanmelding_id
node scripts/magister.mjs schedule <id> <from> <to>      # lessons with homework and tests, YYYY-MM-DD dates
node scripts/magister.mjs grades <aanmelding_id> [top]   # grades (default top=50)
node scripts/magister.mjs infractions <id> <from> <to>   # absences
node scripts/magister.mjs messages [top]                 # inbox (default top=25)
node scripts/magister.mjs message <id>                   # one message: body, recipients, attachment names
node scripts/magister.mjs report-sick <id> <date> [note] # report sick (ziekmelding)
```

`messages` and `message` read the inbox of whoever is logged in, and never mark a message as read.

A lesson's `homework` is `null` or `{type, text, done}`. `type` is `homework`, `test`, `exam`,
`quiz`, `oral`, `info`, `note` or `null`; `done` means the student ticked it off.

# Reporting sick

`report-sick` notifies the school and can't be undone from the CLI: confirm the student and the date
with the user before running it. It needs parent credentials and a school that lets parents report
absence. `date` must be today or tomorrow (Europe/Amsterdam) and a weekday; `note` is at most 255
characters.
