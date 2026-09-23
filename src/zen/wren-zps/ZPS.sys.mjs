/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* ZPS – profile switcher, built into Wren.
 *
 * Started at browser startup (ZPSComponents.manifest) and adds three things:
 *   1. "/profile" rows in the spotlight: profile list, per-profile history, open in profile.
 *   2. A per-profile history of pages visited in that profile.
 *   3. A name badge on every tab that belongs to a profile.
 *
 * A "profile" is a Firefox container: its own cookies, logins and site storage.
 * The pure logic lives in ZPSCore.sys.mjs, shared with the ZPS add-on for Zen.
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";
import * as core from "./ZPSCore.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

const PROFILE_ICON = "fingerprint";
const DYNAMIC_TYPE = "zps";
const STYLESHEET = "chrome://browser/content/zen-styles/wren-zps.css";
const ICONS = {
  tab: "chrome://global/skin/icons/plus.svg",
  search: "chrome://global/skin/icons/search-glass.svg",
  page: "chrome://global/skin/icons/defaultFavicon.svg",
};

// ---------------------------------------------------------------------------
// Profiles (containers)

function listProfiles() {
  const ids = lazy.ContextualIdentityService;
  return ids.getPublicIdentities().map(identity => ({
    id: identity.userContextId,
    name: ids.getUserContextLabel(identity.userContextId),
    color: identity.color,
  }));
}

function profileById(id) {
  return listProfiles().find(p => p.id === id);
}

function createProfile(name) {
  const color = core.pickColor(
    name,
    listProfiles().map(p => p.color)
  );
  const identity = lazy.ContextualIdentityService.create(name, PROFILE_ICON, color);
  return { id: identity.userContextId, name, color: identity.color };
}

function openTabCount(profileId) {
  let count = 0;
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    count += win.gBrowser.tabs.filter(t => t.userContextId === profileId).length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-profile history. Firefox history doesn't know about containers, so ZPS
// keeps its own list in <profile>/zps-history.json.

const History = {
  data: { profiles: {}, lastUsed: {} },
  timer: null,

  get file() {
    return PathUtils.join(PathUtils.profileDir, "zps-history.json");
  },

  async load() {
    try {
      const data = await IOUtils.readJSON(this.file);
      this.data = { profiles: data.profiles || {}, lastUsed: data.lastUsed || {} };
    } catch (e) {
      if (e.name !== "NotFoundError") {
        console.error("ZPS: couldn't read history", e);
      }
    }
  },

  entries(profileId) {
    return this.data.profiles[profileId] || [];
  },

  visit(profileId, url) {
    this.data.profiles[profileId] = core.recordVisit(this.entries(profileId), {
      url,
      time: Date.now(),
    });
    this.touch(profileId);
  },

  retitle(profileId, url, title) {
    const entry = this.entries(profileId).find(e => e.url === url);
    if (entry && title && entry.title !== title) {
      entry.title = title;
      this.save();
    }
  },

  touch(profileId) {
    this.data.lastUsed[profileId] = Date.now();
    this.save();
  },

  forget(profileId) {
    delete this.data.profiles[profileId];
    delete this.data.lastUsed[profileId];
    this.save();
  },

  save() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => this.flush(), 2000);
  },

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await IOUtils.writeJSON(this.file, this.data, { tmpPath: `${this.file}.tmp` });
    } catch (e) {
      console.error("ZPS: couldn't save history", e);
    }
  },
};

// ---------------------------------------------------------------------------
// Opening tabs

async function openInProfile(win, profile, target) {
  let url;
  if (target.type === "url") {
    url = target.url;
  } else if (target.type === "search") {
    const engine = await Services.search.getDefault();
    url = engine.getSubmission(target.query).uri.spec;
  } else {
    url = win.BROWSER_NEW_TAB_URL || "about:newtab";
  }
  History.touch(profile.id);
  // ZPS profiles aren't any space's default container, so Zen keeps the tab
  // in the space you're in.
  win.openTrustedLinkIn(url, "tab", { userContextId: profile.id });
}

// Reopens the spotlight with new text. Picking a row closes the spotlight, so
// wait for that, open it the way ⌘T does, then fill in the text.
function showInSpotlight(win, text) {
  setTimeout(() => {
    win.document.getElementById("cmd_newNavigatorTab")?.doCommand();
    setTimeout(() => win.gURLBar.search(text), 50);
  }, 0);
}

// ---------------------------------------------------------------------------
// Spotlight rows

