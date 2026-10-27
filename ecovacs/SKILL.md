---
name: ecovacs
description: "Read and control an Ecovacs DEEBOT robot vacuum and mop: status, battery, errors, cleaning history, rooms, and how long brushes, filter, mop pads and dust bag have left; start cleaning everywhere or chosen rooms, pause, stop, send it to the dock, set suction and water. Use when the user asks about their robot vacuum, DEEBOT or Ecovacs, wants it to vacuum or mop, stop or go home, asks whether it's done, stuck or charged, or which part to replace."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to gl-nl-api.ecovacs.com, gl-nl-openapi.ecovacs.com and portal-eu.ecouser.net; an Ecovacs account registered in the Netherlands and a DEEBOT on the current (MQTT) platform, not the older XMPP one (Deebot 900, Ozmo 930). Tested on the DEEBOT X1 OMNI. Env: ECOVACS_SESSION (set by `login`), ECOVACS_EMAIL (for `login`) and ECOVACS_ROBOT (name or id, if several), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/ecovacs.mjs login                  # email a verification code to ECOVACS_EMAIL
node scripts/ecovacs.mjs login <code>           # verify with the emailed code; saves the session
node scripts/ecovacs.mjs robots                 # robots on the account: name, model, id, online
node scripts/ecovacs.mjs status                 # state, battery, errors, suction, water, job, station
node scripts/ecovacs.mjs consumables            # parts with percent and cleaning hours left
node scripts/ecovacs.mjs history [count]        # cleaning jobs, newest first (default 10)
node scripts/ecovacs.mjs rooms                  # rooms on the map in use: id, name
node scripts/ecovacs.mjs clean [room,...]       # start cleaning the whole home, or rooms by id: clean 0,2
node scripts/ecovacs.mjs pause | resume | stop  # the running job
node scripts/ecovacs.mjs dock                   # go back to the station
node scripts/ecovacs.mjs locate                 # the robot says "I'm here"
node scripts/ecovacs.mjs suction <level>        # quiet, standard, max or max+
node scripts/ecovacs.mjs water <level>          # low, medium, high or ultrahigh mopping water
```

Every command prints JSON. `clean`, `pause`, `resume`, `stop`, `dock` and `locate` make the robot
move or talk at once, so run them only when the user asks. `suction` and `water` change the robot's
settings, as the app does.

# Auth

The robot listens on no port; everything goes through the Ecovacs cloud. Ecovacs verifies each new
client by email: `login` gets a code sent from noreply@support.ecovacs.com, subject "ECOVACS
verification code" (valid 24 hours), and `login <code>` saves the session as `ECOVACS_SESSION` in the
skill's `.env`. No password is needed, and the session can be copied to other machines. How long it
lasts is not known yet. Once it stops working, commands fail with "run `node scripts/ecovacs.mjs
login`". Ecovacs limits how many code emails it sends, so don't ask for codes in a loop.

# Output notes

`status.state`: `docked` (on the station, charging), `idle` (off the station, doing nothing),
`cleaning`, `paused`, `returning`, `washing`, `drying` or `error`. With an OMNI station every job
starts with `washing` (the station washes the mop pads for a minute or more before the robot leaves),
and after a job the station dries the pads for hours with the robot docked (`drying`). `errors` are
the robot's current errors; `station.errors` the station's, where 314 is permanent on stations without
the auto-water kit and can be ignored. `job` is the running job once the robot is under way, otherwise
the last one: `type` is `all`, `rooms` or `zone`, `area` in m².

`consumables`: `percent` is the life left as the app shows it, `hoursLeft` the cleaning hours left.
`unit care` is the reminder to clean the robot's sensors, wheels and charging contacts. Parts the robot
doesn't have are left out.

`history`: `result` is `finished`, `stopped` (by hand) or `finished with warnings`. Jobs that ended
before the robot left the station are not listed.

`rooms`: `id` is what `clean` takes. `name` is the name or room type set in the app, or null for rooms
nobody named; if the user refers to a room by name and none match, ask them to name rooms in the app.
`clean` with rooms uses the app's number of passes. Rooms are those of the map in use (the current
floor).
