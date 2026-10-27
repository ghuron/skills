#!/usr/bin/env bash
# Pull all secrets from Infisical and configure the local environment.
# Safe to re-run at any time to refresh credentials.
set -euo pipefail

INFISICAL_PROJECT_ID="d56a074c-446e-466b-a6ba-91284fe0a42b"
INFISICAL_DOMAIN="https://eu.infisical.com/api"
INFISICAL_ENV="dev"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# With a machine identity's INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and _CLIENT_SECRET set (cron env), log
# in without a browser; INFISICAL_TOKEN is then used by every later infisical call. Without
# them the CLI uses the session from an interactive `infisical login`.
if [ -z "${INFISICAL_TOKEN:-}" ] && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ]; then
  INFISICAL_TOKEN=$(infisical login --method=universal-auth --domain="$INFISICAL_DOMAIN" --silent --plain)
  export INFISICAL_TOKEN
fi

infisical_path() {
  infisical export \
    --projectId="$INFISICAL_PROJECT_ID" \
    --domain="$INFISICAL_DOMAIN" \
    --env="$INFISICAL_ENV" \
    --path="$1" \
    --format=dotenv
}

get_secret() {
  infisical secrets get "$1" \
    --projectId="$INFISICAL_PROJECT_ID" \
    --domain="$INFISICAL_DOMAIN" \
    --env="$INFISICAL_ENV" \
    --path="$2" \
    --plain \
    --silent
}

# Writes an Infisical path's secrets to <skill>/<file>. A missing or empty path is skipped, so one
# skill without secrets neither stops the run nor leaves an empty .env that makes its tests fail.
write_env() {
  local secrets
  if secrets=$(infisical_path "$1") && [ -n "$secrets" ]; then
    printf '%s\n' "$secrets" > "$REPO/$2"
    echo "==> Wrote $2"
  else
    echo "==> Skipped $2: nothing at $1 in Infisical"
  fi
}

# ---------------------------------------------------------------------------
# Credentials, as .env files in the skill folders (read by the skills and their tests)
# ---------------------------------------------------------------------------
write_env /htm             htm/.env
write_env /magister_parent magister/.env
write_env /magister_child  magister/.child.env   # tests only
write_env /epson           epson/.env
write_env /ecovacs         ecovacs/.env
write_env /ovpay           ovpay/.env
write_env /budgetthuis     budgetthuis/.env
write_env /vodafone        vodafone/.env

# ---------------------------------------------------------------------------
# System secrets
# ---------------------------------------------------------------------------
echo "==> Loading system secrets"
GITHUB_TOKEN=$(get_secret GITHUB_TOKEN /)
GIT_USER_NAME=$(get_secret GIT_USER_NAME /)
GIT_USER_EMAIL=$(get_secret GIT_USER_EMAIL /)

echo "==> Configuring git"
git config --global user.name  "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper store
  printf 'https://%s:%s@github.com\n' "$GIT_USER_NAME" "$GITHUB_TOKEN" > ~/.git-credentials
  chmod 600 ~/.git-credentials
else
  echo "    No GITHUB_TOKEN in Infisical: keeping the existing git credentials"
fi

echo ""
echo "Secrets pulled. Environment is ready."
