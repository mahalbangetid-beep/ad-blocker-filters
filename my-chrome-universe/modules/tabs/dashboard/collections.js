// Zone 2: the active space's head and its grid of collections (rows, menus, drag and drop).
// Every data write goes through runOp / tm:* messages; the page re-renders from storage changes.
import { isSavableUrl } from '../store.js';
import { send, runOp, faviconUrl, h } from '../common.js';
import { icon } from '../../../ui/icons.js';
import { animate, motionLevel, toast, wait } from '../../../ui/motion.js';
import { act, askText, confirmDanger, openDialog, showMenu } from './dialogs.js';

const $ = (id) => document.getElementById(id);

// Entrance stagger is capped so a space with hundreds of tabs still opens instantly.
export const STAGGER_MAX = 24;
const PLANETS = ['var(--solar)', 'var(--ion)', 'var(--nova)', '#8FB4FF', '#C6F26B'];
export const planetColor = (index) => PLANETS[index % PLANETS.length];
const STAR_SPARKS = ['#FFB547', '#FFE3A8', '#FFD07A'];

// getData(): current data; thisTab: the dashboard's own tab; sky: star field for sparks.
const ctx = { getData: () => null, thisTab: null, sky: null };

export function setupCollections(options) {
  Object.assign(ctx, options);
  // One-shot entrance classes are dropped once played, so moving a node never replays them.
  $('cols').addEventListener('animationend', (e) => {
    const cls = e.target.classList;
    if (e.animationName === 'depth') cls.remove('enter', 'dz-enter');
    else if (e.animationName === 'row-new') cls.remove('new');
    else if (e.animationName === 'flash') cls.remove('flash');
    else if (e.animationName === 'opening') cls.remove('opening');
  });
}

// ---------- Helpers ----------

const fast = () => motionLevel() === 'minimal';
const tabCount = (space) => space.collections.reduce((n, c) => n + c.cards.length, 0);
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const clip = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const shortUrl = (url) => url.replace(/^[a-z]+:\/\/(www\.)?/i, '');

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function pulse(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function findCollection(collectionId) {
  for (const space of ctx.getData().spaces) {
    const index = space.collections.findIndex((c) => c.id === collectionId);
    if (index >= 0) return { space, collection: space.collections[index], index };
  }
  return null;
}

function findCard(cardId) {
  for (const space of ctx.getData().spaces) {
    for (const collection of space.collections) {
      const index = collection.cards.findIndex((c) => c.id === cardId);
      if (index >= 0) return { space, collection, card: collection.cards[index], index };
    }
  }
  return null;
}

const activeSpace = () => {
  const data = ctx.getData();
  return data.spaces.find((s) => s.id === data.activeSpaceId) || data.spaces[0];
};

const colEl = (collectionId) => $('cols').querySelector(`.col[data-id="${collectionId}"]`);

// Resolves once the collection's element is on screen (data arrives via storage events).
async function whenCol(collectionId, timeoutMs = 1500) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const el = colEl(collectionId);
    if (el) return el;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return null;
}

// Favicon from Chrome's local cache inside a coloured tile; the letter shows if it fails.
export function favicon(url) {
  const name = host(url);
  const img = h('img', { src: faviconUrl(url, 32), alt: '', loading: 'lazy', draggable: 'false', width: '18', height: '18' });
  img.addEventListener('error', () => img.replaceWith((name[0] || '?').toUpperCase()), { once: true });
  return h('span', { class: 'fav', style: `--h:${hue(name)}` }, img);
}

// ---------- Drag and drop ----------

let dragging = null; // { kind: 'tab' | 'card' | 'collection', ... } for drags started on this page
let afterDrag = null;

export const isDragging = () => dragging !== null;
export function onDragEnd(callback) { afterDrag = callback; }

export function startDrag(event, payload, el) {
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
  afterDrag?.();
}

export function clearDropMarks() {
  document.querySelectorAll('.drop-over, .drop-before, .drop-above, .drop-below')
    .forEach((n) => n.classList.remove('drop-over', 'drop-before', 'drop-above', 'drop-below'));
}

// Internal drags carry a payload; links dragged in from elsewhere become { kind: 'url' }.
export function currentDrag(event) {
  if (dragging) return dragging;
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('text/uri-list') ? { kind: 'url' } : null;
}

function droppedTabs(drag, event) {
  if (drag.kind === 'tab') return drag.tabs;
  if (drag.kind !== 'url') return [];
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && isSavableUrl(s)).map((url) => ({ url, title: url }));
}

