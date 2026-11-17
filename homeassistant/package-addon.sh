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

# The Kiosk Player TV app, so screens can be updated from the dashboard (0.11.0).
# The release builds it first; without it the add-on simply offers no updates.
mkdir -p "$out/app/player"
apk="${PLAYER_APK:-$root/android/player/build/outputs/apk/debug/player-debug.apk}"
if [ -f "$apk" ]; then
  gradle="$root/android/player/build.gradle.kts"
  version_name="$(sed -n 's/^ *versionName *= *"\([^"]*\)".*/\1/p' "$gradle" | head -n1)"
  version_code="$(sed -n 's/^ *versionCode *= *\([0-9][0-9]*\).*/\1/p' "$gradle" | head -n1)"
  test -n "$version_name" && test -n "$version_code" || { echo "No versionName/versionCode in $gradle"; exit 1; }
  cp "$apk" "$out/app/player/kiosk-player.apk"
  printf '{ "version": "%s", "version_code": %s }\n' "$version_name" "$version_code" > "$out/app/player/kiosk-player.json"
  echo "TV app $version_name ($version_code) included"
else
  echo "No TV app built ($apk): the add-on won't offer app updates"
  printf 'The TV app goes here when the release builds it.\n' > "$out/app/player/README.txt"
fi
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
