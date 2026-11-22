/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

// Wren's default search engine is DuckDuckGo, not the engine Mozilla's search
// configuration picks (toolkit/components/search/SearchEngineSelector.sys.mjs).
add_task(async function test_duckduckgo_is_the_default_search_engine() {
  await SearchService.init();

  Assert.equal(
    SearchService.appDefaultEngine.id,
    "ddg",
    "The application default is DuckDuckGo"
  );
  Assert.equal(
    SearchService.defaultEngine.id,
    "ddg",
    "A profile with no choice of its own searches with DuckDuckGo"
  );
  Assert.equal(
    SearchService.defaultPrivateEngine.id,
    "ddg",
    "Private windows search with DuckDuckGo too"
  );
});

add_task(async function test_a_picked_engine_still_wins() {
  const google = SearchService.getEngineById("google");
  Assert.ok(google, "Google is still in the list, for those who pick it");

  await SearchService.setDefault(
    google,
    SearchService.CHANGE_REASON.UNKNOWN
  );
  Assert.equal(
    SearchService.defaultEngine.id,
    "google",
    "The picked engine is used"
  );

  await SearchService.setDefault(
    SearchService.appDefaultEngine,
    SearchService.CHANGE_REASON.UNKNOWN
  );
  Assert.equal(
    SearchService.defaultEngine.id,
    "ddg",
    "Back on the application default"
  );
});
