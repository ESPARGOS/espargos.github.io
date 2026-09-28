#!/usr/bin/env bash
set -euo pipefail

# Consume successful main-branch builds from the two public repositories.
destination="${1:?Usage: include-esp-sdr.sh OUTPUT_DIRECTORY}"
if [[ -e "$destination" ]]; then
  echo "Refusing to overwrite existing directory: $destination" >&2
  exit 1
fi
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/esp-sdr-site.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

download() {
  local repo="$1" workflow="$2" artifact="$3" output="$4" run_id
  run_id=$(gh api "repos/ESPARGOS/$repo/actions/workflows/$workflow/runs" \
    -X GET -f branch=main -f event=push -f status=success -f per_page=1 \
    --jq '.workflow_runs[0].id // empty')
  if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
    echo "No successful main-branch build for ESPARGOS/$repo" >&2
    exit 1
  fi
  echo "Downloading ESPARGOS/$repo run $run_id: $artifact"
  gh run download "$run_id" -R "ESPARGOS/$repo" -n "$artifact" -D "$output"
}

download esp-web-sdr site.yml esp-websdr "$scratch/viewer"
download esp-sdr firmware.yml esp-sdr-firmware "$scratch/firmware"

for file in index.html flash.html app.js radio.js style.css fonts.css espargos-logo.svg flasher/app.js flasher/catalog.mjs; do
  if [[ ! -s "$scratch/viewer/$file" ]]; then
    echo "Missing ESP-WebSDR file: $file" >&2
    exit 1
  fi
done
if [[ ! -s "$scratch/firmware/manifest.json" ]]; then
  echo "Missing ESP-SDR firmware manifest" >&2
  exit 1
fi

# Replace the viewer artifact's bundled images with the complete firmware build.
rm -rf "$scratch/viewer/firmware"
mv "$scratch/firmware" "$scratch/viewer/firmware"
mkdir -p "$(dirname "$destination")"
mv "$scratch/viewer" "$destination"
