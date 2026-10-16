import { STORAGE_KEY, INBOX_NAME, applyOp, normalize, emptyData, findCollection, findSpace, isSavableUrl, search, sessionName } from './store.js';
import { registerMenuProvider } from '../../core/menus.js';
import { guardAction, lockStatus, messageAllowed } from '../../core/gate.js';
import { isModuleEnabled } from '../../core/modules.js';

const DASHBOARD_PATH = 'modules/tabs/newtab.html';
const DASHBOARD_URL = chrome.runtime.getURL(DASHBOARD_PATH);

// --- Storage: the service worker is the only writer, so concurrent edits from
// several dashboard tabs and the popup never overwrite each other. ---

async function load() {
  const { [STORAGE_KEY]: data } = await chrome.storage.local.get(STORAGE_KEY);
  return normalize(data || emptyData());
}

let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const data = await load();
    const result = await fn(data);
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

const op = (operation) => mutate((data) => applyOp(data, operation));

// Menus, shortcuts and the omnibox stay silent while the module is off; while the lock
// is not open they do nothing either (before setup, guardAction steers to the setup page).
async function mayAct() {
  return (await isModuleEnabled('tabs')) && guardAction();
}

// --- Tabs helpers ---

function isDashboard(url) {
  return typeof url === 'string' && url.startsWith(DASHBOARD_URL);
}

function tabInfo(tab) {
  return { url: tab.url || tab.pendingUrl, title: tab.title };
}

async function saveSession({ windowId, tabIds, close, name, spaceId, keepTabId }) {
  let tabs = tabIds?.length
    ? (await chrome.tabs.query({})).filter((t) => tabIds.includes(t.id))
    : await chrome.tabs.query(windowId ? { windowId } : { currentWindow: true });
  tabs = tabs.filter((t) => isSavableUrl(t.url || t.pendingUrl) && !isDashboard(t.url || t.pendingUrl));
  if (!tabs.length) return { ok: false, error: 'Tidak ada tab yang bisa disimpan.' };

  const result = await op({ type: 'collection/create', spaceId, name: name || sessionName(), tabs: tabs.map(tabInfo) });

  if (close) {
    const toClose = tabs.filter((t) => !t.pinned && t.id !== keepTabId);
    const win = toClose[0]?.windowId;
    if (win !== undefined) {
      const remaining = (await chrome.tabs.query({ windowId: win })).filter((t) => !toClose.some((c) => c.id === t.id));
      // Keep the window alive by leaving a dashboard tab in it.
      if (!remaining.length) await chrome.tabs.create({ windowId: win, url: DASHBOARD_URL });
    }
    await chrome.tabs.remove(toClose.map((t) => t.id)).catch(() => {});
  }
  return result;
}

async function openCollection({ collectionId, mode = 'current', cardIds }) {
  const data = await load();
  const found = findCollection(data, collectionId);
  if (!found) return { ok: false, error: 'Koleksi tidak ditemukan' };
  const cards = cardIds ? found.collection.cards.filter((c) => cardIds.includes(c.id)) : found.collection.cards;
  if (!cards.length) return { ok: false, error: 'Koleksi kosong' };

  let windowId;
  let tabIds = [];
  if (mode === 'window') {
    const win = await chrome.windows.create({ url: cards.map((c) => c.url), focused: true });
    windowId = win.id;
    tabIds = win.tabs.map((t) => t.id);
  } else {
    for (const card of cards) {
      const tab = await chrome.tabs.create({ url: card.url, active: false });
      tabIds.push(tab.id);
      windowId = tab.windowId;
    }
  }

  if (mode === 'group' && chrome.tabGroups) {
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: found.collection.name });
  }
  return { ok: true, opened: tabIds.length };
}

// Closes open tabs whose URL is already open in another tab.
async function closeDuplicateTabs() {
  const tabs = await chrome.tabs.query({});
  const seen = new Map();
  const duplicates = [];
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    if (!url || isDashboard(url)) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) {
      // Keep the active or pinned one where possible.
      const kept = seen.get(key);
      if ((tab.active || tab.pinned) && !(kept.active || kept.pinned)) {
        duplicates.push(kept.id);
        seen.set(key, tab);
      } else {
        duplicates.push(tab.id);
      }
    } else {
      seen.set(key, tab);
    }
  }
  if (duplicates.length) await chrome.tabs.remove(duplicates).catch(() => {});
  return { ok: true, closed: duplicates.length };
}

