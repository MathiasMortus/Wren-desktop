/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// WrenTabUnloader puts a tab to sleep (unloads it) when it has not been used
// for wren.tab-unloader.timeout-minutes, and the tab loads again when it is
// selected. Once a minute a timer calls WrenTabUnloader.sweep(). This test
// calls the same sweep with a `now` that lies an hour ahead, so nothing here
// waits for a tab to grow old.

const { WrenTabUnloader } = ChromeUtils.importESModule(
  "resource:///modules/zen/memory/WrenTabUnloader.sys.mjs"
);
const { PermissionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PermissionTestUtils.sys.mjs"
);
const { openGlanceOnTab } = ChromeUtils.importESModule(
  "resource://testing-common/GlanceTestUtils.sys.mjs"
);

const PREF = "wren.tab-unloader.";

const PAGE = "https://example.com/";
const PAGE_LEFT_ON = "https://example.com/?left-here";
const SUBDOMAIN_PAGE = "https://test1.example.com/";
const OTHER_SITE_PAGE = "https://example.org/";
// A page with a text field, which can also open an alert() of its own.
const FORM_PAGE = "https://example.com/browser/zen/tests/wren_memory/file_wren_form.html";
// The host of PAGE, written the way a person might type it into the pref.
const EXCLUDED_HOSTS = " Example.com , ";

// A few dozen page loads, a second window, and the wait for the browser's
// idle start-up.
requestLongerTimeout(5);

// Just past the default timeout of 60 minutes.
function anHourLater() {
  return Date.now() + 61 * 60 * 1000;
}

// Why a sweep an hour from now would leave the tab loaded, or null.
function reasonToKeep(tab) {
  return WrenTabUnloader.reasonToKeep(tab, { now: anHourLater() });
}

// What the timer does, as if it were an hour later. One sweep unloads a
// handful of tabs at most, so this repeats it until nothing is left to unload.
async function sweepAnHourLater() {
  const unloaded = [];
  for (;;) {
    const batch = await WrenTabUnloader.sweep({ now: anHourLater() });
    if (!batch.length) {
      return unloaded;
    }
    unloaded.push(...batch);
  }
}

function isAsleep(tab) {
  return !tab.linkedPanel && tab.hasAttribute("pending");
}

function finishedLoading(tab) {
  // The unloader leaves a tab alone for as long as it shows as loading.
  return TestUtils.waitForCondition(() => !tab.hasAttribute("busy"), "The tab finished loading");
}

async function openBackgroundTab(url = PAGE) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await finishedLoading(tab);
  return tab;
}

async function wake(tab) {
  const restored = BrowserTestUtils.waitForEvent(tab, "SSTabRestored");
  gBrowser.selectedTab = tab;
  await restored;
}

// In real use a tab is unloaded an hour after it was last on screen. Here it
// can be a moment after, while the browser is still busy switching away from
// it, so let that finish first.
function tabSwitchFinished() {
  return TestUtils.waitForCondition(() => !gBrowser._switcher, "The tab switch finished");
}

// Puts two loaded tabs into a split view and waits until both are on screen.
async function splitView(left, right) {
  gBrowser.selectedTab = left;
  const activated = BrowserTestUtils.waitForEvent(window, "ZenViewSplitter:SplitViewActivated");
  gZenViewSplitter.splitTabs([left, right], "grid");
  await activated;
  await TestUtils.waitForCondition(
    () => right.linkedBrowser.zenModeActive,
    "The pane that is not the selected tab is on screen too"
  );
  await tabSwitchFinished();
}

// Selects `tab`, which hides the split view of `left` and `right`.
async function hideSplitViewBehind(tab, left, right) {
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => !left.linkedBrowser.zenModeActive && !right.linkedBrowser.zenModeActive,
    "The split view is no longer on screen"
  );
  await tabSwitchFinished();
}

// Makes the page in `tab` ask "leave this page?" before it is unloaded.
async function askBeforeLeaving(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    // The tab is closed with skipPermitUnload at the end.
    // eslint-disable-next-line mozilla/balanced-listeners
    content.addEventListener("beforeunload", event => event.preventDefault());
  });
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.hasBeforeUnload,
    "The browser knows the page asks before it is left"
  );
}

