import { search, isSavableUrl } from './store.js';
import { send, runOp, loadData, onDataChanged, faviconUrl, hostname, h, applyTheme } from './common.js';
import { guardPage } from '../../core/page-guard.js';
import { isModuleEnabled, onModuleStatesChanged } from '../../core/modules.js';

await guardPage('tab');

// With Tab Manager off, hand the tab to Chrome's own New Tab page. chrome://newtab/ would
// load this override again (an endless loop) and pages cannot navigate to chrome:// URLs
// themselves, but tabs.update to chrome://new-tab-page/ works (checked in Chromium).
// The notice stays as the fallback when that is not possible.
async function leaveDashboard() {
  document.title = 'Tab Baru';
  const enable = h('button', {
    class: 'primary-btn',
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

const $ = (id) => document.getElementById(id);
const DASHBOARD_URL = chrome.runtime.getURL('modules/tabs/newtab.html');
const THEMES = { auto: ['◐', 'Ikuti sistem'], light: ['☀', 'Terang'], dark: ['☾', 'Gelap'] };
const GROUP_COLORS = {
  grey: '#9aa0a6', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

let data = await loadData();
let query = new URLSearchParams(location.search).get('q') || '';
let dragging = null; // { kind: 'tab' | 'card' | 'collection', ... } for drags started on this page
let pendingRender = false;
let pendingScroll = null;
const thisTab = await chrome.tabs.getCurrent();

// ---------- Feedback ----------

let toastTimer;
function toast(text, action) {
  const el = $('toast');
  el.replaceChildren(text);
  if (action) {
    el.append(' ', h('button', { class: 'ghost-btn small', onclick: () => { action.run(); el.classList.remove('show'); } }, action.label));
    el.style.pointerEvents = 'auto';
  } else {
    el.style.pointerEvents = 'none';
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2500);
}

async function act(promise, success) {
  const result = await promise;
  if (!result?.ok) toast(result?.error || 'Terjadi kesalahan');
  else if (success) toast(typeof success === 'function' ? success(result) : success);
  return result;
}

// ---------- Dialogs ----------

const dialog = $('dialog');
const form = $('dialog-form');

// Resolves to an object of field values, or null when cancelled.
function openDialog({ title, message, fields = [], submitLabel = 'Simpan', danger = false }) {
  return new Promise((resolve) => {
    // replaceChildren() neither flattens arrays nor skips empty values, so do it here.
    form.replaceChildren(...[
      h('h2', {}, title),
      message && h('p', {}, message),
      ...fields.map((f) => [
        h('label', { for: `f-${f.name}` }, f.label),
        f.options
          ? h('select', { id: `f-${f.name}`, name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
          : h('input', { id: `f-${f.name}`, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required }),
      ]),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'ghost-btn', onclick: () => dialog.close('cancel') }, 'Batal'),
        h('button', { type: 'submit', value: 'ok', class: danger ? 'danger-btn' : 'primary-btn' }, submitLabel)),
    ].flat().filter(Boolean));
    dialog.returnValue = '';
    dialog.onclose = () => {
      if (dialog.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value])));
    };
    dialog.showModal();
    form.querySelector('input')?.select();
  });
}

async function askText(title, label, value = '') {
  const result = await openDialog({ title, fields: [{ name: 'value', label, value, required: true }] });
  return result?.value.trim() || null;
}

async function confirmDanger(title, message, submitLabel = 'Hapus') {
  return (await openDialog({ title, message, submitLabel, danger: true })) !== null;
}

// ---------- Popover menu ----------

let menuEl = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

function showMenu(anchor, items) {
  closeMenu();
  menuEl = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((item) => (item === '-'
      ? h('hr')
      : h('button', { role: 'menuitem', class: item.danger ? 'danger' : null, onclick: () => { closeMenu(); item.run(); } }, item.label))));
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menuEl.offsetWidth, innerWidth - menuEl.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + menuEl.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menuEl.offsetHeight - 4);
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
  menuEl.querySelector('button')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
});

// ---------- Drag and drop ----------

function startDrag(event, payload, el) {
  dragging = payload;
  el.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'copyMove';
  if (payload.url) event.dataTransfer.setData('text/uri-list', payload.url);
  event.dataTransfer.setData('text/plain', payload.url || payload.kind);
  el.addEventListener('dragend', endDrag, { once: true });
}