// Saves one tab to the "Disimpan" collection of the active space (created on demand).
async function saveToInbox(tab) {
  if (!isSavableUrl(tab.url)) return { ok: false, error: 'Halaman ini tidak bisa disimpan.' };
  return mutate((data) => {
    const space = findSpace(data, data.activeSpaceId);
    let inbox = space.collections.find((c) => c.name === INBOX_NAME);
    if (!inbox) {
      const { id } = applyOp(data, { type: 'collection/create', spaceId: space.id, name: INBOX_NAME });
      inbox = findCollection(data, id).collection;
    }
    return applyOp(data, { type: 'card/add', collectionId: inbox.id, tabs: [tabInfo(tab)], index: 0 });
  });
}

async function openDashboard() {
  const [existing] = (await chrome.tabs.query({ currentWindow: true })).filter((t) => isDashboard(t.url));
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: DASHBOARD_URL });
}

// --- Message router. All message types are prefixed "tm:" so this module can
// share one runtime.onMessage with other features later. ---

const handlers = {
  'tm:getData': () => load(),
  'tm:op': ({ op: operation }) => op(operation),
  'tm:saveSession': (msg) => saveSession(msg),
  'tm:openCollection': (msg) => openCollection(msg),
  'tm:closeDuplicates': () => closeDuplicateTabs(),
  'tm:saveTab': ({ tab, collectionId }) =>
    collectionId ? op({ type: 'card/add', collectionId, tabs: [tab], index: 0 }) : saveToInbox(tab),
};

// Refused unless the lock is open (core/gate.js); the dashboard and popup are gated as pages too.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) return false;
  (async () => {
    if (!(await messageAllowed(type))) return { ok: false, error: 'locked' };
    return handlers[type](message);
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// --- Context menu ---

const MENU = { root: 'tm-root', saveTab: 'tm-save-tab', saveSession: 'tm-save-session', open: 'tm-open' };

// The shared menu (core/menus.js) asks for our items on every rebuild.
registerMenuProvider('tabs', async () => [
  { id: MENU.root, title: 'Tab Manager', contexts: ['page', 'action'] },
  { id: MENU.saveTab, parentId: MENU.root, title: 'Simpan tab ini', contexts: ['page', 'action'] },
  { id: MENU.saveSession, parentId: MENU.root, title: 'Simpan semua tab (sesi)', contexts: ['page', 'action'] },
  { id: MENU.open, parentId: MENU.root, title: 'Buka Tab Manager', contexts: ['page', 'action'] },
]);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (![MENU.saveTab, MENU.saveSession, MENU.open].includes(info.menuItemId) || !(await mayAct())) return;
  if (info.menuItemId === MENU.saveTab && tab) await saveToInbox(tab);
  if (info.menuItemId === MENU.saveSession) await saveSession({ windowId: tab?.windowId });
  if (info.menuItemId === MENU.open) await openDashboard();
});

// --- Keyboard shortcuts ---

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!['save-session', 'save-tab'].includes(command) || !(await mayAct())) return;
  if (command === 'save-session') await saveSession({ windowId: tab?.windowId });
  if (command === 'save-tab' && tab) await saveToInbox(tab);
});

// --- Omnibox: type "tm" + space, then search saved tabs. ---

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

chrome.omnibox.setDefaultSuggestion({ description: 'Cari tab tersimpan di Tab Manager' });

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  // Typing is not an action, so no setup tab is opened here; just reveal nothing.
  if (!(await isModuleEnabled('tabs')) || (await lockStatus()) !== 'open') return suggest([]);
  const results = search(await load(), text);
  const suggestions = [];
  for (const { collection, cards } of results) {
    for (const card of cards) {
      suggestions.push({
        content: card.url,
        description: `${escapeXml(card.title)} <dim>— ${escapeXml(collection.name)}</dim> <url>${escapeXml(card.url)}</url>`,
      });
      if (suggestions.length >= 8) break;
    }
    if (suggestions.length >= 8) break;
  }
  suggest(suggestions);
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  if (!(await mayAct())) return;
  const url = isSavableUrl(text) ? text : `${DASHBOARD_URL}?q=${encodeURIComponent(text)}`;
  if (disposition === 'currentTab') await chrome.tabs.update({ url });
  else await chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});
