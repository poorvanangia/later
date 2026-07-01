#!/usr/bin/env bash
# Build, sign, notarize, and staple the Later macOS release.
#
# Stages: tauri build (sign + bundle .app/.dmg) — retried once if the bundler
#         hits its known flaky AppleScript race
#         → codesign the .dmg (Tauri only signs the .app inside)
#         → xcrun notarytool submit --wait (via 'later-notary' keychain profile)
#         → xcrun stapler staple (offline Gatekeeper)
#
# Prereqs: 'later-notary' keychain profile created via
#          xcrun notarytool store-credentials "later-notary" ...

set -euo pipefail

PROFILE="later-notary"
IDENTITY="Developer ID Application: Poorva Nangia (5F3CS8PL3T)"
SIGNING_KEY_PATH="$HOME/.config/later-updater/later.key"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# Set the updater signing key so `tauri build` also produces the .app.tar.gz +
# .app.tar.gz.sig used by tauri-plugin-updater. Without this env var, the build
# still works but no updater artifacts are emitted.
if [[ ! -f "$SIGNING_KEY_PATH" ]]; then
  echo "ERROR: updater signing key missing at $SIGNING_KEY_PATH" >&2
  echo "       Regenerate with: npx tauri signer generate -w $SIGNING_KEY_PATH --password '' --ci" >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING_KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# Tauri's bundle_dmg.sh has a known AppleScript timing bug ("Can't get disk
# (-1728)") that pops on the first run under load. Retry once before failing.
echo "==> tauri build (signs .app + bundles .dmg + signs updater archive)"
if ! npm run tauri:build; then
  echo "First build failed (likely the flaky DMG bundler). Retrying once..."
  sleep 3
  npm run tauri:build
fi

APP_PATH="src-tauri/target/release/bundle/macos/Later.app"
DMG_PATH="$(ls -t src-tauri/target/release/bundle/dmg/Later_*_*.dmg 2>/dev/null | head -1 || true)"
[[ -d "$APP_PATH" ]] || { echo "ERROR: $APP_PATH missing after build" >&2; exit 1; }
[[ -n "$DMG_PATH" ]] || { echo "ERROR: no .dmg produced" >&2; exit 1; }

echo "==> Verifying .app signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# Tauri signs the .app but not the wrapper .dmg. Without this, spctl --type install
# rejects the DMG even though the .app inside is fine. Sign before notarizing so the
# notary covers the signed DMG.
echo "==> Signing .dmg"
codesign --sign "$IDENTITY" --timestamp "$DMG_PATH"

echo "==> Submitting .dmg to Apple for notarization (waits for verdict)"
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$PROFILE" --wait

echo "==> Stapling tickets"
xcrun stapler staple "$APP_PATH"
xcrun stapler staple "$DMG_PATH"

echo "==> Final Gatekeeper verification"
spctl --assess --verbose=4 --type execute "$APP_PATH"
spctl --assess --verbose=4 --type install "$DMG_PATH"

UPDATER_ARCHIVE="$(ls -t src-tauri/target/release/bundle/macos/Later.app.tar.gz 2>/dev/null | head -1 || true)"
UPDATER_SIG="$(ls -t src-tauri/target/release/bundle/macos/Later.app.tar.gz.sig 2>/dev/null | head -1 || true)"

echo
echo "✓ Release ready:"
echo "  $APP_PATH"
echo "  $DMG_PATH"
if [[ -n "$UPDATER_ARCHIVE" && -n "$UPDATER_SIG" ]]; then
  echo "  $UPDATER_ARCHIVE"
  echo "  $UPDATER_SIG  (latest.json manifest assembly happens in CI — Step 6)"
fi
