import { convertFilterList, assignIds, PRIORITY } from './filters.js';
import { createEngine, hostMatches } from './cosmetic.js';
import { checkForUpdates, clearFeedUpdates, feedAdditions, feedCosmetic, readFeedState, syncDisabledStaticRules } from './updater.js';

// Storage (all keys prefixed "ab:" so this module can live next to others):
//   local:   ab:settings, ab:total (blocked requests, all time)
//   session: ab:tabs ({ tabId: blocked count on the current page })
const SETTINGS_KEY = 'ab:settings';
const TOTAL_KEY = 'ab:total';
const TABS_KEY = 'ab:tabs';
const MENU_ID = 'ab-block-element';
const UPDATE_ALARM = 'ab-update-filters';
const UPDATE_PERIOD_MINUTES = 24 * 60;

const DEFAULT_SETTINGS = {
  enabledLists: null, // null = defaults from lists.json (+ language list)
  allowlist: [],
  customFilters: '',
  paused: false,
  showBadge: true,
  contextMenu: true,
  youtube: true,
  autoUpdate: true,
  feedUrl: null, // null = feedUrl from lists.json
};

// ---------- Lazy data (service workers may not use top-level await) ----------

// lists.json describes the bundled rulesets: { feedVersion, feedUrl, lists: [...] }.
let bundlePromise = null;
function getBundle() {
  bundlePromise ??= fetch(chrome.runtime.getURL('lists.json')).then((r) => r.json());
  return bundlePromise;
}

async function getLists() {
  return (await getBundle()).lists;
}

async function getSettings() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // Lists from an older build (e.g. "easylist") no longer exist; fall back to defaults then.
  const known = new Set((await getLists()).map((l) => l.id));
  if (settings.enabledLists) settings.enabledLists = settings.enabledLists.filter((id) => known.has(id));
  if (!settings.enabledLists?.length && !stored?.listsChosen) settings.enabledLists = null;
  if (!settings.enabledLists) {
    const lang = (navigator.language || '').slice(0, 2).toLowerCase();
    settings.enabledLists = (await getLists()).filter((l) => l.defaultEnabled || (l.language && l.language === lang)).map((l) => l.id);
  }
  return settings;
}

async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export function normalizeDomain(input) {
  let text = String(input || '').trim().toLowerCase();
  if (!text) return null;
  try {
    text = new URL(text.includes('://') ? text : `http://${text}`).hostname;
  } catch {
    return null;
  }
  text = text.replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(text) || text === 'localhost' ? text : null;
}

function isAllowlisted(settings, hostname) {
  return settings.allowlist.some((d) => hostMatches(hostname, d));
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

// ---------- Applying settings to Chrome ----------

async function applyRulesets(settings) {
  const lists = await getLists();
  const want = settings.paused ? [] : settings.enabledLists.filter((id) => lists.some((l) => l.id === id));
  const current = await chrome.declarativeNetRequest.getEnabledRulesets();
  const enableRulesetIds = want.filter((id) => !current.includes(id));
  const disableRulesetIds = current.filter((id) => !want.includes(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }
}

let customCache = { text: null, result: null };
function convertCustom(text) {
  if (customCache.text !== text) customCache = { text, result: convertFilterList(text || '') };
  return customCache.result;
}

function userRules(settings) {
  const rules = [];
  for (const domain of settings.allowlist) {
    rules.push({
      priority: PRIORITY.allowlist,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  rules.push(...convertCustom(settings.customFilters).rules);
  return rules;
}

// Dynamic rules = allowlisted sites + the user's own network filters + rules the
// daily feed added to the enabled lists.
async function applyDynamicRules(settings) {
  const rules = [];
  if (!settings.paused) {
    rules.push(...userRules(settings));
    const limit = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000;
    const additions = await feedAdditions(settings.enabledLists);
    if (rules.length + additions.length <= limit) rules.push(...additions);
  }
  const addRules = assignIds(rules);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    return [];
  } catch {
    // One bad rule rejects the whole batch: add them one by one and report failures.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    const failed = [];
    for (const r of addRules) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [r] }).catch((err) => failed.push(String(err?.message || err)));
    }
    return failed;
  }
}

async function applyBadge(settings) {
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: settings.showBadge && !settings.paused });
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
}

