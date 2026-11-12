#!/usr/bin/env bash
# Puts the add-on together, in two forms:
#
#   homeassistant/dist/kiosk_server       the files in kiosk_server/ plus a copy
#                                         of the server code in app/. This is
#                                         what gets built into the add-on image.
#                                         Also zipped as kiosk_server-addon.zip,
#                                         for copying into Home Assistant's
#                                         "addons" share by hand.
#
#   homeassistant/dist/store              what goes into the public add-on
#                                         repository (hybrid87sg/kiosk-addons):
#                                         the add-on's description and docs,
#                                         pointing at the ready-built image. No
#                                         server code, nothing to build.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/homeassistant/dist"
out="$dist/kiosk_server"
store="$dist/store"
image="ghcr.io/hybrid87sg/kiosk-server"

rm -rf "$out" "$store" "$dist/kiosk_server-addon.zip"
mkdir -p "$out/app"
cp -r "$root/homeassistant/kiosk_server/." "$out/"
cp "$root/server/package.json" "$root/server/package-lock.json" "$out/app/"
cp -r "$root/server/src" "$out/app/src"
cp -r "$root/server/public" "$out/app/public"
(cd "$dist" && zip -qr kiosk_server-addon.zip kiosk_server)
echo "Add-on ready: $dist/kiosk_server-addon.zip"

# The public repository's files. "image:" makes Home Assistant download the
# add-on ready-made instead of building it, so the Dockerfile is left out.
mkdir -p "$store/kiosk_server"
cp "$root/homeassistant/store/repository.yaml" "$root/homeassistant/store/README.md" "$store/"
cp -r "$root/homeassistant/kiosk_server/translations" "$store/kiosk_server/"
cp "$root/homeassistant/kiosk_server/DOCS.md" "$store/kiosk_server/"
cp "$root/homeassistant/kiosk_server/config.yaml" "$store/kiosk_server/config.yaml"
printf '# Home Assistant downloads the add-on ready-made from here (the tag is the version above).\nimage: %s\n' "$image" >> "$store/kiosk_server/config.yaml"
echo "Add-on repository files ready: $store"