function endDrag() {
  dragging = null;
  document.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  clearDropMarks();
  if (pendingRender) {
    pendingRender = false;
    render();
  }
}

function clearDropMarks() {
  document.querySelectorAll('.drop-into, .drop-before, .drop-left, .drop-right, .drop-target')
    .forEach((n) => n.classList.remove('drop-into', 'drop-before', 'drop-left', 'drop-right', 'drop-target'));
}

// Internal drags carry a payload; links dragged in from elsewhere become { kind: 'url' }.
function currentDrag(event) {
  if (dragging) return dragging;
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('text/uri-list') ? { kind: 'url' } : null;
}

function droppedUrls(event) {
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && isSavableUrl(s));
}

// Converts a drop of tabs/links into the tab list stored as cards.
function droppedTabs(drag, event) {
  if (drag.kind === 'tab') return drag.tabs;
  if (drag.kind === 'url') return droppedUrls(event).map((url) => ({ url, title: url }));
  return [];
}

async function afterTabsSaved(drag) {
  if (drag.kind === 'tab' && data.settings.closeAfterSave) {
    await chrome.tabs.remove(drag.tabs.map((t) => t.id).filter((id) => id !== thisTab?.id)).catch(() => {});
  }
}

async function dropIntoCollection(drag, event, collectionId, index) {
  if (drag.kind === 'card') {
    await act(runOp({ type: 'card/move', cardId: drag.cardId, toCollectionId: collectionId, index }));
    return;
  }
  const tabs = droppedTabs(drag, event);
  if (!tabs.length) return;
  const result = await act(runOp({ type: 'card/add', collectionId, tabs, index }), 'Tab disimpan');
  if (result.ok) await afterTabsSaved(drag);
}

document.addEventListener('dragover', (e) => {
  // Clear highlights when the pointer is over something that is not a drop target.
  if (!e.defaultPrevented) clearDropMarks();
});
document.addEventListener('drop', () => setTimeout(endDrag));

// ---------- Rendering: sidebar ----------

function activeSpace() {
  return data.spaces.find((s) => s.id === data.activeSpaceId) || data.spaces[0];
}

function clearSearch() {
  if (!query) return;
  query = '';
  $('search').value = '';
  history.replaceState(null, '', location.pathname);
}

function renderSpaces() {
  $('space-list').replaceChildren(...data.spaces.map((space) => {
    const li = h('li', {
      class: space.id === data.activeSpaceId && !query ? 'active' : null,
      title: space.name,
      onclick: () => {
        clearSearch();
        if (space.id === data.activeSpaceId) render();
        else runOp({ type: 'space/activate', spaceId: space.id });
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        spaceMenu(li, space);
      },
    }, h('span', { class: 'name' }, space.name), h('span', { class: 'badge' }, space.collections.length));

    // Drop a collection on a space to move it there.
    li.addEventListener('dragover', (e) => {
      if (currentDrag(e)?.kind !== 'collection') return;
      e.preventDefault();
      clearDropMarks();
      li.classList.add('drop-target');
    });
    li.addEventListener('drop', (e) => {
      const drag = currentDrag(e);
      if (drag?.kind !== 'collection') return;
      e.preventDefault();
      act(runOp({ type: 'collection/move', collectionId: drag.collectionId, toSpaceId: space.id, index: 0 }), `Dipindah ke ${space.name}`);
    });
    return li;
  }));
}

function renderStarred() {
  const starred = data.spaces.flatMap((space) => space.collections.filter((c) => c.starred).map((c) => ({ space, c })));
  $('starred-list').replaceChildren(...(starred.length
    ? starred.map(({ space, c }) => h('li', {
      title: `${c.name} — ${space.name}`,
      onclick: () => {
        clearSearch();
        pendingScroll = c.id;
        if (space.id === data.activeSpaceId) render();
        else runOp({ type: 'space/activate', spaceId: space.id });
      },
    }, h('span', {}, '★'), h('span', { class: 'name' }, c.name)))
    : [h('li', { class: 'empty' }, 'Belum ada koleksi berbintang')]));
}

// ---------- Rendering: collections ----------

function emptyState(title, text) {
  return h('div', { class: 'empty-state' }, h('strong', {}, title), text);
}

