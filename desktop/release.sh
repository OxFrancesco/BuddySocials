#!/usr/bin/env bash
# Builds the desktop app for this machine and publishes it, so installed copies on the same
# platform offer "Update" the next time they check. Run it on Linux for Linux and on a Mac for macOS.
# Needs the Convex CLI signed in (`bunx convex login`), because only someone who can deploy may publish.
#   ./release.sh            build and publish
#   ./release.sh --prod     publish to the production deployment instead of the dev one
set -euo pipefail
cd "$(dirname "$0")"

target=()
if [[ ${1:-} == --prod ]]; then
  target=(--prod)
  # A prod build talks to the prod deployment and the Clerk production instance by default.
  : "${BUDDYSOCIALS_BUILD_CLERK_ISSUER:?Set BUDDYSOCIALS_BUILD_CLERK_ISSUER to the Clerk production Frontend API URL}"
  : "${BUDDYSOCIALS_BUILD_CLERK_CLIENT_ID:?Set BUDDYSOCIALS_BUILD_CLERK_CLIENT_ID to the prod desktop OAuth client ID}"
  export BUDDYSOCIALS_BUILD_CONVEX_URL=${BUDDYSOCIALS_BUILD_CONVEX_URL:-https://grand-dog-690.convex.cloud}
  export BUDDYSOCIALS_BUILD_CLERK_ISSUER BUDDYSOCIALS_BUILD_CLERK_CLIENT_ID
fi

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "Unsupported system: $(uname -s)" >&2; exit 1 ;;
esac
arch=$(uname -m)
if [[ $arch == arm64 ]]; then arch=aarch64; fi
platform=$os-$arch

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [[ $os == macos ]]; then
  # The whole bundle travels, so the signature made by bundle.sh arrives intact.
  ./bundle.sh
  program=target/bundle/BuddySocials.app/Contents/MacOS/BuddySocials
  file=target/bundle/BuddySocials.app.tar.gz
  tar -czf "$file" -C target/bundle BuddySocials.app
else
  ${CARGO:-cargo} build --release
  program=target/release/buddysocials
  file=$program
fi

version="$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)+$(git rev-parse --short HEAD)"
file_sha=$(sha "$file")
program_sha=$(sha "$program")

# `convex run` prints the function's result as JSON on the last line.
convex() { (cd .. && bunx convex run ${target[@]+"${target[@]}"} "$@") | tail -n 1; }

upload_url=$(convex desktopReleases:uploadUrl | tr -d '"')
echo "Uploading $file ($(du -h "$file" | cut -f1)) for $platform…"
storage_id=$(curl -fsS -X POST -H "Content-Type: application/octet-stream" --data-binary @"$file" "$upload_url" | sed -E 's/.*"storageId":"([^"]+)".*/\1/')
convex desktopReleases:publish "{\"platform\":\"$platform\",\"version\":\"$version\",\"storageId\":\"$storage_id\",\"fileSha256\":\"$file_sha\",\"programSha256\":\"$program_sha\"}" >/dev/null
echo "Published $version for $platform. Installed apps will offer the update within six hours, or right away when opened."
