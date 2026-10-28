#!/usr/bin/env bash
# CI entry point: runs every skill's tests and prints one line per skill on stdout, which the Hermes
# cron job on the CI box delivers to WhatsApp (see PLAN.md). Full test output contains account data,
# so it stays in $STATE/<run>/ on this machine and never reaches stdout.
#
# Reads ~/.config/skills-ci/env if present: INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and _SECRET for
# pull-secrets.sh, and CI_SKIP, a space-separated list of skills not to test on this machine.
set -uo pipefail
umask 077

CI="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$CI")"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/skills-ci"
ENV_FILE="${SKILLS_CI_ENV:-$HOME/.config/skills-ci/env}"
export PATH="$HOME/.local/node_modules/.bin:$PATH"

mkdir -p "$STATE"
if [ -z "${SKILLS_CI_PULLED:-}" ]; then
  # The lock fd survives the exec below, so the fresh copy keeps the lock.
  exec 9>"$STATE/lock"
  if ! flock -n 9; then
    echo "Skills CI: the previous run is still going, skipped this one"
    exit 0
  fi
  # Pull first and restart from the pulled copy, so a change to this script applies to this run.
  pull_note=$(git -C "$REPO" pull --ff-only -q 2>&1) || pull_note="git pull failed, tested the old checkout: $pull_note"
  SKILLS_CI_PULLED=1 PULL_NOTE="${pull_note:-}" exec bash "$CI/run.sh" "$@"
fi

LOG="$STATE/$(date +%F_%H%M)"
mkdir -p "$LOG"
notes=()
[ -n "${PULL_NOTE:-}" ] && notes+=("$PULL_NOTE")

if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi
bash "$CI/pull-secrets.sh" >"$LOG/secrets.log" 2>&1 || notes+=("pull-secrets.sh failed, tested with the last .env files")

# Tests one skill. Prints its summary line; the full output goes to $LOG/<skill>.log.
run_skill() {
  local skill=$1 tap="$LOG/$1.tap" status
  timeout 20m node --test \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=tap --test-reporter-destination="$tap" \
    "$CI/$skill"/*.test.mjs >"$LOG/$skill.log" 2>&1
  status=$?
  if [ ! -s "$tap" ]; then
    echo "❌ $skill: node --test exited with $status, no results"
    return
  fi
  # Top-level results only: subtests are indented. Names and skip reasons come from the test code.
  awk -v skill="$skill" -v status="$status" '
    /^ok [0-9]+ - .* # SKIP/ { skip++; r = $0; sub(/.* # SKIP */, "", r); if (r != "" && !(r in seen)) { seen[r]; reasons = reasons (reasons ? ", " : "") r }; next }
    /^ok [0-9]+ - /          { pass++; next }
    /^not ok [0-9]+ - /      { fail++; n = $0; sub(/^not ok [0-9]+ - /, "", n); sub(/ # (TODO|SKIP).*/, "", n); failed = failed (failed ? "; " : "") n }
    END {
      line = pass + 0 " passed"
      if (skip) line = line ", " skip " skipped" (reasons ? " (" reasons ")" : "")
      if (status == 124)          print "❌ " skill ": timed out after 20 min, " line
      else if (fail)              print "❌ " skill ": " fail " failed (" failed "), " line
      else if (status != 0)       print "❌ " skill ": node --test exited with " status ", " line
      else if (pass + skip == 0)  print "❌ " skill ": no tests ran"
      else                        print "✅ " skill ": " line
    }' "$tap"
}

lines=() red=0 green=0 skipped=0
for dir in "$CI"/*/; do
  skill=$(basename "$dir")
  compgen -G "$dir*.test.mjs" >/dev/null || continue
  if [[ " ${CI_SKIP:-} " == *" $skill "* ]]; then
    lines+=("⏸ $skill: not run on this machine (CI_SKIP)")
    skipped=$((skipped + 1))
    continue
  fi
  line=$(run_skill "$skill")
  lines+=("$line")
  if [[ $line == ✅* ]]; then green=$((green + 1)); else red=$((red + 1)); fi
done

# Keep the last 10 runs' logs.
ls -1d "$STATE"/*/ 2>/dev/null | head -n -10 | xargs -r rm -rf

summary="Skills CI on $(git -C "$REPO" rev-parse --short HEAD): $green green, $red red"
[ "$skipped" -gt 0 ] && summary+=", $skipped not run"
echo "$summary"
printf '%s\n' "${lines[@]}"
for n in "${notes[@]}"; do echo "⚠️ $n"; done
[ "$red" -gt 0 ] && echo "Logs: $(hostname):$LOG"
exit 0
