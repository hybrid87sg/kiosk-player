#!/usr/bin/env bash
# Puts the Home Assistant integration together for its public HACS repository
# (hybrid87sg/kiosk-player-ha):
#
#   homeassistant/dist/kiosk-player-ha    custom_components/kiosk_player plus hacs.json,
#                                         README.md and a check for that repository.
#                                         Tests stay here, in the main repository.
#
# The integration's version (manifest.json) is used as is; change it there.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/homeassistant/integration"
out="$root/homeassistant/dist/kiosk-player-ha"

rm -rf "$out"
mkdir -p "$out/custom_components"
cp -r "$src/custom_components/kiosk_player" "$out/custom_components/"
cp -r "$src/published/." "$out/"
find "$out" -name '__pycache__' -type d -prune -exec rm -rf {} +

version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$out/custom_components/kiosk_player/manifest.json")"
echo "Kiosk Player integration $version is in $out"
