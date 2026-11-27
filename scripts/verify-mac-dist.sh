#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob
dmgs=("${1:?dist directory required}"/*-arm64.dmg)
zips=("$1"/*-arm64-mac.zip)
[[ ${#dmgs[@]} == 1 && ${#zips[@]} == 1 ]] || { echo 'Expected exactly one arm64 DMG and ZIP' >&2; exit 1; }
mountpoint=$(mktemp -d)
trap 'hdiutil detach "$mountpoint" >/dev/null 2>&1 || true; rmdir "$mountpoint"' EXIT
hdiutil verify "${dmgs[0]}"
hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "${dmgs[0]}"
apps=("$mountpoint"/*.app)
[[ ${#apps[@]} == 1 ]]
codesign --verify --deep --strict --verbose=2 "${apps[0]}"
unzip -tq "${zips[0]}"
