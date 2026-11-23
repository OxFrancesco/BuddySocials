#!/usr/bin/env bash
# Prepares the production Convex deployment so anyone can sign up and connect their accounts.
#
#   CLERK_FRONTEND_API_URL=https://clerk.yourdomain.com \
#   CLERK_DESKTOP_CLIENT_ID=... \
#   ./scripts/prod-setup.sh
#
# What it does:
#   1. Copies each platform's developer app keys (YouTube, Instagram, TikTok, X, LinkedIn, Facebook)
#      from the dev deployment to prod. Values are piped, never printed.
#   2. Gives prod its own fresh CREDENTIALS_KEY, so prod tokens are never readable with the dev key.
#   3. Sets the Clerk production instance (a Clerk *development* instance must not serve real users).
#   4. Deploys the functions to prod (PROD_SITE_URL overrides the site URL it prints) and prints the OAuth redirect URIs to register on each platform.
# Re-running is safe: it never overwrites a CREDENTIALS_KEY that prod already has (that would make
# every stored token unreadable).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLERK_FRONTEND_API_URL:?Set CLERK_FRONTEND_API_URL to your Clerk production instance (e.g. https://clerk.yourdomain.com)}"

dev() { bunx convex env "$@" 2>/dev/null; }
prod() { bunx convex env --prod "$@" 2>/dev/null; }
# `env list` prints names only (or NAME=value with --include-values); match both.
has_prod() { prod list | grep -qE "^$1(=|$)"; }
# Values go through stdin so they never show up in the process list.
prod_put() { printf '%s' "$2" | prod set "$1" >/dev/null; }

copy=(
  YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET
  INSTAGRAM_CLIENT_ID INSTAGRAM_CLIENT_SECRET
  TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET
  X_CLIENT_ID X_CLIENT_SECRET
  LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET LINKEDIN_SCOPES
  LINKEDIN_PAGES_CLIENT_ID LINKEDIN_PAGES_CLIENT_SECRET LINKEDIN_PAGES_ENABLED LINKEDIN_PAGES_SCOPES
  FACEBOOK_APP_ID FACEBOOK_APP_SECRET
  WORKOS_AUTHKIT_DOMAIN
)
for name in "${copy[@]}"; do
  value=$(dev get "$name" || true)
  if [[ -n $value ]]; then
    prod_put "$name" "$value"
    echo "copied   $name"
  else
    echo "skipped  $name (not set on dev)"
  fi
done
unset value

if has_prod CREDENTIALS_KEY; then
  echo "kept     CREDENTIALS_KEY (already set on prod)"
else
  prod_put CREDENTIALS_KEY "$(openssl rand -base64 32)"
  prod_put CREDENTIALS_KEY_ID prod1
  echo "created  CREDENTIALS_KEY"
fi

prod_put CLERK_FRONTEND_API_URL "$CLERK_FRONTEND_API_URL"
echo "set      CLERK_FRONTEND_API_URL"
if [[ -n ${CLERK_DESKTOP_CLIENT_ID:-} ]]; then
  prod_put CLERK_DESKTOP_CLIENT_ID "$CLERK_DESKTOP_CLIENT_ID"
  echo "set      CLERK_DESKTOP_CLIENT_ID"
fi
# Open sign-ups: an empty allowlist lets every signed-in user in. Set OWNER_EMAILS to run a private beta.
if [[ -n ${OWNER_EMAILS:-} ]]; then prod_put OWNER_EMAILS "$OWNER_EMAILS"; echo "set      OWNER_EMAILS (private beta)"; fi
if [[ -n ${ADMIN_EMAILS:-} ]]; then prod_put ADMIN_EMAILS "$ADMIN_EMAILS"; echo "set      ADMIN_EMAILS"; fi

bunx convex deploy -y

site=${PROD_SITE_URL:-https://grand-dog-690.convex.site}
cat <<EOF

Prod is deployed. Register this redirect URI on every platform's developer app:
  $site/oauth/callback
Meta (Instagram + Facebook) compliance callbacks:
  Data deletion:  $site/meta/data-deletion
  Deauthorize:    $site/meta/deauthorize
Then publish the desktop app against prod:  ./desktop/release.sh --prod
EOF
