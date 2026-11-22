/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* WrenTabUnloader – puts tabs to sleep when they have not been used for a while.
 *
 * Started once the browser is idle after startup (MemoryComponents.manifest).
 * Once a minute it looks at every tab in every window and unloads the ones
 * nobody has looked at for wren.tab-unloader.timeout-minutes. A sleeping tab
 * stays in the sidebar and reloads where the user left it when they select it.
 * Pinned tabs and essentials sleep too: their pages are where the memory is.
 *
 * It uses the same call Firefox's own low-memory unloader uses (discardBrowser
 * without the force flag), so a page that answers "leave this page?" with no
 * is left alone. A tab with a dialog open, the page's own alert/confirm/prompt
 * boxes included, is not unloaded either. It never goes through
 * gBrowser.explicitUnloadTabs: that one prompts, forces, and moves the
 * selection.
 *
 * Firefox's low-memory unloader asks keepForLowMemory() below, so the same
 * rules hold there (TabUnloader-sys-mjs.patch).
 *
 * The prefs are in prefs/wren/tab-unloader.yaml.
 */

import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

const PREF_BRANCH = "wren.tab-unloader.";
const PREF_ENABLED = PREF_BRANCH + "enabled";

const SWEEP_INTERVAL_MS = 60 * 1000;
// A tick that arrives this much later than planned means the computer slept.
const SLEEP_SLACK_MS = 60 * 1000;
const MAX_SLEEP_GAPS = 64;
// Unloading is spread out so a long list of idle tabs doesn't stall the UI.
const MAX_DISCARDS_PER_SWEEP = 5;
// A hung page never answers the "save your state" request.
const FLUSH_TIMEOUT_MS = 10 * 1000;

// ---------------------------------------------------------------------------
// Settings. Read on every sweep, so a change applies within a minute.

function readSettings() {
  const prefs = Services.prefs;
  return {
    enabled: prefs.getBoolPref(PREF_ENABLED, true),
    timeoutMs: Math.max(1, prefs.getIntPref(PREF_BRANCH + "timeout-minutes", 60)) * 60 * 1000,
    unloadPinned: prefs.getBoolPref(PREF_BRANCH + "unload-pinned", true),
    unloadEssentials: prefs.getBoolPref(PREF_BRANCH + "unload-essentials", true),
    keepNotificationSites: prefs.getBoolPref(PREF_BRANCH + "keep-notification-sites", false),
    excludedHosts: parseHosts(prefs.getStringPref(PREF_BRANCH + "excluded-hosts", "")),
  };
}

// "Mail.Example.com, *.chat.example, https://example.org/inbox" -> host names
// in the form nsIURI.asciiHost reports them.
function parseHosts(list) {
  const hosts = [];
  for (const raw of (list || "").split(",")) {
    const entry = raw.trim().replace(/^\*?\./, "");
    if (!entry) {
      continue;
    }
    try {
      const host = Services.io.newURI(entry.includes("://") ? entry : `https://${entry}`).asciiHost;
      if (host) {
        hosts.push(host);
      }
    } catch (e) {
      // Not a host name. One bad entry must not switch the others off.
    }
  }
  return hosts;
}

function isExcludedHost(uri, hosts) {
  // Empty for pages without a host, such as files.
  const host = uri.asciiHost;
  return !!host && hosts.some(excluded => host === excluded || host.endsWith(`.${excluded}`));
}

// ---------------------------------------------------------------------------
// Time. "Not used for an hour" means an hour in which the computer was awake
// and the unloader was running. Counted by the wall clock alone, opening the
// laptop in the morning would unload every tab at once, and so would starting
// the browser with a session whose last-used times are from yesterday.

const Clock = {
  lastTick: 0,
  gaps: [], // [{ start, end }]: stretches of wall-clock time spent asleep

  start() {
    this.lastTick = Date.now();
    this.gaps = [];
  },

  // `now` is for tests, which cannot put the computer to sleep.
  tick(now = Date.now()) {
    const planned = this.lastTick + SWEEP_INTERVAL_MS;
    if (now - planned > SLEEP_SLACK_MS) {
      this.gaps.push({ start: planned, end: now });
      if (this.gaps.length > MAX_SLEEP_GAPS) {
        this.gaps.shift();
      }
    }
    this.lastTick = now;
  },

  awakeBetween(from, to) {
    let ms = to - from;
    for (const gap of this.gaps) {
      const overlap = Math.min(gap.end, to) - Math.max(gap.start, from);
      if (overlap > 0) {
        ms -= overlap;
      }
    }
    return ms;
  },
};

