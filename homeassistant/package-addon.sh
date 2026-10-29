#!/usr/bin/env bash
# Puts the add-on together: the files in kiosk_server/ plus a copy of the
# server code in app/. The result is homeassistant/dist/kiosk_server, also
# zipped as kiosk_server-addon.zip, ready to copy into Home Assistant's
# "addons" share.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/homeassistant/dist"
out="$dist/kiosk_server"

rm -rf "$out" "$dist/kiosk_server-addon.zip"
mkdir -p "$out/app"
cp -r "$root/homeassistant/kiosk_server/." "$out/"
cp "$root/server/package.json" "$root/server/package-lock.json" "$out/app/"
cp -r "$root/server/src" "$out/app/src"
(cd "$dist" && zip -qr kiosk_server-addon.zip kiosk_server)
echo "Add-on ready: $dist/kiosk_server-addon.zip"