async function afterTabsSaved(drag) {
  if (drag.kind === 'tab' && ctx.getData().settings.closeAfterSave) {
    await chrome.tabs.remove(drag.tabs.map((t) => t.id).filter((id) => id !== ctx.thisTab?.id)).catch(() => {});
  }
}

async function dropIntoCollection(drag, event, collectionId, index) {
  if (drag.kind === 'card') {
    await act(runOp({ type: 'card/move', cardId: drag.cardId, toCollectionId: collectionId, index }));
    return;
  }
  const tabs = droppedTabs(drag, event);
  if (!tabs.length) return;
  const name = findCollection(collectionId)?.collection.name;
  const result = await act(runOp({ type: 'card/add', collectionId, tabs, index }), name ? `Disimpan ke “${clip(name, 40)}”` : 'Tab disimpan');
  if (result.ok) {
    ctx.sky?.burstAt(colEl(collectionId) || $('cols'), 16);
    await afterTabsSaved(drag);
  }
}

document.addEventListener('dragover', (e) => {
  // Clear highlights when the pointer is over something that is not a drop target.
  if (!e.defaultPrevented) clearDropMarks();
});
document.addEventListener('drop', () => setTimeout(endDrag));

// ---------- Space head ----------

function renderHead(space, enter) {
  const data = ctx.getData();
  $('space-meta').textContent = `${space.collections.length} koleksi · ${tabCount(space)} tab`;
  $('space-title').replaceChildren(
    h('span', { class: 'planet', style: `--pc:${planetColor(data.spaces.indexOf(space))}` }),
    h('span', { class: 'title-text' }, space.name));
  $('main-actions').hidden = false;
  const allCollapsed = space.collections.length > 0 && space.collections.every((c) => c.collapsed);
  $('fold-all').hidden = space.collections.length === 0;
  $('fold-all').querySelector('span').textContent = allCollapsed ? 'Bentangkan semua' : 'Lipat semua';
  if (enter) pulse($('main-head'), 'enter');
}

// ---------- Collections ----------

// Rendered collections are reused while their content is unchanged, so fold/star transitions
// keep running across re-renders and large spaces re-render cheaply.
const rendered = new Map(); // collectionId -> { el, sig }
let shownSpaceId = null;
let knownCols = new Set();
let knownCards = new Map(); // collectionId -> Set of card ids last shown in it
const foldPending = new WeakSet();
let dropZone = null;
let emptyNote = null;

const signature = (col) => JSON.stringify([col.name, col.cards.map((c) => [c.id, c.title, c.url])]);

function syncFlags(el, col, searching = false) {
  const collapsed = col.collapsed && !searching;
  if (!foldPending.has(el)) el.classList.toggle('collapsed', collapsed);
  const fold = el.querySelector('.col-fold');
  fold.setAttribute('aria-expanded', String(!el.classList.contains('collapsed')));
  fold.title = el.classList.contains('collapsed') ? 'Bentangkan' : 'Lipat';
  const star = el.querySelector('.star-btn');
  star.classList.toggle('on', col.starred);
  star.setAttribute('aria-pressed', String(col.starred));
  star.title = col.starred ? 'Hapus bintang' : 'Beri bintang';
}

function rowView(card, flash, searching) {
  const li = h('li', { class: `row${flash.has(card.id) ? ' new' : ''}`, dataset: { id: card.id }, draggable: searching ? null : 'true' },
    h('a', {
      class: 'row-link', href: card.url, target: '_blank', rel: 'noopener', draggable: 'false', title: `${card.title}\n${card.url}`,
      onclick: () => pulse(li, 'opening'),
    }, favicon(card.url), h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, card.title), h('span', { class: 'row-url' }, shortUrl(card.url)))),
    h('button', { type: 'button', class: 'icon-btn xs row-edit', 'aria-label': 'Edit tab', title: 'Edit', onclick: () => editCard(card.id) }, icon('edit')),
    h('button', { type: 'button', class: 'icon-btn xs row-x', 'aria-label': 'Hapus tab dari koleksi', title: 'Hapus', onclick: () => deleteCard(card.id, li) }, icon('x')));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && !e.target.closest('button')) deleteCard(card.id, li);
  });
  if (!searching) li.addEventListener('dragstart', (e) => startDrag(e, { kind: 'card', cardId: card.id, url: card.url }, li));
  return li;
}

