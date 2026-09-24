<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
   -->
<img src="./docs/assets/wren-bird.png" width="120px" align="left">

### `Wren`

A small, quick browser for macOS that stays out of your way. Wren is built on
[Zen Browser](https://github.com/zen-browser/desktop), which is built on Mozilla Firefox.

<br clear="left">

### What Wren adds to Zen

- **Profiles in the spotlight.** Press ⌘T and type `/profile Work github.com` to open a link in a
  separate profile, with its own cookies and logins. Each profile keeps its own history, and its
  tabs get a name badge.
- **uBlock Origin, pre-installed.** It installs as a normal extension, so it updates itself and you
  can turn it off.
- **Fingerprint randomizing in every window.** Like Brave, Wren gives each site slightly different
  canvas and WebGL results, with a fresh seed every session, so trackers can't follow one
  fingerprint from site to site. Firefox turns on the full set only in private windows.
- **Its own welcome page**, bundled in the browser and readable offline.
- **Its own profile folder** (`~/Library/Application Support/wren`), so it never touches a Zen
  profile.
- **No self-updater.** Wren updates by rebuilding from Zen's releases (see below), so Zen's update
  server can never replace it.
- A fix for Essentials disappearing in spaces that came from sync.

Everything else is Zen: spaces, compact mode, glance, split view, and the rest.

### Building

Wren builds like Zen, with a few extra steps. You need macOS with Xcode, Node 22, Python 3.11 and
Rust 1.95, and about 50 GB of free disk. The first build takes around an hour.

```sh
npm ci
npm run download                        # Firefox's source, into engine/
npm run import                          # Zen's and Wren's patches, prefs and uBlock Origin
python3 scripts/update_en_US_packs.py   # Zen's English strings (without them ⌘T does nothing)
cd engine && ./mach --no-interactive bootstrap --application-choice browser && cd ..
npx surfer set brand release
npm run build
npm run package                         # a .dmg in engine/obj-*/dist/
```

### Updating

Wren has no self-updater, so security fixes arrive by rebuilding. The script follows Zen's
releases, merges them, rebuilds, runs Wren's tests and packages a new `.dmg`:

```sh
scripts/wren_update.sh check    # is a newer Zen release out?
scripts/wren_update.sh apply    # merge, build, test, package
```

### Tests

Wren's own browser tests live in `src/zen/tests/wren_*`:

```sh
npm test -- wren_zps --headless
npm test -- wren_privacy --headless
npm test -- wren_spaces --headless
```

### Signing

`scripts/wren_sign.sh` signs and notarizes a packaged Wren with an Apple Developer ID. macOS only
shows its passkey sheet to browsers signed with Apple's web-browser passkey entitlement. Until
that entitlement is in place, passkeys in iCloud Keychain and similar providers don't work in
Wren, but USB security keys do.

### Credits and license

Wren is a fork of [Zen Browser](https://github.com/zen-browser/desktop) by the Zen team, which is
built on [Mozilla Firefox](https://www.mozilla.org/firefox/). All the credit for the browser
underneath goes to them. Like both, Wren is licensed under the [Mozilla Public License 2.0](./LICENSE).
uBlock Origin is by Raymond Hill and contributors, GPL-3.0, and ships unmodified.
