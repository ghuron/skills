---
name: mova
description: "Read and control a MOVA robot vacuum and mop (MOVAhome app): status, battery, errors, the station's water tanks, cleaning history, rooms, and how long brushes, filter and sensors have left; start cleaning everywhere or chosen rooms, pause, stop, send it to the dock, set suction and water. Use when the user asks about their MOVA robot vacuum, wants it to vacuum or mop, stop or go home, asks whether it's done, stuck or charged, or which part to replace."
license: MIT-0
compatibility: "Requires Node.js 22+ and network access to eu.iot.mova-tech.com (port 13267); a MOVAhome account in the EU region with a password (not only Google or Apple sign-in). Tested on the MOVA E50 Pro Ultra. Env: MOVA_EMAIL and MOVA_PASSWORD, and MOVA_ROBOT (name or id, if several), from the environment or a .env in the skill folder (the environment wins)."
---
# Commands

```bash
node scripts/mova.mjs robots                 # robots on the account: name, model, id, online
node scripts/mova.mjs status                 # state, battery, errors, suction, water, job, station
node scripts/mova.mjs consumables            # parts with percent and cleaning hours left
node scripts/mova.mjs history [count]        # cleaning jobs, newest first (default 10)
node scripts/mova.mjs rooms                  # rooms on the saved map in use: id, name
node scripts/mova.mjs clean [room,...]       # start cleaning the whole home, or rooms by id: clean 1,3
node scripts/mova.mjs pause | resume | stop  # the running job
node scripts/mova.mjs dock                   # go back to the station
node scripts/mova.mjs locate                 # the robot says "I'm here"
node scripts/mova.mjs suction <level>        # quiet, standard, strong or max
node scripts/mova.mjs water <level>          # low, medium or high mopping water
```

Every command prints JSON. `clean`, `pause`, `resume`, `stop`, `dock` and `locate` make the robot
move or talk at once, so run them only when the user asks. `suction` and `water` change the robot's
settings, as the app does.

# Auth

The robot listens on no port; everything goes through the MOVAhome cloud. Each run logs in with
`MOVA_EMAIL` and `MOVA_PASSWORD`, the MOVAhome app's login.

# Output notes

`status.state` is the robot's own state, such as `charging`, `charged`, `idle`, `sweeping`,
`mopping`, `sweeping and mopping`, `paused`, `returning`, `washing` (the station washing the mop),
`washing paused`, `drying`, `emptying`, `mapping` or `error`. Every job starts on the station: it
adds water and washes the mop (`adding water`, `washing`) for a while before the robot leaves, and
after a job it dries the mop for hours with the robot docked (`drying`). `errors` are all current
robot and station errors, with a message where the code is known: 107, for one, means the station's
clean water tank is empty, and the robot can't mop until it is filled. `job` is the running job,
otherwise the last one: `minutes` and `area` in m². `station` gives the station's state and its clean
water tank (`ok`, `low`, `missing`), dirty water tank and dust bag.

`consumables`: `percent` is the life left as the app shows it, `hoursLeft` the cleaning hours left.
`sensors` and `wheel` are reminders to clean them. Parts the robot doesn't have are left out.

`history`: `completed` is false for a job that was stopped or interrupted.

`rooms`: `id` is what `clean` takes. `name` is the name set in the app, else the room type. Rooms
come from the saved map in use; a robot that hasn't saved a map yet has none, so `rooms` and
`clean` with rooms fail until the home is mapped and the map saved in the app. `clean` with rooms
does one pass with the current suction and water.
