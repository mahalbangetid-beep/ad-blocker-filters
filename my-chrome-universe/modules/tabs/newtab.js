// Tab Manager dashboard (New Tab). Order: lock gate → appearance → (welcome) → data → render → entrance.
// Zones: 1 dashboard/rail.js, 2 dashboard/collections.js, 3 dashboard/open-tabs.js, 4 dashboard/palette.js;
// the top bar, search results view, shortcuts and the arrival/welcome live here.
import { search } from './store.js';
import { send, runOp, loadData, onDataChanged, h } from './common.js';
import { guardPage } from '../../core/page-guard.js';
import { isModuleEnabled, getModuleStates, onModuleStatesChanged } from '../../core/modules.js';
import { initAppearance, watchAppearance, consumeWelcome } from '../../ui/appearance.js';
import { hydrateIcons, icon } from '../../ui/icons.js';
import { installEffects, toast, wait, countUp, motionLevel } from '../../ui/motion.js';
import { createSky } from '../../ui/sky.js';
import { playWelcome } from '../../ui/welcome.js';
import { renderRail, setActiveSpace } from './dashboard/rail.js';
import {
  setupCollections, renderCollections, renderSearch, showSpace, revealCollection, spaceMenu,
  foldAll, addCollection,
} from './dashboard/collections.js';
import { onDragEnd, isDragging } from './dashboard/drag.js';
import { act, askText, openDialog, closeMenu } from './dashboard/dialogs.js';
import {
  setupOpenTabs, renderTabs, syncOpenSettings, saveSession, dedupe, saveDropToSpace, openDrawer, closeDrawer, drawerOpen,
} from './dashboard/open-tabs.js';
import { setupPalette, openPalette, closePalette, paletteOpen } from './dashboard/palette.js';
import { setupGuide, showGuide, hideGuide, guideShown, autoShowGuide } from './dashboard/guide.js';
import { exportData, readImportFile, importData, importBookmarks } from './dashboard/backup.js';

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

let appearance = await initAppearance();
hydrateIcons();
installEffects();
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
if (isMac) {
  $('palette-kbd').textContent = '⌘ K';
  document.querySelectorAll('.kbd-name').forEach((n) => { n.textContent = '⌘ K'; });
  document.querySelectorAll('.kbd-mod').forEach((n) => { n.textContent = '⌘'; });
}

// How the page enters: after an unlock the lock tab turns into this page and the service worker
// raises tm:arrive (read once); after a browser start with Browser Lock off, the welcome plays here.
const modules = await getModuleStates();
const { 'tm:arrive': arrive = false } = await chrome.storage.session.get('tm:arrive');
if (arrive) await chrome.storage.session.remove('tm:arrive');
const welcome = !arrive && !modules.lock && (await consumeWelcome().catch(() => false));
const sky = createSky($('sky'), { mode: welcome ? 'welcome' : 'drift', fxCanvas: $('fx') });
if (welcome) {
  await playWelcome($('welcome'), sky);
  sky.setMode('drift');
}

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
let pendingReveal = null; // { id, cardId } shown once the target space is on screen

function setQuery(next) {
  query = next;
  const url = query ? `${location.pathname}?q=${encodeURIComponent(query)}` : location.pathname;
  history.replaceState(null, '', url);
}

function clearSearch() {
  if (query) setQuery('');
}

