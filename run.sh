#!/usr/bin/env bash
# CI entry point. Intended to run on a schedule (e.g. daily cron).
# For each skill: test → refresh static data if needed → Claude fix → commit + publish.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${HOME}/.local/node_modules/.bin/claude"

cd "$REPO"
git pull
bash "$REPO/pull-secrets.sh"

skill_version() {
  node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('package.json','utf8')).version)"
}

has_script() {
  node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); process.exit(p.scripts?.['$1'] ? 0 : 1)" 2>/dev/null
}

for skill_dir in "$REPO"/*/; do
  [ -f "$skill_dir/package.json" ] || continue
  skill=$(basename "$skill_dir")
  echo ""
  echo "========================================"
  echo "  $skill"
  echo "========================================"
  cd "$skill_dir"

  if npm test 2>&1; then
    echo "==> $skill: all tests passed"
    cd "$REPO"
    continue
  fi

  # Refresh static data if the skill has a refresh script
  if has_script refresh; then
    echo "==> $skill: refreshing static data"
    npm run refresh
    if npm test 2>&1; then
      echo "==> $skill: tests passed after refresh — committing"
      git add "$REPO/skills/$skill"
      git commit -m "$skill: refresh static data [ci]"
      git push
      cd "$REPO"
      continue
    fi
  fi

  # Ask Claude to fix
  echo "==> $skill: tests still failing — asking Claude to fix"
  test_output=$(npm test 2>&1 || true)
  "$CLAUDE" -p "$(cat <<PROMPT
Tests in the '$skill' skill are failing. Error output:

$test_output

The skill lives in $REPO/skills/$skill; its tests and dev scripts are in $skill_dir. Fix the issue in $REPO/skills/$skill or in $skill_dir/*.mjs files (do not modify test files).
After fixing, explain what changed in one sentence starting with 'Fix: '.
PROMPT
)" \
    --allowedTools "Edit,Bash" \
    --max-turns 10

  if npm test 2>&1; then
    echo "==> $skill: tests passed after Claude fix — bumping version and publishing"
    npm version patch --no-git-tag-version
    version=$(skill_version)
    git add package.json "$REPO/skills/$skill" *.mjs 2>/dev/null || true
    git commit -m "$skill: fix + bump to $version [ci]"
    git push
    npm run publish
    echo "==> $skill: published $version"
  else
    echo "==> $skill: Claude fix did not resolve tests — manual intervention required"
    exit 1
  fi

  cd "$REPO"
done

echo ""
echo "==> CI run complete"
