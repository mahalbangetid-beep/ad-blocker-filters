// Zone 3: the browser's open tabs per window (groups, duplicates), "Simpan sesi", closing
// duplicates, saving one tab to "Disimpan", dragging tabs out, and the drawer below 1180 px.
import { isSavableUrl, INBOX_NAME } from '../store.js';
import { send, runOp, h } from '../common.js';
import { icon } from '../../../ui/icons.js';
import { animate, motionLevel } from '../../../ui/motion.js';
import { act } from './dialogs.js';
import { favicon, STAGGER_MAX } from './collections.js';
import { startDrag, droppedTabs, closeDroppedTabs } from './drag.js';

const $ = (id) => document.getElementById(id);
const GROUP_COLORS = {
  grey: '#9aa0a6', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};
const dashboardUrl = () => chrome.runtime.getURL('modules/tabs/newtab.html');
const shortUrl = (url) => url.replace(/^[a-z]+:\/\/(www\.)?/i, '');
const tabUrl = (tab) => tab.url || tab.pendingUrl || '';
const isDashboard = (url) => url.startsWith(dashboardUrl());

// getData(): current data; thisTab: the dashboard's own tab; sky: sparks;
// onSaved(collectionId): a new collection was created from open tabs (reveal it).
const ctx = { getData: () => null, thisTab: null, sky: null, onSaved: () => {} };
let rendered = false;

export function setupOpenTabs(options) {
  Object.assign(ctx, options);
  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated']) {
    chrome.tabs[ev].addListener(scheduleTabsRender);
  }
  chrome.windows.onCreated.addListener(scheduleTabsRender);
  chrome.windows.onRemoved.addListener(scheduleTabsRender);
  chrome.tabGroups?.onUpdated.addListener(scheduleTabsRender);

  $('windows').addEventListener('animationend', (e) => {
    if (e.animationName === 'from-right') e.target.classList.remove('enter');
  });
  $('save-session').addEventListener('click', (e) => saveSession(e.currentTarget));
  $('close-after').addEventListener('change', (e) => {
    runOp({ type: 'settings/update', settings: { closeAfterSave: e.target.checked } });
  });
  $('dedupe').addEventListener('click', () => dedupe());
  $('open-drawer').addEventListener('click', openDrawer);
  $('drawer-scrim').addEventListener('click', closeDrawer);
}

export function syncOpenSettings(data) {
  $('close-after').checked = data.settings.closeAfterSave;
}

// ---------- Drawer (< 1180 px) ----------

export function openDrawer() {
  $('tm-open').classList.add('open');
  $('drawer-scrim').classList.add('open');
}
export function closeDrawer() {
  $('tm-open')?.classList.remove('open');
  $('drawer-scrim')?.classList.remove('open');
}
export const drawerOpen = () => $('tm-open')?.classList.contains('open');

// ---------- Ghost: a label flying from where something was saved to where it went ----------

export function flyGhost(from, to, text) {
  if (motionLevel() === 'minimal' || !from?.isConnected || !to) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const g = h('div', { class: 'ghost-fly', 'aria-hidden': 'true' }, text);
  document.body.append(g);
  const x0 = a.left + a.width / 2 - g.offsetWidth / 2;
  const y0 = a.top + a.height / 2 - g.offsetHeight / 2;
  const x1 = b.left + Math.min(160, b.width / 2) - g.offsetWidth / 2;
  const y1 = Math.max(8, b.top + 40);
  animate(g, [
    { transform: `translate(${x0}px,${y0}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${(x0 + x1) / 2}px,${Math.min(y0, y1) - 80}px) scale(1.05)`, opacity: 1, offset: 0.45 },
    { transform: `translate(${x1}px,${y1}px) scale(.5)`, opacity: 0 },
  ], { duration: 900, easing: 'cubic-bezier(.45,0,.2,1)' }).finished
    .then(() => ctx.sky?.burst(x1 + g.offsetWidth / 2, y1 + 14, 18))
    .catch(() => {})
    .finally(() => g.remove());
}

// ---------- Rendering ----------

