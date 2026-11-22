/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SearchTestUtils: "resource://testing-common/SearchTestUtils.sys.mjs",
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
});

SearchTestUtils.init(this);

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

// Text that is not a web address is searched for with the default search
// engine, in the profile.
add_task(async function test_search_in_a_profile() {
  const profile = findTestProfile();
  Assert.ok(profile, "The test profile exists");

  await SearchTestUtils.installSearchExtension(
    {
      name: "ZpsTestEngine",
      search_url: "https://example.com/",
      search_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true }
  );

  await searchRows(`/profile ${PROFILE_NAME} two words`);
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/?q=two+words");
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await newTab;

  Assert.equal(tab.userContextId, profile.userContextId, "The search opened in the profile");

  BrowserTestUtils.removeTab(tab);
  await PlacesUtils.history.clear();
});

// The profile's own history list holds the same addresses as Firefox's
// history, so clearing history has to clear it too.
add_task(async function test_clearing_history_clears_profile_history() {
  const profile = findTestProfile();
  Assert.ok(profile, "The test profile exists");
  const url = "https://example.com/";

  const historyRows = async () => {
    const rows = await searchRows(`/profile ${PROFILE_NAME} `);
    await UrlbarTestUtils.promisePopupClose(window);
    return rows.filter(result => result.payload.kind === "history");
  };
  const visit = async () => {
    const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId: profile.userContextId });
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    await TestUtils.waitForCondition(
      () => PlacesUtils.history.fetch(url),
      "Firefox's history has the page"
    );
    await TestUtils.waitForCondition(
      async () => (await historyRows()).some(result => result.payload.target.url === url),
      "The profile's history has the page"
    );
    BrowserTestUtils.removeTab(tab);
  };

  await visit();
  await PlacesUtils.history.remove(url);
  await TestUtils.waitForCondition(
    async () => !(await historyRows()).some(result => result.payload.target.url === url),
    "Removing the page from history removes it from the profile's history"
  );

  await visit();
  await PlacesUtils.history.clear();
  await TestUtils.waitForCondition(
    async () => !(await historyRows()).length,
    "Clearing history clears the profile's history"
  );

  await SpecialPowers.pushPrefEnv({ set: [["places.history.enabled", false]] });
  const tab = BrowserTestUtils.addTab(gBrowser, url, { userContextId: profile.userContextId });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  Assert.equal(
    (await historyRows()).length,
    0,
    "With history turned off, the profile's history stays empty"
  );
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
