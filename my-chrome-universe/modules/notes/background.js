// Sticky notes service worker: the only writer of nt:* data. The content script (content.js)
// draws the notes on web pages and asks here to load/save; the page URL always comes from the
// sender, never from the message, so one site can never read or write another site's notes.
import {
  PAGE_PREFIX, INDEX_KEY, SETTINGS_KEY, LIMITS, pageKey, cleanNote, cleanSettings, cleanTitle, indexEntry,
  toCsv, makeBackup, parseBackup, mergeBackup,
} from './store.js';
import { isModuleEnabled, onModuleStatesChanged } from '../../core/modules.js';
import { guardAction, messageAllowed, senderAllowed } from '../../core/gate.js';
import { registerMenuProvider } from '../../core/menus.js';
import { APPEARANCE_KEY } from '../../ui/appearance.js';

const SCRIPT_ID = 'nt-notes';
const SCRIPT_FILE = 'modules/notes/content.js';
const WEB_MATCHES = ['http://*/*', 'https://*/*'];
const MENU_ID = 'nt-new';

// ---------- storage (writes serialized) ----------

let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function readPage(url) {
  const key = PAGE_PREFIX + url;
  const page = (await chrome.storage.local.get(key))[key];
  return page && Array.isArray(page.notes) ? page : null;
}

async function readIndex() {
  const index = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY];
  return index && typeof index === 'object' ? index : {};
}

async function readSettings() {
  return cleanSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

async function readAllPages() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key, page]) => key.startsWith(PAGE_PREFIX) && Array.isArray(page?.notes))
    .map(([, page]) => page);
}

// Stores a page (or removes it once empty) together with its summary row.
async function writePage(page) {
  const index = await readIndex();
  if (page.notes.length) {
    index[page.url] = indexEntry(page);
    await chrome.storage.local.set({ [PAGE_PREFIX + page.url]: page, [INDEX_KEY]: index });
  } else {
    delete index[page.url];
    await chrome.storage.local.remove(PAGE_PREFIX + page.url);
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }
}

async function replaceAllPages(pages) {
  const old = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(PAGE_PREFIX));
  if (old.length) await chrome.storage.local.remove(old);
  const index = {};
  const items = {};
  for (const page of pages) {
    if (!page.notes.length) continue;
    items[PAGE_PREFIX + page.url] = page;
    index[page.url] = indexEntry(page);
  }
  await chrome.storage.local.set({ ...items, [INDEX_KEY]: index });
}

// ---------- tabs ----------

// The page a content script speaks for: only the top frame of a website tab. The tab's URL
// follows same-document navigations (history.pushState); sender.url keeps the first one.
function senderPage(sender) {
  if (!sender?.tab || sender.frameId !== 0) return null;
  return pageKey(sender.tab.url);
}

function tell(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null);
}

// Other tabs showing the same page redraw from storage.
async function refreshTabs(url, exceptTabId = null) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === exceptTabId || !tab.url) continue;
    if (url === null ? pageKey(tab.url) : pageKey(tab.url) === url) tell(tab.id, { type: 'nt:refresh' });
  }
}

// Tabs opened before the module was on have no content script yet.
async function ensureScript(tabId) {
  const pong = await tell(tabId, { type: 'nt:ping' });
  if (pong?.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [SCRIPT_FILE] });
    return true;
  } catch {
    return false;
  }
}

async function runInTab(tabId, message) {
  if (!(await ensureScript(tabId))) return { ok: false, error: 'Catatan tidak bisa ditempel di halaman ini.' };
  return (await tell(tabId, message)) || { ok: false, error: 'Halaman tidak menjawab. Muat ulang halaman lalu coba lagi.' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits (up to 15 s) until a tab has finished loading.
async function loaded(tabId) {
  for (let i = 0; i < 100; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await sleep(150);
  }
  return false;
}

async function syncContentScript({ injectOpenTabs = false } = {}) {
  const on = await isModuleEnabled('notes');
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
  if (on && !registered) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: WEB_MATCHES, js: [SCRIPT_FILE], runAt: 'document_idle', allFrames: false },
    ]);
  }
  if (!on && registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  const tabs = (await chrome.tabs.query({})).filter((t) => pageKey(t.url));
  if (!on) {
    for (const tab of tabs) tell(tab.id, { type: 'nt:off' });
  } else if (injectOpenTabs || !registered) {
    // A fresh copy replaces any older one (content.js tears the previous instance down).
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: [SCRIPT_FILE] }).catch(() => {});
    }
  }
}

// ---------- messages ----------

const NOT_HERE = { ok: false, error: 'Catatan tidak bisa ditempel di halaman ini.' };