function applyMenu(settings) {
  chrome.contextMenus.removeAll(() => {
    if (settings.contextMenu) {
      chrome.contextMenus.create({ id: MENU_ID, title: 'Blokir elemen…', contexts: ['page', 'image', 'link', 'frame', 'video'] });
    }
  });
}

// YouTube video ads ride inside the player data, so they need page scripts
// (youtube-main.js) rather than network rules. Registered only while active.
const YT_IDS = ['ab-youtube', 'ab-youtube-css'];
const YT_MATCHES = ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'];

async function applyYoutube(settings) {
  const active = settings.youtube && !settings.paused && !isAllowlisted(settings, 'www.youtube.com');
  const existing = (await chrome.scripting.getRegisteredContentScripts({ ids: YT_IDS })).map((s) => s.id);
  if (active && existing.length === YT_IDS.length) return;
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing });
  if (!active) return;
  await chrome.scripting.registerContentScripts([
    { id: YT_IDS[0], matches: YT_MATCHES, js: ['youtube-main.js'], world: 'MAIN', runAt: 'document_start', allFrames: true },
    { id: YT_IDS[1], matches: YT_MATCHES, css: ['youtube.css'], runAt: 'document_start', allFrames: true },
  ]);
}

let engineCache = { key: null, engine: null };
async function getEngine(settings) {
  const feed = await readFeedState();
  const versions = settings.enabledLists.map((id) => feed.categories[id]?.version || null);
  const key = JSON.stringify([settings.enabledLists, versions, settings.customFilters]);
  if (engineCache.key === key) return engineCache.engine;
  // Prefer element-hiding data from the daily feed over the bundled copy.
  const parts = await Promise.all(settings.enabledLists.map(async (id) => (await feedCosmetic(id))
    ?? fetch(chrome.runtime.getURL(`cosmetic/${id}.json`)).then((r) => r.json()).catch(() => ({}))));
  parts.push(convertCustom(settings.customFilters).cosmetic);
  engineCache = { key, engine: createEngine(parts) };
  return engineCache.engine;
}

async function applyAll() {
  const settings = await getSettings();
  await applyRulesets(settings);
  await syncDisabledStaticRules((await getLists()).map((l) => l.id)).catch(() => {});
  const failed = await applyDynamicRules(settings);
  await applyBadge(settings);
  await applyYoutube(settings);
  applyMenu(settings);
  return { settings, failed };
}

// ---------- Daily filter updates ----------

// Updates run one after another, so a manual "update now" right after changing
// the feed URL never piggybacks on a check that is still using the old settings.
let updateQueue = Promise.resolve();
function runUpdate(force = false) {
  const run = updateQueue.then(() => updateOnce(force));
  updateQueue = run.catch(() => {});
  return run;
}

async function updateOnce(force) {
  const settings = await getSettings();
  if (!settings.autoUpdate && !force) return readFeedState();
  const bundle = await getBundle();
  const feedUrl = settings.feedUrl || bundle.feedUrl;
  if (!feedUrl) return readFeedState();
  const state = await checkForUpdates({
    feedUrl,
    bundle,
    enabled: settings.enabledLists,
    userRules: userRules(settings).length,
    force,
  });
  if (state.status !== 'error') await applyAll();
  return state;
}

async function ensureUpdateAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: UPDATE_PERIOD_MINUTES });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) runUpdate(false);
});

// ---------- Element hiding ----------