function hasDialog(tab) {
  const box = tab.linkedBrowser.tabDialogBox;
  return !!box && (box._tabDialogManager.hasDialogs || !!box._contentDialogManager?.hasDialogs);
}

add_setup(async function () {
  // The agreed defaults: an hour, and pinned tabs and Essentials sleep too.
  // Checked on the default branch, because the pushPrefEnv below sets the
  // same values on the user branch.
  const defaults = Services.prefs.getDefaultBranch(PREF);
  Assert.ok(defaults.getBoolPref("enabled"), "Sleeping tabs are on by default");
  Assert.equal(defaults.getIntPref("timeout-minutes"), 60, "The default timeout is an hour");
  Assert.ok(defaults.getBoolPref("unload-pinned"), "Pinned tabs sleep by default");
  Assert.ok(defaults.getBoolPref("unload-essentials"), "Essentials sleep by default");
  Assert.equal(defaults.getStringPref("excluded-hosts"), "", "No host is excluded by default");
  Assert.ok(
    defaults.getBoolPref("keep-notification-sites"),
    "Sites allowed to notify stay awake by default"
  );

  // Nothing in this test starts the unloader: the browser does, some time
  // after startup, through MemoryComponents.manifest.
  await TestUtils.waitForCondition(
    () => WrenTabUnloader.running,
    "WrenTabUnloader starts with the browser",
    100,
    300
  );

  // Only against a profile that has other values set.
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF + "enabled", true],
      [PREF + "timeout-minutes", 60],
      [PREF + "unload-pinned", true],
      [PREF + "unload-essentials", true],
      [PREF + "excluded-hosts", ""],
      [PREF + "keep-notification-sites", false],
    ],
  });
});

add_task(async function test_idle_background_tab_is_unloaded_and_the_selected_tab_is_not() {
  const selected = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER_SITE_PAGE);
  const idle = await openBackgroundTab();

  Assert.equal(
    WrenTabUnloader.reasonToKeep(idle),
    "recent",
    "A tab that was just opened counts as recently used"
  );
  Assert.equal((await WrenTabUnloader.sweep()).length, 0, "A sweep right away unloads nothing");
  Assert.ok(!isAsleep(idle), "The background tab is still loaded");

  Assert.strictEqual(reasonToKeep(idle), null, "An hour later nothing keeps the background tab");
  Assert.equal(reasonToKeep(selected), "selected", "The selected tab is kept for being selected");

  const unloaded = await sweepAnHourLater();
  Assert.ok(unloaded.includes(idle), "The sweep reports the background tab as unloaded");
  Assert.ok(isAsleep(idle), "The background tab is unloaded");
  Assert.ok(idle.hasAttribute("discarded"), "It is marked, so its icon is dimmed");
  Assert.ok(!unloaded.includes(selected), "The sweep does not report the selected tab");
  Assert.ok(!isAsleep(selected), "The selected tab is still loaded");
  Assert.equal(gBrowser.selectedTab, selected, "The selection did not move");

  BrowserTestUtils.removeTab(idle);
  BrowserTestUtils.removeTab(selected);
});

