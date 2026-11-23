#!/usr/bin/env bash
# Publishes site/ (landing page, privacy, terms, data deletion) to https://socials.buddytools.org
# as an assets-only Cloudflare Worker named buddysocials-site. Needs the `cf` CLI, signed in.
#
# buddytools.org has a catch-all `*.buddytools.org/*` Worker route, so the zone also carries a
# `socials.buddytools.org/*` route to buddysocials-site; without it the custom domain serves 404s.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-157a8b025a13404b16f11ad7078e53f1}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -r "$root/site" "$work/public"
cat > "$work/package.json" <<'EOF'
{ "name": "buddysocials-site", "private": true, "type": "module" }
EOF
cat > "$work/cloudflare.config.ts" <<'EOF'
import { defineConfig } from "cf/config";
export default defineConfig({
  worker: {
    name: "buddysocials-site",
    compatibilityDate: "2026-11-01",
    domains: ["socials.buddytools.org"],
    workersDev: false,
    previewUrls: false,
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "none" },
  },
});
EOF
cd "$work"
npm i -D cf@1.0.0-rc.0 >/dev/null
cf deploy ./public
