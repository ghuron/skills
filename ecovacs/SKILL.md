---
name: ecovacs
description: "Read and control an Ecovacs DEEBOT robot vacuum and mop through the Ecovacs cloud, as the ECOVACS HOME app does: state (cleaning, paused, returning, docked, washing or drying the mop at an OMNI station), battery, errors, suction and mopping water level, the running or last job, cleaning history, rooms on the map, and consumables (main and side brush, filter, mop pads, dust bag) with percent and hours left; start cleaning the whole home or chosen rooms, pause, resume, stop, send it back to the dock, make it say \"I'm here\", set suction power and water level. Use when the user asks about their robot vacuum, DEEBOT or Ecovacs, wants it to vacuum or mop (everywhere or some rooms), pause, stop or go home, asks whether it's done, stuck or charged, when it last cleaned, or which brush, filter, mop pad or dust bag to replace."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to gl-nl-api.ecovacs.com, gl-nl-openapi.ecovacs.com and portal-eu.ecouser.net; an Ecovacs account registered in the Netherlands, and a DEEBOT on Ecovacs' current (MQTT) platform, not the Deebot 900 / Ozmo 930 era XMPP one. Tested on the DEEBOT X1 OMNI. Env: ECOVACS_SESSION (set by `login`), ECOVACS_EMAIL (the account's email address, for `login`), and ECOVACS_ROBOT (a robot's name or id) when the account has several, from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node ecovacs.mjs login                  # email a verification code to ECOVACS_EMAIL
node ecovacs.mjs login <code>           # verify with the emailed code; saves the session
node ecovacs.mjs robots                 # robots on the account: name, model, id, online
node ecovacs.mjs status                 # state, battery, errors, suction, water, job, station
node ecovacs.mjs consumables            # parts with percent and cleaning hours left
node ecovacs.mjs history [count]        # cleaning jobs, newest first (default 10)
node ecovacs.mjs rooms                  # rooms on the map in use: id, name
node ecovacs.mjs clean [room,...]       # start cleaning the whole home, or rooms by id: clean 0,2
node ecovacs.mjs pause | resume | stop  # the running job
node ecovacs.mjs dock                   # go back to the station
node ecovacs.mjs locate                 # the robot says "I'm here"
node ecovacs.mjs suction <level>        # quiet, standard, max or max+
node ecovacs.mjs water <level>          # low, medium, high or ultrahigh mopping water
```

Every command prints JSON. `clean`, `pause`, `resume`, `stop`, `dock` and `locate` make the robot
move or talk at once, so run them only when the user asks. `suction` and `water` change the robot's
settings, as the app does.

# Auth

The robot listens on no port; everything goes through the Ecovacs cloud. Ecovacs verifies each new
client by email: `login` gets a code sent from noreply@support.ecovacs.com, subject "ECOVACS
verification code" (valid 24 hours), and `login <code>` saves the session as `ECOVACS_SESSION` in the
skill's `.env`. No password is needed, and the session can be copied to other machines. How long it
lasts is not known yet. Once it stops working, commands fail with "run `node
ecovacs.mjs login`". Ecovacs limits how many code emails it sends, so don't ask for codes in a loop.

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