// tab.lastAccessed only moves when a tab is selected or deselected, and comes
// out of the session file after a restart. So each tab also gets the time a
// sweep first found it loaded, and its idle time starts at the later of the
// two. That covers tabs that were restored with an old last-used time and
// tabs that woke up in the background (Reload on a sleeping tab, a split view
// loading its panes).
let awakeSince = new WeakMap();

function isAsleep(tab) {
  // Not just [pending]: the copies ZenWindowSync keeps of a tab in the other
  // windows have no browser and no pending attribute until they are selected.
  return !tab.linkedPanel || tab.hasAttribute("pending");
}

function noteLoadState(tab) {
  if (isAsleep(tab)) {
    awakeSince.delete(tab);
  } else if (!awakeSince.has(tab)) {
    awakeSince.set(tab, Date.now());
  }
}

function idleMs(tab, now) {
  const lastUsed = Math.max(Number(tab.lastAccessed) || 0, awakeSince.get(tab) ?? Date.now());
  return Clock.awakeBetween(lastUsed, now);
}

// ---------------------------------------------------------------------------
// Which tabs stay awake

// What the checks below need to know about one window. `ignoreIdle` leaves
// out how long a tab has gone unused, for callers that decide that themselves.
function contextFor(win, settings, now, { ignoreIdle = false } = {}) {
  let visible = [];
  try {
    // The panes of the split view that is on screen (gZenViewSplitter).
    visible = win.gBrowser.selectedBrowsers;
  } catch (e) {
    // The window is still starting up.
  }
  return { win, settings, now, visible, ignoreIdle };
}

// Discarding a browser closes its dialogs. Tab-level dialogs and the page's
// own alert/confirm/prompt boxes live in two managers, and Firefox's
// non-forced discardBrowser only looks at the first. Read through the
// property: gBrowser.getTabDialogBox() would create a box for every tab.
function hasOpenDialog(browser) {
  const box = browser.tabDialogBox;
  return !!box && (box._tabDialogManager.hasDialogs || !!box._contentDialogManager?.hasDialogs);
}

// Returns why this tab must stay loaded, or null when it may sleep.
// Only call it for a loaded tab: reading most properties of a sleeping tab's
// browser loads it again.
function reasonToKeep(tab, { settings, now, visible, ignoreIdle }) {
  if (!tab.isConnected || tab.closing) {
    return "closing";
  }
  if (tab.selected || tab.multiselected) {
    return "selected";
  }
  if (tab.hasAttribute("zen-empty-tab")) {
    return "empty";
  }
  // Both the glance and the tab it was opened from carry glance-id.
  if (tab.hasAttribute("glance-id") || tab.hasAttribute("zen-glance-tab")) {
    return "glance";
  }
  if (tab.undiscardable) {
    return "undiscardable"; // an extension asked for this tab to be kept
  }
  // Essentials are pinned tabs too, but only their own pref decides for them.
  if (tab.hasAttribute("zen-essential")) {
    if (!settings.unloadEssentials) {
      return "essential";
    }
  } else if (tab.pinned && !settings.unloadPinned) {
    return "pinned";
  }
  if (!ignoreIdle && idleMs(tab, now) < settings.timeoutMs) {
    return "recent";
  }
  if (tab.hasAttribute("busy")) {
    return "loading";
  }
  if (tab.soundPlaying || tab.pictureinpicture || tab.hasAttribute("sharing")) {
    return "media";
  }

  const browser = tab.linkedBrowser;
  if (!browser?.isConnected || !browser.isRemoteBrowser) {
    return "not-unloadable"; // pages that run inside the browser's own process
  }
  // Zen sets zenModeActive on the browser of every pane that is on screen in a
  // split view or glance. Such a tab is not "selected" and its last-used time
  // is stale, so this is the only thing that tells us it is being looked at.
  if (browser.zenModeActive || visible.includes(browser)) {
    return "visible";
  }
  if (hasOpenDialog(browser)) {
    return "dialog";
  }

  const context = browser.browsingContext;
  // Covers what the sound icon misses: a video that has made sound and is now
  // muted by the page, or in a quiet passage. A video that has been silent
  // from the start does not count: Firefox's media control ignores media that
  // never made a sound.
  if (context?.mediaController?.isPlaying) {
    return "media";
  }
  if (
    lazy.webrtcUI.browserHasStreams(browser) ||
    context?.currentWindowGlobal?.hasActivePeerConnections()
  ) {
    return "call";
  }

  const uri = browser.currentURI;
  // Web pages are where the memory is. This leaves alone extension pages,
  // about: pages, and the about:blank page ZenWindowSync puts in a tab after
  // it moved the real page to the same tab in another window.
  if (!uri || !(uri.schemeIs("http") || uri.schemeIs("https") || uri.schemeIs("file"))) {
    return "not-a-web-page";
  }
  if (isExcludedHost(uri, settings.excludedHosts)) {
    return "excluded-host";
  }
  if (
    settings.keepNotificationSites &&
    Services.perms.testPermissionFromPrincipal(browser.contentPrincipal, "desktop-notification") ===
      Services.perms.ALLOW_ACTION
  ) {
    return "notifications";
  }
  // hasToolboxForTab would start the developer tools if they aren't running.
  if (lazy.DevToolsShim.isInitialized() && lazy.DevToolsShim.hasToolboxForTab(tab)) {
    return "devtools";
  }
  return null;
}