function profileRow(profile) {
  const pages = History.entries(profile.id).length;
  const tabs = openTabCount(profile.id);
  const detail = [
    tabs && `${tabs} open ${tabs === 1 ? "tab" : "tabs"}`,
    pages && `${pages} ${pages === 1 ? "page" : "pages"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    kind: "profile",
    title: profile.name,
    color: profile.color,
    detail,
    hint: "History →",
    profileId: profile.id,
    query: core.queryFor(profile.name),
  };
}

function openRow(profile, name, target, searchString) {
  const titles = {
    blank: "Open a new tab",
    url: target.url,
    search: `Search “${target.query}”`,
  };
  const icons = { blank: ICONS.tab, url: ICONS.page, search: ICONS.search };
  return {
    kind: "open",
    icon: target.type === "url" ? `page-icon:${target.url}` : icons[target.type],
    title: titles[target.type],
    badge: profile ? profile.name : name,
    color: profile?.color,
    detail: profile ? "" : "Creates this profile",
    hint: "",
    profileId: profile?.id,
    profileName: name,
    target,
    query: searchString,
  };
}

function historyRow(profile, entry) {
  return {
    kind: "history",
    icon: `page-icon:${entry.url}`,
    title: entry.title || entry.url,
    detail: entry.url.replace(/^https?:\/\/(www\.)?/, ""),
    hint: "",
    profileId: profile.id,
    target: { type: "url", url: entry.url },
    query: core.queryFor(profile.name, entry.url),
  };
}

function noteRow(title) {
  return { kind: "note", icon: ICONS.page, title, detail: "", hint: "" };
}

function buildRows(parsed, searchString) {
  const profiles = core.sortProfiles(listProfiles(), History.data.lastUsed);

  if (parsed.stage !== "profile") {
    const query = parsed.stage === "choose" ? parsed.query.trim() : "";
    const exact = core.findProfile(profiles, query);
    const matches = core.filterProfiles(profiles, query);
    const ordered = exact ? [exact, ...matches.filter(p => p !== exact)] : matches;
    const rows = ordered.map(profileRow);
    if (query && !exact) {
      rows.push({
        kind: "create",
        icon: ICONS.tab,
        title: `Create profile “${query}”`,
        detail: "",
        hint: "",
        profileName: query,
        query: core.queryFor(query),
      });
    }
    if (!rows.length) {
      rows.push(noteRow("No profiles yet. Type a name to create one."));
    }
    return rows;
  }

  const profile = core.findProfile(profiles, parsed.name);
  const target = core.toTarget(parsed.rest);
  const rows = [openRow(profile, parsed.name, target, searchString)];
  if (profile) {
    const history = core
      .filterHistory(History.entries(profile.id), parsed.rest, 9)
      .filter(e => !(target.type === "url" && e.url === target.url));
    rows.push(...history.map(e => historyRow(profile, e)));
    if (!parsed.rest && !History.entries(profile.id).length) {
      rows.push(noteRow("No history yet. Pages you visit in this profile show up here."));
    }
  }
  return rows;
}

class ZPSProvider extends UrlbarProvider {
  get name() {
    return "ZPS";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.HEURISTIC;
  }

  async isActive(queryContext) {
    return !queryContext.searchMode && !!core.parseQuery(queryContext.searchString);
  }

  // Higher than every built-in provider, so "/profile" shows only ZPS rows.
  getPriority() {
    return 100;
  }

  async startQuery(queryContext, addCallback) {
    const parsed = core.parseQuery(queryContext.searchString);
    if (!parsed) {
      return;
    }
    buildRows(parsed, queryContext.searchString).forEach((row, index) => {
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
          heuristic: index === 0,
          payload: { dynamicType: DYNAMIC_TYPE, ...row },
        })
      );
    });
  }

  getViewTemplate() {
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon", "zps-row-icon"] },
        { name: "dot", tag: "span", classList: ["zps-row-dot"] },
        { name: "title", tag: "span", classList: ["urlbarView-title", "zps-row-title"] },
        { name: "badge", tag: "span", classList: ["zps-badge"] },
        { name: "detail", tag: "span", classList: ["zps-row-detail"] },
        { name: "hint", tag: "span", classList: ["zps-row-hint"] },
      ],
    };
  }

  getViewUpdate(result) {
    const row = result.payload;
    const color = row.color ? [`identity-color-${row.color}`] : [];
    return {
      icon: { attributes: { src: row.icon || "", hidden: !row.icon } },
      dot: {
        attributes: { hidden: !!row.icon || !row.color },
        classList: ["zps-row-dot", ...color],
      },
      title: { textContent: row.title || "" },
      badge: {
        textContent: row.badge || "",
        attributes: { hidden: !row.badge },
        classList: ["zps-badge", ...color],
      },
      detail: { textContent: row.detail || "", attributes: { hidden: !row.detail } },
      hint: { textContent: row.hint || "", attributes: { hidden: !row.hint } },
    };
  }

  onEngagement(queryContext, controller, details) {
    const row = details.result?.payload;
    const win = details.element?.ownerGlobal ?? lazy.BrowserWindowTracker.getTopWindow();
    if (!row || !win) {
      return;
    }

    switch (row.kind) {
      case "profile":
        showInSpotlight(win, core.queryFor(profileById(row.profileId)?.name ?? row.title));
        break;
      case "create":
        showInSpotlight(win, core.queryFor(createProfile(row.profileName).name));
        break;
      case "open": {
        const profile =
          (row.profileId && profileById(row.profileId)) ||
          core.findProfile(listProfiles(), row.profileName) ||
          createProfile(row.profileName);
        openInProfile(win, profile, row.target).catch(console.error);
        break;
      }
      case "history": {
        const profile = profileById(row.profileId);
        if (profile) {
          openInProfile(win, profile, row.target).catch(console.error);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tab badges

function updateBadge(tab) {
  const content = tab.querySelector?.(".tab-content");
  if (!content) {
    return;
  }
  let badge = content.querySelector(":scope > .zps-badge");
  const id = tab.userContextId || 0;
  const identity = id && lazy.ContextualIdentityService.getPublicIdentityFromId(id);
  if (!identity) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = tab.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
    badge.className = "zps-badge";
    content.insertBefore(badge, content.querySelector(":scope > .tab-close-button"));
  }
  badge.textContent = lazy.ContextualIdentityService.getUserContextLabel(id);
}

// Browser windows ZPS is attached to.
const windows = new Set();

function updateAllBadges() {
  for (const win of windows) {
    win.gBrowser.tabs.forEach(updateBadge);
  }
}

// ---------------------------------------------------------------------------
// Windows

function initWindow(win) {
  if (windows.has(win) || !win.gBrowser) {
    return;
  }

  const utils = win.windowUtils;
  utils.loadSheetUsingURIString(STYLESHEET, utils.AUTHOR_SHEET);

  const onTab = e => updateBadge(e.target);
  win.addEventListener("TabOpen", onTab);
  win.addEventListener("SSTabRestoring", onTab);

  // Private windows never add to a profile's history.
  if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    win.addEventListener("TabAttrModified", e => {
      const tab = e.target;
      if (!tab.userContextId || !e.detail?.changed?.includes("label")) {
        return;
      }
      History.retitle(tab.userContextId, tab.linkedBrowser.currentURI.spec, tab.label);
    });
    win.gBrowser.addTabsProgressListener({
      onLocationChange(browser, webProgress, request, location) {
        if (!webProgress?.isTopLevel) {
          return;
        }
        const tab = win.gBrowser.getTabForBrowser(browser);
        if (!tab?.userContextId || !core.shouldRecord(location?.spec)) {
          return;
        }
        History.visit(tab.userContextId, location.spec);
      },
    });
  }

  windows.add(win);
  win.addEventListener("unload", () => windows.delete(win), { once: true });
  win.gBrowser.tabs.forEach(updateBadge);
}

const IDENTITY_TOPICS = [
  "contextual-identity-created",
  "contextual-identity-updated",
  "contextual-identity-deleted",
];

const identityObserver = {
  observe(subject, topic) {
    if (topic === "contextual-identity-deleted") {
      const id = subject?.wrappedJSObject?.userContextId;
      if (id) {
        History.forget(id);
      }
    }
    updateAllBadges();
  },
};

export const ZPS = {
  initialized: false,

  // Runs once, before the first window opens (browser-before-ui-startup).
  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    lazy.ProvidersManager.getInstanceForSap("urlbar").registerProvider(new ZPSProvider());

    History.load().then(updateAllBadges);
    lazy.AsyncShutdown.profileBeforeChange.addBlocker("ZPS: save history", () => History.flush());

    IDENTITY_TOPICS.forEach(topic => Services.obs.addObserver(identityObserver, topic));
    Services.obs.addObserver(win => initWindow(win), "browser-delayed-startup-finished");
  },
};