async function render({ first = false } = {}) {
  if (switching) {
    renderAgain = true;
    return;
  }
  syncOpenSettings(data);
  renderRail(data, { onActivate: activate, onReveal: reveal, onSpaceMenu: spaceMenu, onDropTabs: saveDropToSpace, searching: Boolean(query) });
  $('search-actions').hidden = !query;
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
  if (pendingReveal && !switching) {
    const { id, cardId } = pendingReveal;
    pendingReveal = null;
    await wait(350);
    revealCollection(id, { cardId });
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

function reveal(spaceId, collectionId, cardId = null) {
  const searching = Boolean(query);
  clearSearch();
  if (spaceId !== data.activeSpaceId) {
    pendingReveal = { id: collectionId, cardId };
    setActiveSpace(spaceId);
    runOp({ type: 'space/activate', spaceId });
  } else if (searching) {
    pendingReveal = { id: collectionId, cardId };
    render();
  } else {
    revealCollection(collectionId, { cardId });
  }
}

// A collection created from open tabs: scroll to it once it is rendered.
function revealSaved(collectionId) {
  if (!collectionId) return;
  closeDrawer();
  reveal(data.activeSpaceId, collectionId);
}

function showAllResults(text) {
  setQuery(text.trim());
  render();
  $('tm-main').scrollTo({ top: 0 });
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

// ---------- Zone 3: open tabs ----------

setupOpenTabs({ getData: () => data, thisTab, sky, onSaved: revealSaved });

// ---------- Top bar ----------

// Ad Blocker chip: total blocked so far (there is no daily counter); hidden while the module is off.
let abShown = 0;
async function showAdblockChip(enabled, { animate = false } = {}) {
  $('chip-ab').hidden = !enabled;
  if (!enabled) return;
  const options = await send('ab:getOptions').catch(() => null);
  if (!options?.ok) return void ($('chip-ab').hidden = true);
  setBlocked(options.totalBlocked, animate);
}
function setBlocked(total, animate) {
  if (!Number.isFinite(total) || total === abShown) return;
  abShown = total;
  if (animate) countUp($('ab-count'), total, 1600);
  else $('ab-count').textContent = new Intl.NumberFormat('id-ID').format(total);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['ab:total'] && !$('chip-ab').hidden) setBlocked(changes['ab:total'].newValue || 0, false);
});

// Kunci: a short collapse (≤ 450 ms), then lock:lock; the lock sweep closes this page.
let locking = false;
async function lockNow() {
  if (locking) return;
  locking = true;
  closePalette();
  hideGuide();
  closeDrawer();
  sky.reverse(900);
  $('tm').classList.add('collapsing');
  await wait(420);
  const result = await send('lock:lock').catch(() => null);
  if (result?.ok) return; // this page is about to close
  locking = false;
  $('tm').classList.remove('collapsing');
  toast(modules.lock ? 'Gagal mengunci browser' : 'Browser Lock sedang nonaktif', { icon: 'info' });
}

function showModules(states, options) {
  Object.assign(modules, states);
  $('tm-lock').hidden = !states.lock;
  showAdblockChip(states.adblock, options);
}
onModuleStatesChanged((states) => {
  if (!states.tabs) return void location.reload();
  showModules(states);
});

// Theme: auto → light → dark, stored in the shared appearance so every open page follows.
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_INFO = { auto: ['monitor', 'Tema: ikuti sistem'], light: ['sun', 'Tema terang (Fajar)'], dark: ['moon', 'Tema gelap (Malam)'] };
function showTheme() {
  const [name, label] = THEME_INFO[appearance.theme] || THEME_INFO.auto;
  $('theme-btn').replaceChildren(icon(name));
  $('theme-btn').title = label;
  $('theme-btn').setAttribute('aria-label', `Ganti tema (sekarang: ${label})`);
}
showTheme();
watchAppearance((next) => {
  appearance = next;
  showTheme();
});
async function cycleTheme(source = $('theme-btn')) {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(appearance.theme) + 1) % THEME_ORDER.length];
  const result = await send('core:setAppearance', { patch: { theme: next } });
  if (!result?.ok) return toast(result?.error || 'Gagal mengganti tema', { icon: 'info' });
  sky.burstAt(source, 16);
  toast(THEME_INFO[next][1], { icon: THEME_INFO[next][0] });
}
$('theme-btn').addEventListener('click', (e) => cycleTheme(e.currentTarget));
$('tm-lock').addEventListener('click', lockNow);
$('open-palette').addEventListener('click', () => openPalette());

// ---------- Zone 4: palette commands ----------

const importJson = () => $('import-file').click();

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let incoming;
  try {
    incoming = await readImportFile(file);
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
  if (choice) await act(importData(incoming, choice.mode), 'Data diimpor', 'upload');
});

async function addSpace() {
  const name = await askText('Ruang baru', 'Nama ruang');
  if (!name) return;
  clearSearch();
  await act(runOp({ type: 'space/create', name }), `Ruang “${name}” dibuat`, 'plus');
}

