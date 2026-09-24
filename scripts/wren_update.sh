#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Brings Zen's (and so Firefox's) updates into Wren, rebuilds, tests and
# packages it. Wren has no self-updater, so this is how it gets security fixes.
#
#   scripts/wren_update.sh check          is there a newer Zen release?
#   scripts/wren_update.sh apply          merge it, rebuild, test, package
#   scripts/wren_update.sh apply --dev    follow Zen's dev branch instead
#
# check exits 0 when Wren is up to date and 10 when an update is waiting.

set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/python@3.11/libexec/bin:$PATH"

MODE="${1:-check}"
TRACK="release"
[[ "${2:-}" == "--dev" ]] && TRACK="dev"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nwren_update: %s\n' "$*" >&2; exit 1; }

firefox_version() { git show "$1:surfer.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"]["version"])'; }

# The newest Zen release tag, or the tip of Zen's dev branch.
target_ref() {
  if [[ "$TRACK" == "dev" ]]; then
    echo "upstream/dev"
  else
    git tag --list --sort=-creatordate | grep -E '^[0-9]+\.[0-9]+(\.[0-9]+)?[a-z]*$' | head -1
  fi
}

git fetch --quiet upstream --tags
TARGET="$(target_ref)"
[[ -n "$TARGET" ]] || fail "found no Zen release tag"
BEHIND="$(git rev-list --count "HEAD..$TARGET")"
OLD_FF="$(firefox_version HEAD)"
NEW_FF="$(firefox_version "$TARGET")"

if [[ "$MODE" == "check" ]]; then
  if [[ "$BEHIND" == "0" ]]; then
    echo "Wren is up to date with Zen $TARGET (Firefox $OLD_FF)."
    exit 0
  fi
  echo "Update waiting: Zen $TARGET, $BEHIND new commits."
  if [[ "$OLD_FF" != "$NEW_FF" ]]; then
    echo "Firefox $OLD_FF -> $NEW_FF: a full download and rebuild, roughly 2 hours."
  else
    echo "Same Firefox ($OLD_FF): a partial rebuild."
  fi
  echo "Run: scripts/wren_update.sh apply"
  exit 10
fi

[[ "$MODE" == "apply" ]] || fail "unknown command '$MODE' (use check or apply)"
[[ -z "$(git status --porcelain)" ]] || fail "commit or stash your changes first; a merge needs a clean tree"

if [[ "$BEHIND" != "0" ]]; then
  say "Merging Zen $TARGET ($BEHIND commits)"
  # .gitattributes keeps Wren's README (merge=ours); the driver must exist.
  git config merge.ours.driver true
  if ! git merge --no-edit -m "wren: Merge Zen $TARGET" "$TARGET"; then
    fail "the merge has conflicts, most likely in a patch Wren also changed.
Fix them (git status lists them), commit, then run apply again.
To back out instead: git merge --abort"
  fi
else
  say "Already on Zen $TARGET; rebuilding anyway"
fi

if [[ "$OLD_FF" != "$NEW_FF" || ! -d engine ]]; then
  say "Firefox $OLD_FF -> $NEW_FF: downloading the new source (engine/ is replaced)"
  rm -rf engine
  npm run download
  npm run import
  (cd engine && ./mach --no-interactive bootstrap --application-choice browser)
else
  say "Resetting engine/ and re-applying patches (the build folder is kept)"
  git -C engine checkout -- .
  git -C engine clean -fdq
  npm run import
fi

# Zen's own English strings. Without them ⌘T has no key.
python3 scripts/update_en_US_packs.py

say "Building"
mkdir -p .wren
(cd engine && ./mach -l ../.wren/build.log build > /dev/null) || fail "the build failed; the full log is in .wren/build.log"

say "Testing Wren's features"
# run_tests.py takes one folder per run.
for suite in wren_zps wren_privacy; do
  npm test -- "$suite" --headless > ".wren/test-$suite.log" 2>&1 || fail "Wren's $suite tests failed; see .wren/test-$suite.log"
  echo "$suite: $(grep -m1 -oE 'Passed: +[0-9]+' ".wren/test-$suite.log"), $(grep -m1 -oE 'Failed: +[0-9]+' ".wren/test-$suite.log")"
done

say "Packaging"
npm run package > .wren/package.log 2>&1 || fail "packaging failed; see .wren/package.log"
DMG="$(ls -t engine/obj-*/dist/*.dmg | head -1)"
echo "Done: $DMG"
echo "Open it and drag Wren to Applications, replacing the old one."