// A split view sleeps or stays awake as a whole: when one of its tabs is
// unloaded, Zen unloads the others (ZenViewSplitter.handleTabBrowserDiscarded).
function unitOf(tab) {
  return tab.group?.hasAttribute("split-view-group") ? tab.group.tabs : [tab];
}

// The same question for a tab together with its split view, if it is in one.
function reasonToKeepUnit(members, context) {
  const awake = members.filter(tab => !isAsleep(tab));
  if (!awake.length) {
    return "asleep";
  }
  for (const tab of awake) {
    const reason = reasonToKeep(tab, context);
    if (reason) {
      return reason;
    }
  }
  // When one pane is unloaded, Zen unloads the others with the forced call,
  // which asks "leave this page?" out loud. A pane that would ask keeps the
  // whole split view awake. (A pane with a dialog open is kept above.)
  if (members.length > 1 && awake.some(tab => tab.linkedBrowser.hasBeforeUnload)) {
    return "split-view-would-ask";
  }
  return null;
}

// Everything that may sleep now, as { win, members, idle }, longest idle
// first. For a split view `idle` is that of its most recently used pane.
function collectUnits(settings, now) {
  const units = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    try {
      if (
        win.closed ||
        !win.gBrowser ||
        !win.gZenWorkspaces ||
        lazy.PrivateBrowsingUtils.isWindowPrivate(win)
      ) {
        continue;
      }
      // gBrowser.tabs only has the current space. This list has every space,
      // the essentials and the glance tabs.
      const tabs = win.gZenWorkspaces.allStoredTabs;
      tabs.forEach(noteLoadState);

      const context = contextFor(win, settings, now);
      const seen = new Set();
      for (const tab of tabs) {
        // In a large session most tabs are asleep already: pass over those
        // before anything that costs a lookup.
        if (seen.has(tab) || isAsleep(tab)) {
          continue;
        }
        const members = unitOf(tab);
        members.forEach(member => seen.add(member));
        if (reasonToKeepUnit(members, context)) {
          continue;
        }
        const idle = Math.min(
          ...members.filter(member => !isAsleep(member)).map(member => idleMs(member, now))
        );
        units.push({ win, members, idle });
      }
    } catch (e) {
      console.error("WrenTabUnloader: couldn't check a window", e);
    }
  }
  return units.sort((a, b) => b.idle - a.idle);
}

// ---------------------------------------------------------------------------
// Unloading

