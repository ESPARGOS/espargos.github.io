#!/usr/bin/env bash
#
# Build a self-hosted esp-web-tools bundle for the firmware page.
#
# The stock esp-web-tools (loaded from a CDN) bundles the upstream esptool-js,
# which cannot reset USB-UART adapters that have hardware flow control always
# enabled (e.g. the SiLabs CP2102C) into the download mode. We therefore build
# esp-web-tools from source against a patched esptool-js fork and serve the
# result ourselves from site/static/vendor/esp-web-tools/.
#
# The output directory is generated (git-ignored): this script is the source of
# truth, not committed artifacts. It runs both locally and in CI.
#
# Usage:
#   site/scripts/build-esp-web-tools.sh        # build if out of date
#   FORCE_REBUILD=1 site/scripts/build-esp-web-tools.sh
#
# All sources/refs can be overridden via the environment variables below.

set -euo pipefail

ESP_WEB_TOOLS_REPO="${ESP_WEB_TOOLS_REPO:-https://github.com/esphome/esp-web-tools.git}"
ESP_WEB_TOOLS_REF="${ESP_WEB_TOOLS_REF:-10.2.1}"
ESPTOOL_JS_REPO="${ESPTOOL_JS_REPO:-https://github.com/Jeija/esptool-js.git}"
ESPTOOL_JS_REF="${ESPTOOL_JS_REF:-hardware-flow-control}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$SITE_DIR/static/vendor/esp-web-tools"
STAMP="$DEST/.build-stamp"

# Identify this build. Resolve the esptool-js ref to a commit so that pushing
# new commits to a branch triggers a rebuild (best-effort; ignored if offline).
ESPTOOL_JS_SHA="$(git ls-remote "$ESPTOOL_JS_REPO" "$ESPTOOL_JS_REF" 2>/dev/null | head -n1 | cut -f1 || true)"
WANT="esp-web-tools@${ESP_WEB_TOOLS_REF} esptool-js@${ESPTOOL_JS_REPO}#${ESPTOOL_JS_REF}@${ESPTOOL_JS_SHA:-unknown}"

if [[ -z "${FORCE_REBUILD:-}" && -f "$STAMP" && "$(cat "$STAMP")" == "$WANT" && -f "$DEST/install-button.js" ]]; then
  echo "esp-web-tools: up to date ($WANT), skipping. Set FORCE_REBUILD=1 to force."
  exit 0
fi

echo "esp-web-tools: building $WANT"
command -v npm >/dev/null || { echo "error: npm not found (install Node.js)" >&2; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# 1. Build the patched esptool-js. We build it explicitly (npm run build) rather
#    than relying on its install-time "prepare" script, so it works even where
#    dependency lifecycle scripts are disallowed.
echo "--> cloning esptool-js ($ESPTOOL_JS_REF)"
git clone --quiet --depth 1 --branch "$ESPTOOL_JS_REF" "$ESPTOOL_JS_REPO" "$WORKDIR/esptool-js"
( cd "$WORKDIR/esptool-js" && npm install --no-audit --no-fund && npm run build )

# 2. Build esp-web-tools against the patched esptool-js.
echo "--> cloning esp-web-tools ($ESP_WEB_TOOLS_REF)"
git clone --quiet --depth 1 --branch "$ESP_WEB_TOOLS_REF" "$ESP_WEB_TOOLS_REPO" "$WORKDIR/esp-web-tools"
cd "$WORKDIR/esp-web-tools"
npm install --no-audit --no-fund

# Overlay the patched esptool-js build over the resolved dependency. This avoids
# any dependency lifecycle scripts and is independent of npm linking behaviour.
echo "--> overlaying patched esptool-js"
test -f "$WORKDIR/esptool-js/lib/index.js" || { echo "error: esptool-js build produced no lib/" >&2; exit 1; }
rm -rf node_modules/esptool-js/lib node_modules/esptool-js/bundle.js
cp -r "$WORKDIR/esptool-js/lib" node_modules/esptool-js/lib
cp "$WORKDIR/esptool-js/bundle.js" node_modules/esptool-js/bundle.js 2>/dev/null || true

# Build (mirrors esp-web-tools' script/build without the jq dependency).
echo "export const version = \"${ESP_WEB_TOOLS_REF}\";" > src/version.ts
NODE_ENV=production npm exec -- tsc
NODE_ENV=production npm exec -- rollup -c

# Sanity check: the patched reset code must be present in the bundle.
if ! grep -rq "setDTRandRTS" dist/web/; then
  echo "error: patched esptool-js code not found in bundle — overlay failed" >&2
  exit 1
fi

# 3. Publish the artifacts.
echo "--> publishing to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp dist/web/* "$DEST/"
echo "$WANT" > "$STAMP"
echo "esp-web-tools: done ($(ls "$DEST" | wc -l) files)"