function cardView(card, collection, index, searching) {
  const el = h('a', {
    class: 'card',
    href: card.url,
    target: '_blank',
    rel: 'noopener',
    title: `${card.title}\n${card.url}`,
    draggable: searching ? 'false' : 'true',
    dataset: { index: String(index) },
  },
  h('div', { class: 'row' }, h('img', { src: faviconUrl(card.url), alt: '', loading: 'lazy' }), h('span', { class: 'card-title' }, card.title)),
  h('span', { class: 'host' }, hostname(card.url)),
  h('div', { class: 'card-actions' },
    h('button', { title: 'Edit', onclick: (e) => { e.preventDefault(); e.stopPropagation(); editCard(card); } }, '✎'),
    h('button', { title: 'Hapus', onclick: (e) => { e.preventDefault(); e.stopPropagation(); deleteCard(card, collection); } }, '✕')));
  el.addEventListener('dragstart', (e) => startDrag(e, { kind: 'card', cardId: card.id, url: card.url }, el));
  return el;
}

function collectionView(col, { space, cards = col.cards, searching = false }) {
  const collapsed = col.collapsed && !searching;
  const el = h('section', { class: `collection${collapsed ? ' collapsed' : ''}`, id: `c-${col.id}` });

  const head = h('div', { class: 'collection-head', draggable: searching ? null : 'true' },
    h('button', {
      class: 'caret',
      title: collapsed ? 'Bentangkan' : 'Ciutkan',
      hidden: searching,
      onclick: () => runOp({ type: 'collection/update', collectionId: col.id, collapsed: !col.collapsed }),
    }, '▾'),
    h('span', { class: 'title', title: 'Klik dua kali untuk ganti nama', ondblclick: () => renameCollection(col) }, col.name),
    h('span', { class: 'meta' }, `${col.cards.length} tab`),
    searching && h('span', { class: 'space-label' }, space.name),
    h('span', { class: 'spacer' }),
    h('button', {
      class: `star${col.starred ? ' on' : ''}`,
      title: col.starred ? 'Hapus bintang' : 'Beri bintang',
      onclick: () => runOp({ type: 'collection/update', collectionId: col.id, starred: !col.starred }),
    }, col.starred ? '★' : '☆'),
    h('button', { class: 'head-btn', title: 'Buka semua tab di jendela ini', onclick: () => openCollection(col, 'current') }, 'Buka semua'),
    h('button', { class: 'head-btn', title: 'Opsi koleksi', onclick: (e) => collectionMenu(e.currentTarget, col, space) }, '⋯'));

  head.addEventListener('dragstart', (e) => {
    if (e.target === head) startDrag(e, { kind: 'collection', collectionId: col.id }, el);
  });

  const grid = h('div', { class: 'cards' },
    cards.length ? cards.map((card, i) => cardView(card, col, i, searching)) : h('div', { class: 'placeholder' }, 'Seret tab ke sini'));
  el.append(head, grid);

  if (searching) return el;

  // Where in the card list a drop lands: before/after the card under the pointer, else at the end.
  function dropPosition(e) {
    const cardEl = e.target.closest?.('.card');
    if (!cardEl || !grid.contains(cardEl)) return { index: col.cards.length };
    const rect = cardEl.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    return { cardEl, after, index: Number(cardEl.dataset.index) + (after ? 1 : 0) };
  }

  el.addEventListener('dragover', (e) => {
    const drag = currentDrag(e);
    if (!drag) return;
    e.preventDefault();
    clearDropMarks();
    if (drag.kind === 'collection') {
      if (drag.collectionId !== col.id) el.classList.add('drop-before');
      return;
    }
    const pos = dropPosition(e);
    if (pos.cardEl && !collapsed) pos.cardEl.classList.add(pos.after ? 'drop-right' : 'drop-left');
    else el.classList.add('drop-into');
  });

  el.addEventListener('drop', (e) => {
    const drag = currentDrag(e);
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    if (drag.kind === 'collection') {
      if (drag.collectionId !== col.id) {
        runOp({ type: 'collection/move', collectionId: drag.collectionId, toSpaceId: space.id, index: space.collections.indexOf(col) });
      }
      return;
    }
    dropIntoCollection(drag, e, col.id, collapsed ? 0 : dropPosition(e).index);
  });

  return el;
}

