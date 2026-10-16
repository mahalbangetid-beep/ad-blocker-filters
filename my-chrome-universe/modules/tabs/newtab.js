// Tab Manager dashboard (New Tab). Order: lock gate → appearance → data → render.
// Zone 1 lives in dashboard/rail.js, zone 2 in dashboard/collections.js; the open tabs panel,
// search box and ⋯ menu stay here until the open-tabs/palette zones replace them.
import { search, isSavableUrl } from './store.js';
import { send, runOp, loadData, onDataChanged, h } from './common.js';
import { guardPage } from '../../core/page-guard.js';
import { isModuleEnabled, onModuleStatesChanged } from '../../core/modules.js';
import { initAppearance, watchAppearance } from '../../ui/appearance.js';
import { hydrateIcons, icon } from '../../ui/icons.js';
import { installEffects, toast, wait } from '../../ui/motion.js';
import { createSky } from '../../ui/sky.js';
import { renderRail, setActiveSpace } from './dashboard/rail.js';
import {
  setupCollections, renderCollections, renderSearch, showSpace, revealCollection, spaceMenu,
  foldAll, addCollection, favicon, startDrag, onDragEnd, isDragging,
} from './dashboard/collections.js';
import { act, askText, openDialog, showMenu, closeMenu } from './dashboard/dialogs.js';

await guardPage('tab');

const $ = (id) => document.getElementById(id);

// With Tab Manager off, hand the tab to Chrome's own New Tab page. chrome://newtab/ would
// load this override again (an endless loop) and pages cannot navigate to chrome:// URLs
// themselves, but tabs.update to chrome://new-tab-page/ works (checked in Chromium).
// The notice stays as the fallback when that is not possible.
async function leaveDashboard() {
  document.title = 'Tab Baru';
  const enable = h('button', {
    type: 'button',
    class: 'btn primary rp',
    onclick: async () => {
      const result = await send('core:setModule', { id: 'tabs', enabled: true });
      if (result?.ok) location.reload();
    },
  }, 'Aktifkan Tab Manager');
  document.body.replaceChildren(h('main', { class: 'module-off' }, h('p', {}, 'Tab Manager sedang nonaktif.'), enable));
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab) await chrome.tabs.update(tab.id, { url: 'chrome://new-tab-page/' }).catch(() => {});
  return new Promise(() => {});
}

if (!(await isModuleEnabled('tabs'))) await leaveDashboard();
onModuleStatesChanged((states) => { if (!states.tabs) location.reload(); });

let appearance = await initAppearance();
hydrateIcons();
installEffects();
const sky = createSky($('sky'), { mode: 'drift', fxCanvas: $('fx') });

