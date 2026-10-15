---
name: magister
description: "Read a Dutch secondary-school student's Magister (magister.net) data as JSON: timetable (rooster) with homework (huiswerk) and tests (toetsen), grades (cijfers), absences, and inbox messages (berichten); and report a child sick (ziekmelding) with parent credentials. Works with parent (ouder) and student (leerling) accounts. Use when the user asks about a child's school schedule, homework, upcoming tests, grades, absences or school messages, or wants to call a child in sick."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to accounts.magister.net and the school's *.magister.net host. Credentials via MAGISTER_HOST (the school's magister.net host), MAGISTER_USER and MAGISTER_PASSWORD. Variables can also go in a .env file in the skill folder; variables already set in the environment take precedence."
---
# Commands

```bash
node magister.mjs students                       # list students (works for parent and child credentials)
node magister.mjs schedule <id> <from> <to>      # schedule with homework and tests, YYYY-MM-DD dates
node magister.mjs grades <aanmelding_id> [top]   # grades (default top=50)
node magister.mjs infractions <id> <from> <to>   # absences
node magister.mjs messages [top]                 # inbox of the logged-in account (default top=25)
node magister.mjs message <id>                   # one message: body, recipients, attachment names
node magister.mjs report-sick <id> <date> [note] # report sick (ziekmelding), parent credentials only
```

# Flow

Run `students` first to get each student's `id` and `aanmelding_id`. Use `id` for schedule, infractions and report-sick, `aanmelding_id` for grades.
`messages` and `message` need no student: they read the inbox of whoever is logged in.

# Homework

Each `schedule` lesson has `homework`: `null`, or `{type, text, done}` where `type` is one of
`homework`, `test`, `exam`, `quiz`, `oral`, `info`, `note`, and `done` is whether the student ticked it off.

# Messages

`messages` and `message` only read: they never mark a message as read in Magister.

# Reporting sick

`report-sick` notifies the school and cannot be undone from the CLI. Confirm the student and the date with the user before running it.

- Only works with parent credentials, and only for students whose school allows parents to report absence.
- `date` must be today or tomorrow (Europe/Amsterdam) and a weekday, as in the Magister web app.
- `note` is optional, max 255 characters.