// Same rule as tm:closeDuplicates: per URL (without #hash) one tab stays, preferably the active or pinned one.
function duplicateIds(tabs) {
  const kept = new Map();
  const dups = new Set();
  for (const tab of tabs) {
    const url = tabUrl(tab);
    if (!url || isDashboard(url)) continue;
    const key = url.replace(/#.*$/, '');
    const other = kept.get(key);
    if (!other) kept.set(key, tab);
    else if ((tab.active || tab.pinned) && !(other.active || other.pinned)) {
      dups.add(other.id);
      kept.set(key, tab);
    } else dups.add(tab.id);
  }
  return dups;
}

function tabRow(tab, { dup, enterIndex }) {
  const url = tabUrl(tab);
  const savable = isSavableUrl(url);
  const row = h('li', {
    class: `orow${tab.active ? ' active' : ''}${dup ? ' dup' : ''}${enterIndex >= 0 ? ' enter' : ''}`,
    dataset: { id: tab.id, window: tab.windowId },
    style: enterIndex >= 0 ? `--j:${enterIndex}` : null,
    draggable: savable ? 'true' : 'false',
    title: `${tab.title}\n${url}`,
    onclick: () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    },
  },
  favicon(url),
  h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, tab.title || url), h('span', { class: 'row-url' }, shortUrl(url))),
  savable && h('button', {
    type: 'button', class: 'icon-btn xs save-one', 'aria-label': `Simpan ke “${INBOX_NAME}”`, title: `Simpan ke “${INBOX_NAME}”`,
    onclick: (e) => { e.stopPropagation(); saveOne(tab, e.currentTarget); },
  }, icon('download')),
  h('button', {
    type: 'button', class: 'icon-btn xs close-tab', 'aria-label': 'Tutup tab', title: 'Tutup tab',
    onclick: (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); },
  }, icon('x')));
  row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'tab', tabs: [{ id: tab.id, url, title: tab.title }], url }, row));
  return row;
}

let tabsTimer;
function scheduleTabsRender() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(renderTabs, 120);
}

export async function renderTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const dups = duplicateIds(windows.flatMap((w) => w.tabs));
  const enter = !rendered;
  rendered = true;
  let total = 0;

  const blocks = windows.map((win, i) => {
    const tabs = win.tabs.filter((t) => !isDashboard(tabUrl(t)));
    const children = [];
    let groupEl = null;
    let groupId = null;
    for (const tab of tabs) {
      const row = tabRow(tab, { dup: dups.has(tab.id), enterIndex: enter && total < STAGGER_MAX ? total : -1 });
      total++;
      if (tab.groupId > -1) {
        if (tab.groupId !== groupId) {
          groupId = tab.groupId;
          const group = groupById.get(groupId);
          const groupTabs = tabs.filter((t) => t.groupId === groupId);
          groupEl = h('ul', { class: 'group-block' },
            h('li', { class: 'group-head' },
              h('span', { class: 'dot', style: `background:${GROUP_COLORS[group?.color] || GROUP_COLORS.grey}` }),
              h('span', { class: 'group-name' }, group?.title || 'Grup tanpa nama'),
              h('button', { type: 'button', class: 'btn ghost sm rp', onclick: (e) => saveTabs(groupTabs, e.currentTarget, group?.title || 'Grup tab') }, 'Simpan grup')));
          children.push(h('li', {}, groupEl));
        }
        groupEl.append(row);
      } else {
        groupId = null;
        children.push(row);
      }
    }
    return tabs.length > 0 && h('section', { class: 'win' },
      h('h4', {}, icon('window'), h('span', {}, win.id === ctx.thisTab?.windowId ? 'Jendela ini' : `Jendela ${i + 1}`),
        h('span', { class: 'faint' }, `${tabs.length} tab`),
        h('button', { type: 'button', class: 'btn ghost sm rp', onclick: (e) => saveTabs(tabs, e.currentTarget) }, 'Simpan')),
      h('ul', {}, children));
  }).filter(Boolean);

  $('open-count').textContent = String(total);
  const dupCount = $('dup-count');
  if (dupCount.textContent !== String(dups.size)) {
    dupCount.textContent = String(dups.size);
    dupCount.hidden = dups.size === 0;
  }
  $('windows').replaceChildren(...(total ? blocks : [h('div', { class: 'empty-mini' }, icon('sparkle'), h('p', {}, 'Semua tab sudah tersimpan rapi.'))]));
}