export const handlers = {
  // ----- from the content script on a website -----

  async 'nt:load'(message, sender) {
    const url = senderPage(sender);
    if (!url) return NOT_HERE;
    if (!(await isModuleEnabled('notes'))) return { ok: true, enabled: false };
    const [page, settings, got] = await Promise.all([readPage(url), readSettings(), chrome.storage.local.get(APPEARANCE_KEY)]);
    return { ok: true, enabled: true, url, notes: page?.notes || [], settings, motion: got[APPEARANCE_KEY]?.motion || null };
  },

  async 'nt:save'({ note }, sender) {
    const url = senderPage(sender);
    if (!url) return NOT_HERE;
    if (!(await isModuleEnabled('notes'))) return { ok: false, error: 'Catatan Tempel sedang nonaktif.' };
    const result = await serial(async () => {
      const page = (await readPage(url)) || { url, title: '', notes: [] };
      const i = page.notes.findIndex((n) => n.id === note?.id);
      if (i < 0 && page.notes.length >= LIMITS.notesPerPage) {
        return { ok: false, error: `Batas ${LIMITS.notesPerPage} catatan per halaman tercapai.` };
      }
      const { color } = await readSettings();
      const saved = cleanNote(note, { prev: i < 0 ? null : page.notes[i], color });
      if (i < 0) page.notes.push(saved);
      else page.notes[i] = saved;
      page.title = cleanTitle(sender.tab.title) || page.title;
      await writePage(page);
      return { ok: true, note: saved };
    });
    if (result.ok) refreshTabs(url, sender.tab.id);
    return result;
  },

  async 'nt:delete'({ id }, sender) {
    const url = senderPage(sender);
    if (!url) return NOT_HERE;
    await serial(async () => {
      const page = await readPage(url);
      if (!page) return;
      page.notes = page.notes.filter((n) => n.id !== id);
      await writePage(page);
    });
    refreshTabs(url, sender.tab.id);
    return { ok: true };
  },

  // ----- from the popup panel and the settings page -----

  async 'nt:pageState'({ tabId }) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = pageKey(tab?.url);
    if (!url) return { ok: true, supported: false };
    const page = await readPage(url);
    const view = await tell(tabId, { type: 'nt:state' });
    return {
      ok: true, supported: true, url, title: tab.title || '', notes: page?.notes || [],
      hidden: !!view?.hidden, icons: !!view?.icons,
    };
  },

  async 'nt:command'({ tabId, command, id }) {
    if (!(await isModuleEnabled('notes'))) return { ok: false, error: 'Catatan Tempel sedang nonaktif.' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!pageKey(tab?.url)) return NOT_HERE;
    const messages = {
      new: { type: 'nt:new', at: 'center' },
      toggleHidden: { type: 'nt:toggleHidden' },
      toggleIcons: { type: 'nt:toggleIcons' },
      focus: { type: 'nt:focus', id },
    };
    if (!messages[command]) return { ok: false, error: 'Perintah tidak dikenal.' };
    return runInTab(tabId, messages[command]);
  },

  async 'nt:clearPage'({ url }) {
    const key = pageKey(url);
    if (!key) return { ok: false, error: 'Alamat halaman tidak valid.' };
    await serial(async () => {
      const page = await readPage(key);
      if (page) await writePage({ ...page, notes: [] });
    });
    refreshTabs(key);
    return { ok: true };
  },

  async 'nt:list'() {
    const index = await readIndex();
    const pages = Object.entries(index)
      .map(([url, e]) => ({ url, title: e.title || '', count: e.count || 0, updated: e.updated || 0 }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.updated - a.updated);
    return { ok: true, pages, total: pages.reduce((n, p) => n + p.count, 0) };
  },

  // Every page with its notes, the most recently edited page first (the dashboard board).
  async 'nt:all'() {
    const latest = (page) => page.notes.reduce((max, n) => Math.max(max, n.updated || 0), 0);
    const pages = (await readAllPages()).sort((a, b) => latest(b) - latest(a));
    return { ok: true, pages };
  },

  // Shows a note on its page: an open tab of that page is brought forward, otherwise one is opened.
  async 'nt:open'({ url, id }) {
    const key = pageKey(url);
    if (!key) return { ok: false, error: 'Alamat halaman tidak valid.' };
    let tab = (await chrome.tabs.query({})).find((t) => pageKey(t.url) === key);
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } else {
      tab = await chrome.tabs.create({ url: key, active: true });
    }
    if (!(await loaded(tab.id))) return { ok: false, error: 'Halaman belum selesai dimuat.' };
    return runInTab(tab.id, { type: 'nt:focus', id });
  },

  async 'nt:deleteNote'({ url, id }) {
    const key = pageKey(url);
    if (!key) return { ok: false, error: 'Alamat halaman tidak valid.' };
    const result = await serial(async () => {
      const page = await readPage(key);
      const note = page?.notes.find((n) => n.id === id);
      if (!note) return { ok: false, error: 'Catatan tidak ditemukan.' };
      await writePage({ ...page, notes: page.notes.filter((n) => n.id !== id) });
      return { ok: true, note, title: page.title };
    });
    if (result.ok) refreshTabs(key);
    return result;
  },

  // Undo of nt:deleteNote: the note comes back with its id and times.
  async 'nt:restoreNote'({ url, title, note }) {
    const key = pageKey(url);
    if (!key || !note || typeof note !== 'object') return { ok: false, error: 'Permintaan tidak valid.' };
    const result = await serial(async () => {
      const page = (await readPage(key)) || { url: key, title: cleanTitle(title), notes: [] };
      if (page.notes.length >= LIMITS.notesPerPage) return { ok: false, error: `Batas ${LIMITS.notesPerPage} catatan per halaman tercapai.` };
      const restored = cleanNote(note, { now: Number(note.updated) || Date.now() });
      page.notes = [...page.notes.filter((n) => n.id !== restored.id), restored];
      await writePage(page);
      return { ok: true, note: restored };
    });
    if (result.ok) refreshTabs(key);
    return result;
  },

  async 'nt:getSettings'() {
    return { ok: true, settings: await readSettings() };
  },

  async 'nt:saveSettings'({ patch }) {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Permintaan tidak valid.' };
    const settings = await serial(async () => {
      const current = await readSettings();
      // Apply only the keys whose new value is valid.
      for (const [key, value] of Object.entries(patch)) {
        if (key in current && cleanSettings({ ...current, [key]: value })[key] === value) current[key] = value;
      }
      await chrome.storage.local.set({ [SETTINGS_KEY]: current });
      return current;
    });
    refreshTabs(null);
    return { ok: true, settings };
  },

  async 'nt:export'() {
    const pages = (await readAllPages()).sort((a, b) => a.url.localeCompare(b.url));
    return { ok: true, backup: makeBackup(pages, await readSettings()), csv: toCsv(pages) };
  },

  async 'nt:import'({ backup, mode }) {
    if (!['merge', 'replace'].includes(mode)) return { ok: false, error: 'Permintaan tidak valid.' };
    let parsed;
    try {
      parsed = parseBackup(backup);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const count = await serial(async () => {
      const current = Object.fromEntries((await readAllPages()).map((p) => [p.url, p]));
      const merged = mergeBackup(current, parsed.pages, mode);
      await replaceAllPages(Object.values(merged));
      if (mode === 'replace' && parsed.settings) await chrome.storage.local.set({ [SETTINGS_KEY]: parsed.settings });
      return parsed.pages.reduce((n, p) => n + p.notes.length, 0);
    });
    refreshTabs(null);
    return { ok: true, count };
  },

  async 'nt:clearAll'() {
    await serial(() => replaceAllPages([]));
    refreshTabs(null);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) return false;
  if (!senderAllowed(sender, type)) {
    sendResponse({ ok: false, error: 'forbidden' });
    return false;
  }
  (async () => {
    if (!(await messageAllowed(type))) return { ok: false, error: 'locked' };
    return handlers[type](message, sender);
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// ---------- menu, shortcut, navigation ----------

async function mayAct() {
  return (await isModuleEnabled('notes')) && guardAction();
}

registerMenuProvider('notes', async () => [
  { id: MENU_ID, title: 'Tempel catatan di sini', contexts: ['page', 'selection'], documentUrlPatterns: WEB_MATCHES },
]);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !(await mayAct())) return;
  // The pointer position is only known for the top frame.
  const at = info.frameId ? 'center' : 'pointer';
  await runInTab(tab.id, { type: 'nt:new', at, text: info.selectionText || '' });
});

chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'new-note' || !tab?.id || !pageKey(tab.url) || !(await mayAct())) return;
  await runInTab(tab.id, { type: 'nt:new', at: 'center' });
});

// Single-page sites change the URL without loading a new document.
chrome.webNavigation?.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  if (frameId === 0) tell(tabId, { type: 'nt:urlChanged' });
});

// ---------- lifecycle ----------

onModuleStatesChanged(() => { syncContentScript().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { syncContentScript({ injectOpenTabs: true }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { syncContentScript().catch(() => {}); });