function newDropZone(space) {
  const el = h('div', { class: 'new-drop' }, 'Seret tab ke sini untuk membuat koleksi baru');
  el.addEventListener('dragover', (e) => {
    const drag = currentDrag(e);
    if (!drag || drag.kind === 'collection') return;
    e.preventDefault();
    clearDropMarks();
    el.classList.add('drop-into');
  });
  el.addEventListener('drop', async (e) => {
    const drag = currentDrag(e);
    if (!drag || drag.kind === 'collection') return;
    e.preventDefault();
    clearDropMarks();
    const index = space.collections.length;
    if (drag.kind === 'card') {
      const created = await runOp({ type: 'collection/create', spaceId: space.id, name: 'Koleksi baru', index });
      if (created.ok) await act(runOp({ type: 'card/move', cardId: drag.cardId, toCollectionId: created.id, index: 0 }));
      return;
    }
    const tabs = droppedTabs(drag, e);
    if (!tabs.length) return;
    const result = await act(runOp({ type: 'collection/create', spaceId: space.id, name: 'Koleksi baru', tabs, index }), 'Koleksi dibuat');
    if (result.ok) await afterTabsSaved(drag);
  });
  return el;
}

function renderMain() {
  const list = $('collections');
  if (query) {
    const results = search(data, query);
    $('main-title').textContent = `Hasil pencarian “${query}”`;
    $('main-actions').hidden = true;
    list.replaceChildren(...(results.length
      ? results.map((r) => collectionView(r.collection, { space: r.space, cards: r.cards, searching: true }))
      : [emptyState('Tidak ada hasil', 'Coba kata kunci lain.')]));
    return;
  }

  const space = activeSpace();
  $('main-title').textContent = space.name;
  $('main-actions').hidden = false;
  const allCollapsed = space.collections.length > 0 && space.collections.every((c) => c.collapsed);
  $('toggle-collapse').textContent = allCollapsed ? 'Bentangkan semua' : 'Ciutkan semua';
  $('toggle-collapse').hidden = space.collections.length === 0;

  const nodes = space.collections.map((col) => collectionView(col, { space }));
  if (!space.collections.length) {
    nodes.push(emptyState('Belum ada koleksi', 'Seret tab dari panel kanan ke sini, atau klik "Simpan sesi" untuk menyimpan semua tab yang terbuka.'));
  }
  nodes.push(newDropZone(space));
  list.replaceChildren(...nodes);

  if (pendingScroll) {
    $(`c-${pendingScroll}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pendingScroll = null;
  }
}

function render() {
  applyTheme(data.settings.theme);
  const [icon, label] = THEMES[data.settings.theme] || THEMES.auto;
  $('theme-btn').textContent = icon;
  $('theme-btn').title = `Tema: ${label}`;
  $('close-after').checked = data.settings.closeAfterSave;
  renderSpaces();
  renderStarred();
  renderMain();
}

// ---------- Actions ----------

async function renameCollection(col) {
  const name = await askText('Ganti nama koleksi', 'Nama koleksi', col.name);
  if (name) await act(runOp({ type: 'collection/rename', collectionId: col.id, name }));
}

async function editCard(card) {
  const result = await openDialog({
    title: 'Edit tab',
    fields: [
      { name: 'title', label: 'Judul', value: card.title, required: true },
      { name: 'url', label: 'URL', value: card.url, type: 'url', required: true },
    ],
  });
  if (result) await act(runOp({ type: 'card/update', cardId: card.id, title: result.title, url: result.url }));
}

async function deleteCard(card, collection) {
  const index = collection.cards.findIndex((c) => c.id === card.id);
  const result = await act(runOp({ type: 'card/delete', cardId: card.id }));
  if (result.ok) {
    toast('Tab dihapus', {
      label: 'Urungkan',
      run: () => runOp({ type: 'card/add', collectionId: collection.id, tabs: [card], index }),
    });
  }
}

function openCollection(col, mode) {
  return act(send('tm:openCollection', { collectionId: col.id, mode }));
}

function collectionMenu(anchor, col, space) {
  showMenu(anchor, [
    { label: 'Buka di jendela ini', run: () => openCollection(col, 'current') },
    { label: 'Buka di jendela baru', run: () => openCollection(col, 'window') },
    { label: 'Buka sebagai grup tab', run: () => openCollection(col, 'group') },
    '-',
    { label: 'Ganti nama', run: () => renameCollection(col) },
    { label: 'Pindah ke ruang lain…', run: () => moveCollection(col, space) },
    {
      label: 'Hapus tab ganda di koleksi ini',
      run: () => act(runOp({ type: 'collection/dedupe', collectionId: col.id }), (r) => `${r.removed} tab ganda dihapus`),
    },
    {
      label: 'Salin semua URL',
      run: async () => {
        await navigator.clipboard.writeText(col.cards.map((c) => c.url).join('\n'));
        toast('URL disalin');
      },
    },
    '-',
    { label: 'Hapus koleksi', danger: true, run: () => deleteCollection(col) },
  ]);
}

async function moveCollection(col, space) {
  const others = data.spaces.filter((s) => s.id !== space.id);
  if (!others.length) return toast('Buat ruang lain dulu');
  const result = await openDialog({
    title: `Pindahkan “${col.name}”`,
    fields: [{ name: 'spaceId', label: 'Ke ruang', value: others[0].id, options: others.map((s) => ({ value: s.id, label: s.name })) }],
    submitLabel: 'Pindahkan',
  });
  if (result) await act(runOp({ type: 'collection/move', collectionId: col.id, toSpaceId: result.spaceId, index: 0 }), 'Koleksi dipindahkan');
}

async function deleteCollection(col) {
  if (col.cards.length && !(await confirmDanger('Hapus koleksi?', `“${col.name}” berisi ${col.cards.length} tab. Tindakan ini tidak bisa dibatalkan.`))) return;
  await act(runOp({ type: 'collection/delete', collectionId: col.id }), 'Koleksi dihapus');
}

function spaceMenu(anchor, space) {
  showMenu(anchor, [
    {
      label: 'Ganti nama ruang',
      run: async () => {
        const name = await askText('Ganti nama ruang', 'Nama ruang', space.name);
        if (name) await act(runOp({ type: 'space/rename', spaceId: space.id, name }));
      },
    },
    data.spaces.length > 1 && {
      label: 'Hapus ruang',
      danger: true,
      run: async () => {
        const count = space.collections.length;
        const message = count ? `Ruang “${space.name}” dan ${count} koleksi di dalamnya akan dihapus.` : `Hapus ruang “${space.name}”?`;
        if (await confirmDanger('Hapus ruang?', message)) await act(runOp({ type: 'space/delete', spaceId: space.id }), 'Ruang dihapus');
      },
    },
  ]);
}

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
    return toast(`Gagal membaca file: ${err.message}`);
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
  if (choice) await act(runOp({ type: 'import', data: incoming, mode: choice.mode }), 'Data diimpor');
});

async function importBookmarks() {
  // Must be requested directly from the click (user gesture).
  const granted = await chrome.permissions.request({ permissions: ['bookmarks'] });
  if (!granted) return toast('Izin bookmark ditolak');
  const [root] = await chrome.bookmarks.getTree();
  const collections = [];
  (function walk(node, path) {
    const links = (node.children || []).filter((c) => c.url && isSavableUrl(c.url));
    if (links.length) collections.push({ name: path.join(' / ') || 'Bookmark', cards: links.map((l) => ({ url: l.url, title: l.title })) });
    for (const child of node.children || []) if (!child.url) walk(child, child.title ? [...path, child.title] : path);
  })(root, []);
  if (!collections.length) return toast('Tidak ada bookmark');
  await act(runOp({ type: 'import', mode: 'merge', data: { spaces: [{ name: 'Bookmark Chrome', collections }] } }),
    `${collections.length} folder bookmark diimpor ke ruang “Bookmark Chrome”`);
}

// ---------- Open tabs panel ----------

function tabRow(tab) {
  const url = tab.url || tab.pendingUrl || '';
  const savable = isSavableUrl(url);
  const row = h('div', {
    class: `tab-row${tab.active ? ' active' : ''}`,
    draggable: savable ? 'true' : 'false',
    title: `${tab.title}\n${url}`,
    onclick: () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    },
  },
  h('img', { src: faviconUrl(url), alt: '' }),
  h('span', { class: 'tab-title' }, tab.title || url),
  h('button', { class: 'close-tab', title: 'Tutup tab', onclick: (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); } }, '✕'));
  row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'tab', tabs: [{ id: tab.id, url, title: tab.title }], url }, row));
  return row;
}

function saveTabs(tabs, name) {
  return act(send('tm:saveSession', {
    tabIds: tabs.map((t) => t.id),
    name,
    close: data.settings.closeAfterSave,
    keepTabId: thisTab?.id,
  }), (r) => `${r.saved} tab disimpan`);
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
          groupEl = h('div', { class: 'group-block' },
            h('div', { class: 'group-head' },
              h('span', { class: 'dot', style: `background:${GROUP_COLORS[group?.color] || GROUP_COLORS.grey}` }),
              group?.title || 'Grup tanpa nama',
              h('button', { class: 'ghost-btn small', onclick: () => saveTabs(groupTabs, group?.title || 'Grup tab') }, 'Simpan grup')));
          children.push(groupEl);
        }
        groupEl.append(tabRow(tab));
      } else {
        groupId = null;
        children.push(tabRow(tab));
      }
    }
    return h('div', { class: 'window-block' },
      h('div', { class: 'window-head' },
        h('strong', {}, win.id === thisTab?.windowId ? 'Jendela ini' : `Jendela ${i + 1}`),
        `${tabs.length} tab`,
        tabs.length > 0 && h('button', { class: 'ghost-btn small', onclick: () => saveTabs(tabs) }, 'Simpan')),
      children);
  });

  $('open-count').textContent = `(${total})`;
  $('window-list').replaceChildren(...(total ? blocks : [h('p', { class: 'check' }, 'Tidak ada tab lain yang terbuka.')]));
}

for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated']) {
  chrome.tabs[ev].addListener(scheduleTabsRender);
}
chrome.windows.onCreated.addListener(scheduleTabsRender);
chrome.windows.onRemoved.addListener(scheduleTabsRender);
chrome.tabGroups?.onUpdated.addListener(scheduleTabsRender);

// ---------- Static controls ----------

$('search').value = query;
$('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  renderSpaces();
  renderMain();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearSearch();
    render();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing && !dialog.open) {
    e.preventDefault();
    $('search').focus();
  }
});

$('theme-btn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(data.settings.theme) + 1) % order.length];
  runOp({ type: 'settings/update', settings: { theme: next } });
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(data.settings.theme));

$('menu-btn').addEventListener('click', (e) => showMenu(e.currentTarget, [
  { label: 'Ekspor data (JSON)', run: exportData },
  { label: 'Impor data (JSON)…', run: () => $('import-file').click() },
  { label: 'Impor bookmark Chrome', run: importBookmarks },
  '-',
  { label: 'Pintasan keyboard…', run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
]));

$('add-space').addEventListener('click', async () => {
  const name = await askText('Ruang baru', 'Nama ruang');
  if (name) {
    clearSearch();
    await act(runOp({ type: 'space/create', name }));
  }
});

$('add-collection').addEventListener('click', async () => {
  const name = await askText('Koleksi baru', 'Nama koleksi');
  if (name) await act(runOp({ type: 'collection/create', spaceId: activeSpace().id, name, index: 0 }));
});

$('toggle-collapse').addEventListener('click', () => {
  const space = activeSpace();
  const allCollapsed = space.collections.every((c) => c.collapsed);
  runOp({ type: 'collection/setCollapsedAll', spaceId: space.id, collapsed: !allCollapsed });
});

$('space-menu').addEventListener('click', (e) => spaceMenu(e.currentTarget, activeSpace()));

$('main-title').addEventListener('contextmenu', (e) => {
  if (query) return;
  e.preventDefault();
  spaceMenu(e.currentTarget, activeSpace());
});

$('save-session').addEventListener('click', () => act(send('tm:saveSession', {
  windowId: thisTab?.windowId,
  close: data.settings.closeAfterSave,
  keepTabId: thisTab?.id,
}), (r) => `${r.saved} tab disimpan sebagai koleksi baru`));

$('close-after').addEventListener('change', (e) => {
  runOp({ type: 'settings/update', settings: { closeAfterSave: e.target.checked } });
});

$('dedupe').addEventListener('click', () => act(send('tm:closeDuplicates'), (r) => (r.closed ? `${r.closed} tab duplikat ditutup` : 'Tidak ada tab duplikat')));

onDataChanged((next) => {
  data = next;
  if (dragging) pendingRender = true;
  else render();
});

render();
renderTabs();