add_task(async function test_sleeping_tab_comes_back_when_selected() {
  const tab = await openBackgroundTab(PAGE_LEFT_ON);

  Assert.ok((await sweepAnHourLater()).includes(tab), "The tab is unloaded");
  Assert.equal(reasonToKeep(tab), "asleep", "A sleeping tab is left as it is");
  Assert.equal((await sweepAnHourLater()).length, 0, "The next sweep has nothing to do");

  await wake(tab);
  Assert.ok(tab.linkedPanel && !tab.hasAttribute("pending"), "Selecting the tab loads it again");
  Assert.ok(!tab.hasAttribute("discarded"), "Its icon is no longer dimmed");
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE_LEFT_ON, "It shows the page it had");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pinned_tab() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  gBrowser.pinTab(pinned);
  Assert.ok(pinned.pinned, "The tab is pinned");

  // Zen remembers the page a tab was pinned on, and can reset the tab to it.
  // Move on from that page, to see which of the two a sleeping tab wakes on.
  await TestUtils.waitForCondition(
    () => pinned._zenPinnedInitialState?.entry?.url === PAGE,
    "Zen recorded the page the tab was pinned on"
  );
  BrowserTestUtils.startLoadingURIString(pinned.linkedBrowser, PAGE_LEFT_ON);
  await BrowserTestUtils.browserLoaded(pinned.linkedBrowser, false, PAGE_LEFT_ON);
  await finishedLoading(pinned);

  const selected = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER_SITE_PAGE);

  await SpecialPowers.pushPrefEnv({ set: [[PREF + "unload-pinned", false]] });
  Assert.equal(reasonToKeep(pinned), "pinned", "With unload-pinned off, being pinned keeps it");
  Assert.ok(!(await sweepAnHourLater()).includes(pinned), "The sweep does not report it");
  Assert.ok(!isAsleep(pinned), "With unload-pinned off, the pinned tab stays loaded");
  await SpecialPowers.popPrefEnv();

  Assert.strictEqual(reasonToKeep(pinned), null, "By default nothing keeps a pinned tab");
  Assert.ok((await sweepAnHourLater()).includes(pinned), "The sweep reports the pinned tab");
  Assert.ok(isAsleep(pinned), "By default a pinned tab is unloaded like any other");
  Assert.ok(pinned.pinned, "It is still pinned");

  await wake(pinned);
  Assert.equal(
    pinned.linkedBrowser.currentURI.spec,
    PAGE_LEFT_ON,
    "It wakes on the page the user left it on, not on the page it was pinned on"
  );
  Assert.equal(
    pinned._zenPinnedInitialState?.entry?.url,
    PAGE,
    "Zen still knows the page it was pinned on"
  );

  BrowserTestUtils.removeTab(selected);
  BrowserTestUtils.removeTab(pinned);
});

add_task(async function test_essential() {
  const essential = await openBackgroundTab();
  gZenPinnedTabManager.addToEssentials(essential);
  Assert.ok(essential.hasAttribute("zen-essential"), "The tab is an Essential");

  await SpecialPowers.pushPrefEnv({ set: [[PREF + "unload-essentials", false]] });
  Assert.equal(reasonToKeep(essential), "essential", "With unload-essentials off, it is kept");
  Assert.ok(!(await sweepAnHourLater()).includes(essential), "The sweep does not report it");
  Assert.ok(!isAsleep(essential), "With unload-essentials off, the Essential stays loaded");
  await SpecialPowers.popPrefEnv();

  // An Essential is a pinned tab too, but unload-pinned is not about it.
  await SpecialPowers.pushPrefEnv({ set: [[PREF + "unload-pinned", false]] });
  Assert.strictEqual(reasonToKeep(essential), null, "unload-pinned does not keep an Essential");
  await SpecialPowers.popPrefEnv();

  Assert.ok((await sweepAnHourLater()).includes(essential), "The sweep reports the Essential");
  Assert.ok(isAsleep(essential), "By default an Essential is unloaded like any other tab");
  Assert.ok(essential.hasAttribute("zen-essential"), "It is still an Essential");

  BrowserTestUtils.removeTab(essential);
});

