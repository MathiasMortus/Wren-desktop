/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// WrenMemory asks every process to give memory back, once, each time the
// browser has been left alone for a while. It does that by sending the
// "memory-pressure" notification with "heap-minimize", which is what this
// test counts.

const { WrenMemory } = ChromeUtils.importESModule(
  "resource:///modules/zen/memory/WrenMemory.sys.mjs"
);

const PREF_ENABLED = "wren.memory.idle-minimize.enabled";
const PREF_DELAY = "wren.memory.idle-minimize.delay-seconds";

// The variants that leave out pointer moves Firefox makes up after a reflow.
const TOPIC_INACTIVE = "user-interaction-inactive-non-synthesized";
const TOPIC_ACTIVE = "user-interaction-active-non-synthesized";

// The shortest delay the pref allows is 1 second. "No sweep" is checked half
// a second after a sweep would have come.
const DELAY_SECONDS = 1;
const PAST_THE_DELAY_MS = 1500;

// Eight sweeps, each a full garbage collection, plus the waits above.
requestLongerTimeout(3);

let sweeps = 0;
function countSweeps(_subject, _topic, data) {
  if (data === "heap-minimize") {
    sweeps++;
  }
}

function nextSweep() {
  return TestUtils.topicObserved("memory-pressure", (_subject, data) => data === "heap-minimize");
}

function wait(ms) {
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  return new Promise(resolve => setTimeout(resolve, ms));
}

function observerCount(topic) {
  return Array.from(Services.obs.enumerateObservers(topic)).length;
}

// What Firefox tells WrenMemory a few seconds after the last input, and when
// input starts again.
function userLeaves() {
  WrenMemory.observe(null, TOPIC_INACTIVE, null);
}

function userComesBack() {
  WrenMemory.observe(null, TOPIC_ACTIVE, null);
}

add_setup(async function () {
  // Nothing in this test starts WrenMemory: the browser does, some time after
  // startup, through MemoryComponents.manifest.
  await TestUtils.waitForCondition(
    () => WrenMemory.initialized,
    "WrenMemory starts with the browser",
    100,
    300
  );

  // The rest of the test hands WrenMemory its notifications directly. Left
  // listening, it would also get the browser's real ones, from input that an
  // earlier test synthesized, at moments this test does not choose.
  const inactiveObservers = observerCount(TOPIC_INACTIVE);
  const activeObservers = observerCount(TOPIC_ACTIVE);
  WrenMemory.uninit();
  Assert.equal(
    observerCount(TOPIC_INACTIVE),
    inactiveObservers - 1,
    "WrenMemory was listening for the user going away"
  );
  Assert.equal(
    observerCount(TOPIC_ACTIVE),
    activeObservers - 1,
    "WrenMemory was listening for the user coming back"
  );

  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_ENABLED, true],
      [PREF_DELAY, DELAY_SECONDS],
    ],
  });
  Services.obs.addObserver(countSweeps, "memory-pressure");

  registerCleanupFunction(async () => {
    Services.obs.removeObserver(countSweeps, "memory-pressure");
    userComesBack();
    // Back to the real delay before WrenMemory starts waiting again, or it
    // would sweep one second into the next test.
    await SpecialPowers.flushPrefEnv();
    WrenMemory.init();
  });
});

add_task(async function test_one_sweep_per_inactive_period() {
  const before = sweeps;
  userComesBack();

  const swept = nextSweep();
  userLeaves();
  await swept;
  Assert.equal(sweeps, before + 1, "Being away for the delay gives one sweep");

  userLeaves();
  await wait(PAST_THE_DELAY_MS);
  Assert.equal(sweeps, before + 1, "Staying away does not give another one");
});

add_task(async function test_a_repeated_inactive_does_not_restart_the_wait() {
  userComesBack();

  // Firefox repeats "inactive" every few seconds while only made-up pointer
  // moves arrive. The wait must run from the first one.
  userLeaves();
  const waiting = WrenMemory.timer;
  Assert.notEqual(waiting, null, "Going away starts the wait");
  userLeaves();
  Assert.equal(WrenMemory.timer, waiting, "Another 'inactive' leaves the wait running");

  userComesBack();
  Assert.equal(WrenMemory.timer, null, "Coming back stops it");
});

add_task(async function test_starts_waiting_at_startup() {
  const before = sweeps;
  // A browser that is started and left alone may have had its only
  // "inactive" before WrenMemory started, so init() starts the wait itself.
  // This test listens to the browser's real notifications for a moment.
  const swept = nextSweep();
  WrenMemory.init();
  try {
    await swept;
    Assert.equal(sweeps, before + 1, "A browser left alone after startup gets its sweep");
  } finally {
    WrenMemory.uninit();
  }
});