// ---------- Actions ----------

const closeAfter = () => ctx.getData().settings.closeAfterSave;

function rowsOut(rows, keyframe) {
  const step = motionLevel() === 'minimal' ? 0 : 35;
  return Promise.all(rows.slice(0, STAGGER_MAX).map((r, i) => animate(r, [{ opacity: 1, transform: 'none' }, keyframe],
    { duration: 280, delay: i * step, fill: 'forwards' }).finished.catch(() => {})));
}

async function saveTabs(tabs, source, name) {
  const result = await act(send('tm:saveSession', {
    tabIds: tabs.map((t) => t.id),
    name,
    close: closeAfter(),
    keepTabId: ctx.thisTab?.id,
  }), (r) => `${r.saved} tab disimpan`, 'download');
  if (result?.ok) {
    flyGhost(source, $('cols'), `${result.saved} tab`);
    ctx.onSaved(result.id);
  }
}

// Saves every tab of this window as a new collection ("Tutup tab setelah disimpan" closes them).
export async function saveSession(source = $('save-session')) {
  const windowId = ctx.thisTab?.windowId;
  const close = closeAfter();
  const rows = close ? [...$('windows').querySelectorAll(`.orow[data-window="${windowId}"][draggable="true"]`)] : [];
  if (rows.length) await rowsOut(rows, { opacity: 0, transform: 'translateX(40px)' });
  const result = await act(send('tm:saveSession', { windowId, close, keepTabId: ctx.thisTab?.id }),
    (r) => `${r.saved} tab disimpan sebagai koleksi baru`, 'download');
  if (!result?.ok) return void renderTabs();
  flyGhost(source, $('cols'), `${result.saved} tab`);
  ctx.onSaved(result.id);
}

export async function dedupe() {
  const rows = [...$('windows').querySelectorAll('.orow.dup')];
  if (rows.length) await rowsOut(rows, { opacity: 0, transform: 'scale(.8)', filter: 'blur(4px)' });
  const result = await act(send('tm:closeDuplicates'),
    (r) => (r.closed ? `${r.closed} tab duplikat ditutup` : 'Tidak ada tab duplikat'), 'copy');
  if (!result?.ok) renderTabs();
}

// One tab into "Disimpan" of the active space (created on demand by the service worker).
async function saveOne(tab, button) {
  const data = ctx.getData();
  const space = data.spaces.find((s) => s.id === data.activeSpaceId) || data.spaces[0];
  const inbox = space.collections.find((c) => c.name === INBOX_NAME);
  const target = (inbox && $('cols').querySelector(`.col[data-id="${inbox.id}"]`)) || $('cols');
  flyGhost(button, target, shortUrl(tabUrl(tab)).split('/')[0]);
  const result = await act(send('tm:saveTab', { tab: { url: tabUrl(tab), title: tab.title } }),
    `Disimpan ke “${INBOX_NAME}” di ${space.name}`, 'download');
  if (!result?.ok) return;
  // Unfold "Disimpan" so the new row is seen arriving.
  if (inbox?.collapsed) runOp({ type: 'collection/update', collectionId: inbox.id, collapsed: false });
  if (closeAfter() && tab.id !== ctx.thisTab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
}

// Open tabs or links dropped on a space in the rail go to that space's "Disimpan".
export async function saveDropToSpace(spaceId, drag, event, button) {
  const tabs = droppedTabs(drag, event);
  const space = ctx.getData().spaces.find((s) => s.id === spaceId);
  if (!tabs.length || !space) return;
  const inbox = space.collections.find((c) => c.name === INBOX_NAME);
  const op = inbox
    ? { type: 'card/add', collectionId: inbox.id, tabs, index: 0 }
    : { type: 'collection/create', spaceId, name: INBOX_NAME, tabs, index: 0 };
  const result = await act(runOp(op), `Disimpan ke “${INBOX_NAME}” di ${space.name}`, 'download');
  if (!result?.ok) return;
  ctx.sky?.burstAt(button, 16);
  await closeDroppedTabs(drag, { close: closeAfter(), keepTabId: ctx.thisTab?.id });
}
