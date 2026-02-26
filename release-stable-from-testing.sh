#!/usr/bin/env bash
set -euo pipefail

# Promote firmware from testing -> stable by downloading from espargos.net.
# This script writes into site/content/firmware/stable.

BASE_URL="${BASE_URL:-https://espargos.net/firmware}"
SOURCE_CHANNEL="${SOURCE_CHANNEL:-testing}"
TARGET_CHANNEL="${TARGET_CHANNEL:-stable}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRMWARE_ROOT="$SCRIPT_DIR/site/content/firmware"
TARGET_DIR="$FIRMWARE_ROOT/$TARGET_CHANNEL"

FILES=(
  "espargos-sensor-artifact.json"
  "espargos-controller-artifact.json"
  "espargos-sensor-firmware.bin"
  "sensor-firmware-partition.bin"
  "espargos-controller-firmware.bin"
  "espargos-controller-assets.bin"
  "espargos-controller-recovery.bin"
)

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required but not installed." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"

echo "Promoting firmware from '$SOURCE_CHANNEL' to '$TARGET_CHANNEL'"
echo "Source: $BASE_URL/$SOURCE_CHANNEL"
echo "Target: $TARGET_DIR"
echo

for file in "${FILES[@]}"; do
  src="$BASE_URL/$SOURCE_CHANNEL/$file"
  dst="$TMP_DIR/$file"
  echo "Downloading: $src"
  curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
    --output "$dst" "$src"
done

for file in "${FILES[@]}"; do
  install -m 0644 "$TMP_DIR/$file" "$TARGET_DIR/$file"
done

echo
echo "Done. Stable channel was updated with:"
for file in "${FILES[@]}"; do
  echo "  - $TARGET_CHANNEL/$file"
done
echo
echo "Next step: review and commit changes."