add_task(async function test_coming_back_cancels_and_rearms() {
  const before = sweeps;
  userComesBack();

  userLeaves();
  userComesBack();
  await wait(PAST_THE_DELAY_MS);
  Assert.equal(sweeps, before, "Coming back before the delay is over cancels the sweep");

  const swept = nextSweep();
  userLeaves();
  await swept;
  Assert.equal(sweeps, before + 1, "The next time away gets its own sweep");
});

add_task(async function test_no_sweep_when_turned_off() {
  const before = sweeps;
  userComesBack();

  await SpecialPowers.pushPrefEnv({ set: [[PREF_ENABLED, false]] });
  userLeaves();
  await wait(PAST_THE_DELAY_MS);
  Assert.equal(sweeps, before, "No sweep while the pref is off");
  await SpecialPowers.popPrefEnv();

  userComesBack();
  const swept = nextSweep();
  userLeaves();
  await swept;
  Assert.equal(sweeps, before + 1, "Turning the pref back on works without a restart");
});

add_task(async function test_waits_while_a_tab_plays_sound() {
  const before = sweeps;
  userComesBack();

  // The attribute is how the browser marks a tab that is making sound, and
  // what tab.soundPlaying reads.
  const tab = gBrowser.selectedTab;
  tab.toggleAttribute("soundplaying", true);
  try {
    Assert.ok(tab.soundPlaying, "The tab counts as playing sound");
    userLeaves();
    await wait(PAST_THE_DELAY_MS);
    Assert.equal(sweeps, before, "No sweep while a tab plays sound");

    const swept = nextSweep();
    tab.removeAttribute("soundplaying");
    await swept;
    Assert.equal(sweeps, before + 1, "The sweep comes once the sound has stopped");
  } finally {
    tab.removeAttribute("soundplaying");
  }
});

add_task(async function test_waits_during_a_call() {
  const before = sweeps;
  userComesBack();

  // What webrtcUI (a global of the browser window) records for a tab that is
  // using the camera. Getting a real camera stream means permission prompts
  // and a sharing indicator window.
  const call = {};
  webrtcUI.perTabIndicators.set(call, { showCameraIndicator: true });
  try {
    Assert.ok(webrtcUI.showGlobalIndicator, "A tab counts as using the camera");
    userLeaves();
    await wait(PAST_THE_DELAY_MS);
    Assert.equal(sweeps, before, "No sweep while the camera is in use");

    const swept = nextSweep();
    webrtcUI.perTabIndicators.delete(call);
    await swept;
    Assert.equal(sweeps, before + 1, "The sweep comes once the call has ended");
  } finally {
    webrtcUI.perTabIndicators.delete(call);
  }
});

add_task(async function test_waits_during_picture_in_picture() {
  const before = sweeps;
  userComesBack();

  // What the browser sets on a tab whose video plays in its own window.
  const tab = gBrowser.selectedTab;
  tab.toggleAttribute("pictureinpicture", true);
  try {
    userLeaves();
    await wait(PAST_THE_DELAY_MS);
    Assert.equal(sweeps, before, "No sweep while a video plays in Picture-in-Picture");

    const swept = nextSweep();
    tab.removeAttribute("pictureinpicture");
    await swept;
    Assert.equal(sweeps, before + 1, "The sweep comes once the video window is closed");
  } finally {
    tab.removeAttribute("pictureinpicture");
  }
});

add_task(async function test_waits_while_a_page_is_fullscreen() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["full-screen-api.allow-trusted-requests-only", false],
      ["full-screen-api.transition-duration.enter", "0 0"],
      ["full-screen-api.transition-duration.leave", "0 0"],
    ],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const before = sweeps;
  userComesBack();

  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.document.body.requestFullscreen();
    });
    await TestUtils.waitForCondition(() => document.fullscreenElement, "The page is fullscreen");

    userLeaves();
    await wait(PAST_THE_DELAY_MS);
    Assert.equal(sweeps, before, "No sweep while a page is fullscreen");

    const swept = nextSweep();
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.exitFullscreen());
    await swept;
    Assert.equal(sweeps, before + 1, "The sweep comes once the page has left fullscreen");
  } finally {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      await TestUtils.waitForCondition(() => !document.fullscreenElement, "Fullscreen ended");
    }
    userComesBack();
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
