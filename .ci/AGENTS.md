- The repo is public and `run.sh` pushes fixes unreviewed: no personal data (names, emails, card or account
  numbers, real API responses) in code or comments.
- If a fix changes a skill's commands, hosts or env vars, update its `SKILL.md` to match, `compatibility` included.
- Skills load only the `.env` in their own folder, never one in the working directory.
