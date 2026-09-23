/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
});

const PROFILE_NAME = "ZpsTest";

async function searchRows(value) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value });
  const rows = [];
  for (let index = 0; index < UrlbarTestUtils.getResultCount(window); index++) {
    const { result } = await UrlbarTestUtils.getRowAt(window, index);
    rows.push(result);
  }
  return rows;
}

function findTestProfile() {
  return ContextualIdentityService.getPublicIdentities().find(
    identity => ContextualIdentityService.getUserContextLabel(identity.userContextId) === PROFILE_NAME
  );
}

registerCleanupFunction(() => {
  const profile = findTestProfile();
  if (profile) {
    ContextualIdentityService.remove(profile.userContextId);
  }
});

add_task(async function test_zps_starts_with_the_browser() {
  Assert.ok(
    ProvidersManager.getInstanceForSap("urlbar").getProvider("ZPS"),
    "ZPS registers its spotlight provider at startup, with no add-on"
  );
});

add_task(async function test_profile_keyword_shows_only_zps_rows() {
  const rows = await searchRows("/profile");
  Assert.greater(rows.length, 0, "/profile shows rows");
  Assert.ok(
    rows.every(result => result.providerName === "ZPS"),
    "Every row for /profile comes from ZPS"
  );
  Assert.ok(
    rows.every(result => result.payload.dynamicType === "zps"),
    "Every row uses the ZPS row layout"
  );
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function test_other_queries_are_left_alone() {
  const rows = await searchRows("/profiles");
  Assert.ok(
    rows.every(result => result.providerName !== "ZPS"),
    "ZPS ignores text that only starts like its keyword"
  );
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function test_open_link_in_a_new_profile() {
  Assert.ok(!findTestProfile(), "The test profile does not exist yet");

  const rows = await searchRows(`/profile ${PROFILE_NAME} example.com`);
  const first = rows[0];
  Assert.equal(first.providerName, "ZPS", "The first row is ZPS's");
  Assert.equal(first.payload.kind, "open", "It offers to open the link");
  Assert.equal(first.payload.title, "https://example.com", "It turns the text into a web address");
  Assert.equal(first.payload.detail, "Creates this profile", "It says it will create the profile");

  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/");
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await newTab;

  const profile = findTestProfile();
  Assert.ok(profile, "Opening the row created the profile");
  Assert.equal(tab.userContextId, profile.userContextId, "The tab opened in the new profile");

  await TestUtils.waitForCondition(
    () => tab.querySelector(".tab-content > .zps-badge")?.textContent === PROFILE_NAME,
    "The tab gets a badge with the profile's name"
  );

  BrowserTestUtils.removeTab(tab);
});
