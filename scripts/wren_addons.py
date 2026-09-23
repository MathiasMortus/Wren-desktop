# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Fetches the extensions Wren ships pre-installed, pinned by version and
# SHA-256, into src/zen/wren-addons/. Firefox installs anything in the app's
# distribution/extensions folder into each new profile, as a normal add-on
# that updates itself from addons.mozilla.org and can be turned off.
# Run before `surfer import` (npm run import does this).

import hashlib
import os
import sys
import urllib.request

ADDONS_DIR = os.path.join("src", "zen", "wren-addons")

ADDONS = [
  {
    # uBlock Origin, GPL-3.0-only. Shipped unmodified, signed by Mozilla.
    "id": "uBlock0@raymondhill.net",
    "version": "1.75.0",
    "url": "https://addons.mozilla.org/firefox/downloads/file/5034826/ublock_origin-1.75.0.xpi",
    "sha256": "5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287",
  },
]


def sha256_of(path: str) -> str:
  digest = hashlib.sha256()
  with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
      digest.update(chunk)
  return digest.hexdigest()


def fetch(addon: dict) -> None:
  path = os.path.join(ADDONS_DIR, f"{addon['id']}.xpi")
  if os.path.exists(path) and sha256_of(path) == addon["sha256"]:
    print(f"wren_addons: {addon['id']} {addon['version']} already present")
    return

  tmp = f"{path}.download"
  print(f"wren_addons: downloading {addon['id']} {addon['version']}")
  urllib.request.urlretrieve(addon["url"], tmp)
  actual = sha256_of(tmp)
  if actual != addon["sha256"]:
    os.remove(tmp)
    sys.exit(f"wren_addons: {addon['id']} hash mismatch: expected {addon['sha256']}, got {actual}")
  os.replace(tmp, path)
  print(f"wren_addons: {addon['id']} {addon['version']} verified")


def main() -> None:
  for addon in ADDONS:
    fetch(addon)


if __name__ == "__main__":
  main()
