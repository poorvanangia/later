#!/usr/bin/env bash
# Build a styled DMG for the current Later.app using create-dmg
# (andreyvit/create-dmg — the Bash tool, `brew install create-dmg`).
#
# Tauri's built-in DMG bundler ignores our background/icon-position config in
# headless CI, so we produce the DMG here instead. Locally, requires Homebrew's
# create-dmg on PATH; in CI, the release workflow installs it before invoking.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_SRC="src-tauri/target/release/bundle/macos/Later.app"
DMG_OUT_DIR="src-tauri/target/release/bundle/dmg"
DMG_OUT="$DMG_OUT_DIR/Later.dmg"
BACKGROUND="src-tauri/dmg-bg.png"

[[ -d "$APP_SRC" ]] || { echo "Missing $APP_SRC — build the .app first (npm run tauri:build)" >&2; exit 1; }
[[ -f "$BACKGROUND" ]] || { echo "Missing $BACKGROUND" >&2; exit 1; }
command -v create-dmg >/dev/null || { echo "create-dmg not on PATH — brew install create-dmg" >&2; exit 1; }

# Stage the .app alone so nothing else in bundle/macos (Later.app.tar.gz, .sig,
# etc.) leaks into the DMG.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP_SRC" "$STAGE/"

mkdir -p "$DMG_OUT_DIR"
rm -f "$DMG_OUT"

create-dmg \
  --overwrite \
  --window-size 800 500 \
  --icon-size 128 \
  --background "$BACKGROUND" \
  --icon Later.app 200 320 \
  --app-drop-link 600 320 \
  --hide-extension Later.app \
  "$DMG_OUT" \
  "$STAGE"

echo "Built $DMG_OUT"
