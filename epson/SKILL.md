---
name: epson
description: "Read the remaining ink cartridge levels (percent per colour) of an Epson Expression XP-series network printer from its built-in web server, as JSON. Use when the user asks how much ink is left, which cartridge to replace, or wants to monitor printer ink."
license: MIT-0
compatibility: "Requires Node.js 22+ and the printer on the local network; set EPSON_HOST to its IP address or hostname, in the environment or a .env in the skill folder (the environment wins). Tested on the Expression Photo XP-8700."
---
# Commands

```bash
node epson.mjs ink   # [{"color": "Black", "level": 72}, ...]
```

`level` is the percentage left, or `null` if the printer doesn't report it.