// searchSpace: set when the collection is shown as a search result (no dragging, never folded).
function colView(col, { cards = col.cards, flash = new Set(), searchSpace = null } = {}) {
  const searching = Boolean(searchSpace);
  const id = col.id;
  const head = h('header', { class: 'col-head', draggable: searching ? null : 'true' },
    h('button', { type: 'button', class: 'icon-btn sm col-fold', 'aria-label': 'Lipat atau buka koleksi', hidden: searching, onclick: () => toggleFold(id) }, icon('chevronDown')),
    h('h3', { class: 'col-name', title: 'Klik dua kali untuk ganti nama', ondblclick: () => startRename(id) }, col.name),
    h('span', { class: 'pill' }, col.cards.length),
    searching && h('span', { class: 'col-space', title: searchSpace.name }, searchSpace.name),
    h('div', { class: 'col-actions' },
      h('button', { type: 'button', class: 'icon-btn sm star-btn', 'aria-label': 'Bintangi koleksi', onclick: (e) => toggleStar(id, e.currentTarget) }, icon('star')),
      h('button', { type: 'button', class: 'icon-btn sm open-all', 'aria-label': 'Buka semua tab', title: 'Buka semua di jendela ini', onclick: () => openAll(id) }, icon('external')),
      h('button', { type: 'button', class: 'icon-btn sm col-more', 'aria-label': 'Opsi koleksi', title: 'Opsi', 'aria-haspopup': 'menu', onclick: (e) => collectionMenu(e.currentTarget, id) }, icon('more'))));
  const body = h('div', {}, cards.length
    ? h('ul', { class: 'rows' }, cards.map((card) => rowView(card, flash, searching)))
    : h('p', { class: 'col-empty' }, 'Koleksi kosong. Tarik tab ke sini.'));
  const el = h('article', { class: 'col glow', dataset: { id } }, head, h('div', { class: 'col-body' }, body));
  syncFlags(el, col, searching);
  if (searching) return el;

  head.addEventListener('dragstart', (e) => {
    if (e.target === head) startDrag(e, { kind: 'collection', collectionId: id }, el);
  });

  // Where a drop lands: above/below the row under the pointer, else at the end (start when folded).
  const dropPosition = (e) => {
    const found = findCollection(id);
    const count = found?.collection.cards.length ?? 0;
    if (el.classList.contains('collapsed')) return { index: 0 };
    const row = e.target.closest?.('.row');
    if (!row || !el.contains(row)) return { index: count };
    const at = found.collection.cards.findIndex((c) => c.id === row.dataset.id);
    const rect = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    return { row, after, index: (at < 0 ? count : at) + (after ? 1 : 0) };
  };

  el.addEventListener('dragover', (e) => {
    const drag = currentDrag(e);
    if (!drag) return;
    e.preventDefault();
    clearDropMarks();
    if (drag.kind === 'collection') {
      if (drag.collectionId !== id) el.classList.add('drop-before');
      return;
    }
    const pos = dropPosition(e);
    if (pos.row) pos.row.classList.add(pos.after ? 'drop-below' : 'drop-above');
    else el.classList.add('drop-over');
  });

  el.addEventListener('drop', (e) => {
    const drag = currentDrag(e);
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    if (drag.kind === 'collection') {
      const target = findCollection(id);
      if (drag.collectionId !== id && target) {
        runOp({ type: 'collection/move', collectionId: drag.collectionId, toSpaceId: target.space.id, index: target.index });
      }
      return;
    }
    dropIntoCollection(drag, e, id, dropPosition(e).index);
  });
  return el;
}

function newDropZone() {
  const el = h('div', { class: 'new-drop' }, h('div', {}, icon('plus'), 'Tarik tab ke sini untuk membuat koleksi baru'));
  el.addEventListener('dragover', (e) => {
    const drag = currentDrag(e);
    if (!drag || drag.kind === 'collection') return;
    e.preventDefault();
    clearDropMarks();
    el.classList.add('drop-over');
  });
  el.addEventListener('drop', async (e) => {
    const drag = currentDrag(e);
    if (!drag || drag.kind === 'collection') return;
    e.preventDefault();
    clearDropMarks();
    const space = activeSpace();
    const index = space.collections.length;
    if (drag.kind === 'card') {
      const created = await runOp({ type: 'collection/create', spaceId: space.id, name: 'Koleksi baru', index });
      if (created?.ok) await act(runOp({ type: 'card/move', cardId: drag.cardId, toCollectionId: created.id, index: 0 }), 'Koleksi baru dibuat');
      return;
    }
    const tabs = droppedTabs(drag, e);
    if (!tabs.length) return;
    const result = await act(runOp({ type: 'collection/create', spaceId: space.id, name: 'Koleksi baru', tabs, index }), 'Koleksi baru dibuat');
    if (result.ok) await afterTabsSaved(drag);
  });
  return el;
}