async function injectCosmetics({ tabId, frameId, documentId, url }) {
  const frameHost = hostOf(url);
  if (!frameHost || tabId < 0) return;
  const settings = await getSettings();
  if (settings.paused) return;

  // Allowlisting follows the top-level page, like Adblock Plus.
  let topHost = frameHost;
  if (frameId !== 0) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    topHost = hostOf(tab?.url) || frameHost;
  }
  if (isAllowlisted(settings, topHost)) return;

  const css = (await getEngine(settings)).cssFor(frameHost);
  if (!css) return;
  const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] };
  await chrome.scripting.insertCSS({ target, css, origin: 'USER' }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener((details) => {
  injectCosmetics(details);
  if (details.frameId === 0) {
    resetTabCount(details.tabId);
    refreshIcon(details.tabId, details.url);
  }
});

// ---------- Blocked-request counter ----------

let tabCounts = null; // Map tabId -> count
let pendingTotal = 0;
let flushTimer = null;

async function loadCounts() {
  if (!tabCounts) {
    const { [TABS_KEY]: saved = {} } = await chrome.storage.session.get(TABS_KEY);
    tabCounts = new Map(Object.entries(saved).map(([k, v]) => [Number(k), v]));
  }
  return tabCounts;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const counts = await loadCounts();
    const add = pendingTotal;
    pendingTotal = 0;
    const { [TOTAL_KEY]: total = 0 } = await chrome.storage.local.get(TOTAL_KEY);
    await chrome.storage.local.set({ [TOTAL_KEY]: total + add });
    await chrome.storage.session.set({ [TABS_KEY]: Object.fromEntries(counts) });
  }, 500);
}

async function resetTabCount(tabId) {
  (await loadCounts()).set(tabId, 0);
  scheduleFlush();
}

chrome.webRequest.onErrorOccurred.addListener(async (details) => {
  if (details.error !== 'net::ERR_BLOCKED_BY_CLIENT' || details.tabId < 0) return;
  const counts = await loadCounts();
  counts.set(details.tabId, (counts.get(details.tabId) || 0) + 1);
  pendingTotal++;
  scheduleFlush();
}, { urls: ['<all_urls>'] });

chrome.tabs.onRemoved.addListener(async (tabId) => {
  (await loadCounts()).delete(tabId);
  scheduleFlush();
});

// ---------- Toolbar icon state ----------

const ICONS = {
  on: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' },
  off: { 16: 'icons/icon16-off.png', 32: 'icons/icon32-off.png', 48: 'icons/icon48-off.png' },
};

async function refreshIcon(tabId, url) {
  const settings = await getSettings();
  const host = hostOf(url);
  const off = settings.paused || (host && isAllowlisted(settings, host));
  await chrome.action.setIcon({ tabId, path: off ? ICONS.off : ICONS.on }).catch(() => {});
}

async function refreshAllIcons() {
  for (const tab of await chrome.tabs.query({})) refreshIcon(tab.id, tab.url);
}

// ---------- Block element (picker) ----------

async function startPicker(tabId, frameId = 0) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['picker.js'] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id >= 0) startPicker(tab.id, info.frameId || 0).catch(() => {});
});

// ---------- Messages (all prefixed "ab:") ----------

