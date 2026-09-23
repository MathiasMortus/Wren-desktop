/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pure helpers: no browser APIs, so Node can test them.

export const KEYWORD = "/profile";

// Colors Firefox containers store internally, minus "toolbar" (too plain for a
// badge). Note: extensions call "cyan" "turquoise", but Firefox itself says "cyan".
export const COLORS = ["blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple"];

export const HISTORY_LIMIT = 200;

// Reads what's typed in the spotlight.
//   null                        not a ZPS query
//   { stage: "list" }           "/profile" or "/profile "
//   { stage: "choose", query }  "/profile te" (still typing a name)
//   { stage: "profile", name, rest }  "/profile test " or "/profile test github.com"
export function parseQuery(searchString) {
  const s = (searchString || "").trimStart();
  if (s.slice(0, KEYWORD.length).toLowerCase() !== KEYWORD) return null;

  const after = s.slice(KEYWORD.length);
  if (after && !/^\s/.test(after)) return null; // "/profiles" isn't ours
  const body = after.trimStart();
  if (!body) return { stage: "list" };

  const quote = body[0];
  if (quote === '"' || quote === "'") {
    const end = body.indexOf(quote, 1);
    if (end === -1) return { stage: "choose", query: body.slice(1) };
    const name = body.slice(1, end).trim();
    const tail = body.slice(end + 1);
    if (!name) return { stage: "list" };
    return { stage: "profile", name, rest: tail.trim() };
  }

  const gap = body.search(/\s/);
  if (gap === -1) return { stage: "choose", query: body };
  return { stage: "profile", name: body.slice(0, gap), rest: body.slice(gap).trim() };
}

// The text to put in the spotlight for a profile, quoting names with spaces.
export function queryFor(name, rest = "") {
  const shown = /\s/.test(name) ? `"${name}"` : name;
  return `${KEYWORD} ${shown} ${rest}`.replace(/\s+$/, " ");
}

const HOST_LIKE = /^(localhost|\d{1,3}(\.\d{1,3}){3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?([/?#].*)?$/i;
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i;
const WEB_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// What the text after the profile name means.
export function toTarget(rest) {
  const s = (rest || "").trim();
  if (!s) return { type: "blank" };
  if (WEB_SCHEME.test(s) && !/\s/.test(s)) return { type: "url", url: s };
  if (HOST_LIKE.test(s)) {
    return { type: "url", url: (LOCAL_HOST.test(s) ? "http://" : "https://") + s };
  }
  if (ANY_SCHEME.test(s) && !/\s/.test(s) && !/^(javascript|data):/i.test(s)) {
    return { type: "url", url: s };
  }
  return { type: "search", query: s };
}

export function findProfile(profiles, name) {
  const wanted = (name || "").trim().toLowerCase();
  if (!wanted) return undefined;
  return profiles.find(p => p.name.toLowerCase() === wanted);
}

// Prefers a color no other profile has. Once all are taken, the name decides.
export function pickColor(name, usedColors = []) {
  const used = usedColors.map(c => (c === "turquoise" ? "cyan" : c));
  const free = COLORS.filter(c => !used.includes(c));
  if (free.length) return free[0];
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

// Most recently used profiles first, then the rest alphabetically.
export function sortProfiles(profiles, lastUsed = {}) {
  return [...profiles].sort((a, b) => {
    const diff = (lastUsed[b.id] || 0) - (lastUsed[a.id] || 0);
    return diff || a.name.localeCompare(b.name);
  });
}

export function filterProfiles(profiles, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return profiles;
  const starts = profiles.filter(p => p.name.toLowerCase().startsWith(q));
  const contains = profiles.filter(p => !starts.includes(p) && p.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

// Adds a visit to one profile's history list. Returns a new list, newest first.
export function recordVisit(entries, { url, title, time }) {
  const existing = entries.find(e => e.url === url);
  const entry = {
    url,
    title: title || existing?.title || "",
    lastVisit: time,
    visits: (existing?.visits || 0) + 1,
  };
  return [entry, ...entries.filter(e => e.url !== url)].slice(0, HISTORY_LIMIT);
}

// Keeps entries whose title or URL contain every typed word.
export function filterHistory(entries, text, limit = 8) {
  const words = (text || "").toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter(e => {
      const hay = `${e.title} ${e.url}`.toLowerCase();
      return words.every(w => hay.includes(w));
    })
    .slice(0, limit);
}

export function shouldRecord(url) {
  return /^https?:\/\//i.test(url || "");
}
