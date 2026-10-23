#!/usr/bin/env bash
# Drive the deep-pass stage without remembering flags.
#
#   CLOUDFLARE_API_TOKEN=... ./scripts/alch.sh plan
#   CLOUDFLARE_API_TOKEN=... ./scripts/alch.sh deploy
#   CLOUDFLARE_API_TOKEN=... ./scripts/alch.sh destroy
#
# STAGE overrides the stage (default: deep-pass). The token must be a real API
# token — see the Credentials section of README.md for why a spent wrangler
# OAuth session cannot be refreshed.
set -euo pipefail

STAGE="${STAGE:-deep-pass}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-7a470541a704caaf91e71efccc78fd36}"
CMD="${1:-plan}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set." >&2
  echo "Create one at https://dash.cloudflare.com/profile/api-tokens with:" >&2
  echo "  Account | Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit," >&2
  echo "  Workers KV Storage:Edit, Queues:Edit, Account Settings:Read" >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

cd "$(dirname "$0")/.."

case "$CMD" in
  plan)    exec pnpm exec alchemy plan    --stage "$STAGE" --no-input ;;
  deploy)  exec pnpm exec alchemy deploy  --stage "$STAGE" --yes --no-input ;;
  destroy) exec pnpm exec alchemy destroy --stage "$STAGE" --yes --no-input ;;
  *)
    echo "usage: $0 {plan|deploy|destroy}   (STAGE=... to override)" >&2
    exit 2
    ;;
esac
