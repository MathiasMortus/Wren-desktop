#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Signs, notarizes and staples a packaged Wren with your Apple Developer ID,
# so macOS lets it show the passkey sheet (the managed entitlement
# com.apple.developer.web-browser.public-key-credential) and trusts it on
# any Mac. Run after `npm run package`. Mirrors Zen's release workflow.
#
# Nothing secret lives in the repo. Put these in ~/.wren-keys/:
#   signing.env              WREN_TEAM_ID=ABCDE12345
#                            WREN_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
#                            WREN_NOTARY_PROFILE=wren-notary
#   Wren.provisionprofile    Developer ID profile for the Wren App ID, with the
#                            Web Browser Public Key Credential entitlement
# and store the notarization password in your Keychain, once:
#   xcrun notarytool store-credentials wren-notary --apple-id you@example.com --team-id ABCDE12345
#
#   scripts/wren_sign.sh             sign, notarize, staple
#   scripts/wren_sign.sh --no-notarize   sign only (quicker, for testing)

set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/python@3.11/libexec/bin:$PATH"

KEYS="$HOME/.wren-keys"
NOTARIZE=1
[[ "${1:-}" == "--no-notarize" ]] && NOTARIZE=0

fail() { printf '\nwren_sign: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

[[ -f "$KEYS/signing.env" ]] || fail "missing $KEYS/signing.env (see the top of this script)"
# shellcheck source=/dev/null
source "$KEYS/signing.env"
: "${WREN_TEAM_ID:?set WREN_TEAM_ID in $KEYS/signing.env}"
: "${WREN_SIGNING_IDENTITY:?set WREN_SIGNING_IDENTITY in $KEYS/signing.env}"
[[ -f "$KEYS/Wren.provisionprofile" ]] || fail "missing $KEYS/Wren.provisionprofile"
security find-identity -v -p codesigning | grep -qF "$WREN_SIGNING_IDENTITY" \
  || fail "no '$WREN_SIGNING_IDENTITY' certificate in your Keychain"

OBJ="$(ls -d engine/obj-*/ | head -1)"
DMG="$(ls -t "$OBJ"dist/*.dmg 2>/dev/null | head -1)"
[[ -n "$DMG" ]] || fail "no packaged .dmg; run npm run package first"
BUNDLE_ID="$(defaults read "$PWD/${OBJ}dist/Wren.app/Contents/Info.plist" CFBundleIdentifier)"

WORK="$PWD/.wren/sign"
rm -rf "$WORK" && mkdir -p "$WORK/stage"

say "Copying Wren.app out of $(basename "$DMG")"
MOUNT="$(hdiutil attach -readonly -nobrowse "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}')"
ditto "$MOUNT/Wren.app" "$WORK/stage/Wren.app"
hdiutil detach -quiet "$MOUNT"

# The entitlements name the App ID; Zen's patch points them at Zen's team.
ENT="engine/security/mac/hardenedruntime/production/firefox.browser.xml"
python3 - "$ENT" "$WREN_TEAM_ID.$BUNDLE_ID" <<'EOF'
import re, sys
path, app_id = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
pattern = r"(<key>com\.apple\.application-identifier</key>\s*<string>)[^<]*(</string>)"
text, count = re.subn(pattern, rf"\g<1>{app_id}\g<2>", text)
if count != 1:
    sys.exit(f"wren_sign: expected one application-identifier in {path}, found {count}")
open(path, "w", encoding="utf-8").write(text)
print(f"wren_sign: entitlements name {app_id}")
EOF

say "Signing with $WREN_SIGNING_IDENTITY"
cp "$KEYS/Wren.provisionprofile" engine/embedded.provisionprofile
trap 'rm -f engine/embedded.provisionprofile' EXIT
(cd engine && ./mach macos-sign -v -c release -e production \
  -s "$WREN_SIGNING_IDENTITY" -a "$WORK/stage/Wren.app")

say "Checking the signature"
codesign --verify --deep --strict "$WORK/stage/Wren.app"
codesign -d --entitlements - --xml "$WORK/stage/Wren.app" 2>/dev/null \
  | grep -q "com.apple.developer.web-browser.public-key-credential" \
  || fail "the signed app lacks the passkey entitlement"

say "Building the .dmg"
(cd engine && ./mach python -m mozbuild.action.make_dmg \
  --volume-name Wren \
  --background ./browser/branding/release/background.png \
  --icon ./browser/branding/release/firefox.icns \
  --dsstore ./browser/branding/release/dsstore \
  "$WORK/stage/" "$WORK/Wren-unsigned.dmg")
OUT="$PWD/.wren/Wren.dmg"
rm -f "$OUT"
hdiutil convert "$WORK/Wren-unsigned.dmg" -format UDZO -imagekey zlib-level=9 -o "$OUT" > /dev/null
codesign -s "$WREN_SIGNING_IDENTITY" "$OUT"

if (( NOTARIZE )); then
  : "${WREN_NOTARY_PROFILE:?set WREN_NOTARY_PROFILE in $KEYS/signing.env}"
  say "Notarizing (Apple usually answers in a few minutes)"
  xcrun notarytool submit "$OUT" --keychain-profile "$WREN_NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT"
  spctl -a -t open --context context:primary-signature -v "$OUT"
fi

echo "Done: $OUT"
