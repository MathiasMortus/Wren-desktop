/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reported in Wren: in some spaces the Essentials row was hidden, leaving a
// blank gap. Those spaces had no containerTabId at all (the space list can
// hold them after a restore or a sync), and `containerTabId + 0` turned the
// missing value into NaN, which never matches container 0. Everything else in
// Zen treats a missing containerTabId as 0 ("no container").

function assertVisible(tab, where) {
  const section = tab.parentNode;
  const rect = tab.getBoundingClientRect();
  Assert.ok(!section.hasAttribute("hidden"), `${where}: the Essentials row is not hidden`);
  Assert.greater(Math.round(rect.width), 0, `${where}: the essential tab has width`);
  Assert.greater(Math.round(rect.height), 0, `${where}: the essential tab has height`);
}

// Delivers a space the way sync and window sync do, through
// propagateWorkspaces, without a containerTabId.
async function addSpaceWithoutContainerId(name) {
  const space = { uuid: gZenUIManager.generateUuidv4(), name, theme: null };
  const list = gZenWorkspaces.getWorkspaces().map(w => ({ ...w }));
  list.push(space);
  Assert.ok(!("containerTabId" in space), "The incoming space has no containerTabId");
  await gZenWorkspaces.propagateWorkspaces(list);
  return gZenWorkspaces.getWorkspaceFromId(space.uuid);
}

add_task(async function test_essentials_show_in_a_space_without_containerTabId() {
  Assert.ok(
    Services.prefs.getBoolPref("zen.workspaces.separate-essentials"),
    "Zen's default: Essentials are separated by container"
  );
  const first = gZenWorkspaces.getActiveWorkspace();
  const essential = BrowserTestUtils.addTab(gBrowser, "https://example.com/", {
    skipAnimation: true,
  });
  gZenPinnedTabManager.addToEssentials(essential);
  assertVisible(essential, "first space");

  const second = await addSpaceWithoutContainerId("Synced space");
  Assert.ok(second, "The synced space is in Zen's list");
  Assert.strictEqual(second.containerTabId, 0, "A missing containerTabId is read as 0");

  await gZenWorkspaces.changeWorkspace(second);
  Assert.equal(gZenWorkspaces.activeWorkspace, second.uuid, "In the space without the field");
  assertVisible(essential, "space without containerTabId");

  // Selecting an Essential there must not throw you into another space.
  gBrowser.selectedTab = essential;
  await TestUtils.waitForTick();
  await TestUtils.waitForCondition(() => !gZenWorkspaces._workspaceChangeInProgress);
  Assert.equal(
    gZenWorkspaces.activeWorkspace,
    second.uuid,
    "Selecting an Essential keeps you in the space you are in"
  );

  await gZenWorkspaces.changeWorkspace(first);
  await gZenWorkspaces.removeWorkspace(second.uuid);
  BrowserTestUtils.removeTab(essential);
});
