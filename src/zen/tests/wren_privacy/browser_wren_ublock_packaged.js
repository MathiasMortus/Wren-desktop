/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test profiles never install distribution add-ons
// (extensions.installDistroAddons is false), so this checks what Wren ships:
// uBlock Origin in <app>/distribution/extensions, where Firefox installs it
// from into every new profile.
add_task(async function test_ublock_is_in_the_distribution_folder() {
  const xpi = Services.dirsvc.get("XREAppDist", Ci.nsIFile);
  xpi.append("extensions");
  xpi.append("uBlock0@raymondhill.net.xpi");
  Assert.ok(xpi.exists(), `uBlock Origin ships in ${xpi.path}`);
  Assert.greater(xpi.fileSize, 1000000, "It is the full extension, not a stub");
});
