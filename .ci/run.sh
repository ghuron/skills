#!/usr/bin/env bash
# CI entry point. Intended to run on a schedule (e.g. daily cron).
# For each skill: test → refresh static data if needed → Claude fix → commit + push.
set -euo pipefail

CI="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$CI")"
CLAUDE="${HOME}/.local/node_modules/.bin/claude"

cd "$REPO"
git pull
bash "$CI/pull-secrets.sh"

run_tests() {
  node --test "$1"/*.test.mjs
}

for test_dir in "$CI"/*/; do
  test_dir="${test_dir%/}"
  skill=$(basename "$test_dir")
  skill_dir="$REPO/skills/$skill"
  echo ""
  echo "========================================"
  echo "  $skill"
  echo "========================================"

  if run_tests "$test_dir" 2>&1; then
    echo "==> $skill: all tests passed"
    continue
  fi

  # Refresh static data if the skill has a refresh script
  if [ -f "$test_dir/refresh.mjs" ]; then
    echo "==> $skill: refreshing static data"
    node "$test_dir/refresh.mjs"
    if run_tests "$test_dir" 2>&1; then
      echo "==> $skill: tests passed after refresh — committing"
      git add "$skill_dir"
      git commit -m "$skill: refresh static data [ci]"
      git push
      continue
    fi
  fi

  # Ask Claude to fix
  echo "==> $skill: tests still failing — asking Claude to fix"
  test_output=$(run_tests "$test_dir" 2>&1 || true)
  "$CLAUDE" -p "$(cat <<PROMPT
Tests in the '$skill' skill are failing. Error output:

$test_output

The skill lives in $skill_dir; its tests and dev scripts are in $test_dir. Fix the issue in $skill_dir or in the dev scripts (do not modify test files).
After fixing, explain what changed in one sentence starting with 'Fix: '.
PROMPT
)" \
    --allowedTools "Edit,Bash" \
    --max-turns 10

  if run_tests "$test_dir" 2>&1; then
    echo "==> $skill: tests passed after Claude fix — committing"
    git add "$skill_dir" "$test_dir"
    git commit -m "$skill: fix [ci]"
    git push
  else
    echo "==> $skill: Claude fix did not resolve tests — manual intervention required"
    exit 1
  fi
done

echo ""
echo "==> CI run complete"
