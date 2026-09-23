# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Surfer writes firefox-branding.js on every import, with Zen's website
# hardcoded, and that file loads after prefs/*.yaml. This rewrites the
# first-run pages so Wren opens its own bundled welcome page instead.
# Run after `surfer import` (npm run import does this).

import glob
import re
import sys

OVERRIDES = {
  "startup.homepage_welcome_url": "resource://wren-welcome/index.html",
  # Zen opens its privacy policy as a second first-run tab.
  "startup.homepage_welcome_url.additional": "",
  # Zen opens its changelog site after every version change.
  "startup.homepage_override_url": "",
}


def rewrite(path: str) -> None:
  with open(path, "r", encoding="utf-8") as f:
    contents = f.read()

  for name, value in OVERRIDES.items():
    pattern = re.compile(r'pref\("' + re.escape(name) + r'",\s*"[^"]*"\);')
    contents, count = pattern.subn(f'pref("{name}", "{value}");', contents)
    if count != 1:
      sys.exit(f"wren_branding: expected one '{name}' in {path}, found {count}")

  with open(path, "w", encoding="utf-8") as f:
    f.write(contents)
  print(f"wren_branding: rewrote first-run pages in {path}")


def is_surfer_generated(path: str) -> bool:
  # Firefox's own branding folders (nightly, official...) have their own
  # firefox-branding.js; only surfer's brands carry Zen's or Wren's pages.
  with open(path, "r", encoding="utf-8") as f:
    contents = f.read()
  return "zen-browser.app" in contents or "wren-welcome" in contents


def main() -> None:
  paths = sorted(glob.glob("engine/browser/branding/*/pref/firefox-branding.js"))
  paths = [p for p in paths if is_surfer_generated(p)]
  if not paths:
    sys.exit("wren_branding: no surfer-generated firefox-branding.js found; run surfer import first")
  for path in paths:
    rewrite(path)


if __name__ == "__main__":
  main()
