/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* WrenMemory – gives memory back while nobody is using the browser.
 *
 * Started once the browser is up and idle (MemoryComponents.manifest). When
 * Wren has had no keyboard or mouse input for a few minutes, it sends one
 * "heap-minimize" memory-pressure notification. Firefox passes that on to
 * every process, and each one collects garbage and drops what it can rebuild
 * later: decoded images, font caches, pages kept for instant Back, spare
 * content processes.
 *
 * One notification, not about:memory's "Minimize memory usage": that button
 * makes every web process collect six times and frees about 2% more.
 *
 * The memory prefs that go with this are in prefs/wren/memory.yaml.
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

const PREF_ENABLED = "wren.memory.idle-minimize.enabled";
const PREF_DELAY = "wren.memory.idle-minimize.delay-seconds";

// Outside this range the delay pref would give a timer that fires in a tight
// loop while a sweep is being held back, or one too long for a timer to count.
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 24 * 60 * 60;

// Firefox sends these in the parent process, for input anywhere in the
// browser, web pages included. "inactive" comes 5 to 10 seconds after the
// last key press, click, scroll or pointer move, and "active" with the next
// input and every 5 seconds while input keeps coming. These are the
// "-non-synthesized" variants: the plain "user-interaction-active" also
// counts the pointer moves Firefox makes up after a reflow under a cursor
// that rests over the window (a tab title or favicon changing is enough), so
// with the cursor left there the user would never count as away. In that
// case "inactive" comes again every 5 seconds, and "active" can come up to
// 5 seconds after the user is back.
const TOPIC_INACTIVE = "user-interaction-inactive-non-synthesized";
const TOPIC_ACTIVE = "user-interaction-active-non-synthesized";

// A sweep makes every process stop and collect for a moment. Someone who
// gives no input can still be listening, watching a video, or in a call, and
// would hear or see that pause.
function someoneIsStillThere() {
  if (lazy.webrtcUI.showGlobalIndicator) {
    return true;
  }
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    // fullscreenElement is set for a page's own fullscreen (a video), not for
    // a fullscreen window, which is how many people always use the browser.
    if (win.document.fullscreenElement) {
      return true;
    }
    // Asked of the document, because gBrowser.tabs only lists the tabs of the
    // space that is showing, and music often plays in another one.
    if (win.document.querySelector(".tabbrowser-tab:is([soundplaying], [pictureinpicture])")) {
      return true;
    }
    // A video on screen that plays on without sound: in a quiet passage, or
    // muted after it started. (Firefox's media control never sees a video
    // that has been silent from the start.) On screen means the selected tab,
    // or a pane Zen shows next to it in a split view or glance (zenModeActive
    // is on the browser).
    const loadedTabs = win.document.querySelectorAll(".tabbrowser-tab[linkedpanel]:not([pending])");
    for (const tab of loadedTabs) {
      const browser = tab.linkedBrowser;
      if (
        (tab.selected || browser?.zenModeActive) &&
        browser?.browsingContext?.mediaController?.isPlaying
      ) {
        return true;
      }
    }
  }
  return false;
}

export const WrenMemory = {
  initialized: false,

  // The pending timer while the user is away, or null.
  timer: null,

  // Whether this stretch of inactivity has had its sweep.
  swept: false,

  // Runs once, after startup, when the browser is idle (browser-idle-startup).
  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    Services.obs.addObserver(this, TOPIC_INACTIVE);
    Services.obs.addObserver(this, TOPIC_ACTIVE);

    // A browser that is started and then left alone gets its only "inactive"
    // a few seconds after startup, which can be before this runs. So start
    // out as if the user is away. If they are not, "active" arrives within
    // 5 seconds and stops the timer.
    this.swept = false;
    this.arm();
  },

  // Stops listening and waiting. The test uses this to feed observe() by hand
  // without the browser's own activity notifications arriving in between.
  uninit() {
    if (!this.initialized) {
      return;
    }
    this.initialized = false;

    Services.obs.removeObserver(this, TOPIC_INACTIVE);
    Services.obs.removeObserver(this, TOPIC_ACTIVE);
    this.disarm();
  },

  observe(_subject, topic) {
    if (topic === TOPIC_ACTIVE) {
      this.disarm();
      this.swept = false;
    } else if (topic === TOPIC_INACTIVE && !this.swept && this.timer === null) {
      // "inactive" can repeat while the user stays away. The wait runs from
      // the first one, so a repeat leaves a running timer alone.
      this.arm();
    }
  },

  // The prefs are read here and in onTimer rather than cached, so a change
  // applies from the next time the user goes away, without a restart.
  arm() {
    this.disarm();
    if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) {
      return;
    }
    const seconds = Math.min(
      Math.max(Services.prefs.getIntPref(PREF_DELAY, 300), MIN_DELAY_SECONDS),
      MAX_DELAY_SECONDS
    );
    this.timer = setTimeout(() => this.onTimer(), seconds * 1000);
  },

  disarm() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  },

  onTimer() {
    this.timer = null;
    if (Services.startup.shuttingDown || !Services.prefs.getBoolPref(PREF_ENABLED, true)) {
      return;
    }
    if (someoneIsStillThere()) {
      // Look again after the same delay: the music may have ended by then.
      this.arm();
      return;
    }

    // Set before sending, so nothing this triggers can start a second sweep.
    this.swept = true;
    Services.obs.notifyObservers(null, "memory-pressure", "heap-minimize");
  },
};
