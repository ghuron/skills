#!/usr/bin/env bash
# Bootstrap a fresh Linux machine (Node already installed).
# Only required interaction: browser sign-in during `infisical login`.
set -euo pipefail

CI="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing infisical and claude to ~/.local"
npm install --prefix ~/.local @infisical/cli @anthropic-ai/claude-code

if ! grep -qF '$HOME/.local/node_modules/.bin' ~/.bashrc; then
  echo 'export PATH="$HOME/.local/node_modules/.bin:$PATH"' >> ~/.bashrc
fi
export PATH="$HOME/.local/node_modules/.bin:$PATH"

echo "==> Logging in to Infisical — your browser will open"
infisical login

bash "$CI/pull-secrets.sh"

echo ""
echo "Bootstrap complete. Open a new shell or run: source ~/.bashrc"
echo "Then start Claude with: claude"