// Puts `nodes` into `parent` in order, moving only what is out of place.
function place(parent, nodes) {
  let ref = parent.firstChild;
  for (const node of nodes) {
    if (node === ref) {
      ref = ref.nextSibling;
      continue;
    }
    parent.insertBefore(node, ref);
  }
  while (ref) {
    const next = ref.nextSibling;
    ref.remove();
    ref = next;
  }
}

// Renders `space` into #cols. enter: play the staggered entrance (first STAGGER_MAX only);
// otherwise new collections animate in and rows that just arrived flash.
export function renderCollections(space, { enter = false, flashId = null } = {}) {
  renderHead(space, enter);
  const same = !enter && space.id === shownSpaceId;
  if (!same) rendered.clear();
  const nodes = [];
  const seen = new Set();
  let entering = 0;
  space.collections.forEach((col, i) => {
    const sig = signature(col);
    let entry = rendered.get(col.id);
    if (!entry || entry.sig !== sig) {
      const isNew = !knownCols.has(col.id);
      const known = knownCards.get(col.id);
      const flash = new Set(same && !isNew && known ? col.cards.filter((c) => !known.has(c.id)).map((c) => c.id) : []);
      if (flashId) flash.add(flashId);
      entry = { el: colView(col, { flash }), sig };
      rendered.set(col.id, entry);
      if ((enter || (same && isNew)) && entering < STAGGER_MAX) {
        entry.el.classList.add('enter');
        entry.el.style.setProperty('--i', String(enter ? i : 0));
        entering++;
      }
    }
    syncFlags(entry.el, col);
    nodes.push(entry.el);
    seen.add(col.id);
  });
  for (const id of rendered.keys()) if (!seen.has(id)) rendered.delete(id);

  if (!space.collections.length) {
    emptyNote ||= h('div', { class: 'empty-space' }, h('strong', {}, 'Belum ada koleksi'),
      'Tarik tab dari panel “Tab terbuka” ke sini, atau klik “Simpan sesi” untuk menyimpan semua tab yang terbuka.');
    nodes.push(emptyNote);
  }
  dropZone ||= newDropZone();
  if (enter && space.collections.length < STAGGER_MAX) {
    dropZone.style.setProperty('--i', String(space.collections.length));
    pulse(dropZone, 'dz-enter');
  }
  nodes.push(dropZone);
  place($('cols'), nodes);

  knownCols = seen;
  knownCards = new Map(space.collections.map((c) => [c.id, new Set(c.cards.map((card) => card.id))]));
  shownSpaceId = space.id;
}

// Search results: matching cards of every space, grouped by collection.
export function renderSearch(results, query) {
  shownSpaceId = null;
  rendered.clear();
  knownCols = new Set();
  $('space-meta').textContent = `${results.length} koleksi cocok`;
  $('space-title').replaceChildren(icon('search'), h('span', { class: 'title-text' }, `Hasil pencarian “${query}”`));
  $('main-actions').hidden = true;
  $('cols').replaceChildren(...(results.length
    ? results.map((r) => colView(r.collection, { cards: r.cards, searchSpace: r.space }))
    : [h('div', { class: 'empty-space' }, h('strong', {}, 'Tidak ada hasil'), 'Coba kata kunci lain.')]));
}

