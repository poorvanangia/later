#!/usr/bin/env bash
# Build, sign, notarize, and staple the Later macOS release.
#
# Stages: tauri build (bundles .app + updater — DMG bundling disabled because
#         bundle_dmg.sh produces DMGs without a .DS_Store in CI, so the layout
#         defaults to Finder's ugly built-in one)
#         → create-dmg (npm) to package .app into a properly-laid-out DMG
#         → codesign the .dmg
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

echo "==> tauri build (signs .app + emits updater archive; DMG built separately)"
# Force a fresh bundle so icon/resource updates aren't shadowed by a prior
# build's output that Cargo's incremental logic won't invalidate.
rm -rf src-tauri/target/release/bundle
npm run tauri:build

APP_PATH="src-tauri/target/release/bundle/macos/Later.app"
DMG_DIR="src-tauri/target/release/bundle/dmg"
[[ -d "$APP_PATH" ]] || { echo "ERROR: $APP_PATH missing after build" >&2; exit 1; }

echo "==> Verifying .app signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# create-dmg produces a nicely-laid-out DMG with a real .DS_Store. We pass
# --no-code-sign because we sign explicitly below with the pinned identity.
echo "==> Building .dmg via create-dmg"
mkdir -p "$DMG_DIR"
rm -f "$DMG_DIR"/*.dmg
npm run dmg:build
VERSION="$(node -p "require('./package.json').version")"
DMG_SRC="$(ls -t "$DMG_DIR"/*.dmg | head -1)"
DMG_PATH="$DMG_DIR/Later_${VERSION}_aarch64.dmg"
mv "$DMG_SRC" "$DMG_PATH"

echo "==> Signing .dmg"
codesign --sign "$IDENTITY" --timestamp --force "$DMG_PATH"
codesign --verify --verbose=2 "$DMG_PATH"

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