function commands() {
  const narrow = matchMedia('(max-width: 1180px)').matches;
  const allFolded = activeSpace().collections.length > 0 && activeSpace().collections.every((c) => c.collapsed);
  return [
    { ic: 'download', label: 'Simpan sesi (semua tab di jendela ini)', keywords: 'simpan tab', hint: 'Alt+Shift+S', run: () => saveSession() },
    modules.lock && { ic: 'lock', label: 'Kunci browser sekarang', hint: 'Alt+Shift+L', run: lockNow },
    { ic: 'copy', label: 'Hapus tab duplikat', keywords: 'tutup ganda', run: () => dedupe() },
    { ic: 'plus', label: 'Buat koleksi baru', run: () => { clearSearch(); render().then(() => addCollection()); } },
    { ic: 'plus', label: 'Buat ruang baru', run: addSpace },
    !query && { ic: 'fold', label: allFolded ? 'Bentangkan semua koleksi' : 'Lipat semua koleksi', run: () => foldAll() },
    narrow && { ic: 'window', label: 'Tampilkan tab terbuka', run: openDrawer },
    { ic: THEME_INFO[appearance.theme]?.[0] || 'moon', label: 'Ganti tema', keywords: 'gelap terang malam fajar tampilan', run: () => cycleTheme() },
    { ic: 'help', label: 'Tunjukkan kerangka Tab Manager', keywords: 'panduan bantuan', run: () => showGuide() },
    { ic: 'settings', label: 'Buka pengaturan', run: () => { location.href = $('settings-btn').href; } },
    { ic: 'download', label: 'Ekspor data (JSON)', keywords: 'cadangan backup', run: () => exportData(data) },
    { ic: 'upload', label: 'Impor data (JSON)…', keywords: 'cadangan backup toby', run: importJson },
    {
      ic: 'folder', label: 'Impor bookmark Chrome', keywords: 'penanda',
      run: async () => act(importBookmarks(), (r) => `${r.count} folder bookmark diimpor ke ruang “Bookmark Chrome”`, 'upload'),
    },
    { ic: 'key', label: 'Pintasan keyboard…', keywords: 'shortcut tombol', run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
    ...data.spaces.map((s) => ({ ic: 'globe', label: `Pindah ke ruang ${s.name}`, run: () => activate(s.id) })),
  ].filter(Boolean);
}

setupPalette({
  getData: () => data,
  commands,
  onReveal: reveal,
  onOpenCard: (card) => {
    chrome.tabs.create({ url: card.url, active: false });
    toast(`Membuka ${card.title}`, { icon: 'external' });
  },
  onShowAll: showAllResults,
});

setupGuide({ beforeShow: closeDrawer });

// ---------- Zone 1/2 static controls ----------

$('add-space').addEventListener('click', addSpace);
$('add-col').addEventListener('click', () => addCollection());
$('fold-all').addEventListener('click', () => foldAll());
$('space-menu').addEventListener('click', (e) => spaceMenu(e.currentTarget, activeSpace().id));
$('space-title').addEventListener('contextmenu', (e) => {
  if (query) return;
  e.preventDefault();
  spaceMenu(e.currentTarget, activeSpace().id);
});
$('clear-search').addEventListener('click', () => {
  clearSearch();
  render();
});
$('open-drawer').addEventListener('click', closeMenu);

// ---------- Shortcuts ----------

document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || el?.isContentEditable;
  const modal = $('dialog').open;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !modal) {
    e.preventDefault();
    if (paletteOpen()) closePalette();
    else openPalette();
    return;
  }
  if (e.key === '/' && !typing && !modal && !paletteOpen()) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === 'Escape' && !modal) {
    if (paletteOpen()) closePalette();
    else if (guideShown()) hideGuide();
    else if (drawerOpen()) closeDrawer();
    else if (query && !typing) {
      clearSearch();
      render();
    }
  }
});

// ---------- First paint and entrance ----------

await render({ first: true });
performance.mark('tm:rendered');
if (arrive) {
  $('tm').classList.add('arrive');
  sky.warp(motionLevel() === 'full' ? 1100 : 800);
}
$('tm').classList.add('ready');
renderTabs();
showModules(modules, { animate: true });
autoShowGuide(arrive || welcome ? 2200 : 1700);