add_task(async function test_tab_playing_sound_or_kept_by_an_extension_stays_loaded() {
  const tab = await openBackgroundTab();

  // The attribute is how the browser marks a tab that is making sound, and
  // what tab.soundPlaying reads.
  tab.toggleAttribute("soundplaying", true);
  Assert.ok(tab.soundPlaying, "The tab counts as playing sound");
  Assert.equal(reasonToKeep(tab), "media", "Playing sound keeps the tab");
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(!isAsleep(tab), "A tab that plays sound stays loaded");
  tab.removeAttribute("soundplaying");

  // What an extension sets with tabs.update(id, { autoDiscardable: false }).
  tab.undiscardable = true;
  Assert.equal(reasonToKeep(tab), "undiscardable", "An extension's request keeps the tab");
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(!isAsleep(tab), "A tab an extension wants kept stays loaded");
  tab.undiscardable = false;

  Assert.ok((await sweepAnHourLater()).includes(tab), "Without either, the same tab is unloaded");
  Assert.ok(isAsleep(tab), "The tab is unloaded");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_on_screen_without_being_selected_stays_loaded() {
  const tab = await openBackgroundTab();

  // What Zen sets on the browser of a tab that is on screen in a split view
  // or under a glance while another tab is the selected one. It is on the
  // browser, not on the tab.
  tab.linkedBrowser.zenModeActive = true;
  Assert.equal(reasonToKeep(tab), "visible", "Being on screen keeps the tab");
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(!isAsleep(tab), "A tab that is on screen stays loaded");
  tab.linkedBrowser.zenModeActive = false;

  Assert.ok((await sweepAnHourLater()).includes(tab), "Off screen, the same tab is unloaded");
  Assert.ok(isAsleep(tab), "The tab is unloaded");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_excluded_hosts() {
  const excluded = await openBackgroundTab(PAGE);
  const subdomain = await openBackgroundTab(SUBDOMAIN_PAGE);
  const otherSite = await openBackgroundTab(OTHER_SITE_PAGE);

  await SpecialPowers.pushPrefEnv({ set: [[PREF + "excluded-hosts", EXCLUDED_HOSTS]] });
  Assert.equal(reasonToKeep(excluded), "excluded-host", "A listed host is kept");
  Assert.equal(reasonToKeep(subdomain), "excluded-host", "So are its subdomains");
  Assert.strictEqual(reasonToKeep(otherSite), null, "Another site is not");

  const unloaded = await sweepAnHourLater();
  Assert.ok(unloaded.includes(otherSite), "The sweep reports the tab of the other site");
  Assert.ok(isAsleep(otherSite), "The tab of the other site is unloaded");
  Assert.ok(!unloaded.includes(excluded), "The sweep does not report the listed host");
  Assert.ok(!isAsleep(excluded), "The tab of the listed host stays loaded");
  Assert.ok(!unloaded.includes(subdomain), "The sweep does not report the subdomain");
  Assert.ok(!isAsleep(subdomain), "The tab of its subdomain stays loaded");
  await SpecialPowers.popPrefEnv();

  await sweepAnHourLater();
  Assert.ok(isAsleep(excluded), "Taken off the list, the host's tab is unloaded");
  Assert.ok(isAsleep(subdomain), "And so is the subdomain's");

  BrowserTestUtils.removeTab(excluded);
  BrowserTestUtils.removeTab(subdomain);
  BrowserTestUtils.removeTab(otherSite);
});

add_task(async function test_excluded_hosts_written_other_ways() {
  const exampleCom = await openBackgroundTab(PAGE);
  const subdomain = await openBackgroundTab(SUBDOMAIN_PAGE);
  const exampleOrg = await openBackgroundTab(OTHER_SITE_PAGE);

  // A URL, a "*." name, and an entry that is not a host name at all.
  await SpecialPowers.pushPrefEnv({
    set: [[PREF + "excluded-hosts", "https://example.org/inbox, *.example.com, not a host"]],
  });
  Assert.equal(reasonToKeep(exampleOrg), "excluded-host", "A URL counts as its host");
  Assert.equal(reasonToKeep(exampleCom), "excluded-host", "A *. name counts as the name");
  Assert.equal(reasonToKeep(subdomain), "excluded-host", "and covers its subdomains");
  await SpecialPowers.popPrefEnv();

  // A name covers its subdomains, not every host that ends in the same letters.
  await SpecialPowers.pushPrefEnv({
    set: [[PREF + "excluded-hosts", "ample.org, test1.example.com"]],
  });
  Assert.strictEqual(reasonToKeep(exampleOrg), null, "ample.org does not cover example.org");
  Assert.strictEqual(reasonToKeep(exampleCom), null, "A subdomain does not cover its parent");
  Assert.equal(reasonToKeep(subdomain), "excluded-host", "The subdomain itself is kept");
  await SpecialPowers.popPrefEnv();

  BrowserTestUtils.removeTab(exampleCom);
  BrowserTestUtils.removeTab(subdomain);
  BrowserTestUtils.removeTab(exampleOrg);
});

add_task(async function test_timeout_pref_applies_at_once() {
  const tab = await openBackgroundTab();

  await SpecialPowers.pushPrefEnv({ set: [[PREF + "timeout-minutes", 120]] });
  Assert.equal(reasonToKeep(tab), "recent", "With a two-hour timeout, one hour is recent");
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(!isAsleep(tab), "The tab stays loaded");
  await SpecialPowers.popPrefEnv();

  Assert.ok((await sweepAnHourLater()).includes(tab), "With the timeout back at an hour, it is");
  Assert.ok(isAsleep(tab), "The tab is unloaded");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_turned_off() {
  const tab = await openBackgroundTab();

  await SpecialPowers.pushPrefEnv({ set: [[PREF + "enabled", false]] });
  Assert.ok(!WrenTabUnloader.running, "Turning the pref off stops the timer");
  Assert.equal(reasonToKeep(tab), "disabled", "Every tab is kept");
  Assert.equal((await sweepAnHourLater()).length, 0, "A sweep does nothing");
  Assert.ok(!isAsleep(tab), "The tab stays loaded");
  await SpecialPowers.popPrefEnv();

  Assert.ok(WrenTabUnloader.running, "Turning the pref on starts the timer again, with no restart");
  Assert.ok((await sweepAnHourLater()).includes(tab), "The sweep reports the tab");
  Assert.ok(isAsleep(tab), "The tab is unloaded");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_split_view_sleeps_as_a_whole() {
  // The tab to look at while the split view is hidden. Kept out of the first
  // sweep, which runs while it is in the background.
  const elsewhere = await openBackgroundTab(OTHER_SITE_PAGE);
  elsewhere.undiscardable = true;
  const left = await openBackgroundTab();
  const right = await openBackgroundTab();
  await splitView(left, right);

  Assert.ok(!right.selected, "Only one tab of the split view is the selected tab");
  // The pane that is not selected is kept through the selected one: a split
  // view sleeps or stays as a whole. (The rule for a pane that is on screen
  // on its own is in test_tab_on_screen_without_being_selected_stays_loaded.)
  Assert.equal(reasonToKeep(right), "selected", "A split view counts as selected through a pane");
  const whileVisible = await sweepAnHourLater();
  Assert.ok(!whileVisible.includes(left) && !whileVisible.includes(right), "Neither is reported");
  Assert.ok(!isAsleep(left) && !isAsleep(right), "A split view on screen stays loaded");

  await hideSplitViewBehind(elsewhere, left, right);
  Assert.strictEqual(reasonToKeep(left), null, "Nothing keeps a hidden split view");

  // Zen answers the unloading of a pane by unloading the whole split view
  // itself (ZenViewSplitter.handleTabBrowserDiscarded). By then both panes are
  // asleep, so it has nothing left to do, but it is still busy for a moment.
  // Waking a pane in that moment would race it, so wait for it to finish.
  const zenUnloads = [];
  const explicitUnloadTabs = gBrowser.explicitUnloadTabs;
  gBrowser.explicitUnloadTabs = function (...args) {
    const done = explicitUnloadTabs.apply(this, args);
    zenUnloads.push(done);
    return done;
  };
  let unloaded;
  try {
    unloaded = await sweepAnHourLater();
  } finally {
    gBrowser.explicitUnloadTabs = explicitUnloadTabs;
  }
  await Promise.all(zenUnloads);
  Assert.ok(unloaded.includes(left) && unloaded.includes(right), "The sweep unloads both panes");
  Assert.ok(isAsleep(left) && isAsleep(right), "Both panes of the hidden split view are unloaded");
  Assert.equal(gBrowser.selectedTab, elsewhere, "The selection did not move");
  Assert.ok(
    left.group && left.group === right.group && left.group.hasAttribute("split-view-group"),
    "The split view itself is still there"
  );

  // Selecting one sleeping pane brings the whole split view back.
  gBrowser.selectedTab = left;
  await TestUtils.waitForCondition(
    () => [left, right].every(pane => pane.linkedPanel && !pane.hasAttribute("pending")),
    "Both panes load again"
  );
  await TestUtils.waitForCondition(
    () => right.linkedBrowser.zenModeActive,
    "The other pane is on screen again"
  );
  await tabSwitchFinished();
  Assert.equal(left.group, right.group, "They are still one split view");

  BrowserTestUtils.removeTab(left);
  BrowserTestUtils.removeTab(right);
  BrowserTestUtils.removeTab(elsewhere);
});

add_task(async function test_restored_tab_is_not_unloaded_at_once() {
  const tab = await openBackgroundTab();
  // What a tab restored from yesterday's session looks like: its last-used
  // time comes from the session file.
  tab.updateLastAccessed(Date.now() - 3 * 60 * 60 * 1000);

  Assert.ok(
    !(await WrenTabUnloader.sweep()).includes(tab),
    "A sweep right away does not unload it"
  );
  Assert.ok(!isAsleep(tab), "The tab is still loaded");
  Assert.equal(
    WrenTabUnloader.reasonToKeep(tab),
    "recent",
    "Its hour starts when a sweep first finds it loaded"
  );

  Assert.ok((await sweepAnHourLater()).includes(tab), "An hour after that it is unloaded");
  Assert.ok(isAsleep(tab), "The tab is unloaded");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_time_the_computer_sleeps_does_not_count() {
  const tab = await openBackgroundTab();
  const clock = WrenTabUnloader._clock;
  const saved = { lastTick: clock.lastTick, gaps: [...clock.gaps] };
  try {
    // A tick, and the next one three hours later instead of one minute: the
    // computer slept in between. Nothing else may run between these lines,
    // or the real timer would tick in between.
    const before = Date.now();
    clock.tick(before);
    const after = before + 3 * 60 * 60 * 1000;
    clock.tick(after);

    Assert.equal(
      WrenTabUnloader.reasonToKeep(tab, { now: after + 2 * 60 * 1000 }),
      "recent",
      "Just after waking up, a tab used just before the sleep counts as recent"
    );
    Assert.strictEqual(
      WrenTabUnloader.reasonToKeep(tab, { now: after + 61 * 60 * 1000 }),
      null,
      "An hour awake after that, nothing keeps it"
    );
  } finally {
    // The made-up sleep lies in the future, where it would take an hour off
    // every later task.
    clock.lastTick = saved.lastTick;
    clock.gaps = saved.gaps;
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_glance_stays_awake() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let elsewhere;

  await openGlanceOnTab(window, async glance => {
    Assert.equal(reasonToKeep(parent), "glance", "The tab a glance was opened from is kept");
    Assert.ok(reasonToKeep(glance), "The glance itself is kept");

    // Zen keeps the glance attached to its tab when the user switches away.
    elsewhere = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER_SITE_PAGE);
    Assert.equal(reasonToKeep(glance), "glance", "The glance is kept while it exists");
    Assert.equal(reasonToKeep(parent), "glance", "So is the tab it belongs to");
    const unloaded = await sweepAnHourLater();
    Assert.ok(!unloaded.includes(glance) && !unloaded.includes(parent), "Neither is reported");
    Assert.ok(!isAsleep(glance) && !isAsleep(parent), "Both stay loaded");

    // Back to the glance, so it can be closed the normal way.
    gBrowser.selectedTab = gZenGlanceManager.getTabOrGlanceParent(glance);
    await TestUtils.waitForCondition(() => glance.selected, "The glance is selected again");
    BrowserTestUtils.removeTab(elsewhere);
  });

  await TestUtils.waitForCondition(
    () => !parent.hasAttribute("glance-id"),
    "The glance is closed"
  );
  elsewhere = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER_SITE_PAGE);
  await tabSwitchFinished();
  Assert.strictEqual(reasonToKeep(parent), null, "Without its glance the tab may sleep");
  Assert.ok((await sweepAnHourLater()).includes(parent), "The sweep reports it");
  Assert.ok(isAsleep(parent), "The tab is unloaded");

  BrowserTestUtils.removeTab(elsewhere);
  BrowserTestUtils.removeTab(parent);
});

add_task(async function test_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await win.gZenWorkspaces.promiseInitialized;
  const tab = BrowserTestUtils.addTab(win.gBrowser, PAGE, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  await finishedLoading(tab);

  Assert.ok(!tab.selected, "The tab is in the background of the private window");
  Assert.equal(reasonToKeep(tab), "private", "A tab in a private window is kept");
  // Private tabs are not in the session store: unloaded, the page would be gone.
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(tab.linkedPanel && !tab.hasAttribute("pending"), "The private tab stays loaded");

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_page_that_asks_before_leaving() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.require_user_interaction_for_beforeunload", false]],
  });
  const tab = await openBackgroundTab();
  await askBeforeLeaving(tab);

  // The sweep tries, and Firefox refuses without showing the question.
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(!isAsleep(tab), "A page that asks before it is left stays loaded");
  Assert.ok(!hasDialog(tab), "No 'leave this page?' question was shown");

  BrowserTestUtils.removeTab(tab, { skipPermitUnload: true });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_hidden_split_view_that_would_ask_stays_loaded() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.require_user_interaction_for_beforeunload", false]],
  });
  const elsewhere = await openBackgroundTab(OTHER_SITE_PAGE);
  elsewhere.undiscardable = true;
  const left = await openBackgroundTab();
  const right = await openBackgroundTab();
  await splitView(left, right);
  await askBeforeLeaving(right);
  await hideSplitViewBehind(elsewhere, left, right);

  // Zen would unload the other pane with the forced call, which asks out loud.
  Assert.equal(reasonToKeep(left), "split-view-would-ask", "The whole split view is kept");
  Assert.equal(reasonToKeep(right), "split-view-would-ask", "from either pane");
  const unloaded = await sweepAnHourLater();
  Assert.ok(!unloaded.includes(left) && !unloaded.includes(right), "Neither is reported");
  Assert.ok(!isAsleep(left) && !isAsleep(right), "Both panes stay loaded");
  Assert.ok(!hasDialog(left) && !hasDialog(right), "No 'leave this page?' question was shown");

  BrowserTestUtils.removeTab(left);
  BrowserTestUtils.removeTab(right, { skipPermitUnload: true });
  BrowserTestUtils.removeTab(elsewhere);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_tab_with_a_page_dialog_stays_loaded() {
  const tab = await openBackgroundTab(FORM_PAGE);
  // The page opens the alert itself: one opened from the test's own code
  // would count as the browser's, and bring the tab to the front.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.dispatchEvent(new content.CustomEvent("wren-open-alert"));
  });
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.tabDialogBox?._contentDialogManager?.hasDialogs,
    "The page's dialog is open"
  );
  Assert.ok(!tab.selected, "The dialog did not bring the tab to the front");

  // Unloading the tab would close the dialog unanswered.
  Assert.equal(reasonToKeep(tab), "dialog", "An open page dialog keeps the tab");
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  Assert.ok(!isAsleep(tab), "The tab stays loaded");
  Assert.ok(hasDialog(tab), "The dialog is still open");

  tab.linkedBrowser.tabDialogBox.abortAllDialogs();
  await TestUtils.waitForCondition(() => !hasDialog(tab), "The dialog is closed");
  Assert.ok((await sweepAnHourLater()).includes(tab), "Without the dialog the tab is unloaded");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_in_a_call_stays_loaded() {
  const tab = await openBackgroundTab();
  // What webrtcUI records for a page that uses the camera, microphone or
  // screen. A real stream means permission prompts and a sharing indicator.
  const stream = { topBrowsingContext: tab.linkedBrowser.browsingContext, state: {} };
  webrtcUI._streams.push(stream);
  try {
    Assert.ok(webrtcUI.browserHasStreams(tab.linkedBrowser), "The tab counts as in a call");
    Assert.equal(reasonToKeep(tab), "call", "Being in a call keeps the tab");
    Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
    Assert.ok(!isAsleep(tab), "The tab stays loaded");
  } finally {
    webrtcUI._streams = webrtcUI._streams.filter(item => item !== stream);
  }

  Assert.ok((await sweepAnHourLater()).includes(tab), "After the call the tab is unloaded");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_multiselected_tab_stays_loaded() {
  const tab = await openBackgroundTab();
  gBrowser.addToMultiSelectedTabs(tab);
  try {
    Assert.ok(tab.multiselected, "The tab is part of a multiselection");
    Assert.equal(reasonToKeep(tab), "selected", "A multiselected tab counts as selected");
    Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  } finally {
    gBrowser.clearMultiSelectedTabs();
  }
  Assert.strictEqual(reasonToKeep(tab), null, "Once the selection is cleared it may sleep");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_keep_notification_sites() {
  PermissionTestUtils.add(PAGE, "desktop-notification", Services.perms.ALLOW_ACTION);
  registerCleanupFunction(() => PermissionTestUtils.remove(PAGE, "desktop-notification"));
  const tab = await openBackgroundTab();

  Assert.strictEqual(
    reasonToKeep(tab),
    null,
    "With the pref off, a site that may notify sleeps too"
  );
  await SpecialPowers.pushPrefEnv({ set: [[PREF + "keep-notification-sites", true]] });
  Assert.equal(reasonToKeep(tab), "notifications", "With the pref on, such a site is kept");
  Assert.ok(!(await sweepAnHourLater()).includes(tab), "The sweep does not report it");
  await SpecialPowers.popPrefEnv();

  PermissionTestUtils.remove(PAGE, "desktop-notification");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_sleeping_tab_keeps_what_was_typed() {
  const TYPED = "Half a sentence";
  const tab = await openBackgroundTab(FORM_PAGE);
  // Typing into a field, the way the session store tests do it.
  await SpecialPowers.spawn(tab.linkedBrowser, [TYPED], text => {
    const input = content.document.getElementById("text");
    input.value = text;
    const event = input.ownerDocument.createEvent("UIEvents");
    event.initUIEvent("input", true, true, input.documentGlobal, 0);
    input.dispatchEvent(event);
  });

  Assert.ok((await sweepAnHourLater()).includes(tab), "The tab is unloaded");
  await wake(tab);
  const value = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const input = () => content.document.getElementById("text");
    await ContentTaskUtils.waitForCondition(() => input()?.value, "The field is filled in again");
    return input().value;
  });
  Assert.equal(value, TYPED, "The text typed before the tab slept is still there");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_with_a_second_synced_window() {
  const tabsBefore = new Set(gBrowser.tabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  let tab;
  try {
    tab = await openBackgroundTab(PAGE_LEFT_ON);
    const copy = await TestUtils.waitForCondition(
      () => gZenWindowSync.getItemFromWindow(win, tab.id),
      "The tab has its copy in the second window"
    );

    // ZenWindowSync keeps one page for both, in whichever window last showed it.
    const unloaded = await sweepAnHourLater();
    Assert.ok(unloaded.includes(tab) || unloaded.includes(copy), "The sweep unloads the page");
    Assert.ok(!(unloaded.includes(tab) && unloaded.includes(copy)), "It does so only once");
    for (const each of [tab, copy]) {
      Assert.ok(!each.linkedPanel || each.hasAttribute("pending"), "No page is left loaded");
    }
    Assert.ok(!unloaded.includes(gBrowser.selectedTab), "The selected tab here is kept");
    Assert.ok(!unloaded.includes(win.gBrowser.selectedTab), "So is the one in the other window");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }

  await wake(tab);
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE_LEFT_ON, "It wakes on the page it had");
  BrowserTestUtils.removeTab(tab);
  // ZenWindowSync gives this window a copy of the second window's first tab,
  // and the copy stays when that window closes. It is Zen's, not ours: the
  // unloader never touches it (about:blank is not a web page).
  for (const leftover of [...gBrowser.tabs]) {
    if (!tabsBefore.has(leftover)) {
      BrowserTestUtils.removeTab(leftover);
    }
  }
});
