---
name: epson
description: "Read the remaining ink cartridge levels (percent per colour) of an Epson Expression XP-series network printer from its built-in web server, as JSON. Use when the user asks how much ink is left, which cartridge to replace, or wants to monitor printer ink."
license: MIT-0
compatibility: "Requires Node.js 20+ and the printer on the local network; set EPSON_HOST to its IP address or hostname. Tested on the Expression Photo XP-8700."
---
# Commands

```bash
node epson.mjs ink   # list remaining ink cartridge levels as JSON
```

# Output

Returns a JSON array of `{ "color": string, "level": number | null }` objects.
`level` is 0–100 (percent remaining), or `null` if the printer reports an unknown level.

Example:
```json
[
  { "color": "Black",   "level": 72 },
  { "color": "Cyan",    "level": 45 },
  { "color": "Magenta", "level": 30 },
  { "color": "Yellow",  "level": 88 }
]
```
