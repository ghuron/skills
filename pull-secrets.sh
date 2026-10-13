#!/usr/bin/env bash
# Pull all secrets from Infisical and configure the local environment.
# Safe to re-run at any time to refresh credentials.
set -euo pipefail

INFISICAL_PROJECT_ID="d56a074c-446e-466b-a6ba-91284fe0a42b"
INFISICAL_DOMAIN="https://eu.infisical.com/api"
INFISICAL_ENV="dev"
REPO="$(cd "$(dirname "$0")" && pwd)"

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

# ---------------------------------------------------------------------------
# .env files for integration tests
# ---------------------------------------------------------------------------
echo "==> Writing htm/.env"
infisical_path /htm > "$REPO/htm/.env"

echo "==> Writing magister/.parent.env"
infisical_path /magister_parent > "$REPO/magister/.parent.env"

echo "==> Writing magister/.child.env"
infisical_path /magister_child > "$REPO/magister/.child.env"

echo "==> Writing epson/.env"
infisical_path /epson > "$REPO/epson/.env"

echo "==> Writing ovpay/.env"
infisical_path /ovpay > "$REPO/ovpay/.env"

# ---------------------------------------------------------------------------
# System secrets
# ---------------------------------------------------------------------------
echo "==> Loading system secrets"
CLAWHUB_TOKEN=$(get_secret CLAWHUB_TOKEN /)
GITHUB_TOKEN=$(get_secret GITHUB_TOKEN /)
GIT_USER_NAME=$(get_secret GIT_USER_NAME /)
GIT_USER_EMAIL=$(get_secret GIT_USER_EMAIL /)

echo "==> Logging in to clawhub"
"$HOME/.local/node_modules/.bin/clawhub" login --token "$CLAWHUB_TOKEN" --no-browser

echo "==> Configuring git"
git config --global user.name  "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
git config --global credential.helper store
printf 'https://%s:%s@github.com\n' "$GIT_USER_NAME" "$GITHUB_TOKEN" > ~/.git-credentials
chmod 600 ~/.git-credentials

echo ""
echo "Secrets pulled. Environment is ready."