const handlers = {
  async 'ab:getPopupState'({ tabId }) {
    const settings = await getSettings();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const host = hostOf(tab?.url);
    const counts = await loadCounts();
    const { [TOTAL_KEY]: total = 0 } = await chrome.storage.local.get(TOTAL_KEY);
    return {
      ok: true,
      host,
      site: host ? normalizeDomain(host) : null,
      paused: settings.paused,
      allowlisted: Boolean(host && isAllowlisted(settings, host)),
      pageBlocked: counts.get(tabId) || 0,
      totalBlocked: total + pendingTotal,
    };
  },

  async 'ab:setAllowlisted'({ domain, allowlisted, tabId }) {
    const site = normalizeDomain(domain);
    if (!site) return { ok: false, error: 'Domain tidak valid' };
    const settings = await getSettings();
    // Removing also drops broader entries that cover this site (e.g. example.com for www.example.com).
    const allowlist = allowlisted
      ? [...new Set([...settings.allowlist, site])]
      : settings.allowlist.filter((d) => !hostMatches(site, d) && d !== site);
    await saveSettings({ allowlist });
    await applyAll();
    if (tabId >= 0) chrome.tabs.reload(tabId);
    refreshAllIcons();
    return { ok: true, allowlist };
  },

  async 'ab:setPaused'({ paused, tabId }) {
    await saveSettings({ paused: Boolean(paused) });
    await applyAll();
    if (tabId >= 0) chrome.tabs.reload(tabId);
    refreshAllIcons();
    return { ok: true };
  },

  async 'ab:startPicker'({ tabId }) {
    await startPicker(tabId);
    return { ok: true };
  },

  // From the picker: add "domain##selector" and hide it right away.
  async 'ab:addFilter'({ filter }, sender) {
    const line = String(filter || '').trim();
    if (!line || line.includes('\n')) return { ok: false, error: 'Filter tidak valid' };
    const settings = await getSettings();
    const customFilters = settings.customFilters ? `${settings.customFilters.trimEnd()}\n${line}` : line;
    await saveSettings({ customFilters });
    const { settings: applied } = await applyAll();
    const tabId = sender?.tab?.id;
    if (tabId >= 0) {
      const host = hostOf(sender.tab.url);
      const css = (await getEngine(applied)).cssFor(host);
      await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, css, origin: 'USER' }).catch(() => {});
    }
    return { ok: true };
  },

  async 'ab:getOptions'() {
    const [settings, lists] = await Promise.all([getSettings(), getLists()]);
    const { [TOTAL_KEY]: total = 0 } = await chrome.storage.local.get(TOTAL_KEY);
    const custom = convertCustom(settings.customFilters).stats;
    const bundle = await getBundle();
    const feed = await readFeedState();
    return {
      ok: true, settings, lists, totalBlocked: total + pendingTotal, custom,
      feed, bundleVersion: bundle.feedVersion, feedUrl: settings.feedUrl || bundle.feedUrl,
    };
  },

  async 'ab:saveSettings'({ patch }) {
    const allowed = {};
    const lists = await getLists();
    if (Array.isArray(patch?.enabledLists)) {
      allowed.enabledLists = patch.enabledLists.filter((id) => lists.some((l) => l.id === id));
      allowed.listsChosen = true; // the user may deliberately turn every list off
    }
    if ('showBadge' in (patch || {})) allowed.showBadge = Boolean(patch.showBadge);
    if ('contextMenu' in (patch || {})) allowed.contextMenu = Boolean(patch.contextMenu);
    if ('youtube' in (patch || {})) allowed.youtube = Boolean(patch.youtube);
    if ('autoUpdate' in (patch || {})) allowed.autoUpdate = Boolean(patch.autoUpdate);
    await saveSettings(allowed);
    const { settings } = await applyAll();
    // A newly enabled list may need its update downloaded.
    if (allowed.enabledLists) runUpdate(false);
    return { ok: true, settings };
  },

  async 'ab:saveCustomFilters'({ text }) {
    await saveSettings({ customFilters: String(text || '') });
    const { failed } = await applyAll();
    return { ok: true, stats: convertCustom(String(text || '')).stats, failed };
  },

  async 'ab:updateFilters'() {
    const feed = await runUpdate(true);
    return { ok: feed.status !== 'error', feed, error: feed.error };
  },

  // Points the extension at another feed (forks, local testing). null = default.
  async 'ab:setFeedUrl'({ url }) {
    let feedUrl = null;
    if (url !== null) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: 'URL tidak valid' };
      }
      if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'URL harus http(s)' };
      if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
      feedUrl = parsed.href;
    }
    await saveSettings({ feedUrl });
    await clearFeedUpdates();
    await applyAll();
    return { ok: true };
  },

  async 'ab:allowlistAdd'({ domain }) {
    return handlers['ab:setAllowlisted']({ domain, allowlisted: true });
  },

  async 'ab:allowlistRemove'({ domain }) {
    const settings = await getSettings();
    await saveSettings({ allowlist: settings.allowlist.filter((d) => d !== domain) });
    await applyAll();
    refreshAllIcons();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Enabled rulesets reset to the manifest defaults on install/update; reapply ours.
  if (reason === 'install') await saveSettings({});
  // Downloaded updates were computed against the previous bundled rulesets.
  if (reason === 'update') await clearFeedUpdates();
  await applyAll();
  await ensureUpdateAlarm();
  runUpdate(false);
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await applyAll();
  await ensureUpdateAlarm();
});