const DASHBOARD_URL = chrome.runtime.getURL('modules/tabs/newtab.html');
const GROUP_COLORS = {
  grey: '#9aa0a6', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

let data = await loadData();
let query = new URLSearchParams(location.search).get('q') || '';
const thisTab = await chrome.tabs.getCurrent();
setupCollections({ getData: () => data, thisTab, sky });

// ---------- Rendering ----------

const activeSpace = () => data.spaces.find((s) => s.id === data.activeSpaceId) || data.spaces[0];

let shownSpaceId = null; // space currently in #cols (null: search results or nothing yet)
let switching = false;
let renderAgain = false;
let pendingRender = false;
let pendingReveal = null;

function clearSearch() {
  if (!query) return;
  query = '';
  $('search').value = '';
  history.replaceState(null, '', location.pathname);
}

async function render({ first = false } = {}) {
  if (switching) {
    renderAgain = true;
    return;
  }
  $('close-after').checked = data.settings.closeAfterSave;
  renderRail(data, { onActivate: activate, onReveal: reveal, onSpaceMenu: spaceMenu, searching: Boolean(query) });
  if (query) {
    shownSpaceId = null;
    renderSearch(search(data, query), query);
    return;
  }
  const space = activeSpace();
  if (shownSpaceId && shownSpaceId !== space.id) {
    const ids = data.spaces.map((s) => s.id);
    const dir = ids.indexOf(space.id) >= ids.indexOf(shownSpaceId) ? 1 : -1;
    shownSpaceId = space.id;
    switching = true;
    closeDrawer();
    await showSpace(space, { dir });
    switching = false;
    if (renderAgain) {
      renderAgain = false;
      await render();
    }
  } else {
    renderCollections(space, { enter: first || shownSpaceId === null });
    shownSpaceId = space.id;
  }
  if (pendingReveal) {
    const id = pendingReveal;
    pendingReveal = null;
    await wait(350);
    revealCollection(id);
  }
}

function activate(spaceId) {
  const searching = Boolean(query);
  clearSearch();
  if (spaceId === data.activeSpaceId) {
    if (searching) render();
    return;
  }
  setActiveSpace(spaceId);
  runOp({ type: 'space/activate', spaceId });
}

function reveal(spaceId, collectionId) {
  const searching = Boolean(query);
  clearSearch();
  if (spaceId !== data.activeSpaceId) {
    pendingReveal = collectionId;
    setActiveSpace(spaceId);
    runOp({ type: 'space/activate', spaceId });
  } else if (searching) {
    pendingReveal = collectionId;
    render();
  } else {
    revealCollection(collectionId);
  }
}

onDragEnd(() => {
  if (!pendingRender) return;
  pendingRender = false;
  render();
});

onDataChanged((next) => {
  data = next;
  if (isDragging()) pendingRender = true;
  else render();
});

// ---------- Import / export ----------

function exportData() {
  const payload = { format: 'tab-manager', version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: `tab-manager-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Accepts this extension's export, a raw data object, or a Toby-style export ({ lists: [...] }).
function toImportData(json) {
  if (json?.format === 'tab-manager' && json.data) return json.data;
  if (Array.isArray(json?.spaces)) return json;
  if (Array.isArray(json?.lists)) {
    return {
      spaces: [{
        name: 'Impor Toby',
        collections: json.lists.map((list) => ({
          name: list.title || 'Koleksi',
          cards: (list.cards || []).map((c) => ({ url: c.url, title: c.customTitle || c.title })),
        })),
      }],
    };
  }
  throw new Error('Format file tidak dikenali');
}

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let incoming;
  try {
    incoming = toImportData(JSON.parse(await file.text()));
  } catch (err) {
    return toast(`Gagal membaca file: ${err.message}`, { icon: 'info' });
  }
  const choice = await openDialog({
    title: 'Impor data',
    message: `File: ${file.name}`,
    fields: [{
      name: 'mode',
      label: 'Cara impor',
      value: 'merge',
      options: [
        { value: 'merge', label: 'Tambahkan ke data yang ada' },
        { value: 'replace', label: 'Ganti semua data yang ada' },
      ],
    }],
    submitLabel: 'Impor',
  });
  if (choice) await act(runOp({ type: 'import', data: incoming, mode: choice.mode }), 'Data diimpor', 'upload');
});

async function importBookmarks() {
  // Must be requested directly from the click (user gesture).
  const granted = await chrome.permissions.request({ permissions: ['bookmarks'] });
  if (!granted) return toast('Izin bookmark ditolak', { icon: 'info' });
  const [root] = await chrome.bookmarks.getTree();
  const collections = [];
  (function walk(node, path) {
    const links = (node.children || []).filter((c) => c.url && isSavableUrl(c.url));
    if (links.length) collections.push({ name: path.join(' / ') || 'Bookmark', cards: links.map((l) => ({ url: l.url, title: l.title })) });
    for (const child of node.children || []) if (!child.url) walk(child, child.title ? [...path, child.title] : path);
  })(root, []);
  if (!collections.length) return toast('Tidak ada bookmark', { icon: 'info' });
  await act(runOp({ type: 'import', mode: 'merge', data: { spaces: [{ name: 'Bookmark Chrome', collections }] } }),
    `${collections.length} folder bookmark diimpor ke ruang “Bookmark Chrome”`, 'upload');
}

// ---------- Open tabs panel ----------

function tabRow(tab) {
  const url = tab.url || tab.pendingUrl || '';
  const savable = isSavableUrl(url);
  const row = h('li', {
    class: `orow${tab.active ? ' active' : ''}`,
    draggable: savable ? 'true' : 'false',
    title: `${tab.title}\n${url}`,
    onclick: () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    },
  },
  favicon(url),
  h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, tab.title || url), h('span', { class: 'row-url' }, url.replace(/^[a-z]+:\/\/(www\.)?/i, ''))),
  h('button', { type: 'button', class: 'icon-btn xs close-tab', 'aria-label': 'Tutup tab', title: 'Tutup tab', onclick: (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); } }, icon('x')));
  row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'tab', tabs: [{ id: tab.id, url, title: tab.title }], url }, row));
  return row;
}

function saveTabs(tabs, name) {
  return act(send('tm:saveSession', {
    tabIds: tabs.map((t) => t.id),
    name,
    close: data.settings.closeAfterSave,
    keepTabId: thisTab?.id,
  }), (r) => `${r.saved} tab disimpan`, 'download');
}

let tabsTimer;
function scheduleTabsRender() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(renderTabs, 120);
}

async function renderTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  let total = 0;

  const blocks = windows.map((win, i) => {
    const tabs = win.tabs.filter((t) => !(t.url || t.pendingUrl || '').startsWith(DASHBOARD_URL));
    total += tabs.length;
    const children = [];
    let groupEl = null;
    let groupId = null;
    for (const tab of tabs) {
      if (tab.groupId > -1) {
        if (tab.groupId !== groupId) {
          groupId = tab.groupId;
          const group = groupById.get(groupId);
          const groupTabs = tabs.filter((t) => t.groupId === groupId);
          groupEl = h('ul', { class: 'group-block' },
            h('li', { class: 'group-head' },
              h('span', { class: 'dot', style: `background:${GROUP_COLORS[group?.color] || GROUP_COLORS.grey}` }),
              h('span', { class: 'group-name' }, group?.title || 'Grup tanpa nama'),
              h('button', { type: 'button', class: 'btn ghost sm rp', onclick: () => saveTabs(groupTabs, group?.title || 'Grup tab') }, 'Simpan grup')));
          children.push(h('li', {}, groupEl));
        }
        groupEl.append(tabRow(tab));
      } else {
        groupId = null;
        children.push(tabRow(tab));
      }
    }
    return h('section', { class: 'win' },
      h('h4', {}, icon('window'), h('span', {}, win.id === thisTab?.windowId ? 'Jendela ini' : `Jendela ${i + 1}`),
        h('span', { class: 'faint' }, `${tabs.length} tab`),
        tabs.length > 0 && h('button', { type: 'button', class: 'btn ghost sm rp', onclick: () => saveTabs(tabs) }, 'Simpan')),
      h('ul', {}, children));
  });

  $('open-count').textContent = String(total);
  $('windows').replaceChildren(...(total ? blocks : [h('div', { class: 'empty-mini' }, icon('sparkle'), h('p', {}, 'Tidak ada tab lain yang terbuka.'))]));
}

for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated']) {
  chrome.tabs[ev].addListener(scheduleTabsRender);
}
chrome.windows.onCreated.addListener(scheduleTabsRender);
chrome.windows.onRemoved.addListener(scheduleTabsRender);
chrome.tabGroups?.onUpdated.addListener(scheduleTabsRender);

function openDrawer() {
  $('tm-open').classList.add('open');
  $('drawer-scrim').classList.add('open');
}
function closeDrawer() {
  $('tm-open').classList.remove('open');
  $('drawer-scrim').classList.remove('open');
}

// ---------- Static controls ----------

$('search').value = query;
$('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  render();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearSearch();
    render();
  }
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (e.key === '/' && !typing && !$('dialog').open) {
    e.preventDefault();
    $('search').focus();
  }
  if (e.key === 'Escape') closeDrawer();
});

// Theme: auto → light → dark, stored in the shared appearance so every open page follows.
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_INFO = { auto: ['monitor', 'Tema: ikuti sistem'], light: ['sun', 'Tema terang (Fajar)'], dark: ['moon', 'Tema gelap (Malam)'] };
function showTheme() {
  const [name, label] = THEME_INFO[appearance.theme] || THEME_INFO.auto;
  $('theme-btn').replaceChildren(icon(name));
  $('theme-btn').title = label;
}
showTheme();
watchAppearance((next) => {
  appearance = next;
  showTheme();
});
$('theme-btn').addEventListener('click', async (e) => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(appearance.theme) + 1) % THEME_ORDER.length];
  const result = await send('core:setAppearance', { patch: { theme: next } });
  if (!result?.ok) return toast(result?.error || 'Gagal mengganti tema', { icon: 'info' });
  sky.burstAt(e.currentTarget, 16);
  toast(THEME_INFO[next][1], { icon: THEME_INFO[next][0] });
});

$('menu-btn').addEventListener('click', (e) => showMenu(e.currentTarget, [
  { ic: 'download', label: 'Ekspor data (JSON)', run: exportData },
  { ic: 'upload', label: 'Impor data (JSON)…', run: () => $('import-file').click() },
  { ic: 'folder', label: 'Impor bookmark Chrome', run: importBookmarks },
  '-',
  { ic: 'key', label: 'Pintasan keyboard…', run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
]));

$('add-space').addEventListener('click', async () => {
  const name = await askText('Ruang baru', 'Nama ruang');
  if (!name) return;
  clearSearch();
  await act(runOp({ type: 'space/create', name }), `Ruang “${name}” dibuat`, 'plus');
});

$('add-col').addEventListener('click', () => addCollection());
$('fold-all').addEventListener('click', () => foldAll());
$('space-menu').addEventListener('click', (e) => spaceMenu(e.currentTarget, activeSpace().id));
$('space-title').addEventListener('contextmenu', (e) => {
  if (query) return;
  e.preventDefault();
  spaceMenu(e.currentTarget, activeSpace().id);
});

$('save-session').addEventListener('click', () => act(send('tm:saveSession', {
  windowId: thisTab?.windowId,
  close: data.settings.closeAfterSave,
  keepTabId: thisTab?.id,
}), (r) => `${r.saved} tab disimpan sebagai koleksi baru`, 'download'));

$('close-after').addEventListener('change', (e) => {
  runOp({ type: 'settings/update', settings: { closeAfterSave: e.target.checked } });
});

$('dedupe').addEventListener('click', () => act(send('tm:closeDuplicates'),
  (r) => (r.closed ? `${r.closed} tab duplikat ditutup` : 'Tidak ada tab duplikat'), 'copy'));

$('open-drawer').addEventListener('click', () => {
  closeMenu();
  openDrawer();
});
$('drawer-scrim').addEventListener('click', closeDrawer);

// ---------- First paint ----------

await render({ first: true });
performance.mark('tm:rendered');
$('tm').classList.add('ready');
renderTabs();
