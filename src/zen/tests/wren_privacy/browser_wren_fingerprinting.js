/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Wren turns on fingerprinting protection in every window, so canvas reads
// get per-site noise: the same drawing reads back differently on two sites,
// and the same on one site within a session.

const SITE_A = "https://example.com/";
const SITE_B = "https://example.org/";

// Runs as the page itself, like a fingerprinting script would. Code with the
// test's own privileges always reads unrandomized pixels.
const DRAW_AND_READ = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 60;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 240, 0);
  gradient.addColorStop(0, "#ec7951");
  gradient.addColorStop(1, "#2b211c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 240, 60);
  ctx.font = "20px sans-serif";
  ctx.fillStyle = "#fff4ea";
  ctx.fillText("Wren fingerprint test", 8, 38);
  return canvas.toDataURL();
})()`;

async function canvasFingerprint(url) {
  return BrowserTestUtils.withNewTab(url, browser =>
    SpecialPowers.spawn(browser, [DRAW_AND_READ], code => content.wrappedJSObject.eval(code))
  );
}

add_task(async function test_protection_is_on_in_normal_windows() {
  Assert.ok(
    Services.prefs.getBoolPref("privacy.fingerprintingProtection"),
    "Fingerprinting protection is on outside private windows"
  );
  Assert.stringContains(
    Services.prefs.getStringPref("privacy.fingerprintingProtection.overrides"),
    "+WebGLRandomization",
    "WebGL reads are randomized too"
  );
});

add_task(async function test_canvas_reads_differ_per_site() {
  const a1 = await canvasFingerprint(SITE_A);
  const a2 = await canvasFingerprint(SITE_A);
  const b = await canvasFingerprint(SITE_B);

  Assert.equal(a1, a2, "One site sees a stable canvas within a session");
  Assert.notEqual(a1, b, "Two sites see different canvas noise");
});

add_task(async function test_without_protection_sites_match() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.fingerprintingProtection", false],
      ["privacy.baselineFingerprintingProtection", false],
    ],
  });
  const a = await canvasFingerprint(SITE_A);
  const b = await canvasFingerprint(SITE_B);
  Assert.equal(a, b, "With protection off, both sites read identical pixels");
  await SpecialPowers.popPrefEnv();
});