// Asks the page for its latest scroll position, form text and history, so the
// tab comes back the way it was left. False when the page didn't answer.
async function saveState(win, tab) {
  let timer;
  const gaveUp = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([win.gBrowser.prepareDiscardBrowser(tab).then(() => true), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

// A tab opened from a collapsed folder stays shown under the folder header
// ([folder-active]). Zen's own Unload takes it out of there first
// (ZenPinnedTabManager.onCloseTabShortcut). Without this the collapsed folder
// would go on showing a sleeping tab as its active one.
async function leaveCollapsedFolder(win, tabs) {
  for (const tab of tabs) {
    if (!tab.hasAttribute("folder-active") || !win.gZenFolders) {
      continue;
    }
    const group = tab.group?.hasAttribute("split-view-group") ? tab.group.group : tab.group;
    try {
      await win.gZenFolders.animateUnload(group, tab);
    } catch (e) {
      console.error("WrenTabUnloader: couldn't take a tab out of its folder", e);
    }
  }
}

// Returns the tabs it unloaded: none, one, or every pane of a split view.
async function putToSleep({ win, members }, settings, now) {
  const stillToSleep = () =>
    !win.closed && !reasonToKeepUnit(members, contextFor(win, settings, now));
  const awake = members.filter(member => !isAsleep(member));

  // Every pane of a split view is saved here, with a time limit, and then all
  // of them are unloaded at once below. Left to Zen, the other panes would be
  // saved without a time limit and then force-unloaded, even if the user had
  // brought the split view back on screen in the meantime.
  const saved = (await Promise.all(awake.map(tab => saveState(win, tab)))).every(Boolean);
  // The user may have come back to the tab, or closed it, while we waited.
  if (saved && stillToSleep()) {
    await leaveCollapsedFolder(win, awake);
  }

  const unloaded = [];
  // Checked again right before, and no waiting from here on: nothing can come
  // between the check and the unloading.
  if (saved && stillToSleep()) {
    for (const tab of awake) {
      try {
        // Without the force flag Firefox refuses when the page answers
        // "leave this page?" with no, or has a tab-level dialog open.
        if (!isAsleep(tab) && win.gBrowser.discardBrowser(tab)) {
          unloaded.push(tab);
        }
      } catch (e) {
        console.error("WrenTabUnloader: couldn't unload a tab", e);
      }
    }
  }

  if (!unloaded.length) {
    // Start counting again, so the page is asked once per timeout and not
    // once a minute.
    for (const member of members) {
      if (!isAsleep(member)) {
        awakeSince.set(member, Date.now());
      }
    }
    return [];
  }
  for (const tab of unloaded) {
    awakeSince.delete(tab);
    // The mark "Unload Tab" leaves on a tab. Zen dims the icon of a tab that
    // has it (browser.tabs.fadeOutExplicitlyUnloadedTabs), which is how a
    // sleeping tab is told from a loaded one. Session restore removes it on
    // wake-up.
    tab.toggleAttribute("discarded", true);
  }
  return unloaded;
}

async function runSweep(now) {
  const settings = readSettings();
  // Offline, a sleeping tab could not come back.
  if (!settings.enabled || Services.io.offline || Services.startup.shuttingDown) {
    return [];
  }
  const asleep = [];
  for (const unit of collectUnits(settings, now)) {
    if (asleep.length >= MAX_DISCARDS_PER_SWEEP) {
      break;
    }
    try {
      asleep.push(...(await putToSleep(unit, settings, now)));
    } catch (e) {
      console.error("WrenTabUnloader: couldn't check a tab", e);
    }
  }
  return asleep;
}

// ---------------------------------------------------------------------------

let initialized = false;
let timer = null;
let queue = Promise.resolve();
let queued = 0;

function updateTimer() {
  const enabled = Services.prefs.getBoolPref(PREF_ENABLED, true);
  if (enabled && !timer) {
    // Time spent switched off doesn't count as time a tab went unused.
    Clock.start();
    awakeSince = new WeakMap();
    timer = setInterval(() => {
      Clock.tick();
      // A sweep waits for pages to answer, and a hung one takes a while to
      // give up on: don't pile sweeps up behind it.
      if (!queued) {
        WrenTabUnloader.sweep();
      }
    }, SWEEP_INTERVAL_MS);
  } else if (!enabled && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const WrenTabUnloader = {
  // Runs once, after startup, when the browser is idle (browser-idle-startup).
  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    Services.prefs.addObserver(PREF_ENABLED, updateTimer);
    updateTimer();
  },

  // True while the once-a-minute timer is on.
  get running() {
    return !!timer;
  },

  // One pass over all tabs: what the timer runs every minute. Resolves to the
  // tabs it put to sleep. Tests pass a later `now` instead of waiting an hour.
  sweep({ now = Date.now() } = {}) {
    queued++;
    // One at a time: a sweep waits for pages, and two of them working on the
    // same tabs would trip over each other.
    const result = queue
      .then(() => runSweep(now))
      .catch(e => {
        console.error("WrenTabUnloader: sweep failed", e);
        return [];
      })
      .finally(() => queued--);
    // The queue outlives the sweep, so it must not hold on to the tabs.
    queue = result.then(() => {});
    return result;
  },

  // Why a sweep at `now` would leave this tab loaded, as one word such as
  // "selected", "recent" or "pinned", or null when it would unload it. This
  // is the check the sweep itself makes. For tests, and for asking in the
  // Browser Console why a tab never sleeps.
  reasonToKeep(tab, { now = Date.now() } = {}) {
    const win = tab.documentGlobal;
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return "private";
    }
    const settings = readSettings();
    if (!settings.enabled) {
      return "disabled";
    }
    if (Services.io.offline) {
      return "offline";
    }
    return reasonToKeepUnit(unitOf(tab), contextFor(win, settings, now));
  },

  // For Firefox's own unloader, which unloads tabs when the system runs low
  // on memory (TabUnloader-sys-mjs.patch). Why it must leave this tab loaded,
  // or null. The same checks as a sweep, with two differences: how long the
  // tab has gone unused is left to Firefox, and the checks apply even with
  // sleeping tabs turned off, because they are about not losing anything.
  // Firefox skips private windows itself.
  keepForLowMemory(tab) {
    if (isAsleep(tab)) {
      return null;
    }
    return reasonToKeepUnit(
      unitOf(tab),
      contextFor(tab.documentGlobal, readSettings(), Date.now(), { ignoreIdle: true })
    );
  },

  // The record of when the computer slept. Only for tests.
  get _clock() {
    return Clock;
  },
};