// Space switch: the old content slides away, the new one enters from depth.
export async function showSpace(space, { dir = 1 } = {}) {
  const content = $('tm-content');
  const out = animate(content, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-18 * dir}px)`, filter: 'blur(4px)' }],
    { duration: 220, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
  await out.finished.catch(() => {});
  renderCollections(space, { enter: true });
  out.cancel();
  $('tm-main').scrollTop = 0;
}

export function revealCollection(collectionId) {
  const el = colEl(collectionId);
  if (!el) return;
  el.scrollIntoView({ behavior: fast() ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('enter');
  pulse(el, 'flash');
}

// ---------- Collection actions ----------

function toggleFold(collectionId) {
  const found = findCollection(collectionId);
  const el = colEl(collectionId);
  if (!found || !el) return;
  const collapsed = !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', collapsed);
  el.querySelector('.col-fold').setAttribute('aria-expanded', String(!collapsed));
  runOp({ type: 'collection/update', collectionId, collapsed });
}

export function foldAll() {
  const space = activeSpace();
  const fold = space.collections.some((c) => !c.collapsed);
  space.collections.forEach((c, i) => {
    const el = colEl(c.id);
    if (!el) return;
    if (fast() || i >= STAGGER_MAX) return void el.classList.toggle('collapsed', fold);
    foldPending.add(el);
    setTimeout(() => {
      foldPending.delete(el);
      el.classList.toggle('collapsed', fold);
    }, i * 60);
  });
  $('fold-all').querySelector('span').textContent = fold ? 'Bentangkan semua' : 'Lipat semua';
  runOp({ type: 'collection/setCollapsedAll', spaceId: space.id, collapsed: fold });
}

function toggleStar(collectionId, button) {
  const found = findCollection(collectionId);
  if (!found) return;
  const starred = !found.collection.starred;
  button.classList.toggle('on', starred);
  if (starred) {
    ctx.sky?.burstAt(button, 26, STAR_SPARKS);
    toast(`“${clip(found.collection.name, 40)}” dibintangi`, { icon: 'star' });
  }
  runOp({ type: 'collection/update', collectionId, starred });
}

async function openCollection(collectionId, mode) {
  const found = findCollection(collectionId);
  if (!found) return;
  const el = colEl(collectionId);
  if (el && !el.classList.contains('collapsed')) {
    [...el.querySelectorAll('.row')].slice(0, STAGGER_MAX).forEach((row, i) => setTimeout(() => pulse(row, 'opening'), fast() ? 0 : i * 90));
  }
  const where = { current: '', window: ' di jendela baru', group: ' sebagai grup tab' }[mode];
  await act(send('tm:openCollection', { collectionId, mode }),
    `Membuka ${found.collection.cards.length} tab dari “${clip(found.collection.name, 40)}”${where}`, 'external');
}

const openAll = (collectionId) => openCollection(collectionId, 'current');

export function startRename(collectionId) {
  const name = colEl(collectionId)?.querySelector('.col-name');
  const found = findCollection(collectionId);
  if (!name || !found || name.isContentEditable) return;
  const original = found.collection.name;
  name.contentEditable = 'true';
  name.focus();
  const range = document.createRange();
  range.selectNodeContents(name);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  const done = (save) => {
    name.removeEventListener('keydown', onKey);
    name.removeEventListener('blur', onBlur);
    const next = name.textContent.replace(/\s+/g, ' ').trim();
    name.contentEditable = 'false';
    name.textContent = original;
    if (save && next && next !== original) act(runOp({ type: 'collection/rename', collectionId, name: next }));
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
  };
  const onBlur = () => done(true);
  name.addEventListener('keydown', onKey);
  name.addEventListener('blur', onBlur);
}

export async function addCollection() {
  const result = await act(runOp({ type: 'collection/create', spaceId: activeSpace().id, name: 'Koleksi baru', index: 0 }));
  if (!result?.ok) return;
  const el = await whenCol(result.id);
  if (!el) return;
  $('tm-main').scrollTo({ top: 0, behavior: fast() ? 'auto' : 'smooth' });
  await wait(400);
  startRename(result.id);
}

async function moveCollection(collectionId) {
  const found = findCollection(collectionId);
  if (!found) return;
  const others = ctx.getData().spaces.filter((s) => s.id !== found.space.id);
  if (!others.length) return toast('Buat ruang lain dulu', { icon: 'info' });
  const result = await openDialog({
    title: `Pindahkan “${clip(found.collection.name, 40)}”`,
    fields: [{ name: 'spaceId', label: 'Ke ruang', value: others[0].id, options: others.map((s) => ({ value: s.id, label: s.name })) }],
    submitLabel: 'Pindahkan',
  });
  if (result) await act(runOp({ type: 'collection/move', collectionId, toSpaceId: result.spaceId, index: 0 }), 'Koleksi dipindahkan');
}

async function copyUrls(collectionId) {
  const found = findCollection(collectionId);
  if (!found) return;
  await navigator.clipboard.writeText(found.collection.cards.map((c) => c.url).join('\n'));
  toast('URL disalin', { icon: 'copy' });
}

// Deleting is undoable from the toast: the collection is recreated in place with its tabs.
async function deleteCollection(collectionId) {
  const found = findCollection(collectionId);
  if (!found) return;
  const { space, collection, index } = found;
  const el = colEl(collectionId);
  const out = el && animate(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.88)', filter: 'blur(8px)' }],
    { duration: 340, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
  await out?.finished.catch(() => {});
  const result = await act(runOp({ type: 'collection/delete', collectionId }));
  if (!result?.ok) return void out?.cancel();
  toast(`Koleksi “${clip(collection.name, 40)}” dihapus`, {
    icon: 'trash',
    action: {
      label: 'Urungkan',
      run: async () => {
        const restored = await act(runOp({
          type: 'collection/create', spaceId: space.id, name: collection.name, index,
          tabs: collection.cards.map((c) => ({ url: c.url, title: c.title })),
        }));
        if (restored?.ok && (collection.starred || collection.collapsed)) {
          await runOp({ type: 'collection/update', collectionId: restored.id, starred: collection.starred, collapsed: collection.collapsed });
        }
      },
    },
  });
}

function collectionMenu(anchor, collectionId) {
  showMenu(anchor, [
    { ic: 'external', label: 'Buka di jendela ini', run: () => openCollection(collectionId, 'current') },
    { ic: 'window', label: 'Buka di jendela baru', run: () => openCollection(collectionId, 'window') },
    { ic: 'group', label: 'Buka sebagai grup tab', run: () => openCollection(collectionId, 'group') },
    '-',
    { ic: 'edit', label: 'Ganti nama', run: () => startRename(collectionId) },
    { ic: 'folder', label: 'Pindah ke ruang lain…', run: () => moveCollection(collectionId) },
    {
      ic: 'copy',
      label: 'Hapus tab ganda di koleksi ini',
      run: () => act(runOp({ type: 'collection/dedupe', collectionId }), (r) => (r.removed ? `${r.removed} tab ganda dihapus` : 'Tidak ada tab ganda')),
    },
    { ic: 'link', label: 'Salin semua URL', run: () => copyUrls(collectionId) },
    '-',
    { ic: 'trash', label: 'Hapus koleksi', danger: true, run: () => deleteCollection(collectionId) },
  ]);
}

// ---------- Card actions ----------

async function editCard(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const result = await openDialog({
    title: 'Edit tab',
    fields: [
      { name: 'title', label: 'Judul', value: found.card.title, required: true },
      { name: 'url', label: 'URL', value: found.card.url, type: 'url', required: true },
    ],
  });
  if (result) await act(runOp({ type: 'card/update', cardId, title: result.title, url: result.url }));
}

async function deleteCard(cardId, li) {
  const found = findCard(cardId);
  if (!found) return;
  const { collection, card, index } = found;
  const out = li && animate(li, [
    { opacity: 1, transform: 'none', height: `${li.offsetHeight}px` },
    { opacity: 0, transform: 'translateX(30px)', height: '0px', paddingTop: '0px', paddingBottom: '0px' },
  ], { duration: 320, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
  await out?.finished.catch(() => {});
  const result = await act(runOp({ type: 'card/delete', cardId }));
  if (!result?.ok) return void out?.cancel();
  toast(`“${clip(card.title)}” dihapus`, {
    icon: 'trash',
    action: { label: 'Urungkan', run: () => act(runOp({ type: 'card/add', collectionId: collection.id, tabs: [{ url: card.url, title: card.title }], index })) },
  });
}

// ---------- Space menu ----------

export function spaceMenu(anchor, spaceId) {
  const data = ctx.getData();
  const space = data.spaces.find((s) => s.id === spaceId);
  if (!space) return;
  showMenu(anchor, [
    {
      ic: 'edit',
      label: 'Ganti nama ruang',
      run: async () => {
        const name = await askText('Ganti nama ruang', 'Nama ruang', space.name);
        if (name) await act(runOp({ type: 'space/rename', spaceId, name }));
      },
    },
    data.spaces.length > 1 && {
      ic: 'trash',
      label: 'Hapus ruang',
      danger: true,
      run: async () => {
        const count = space.collections.length;
        const message = count ? `Ruang “${space.name}” dan ${count} koleksi di dalamnya akan dihapus.` : `Hapus ruang “${space.name}”?`;
        if (await confirmDanger('Hapus ruang?', message)) await act(runOp({ type: 'space/delete', spaceId }), 'Ruang dihapus', 'trash');
      },
    },
  ]);
}
