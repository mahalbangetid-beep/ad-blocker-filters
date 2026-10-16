// Tests for tab-manager: pure store operations plus background.js driven
// through a simulated chrome.* API. Run: node --test tests/tab-manager.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, normalize, applyOp, search, STORAGE_KEY } from '../tab-manager/store.js';

// ---------- store.js ----------

function fixture() {
  const data = emptyData();
  const { id: a } = applyOp(data, { type: 'collection/create', name: 'A', tabs: [{ url: 'https://a1.com/', title: 'A1' }, { url: 'https://a2.com/', title: 'A2' }] });
  const { id: b } = applyOp(data, { type: 'collection/create', name: 'B', tabs: [{ url: 'https://b1.com/', title: 'B1' }], index: 1 });
  return { data, a, b, space: data.spaces[0] };
}

test('collection/create skips unsavable URLs', () => {
  const data = emptyData();
  const r = applyOp(data, { type: 'collection/create', tabs: [{ url: 'chrome://newtab/' }, { url: 'https://x.com/', title: 'X' }] });
  assert.equal(r.saved, 1);
  assert.equal(data.spaces[0].collections[0].cards[0].url, 'https://x.com/');
});

test('card/move within and across collections', () => {
  const { data, a, b, space } = fixture();
  const [a1, a2] = space.collections.find((c) => c.id === a).cards;
  // Move A1 after A2 inside A (index 2 = end, adjusted for removal).
  applyOp(data, { type: 'card/move', cardId: a1.id, toCollectionId: a, index: 2 });
  assert.deepEqual(space.collections.find((c) => c.id === a).cards.map((c) => c.title), ['A2', 'A1']);
  // Move A2 to the front of B.
  applyOp(data, { type: 'card/move', cardId: a2.id, toCollectionId: b, index: 0 });
  assert.deepEqual(space.collections.find((c) => c.id === b).cards.map((c) => c.title), ['A2', 'B1']);
});

test('collection/move reorders and moves between spaces', () => {
  const { data, a, b, space } = fixture();
  assert.deepEqual(space.collections.map((c) => c.name), ['A', 'B']);
  applyOp(data, { type: 'collection/move', collectionId: a, toSpaceId: space.id, index: 2 });
  assert.deepEqual(space.collections.map((c) => c.name), ['B', 'A']);
  const { id: other } = applyOp(data, { type: 'space/create', name: 'Kerja' });
  applyOp(data, { type: 'collection/move', collectionId: b, toSpaceId: other, index: 0 });
  assert.deepEqual(space.collections.map((c) => c.name), ['A']);
  assert.equal(data.spaces[1].collections[0].name, 'B');
});

test('space/delete keeps at least one space and fixes the active space', () => {
  const data = emptyData();
  assert.throws(() => applyOp(data, { type: 'space/delete', spaceId: data.spaces[0].id }));
  const { id } = applyOp(data, { type: 'space/create', name: 'Dua' });
  assert.equal(data.activeSpaceId, id);
  applyOp(data, { type: 'space/delete', spaceId: id });
  assert.equal(data.activeSpaceId, data.spaces[0].id);
});

test('dedupe, search and card/update validation', () => {
  const { data, a } = fixture();
  applyOp(data, { type: 'card/add', collectionId: a, tabs: [{ url: 'https://a1.com/', title: 'again' }] });
  assert.equal(applyOp(data, { type: 'collection/dedupe', collectionId: a }).removed, 1);
  assert.deepEqual(search(data, 'b1').map((r) => r.collection.name), ['B']);
  assert.equal(search(data, 'a').find((r) => r.collection.name === 'A').cards.length, 2); // name match keeps all cards
  const card = data.spaces[0].collections[0].cards[0];
  assert.throws(() => applyOp(data, { type: 'card/update', cardId: card.id, url: 'javascript:alert(1)' }));
});

test('import merge gives fresh ids; normalize repairs bad data', () => {
  const { data } = fixture();
  const copy = structuredClone(data);
  applyOp(data, { type: 'import', data: copy, mode: 'merge' });
  assert.equal(data.spaces.length, 2);
  assert.notEqual(data.spaces[1].collections[0].id, data.spaces[0].collections[0].id);
  const fixed = normalize({ spaces: [{ collections: [{ cards: [{ url: 'https://z.com/' }, { nope: 1 }] }] }] });
  assert.equal(fixed.spaces[0].collections[0].cards.length, 1);
  assert.equal(fixed.activeSpaceId, fixed.spaces[0].id);
  assert.equal(normalize(null).spaces.length, 1);
});

// ---------- background.js with a simulated chrome API ----------

const BASE = 'chrome-extension://tm/';

function event() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), fire: (...a) => Promise.all(listeners.map((fn) => fn(...a))) };
}

let nextId = 1;
const tabs = [];
const groups = [];
let store = {};
const omniboxSuggestions = [];

const chrome = {
  runtime: { getURL: (p) => BASE + p.replace(/^\//, ''), onMessage: event(), onInstalled: event() },
  storage: {
    local: {
      async get(key) { return key in store ? { [key]: structuredClone(store[key]) } : {}; },
      async set(obj) { Object.assign(store, structuredClone(obj)); },
    },
  },
  tabs: {
    async query(q = {}) {
      return tabs.filter((t) => (q.windowId ? t.windowId === q.windowId : q.currentWindow ? t.windowId === 1 : true)).map((t) => ({ ...t }));
    },
    async create({ url = 'chrome://newtab/', windowId = 1, active = true } = {}) {
      const tab = { id: nextId++, url, title: url, windowId, active, pinned: false };
      tabs.push(tab);
      return { ...tab };
    },
    async remove(ids) {
      for (const id of [].concat(ids)) {
        const i = tabs.findIndex((t) => t.id === id);
        if (i >= 0) tabs.splice(i, 1);
      }
    },
    async update() {},
    async group({ tabIds }) { groups.push(tabIds); return 77; },
  },
  tabGroups: { async update(id, props) { groups.push(props); } },
  windows: {
    async create({ url }) {
      const windowId = 900 + nextId;
      const created = [];
      for (const u of url) created.push(await chrome.tabs.create({ url: u, windowId }));
      return { id: windowId, tabs: created };
    },
  },
  contextMenus: { removeAll: (cb) => cb?.(), create() {}, onClicked: event() },
  commands: { onCommand: event() },
  omnibox: { setDefaultSuggestion() {}, onInputChanged: event(), onInputEntered: event() },
};
globalThis.chrome = chrome;

function send(message) {
  return new Promise((resolve) => {
    for (const fn of chrome.runtime.onMessage.listeners) fn(message, {}, resolve);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const urls = () => tabs.map((t) => t.url);
const collections = () => store[STORAGE_KEY].spaces[0].collections;

await import('../tab-manager/background.js');

test('save session keeps tabs open by default', async () => {
  tabs.push({ id: nextId++, url: 'https://one.com/', title: 'One', windowId: 1, pinned: false });
  tabs.push({ id: nextId++, url: 'https://two.com/', title: 'Two', windowId: 1, pinned: true });
  tabs.push({ id: nextId++, url: 'chrome://settings/', title: 'Settings', windowId: 1, pinned: false });
  const r = await send({ type: 'tm:saveSession', windowId: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.saved, 2);
  assert.equal(collections()[0].cards.length, 2);
  assert.match(collections()[0].name, /^Sesi /);
  assert.equal(tabs.length, 3);
});

test('save session with close keeps pinned tabs and the dashboard', async () => {
  const dash = await chrome.tabs.create({ url: BASE + 'newtab.html' });
  const r = await send({ type: 'tm:saveSession', windowId: 1, close: true, keepTabId: dash.id, name: 'Riset' });
  assert.equal(r.ok, true);
  assert.equal(collections()[0].name, 'Riset');
  assert.deepEqual(urls(), ['https://two.com/', 'chrome://settings/', BASE + 'newtab.html']);
});

test('closing every tab leaves a dashboard so the window survives', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://solo.com/', title: 'Solo', windowId: 5, pinned: false });
  await send({ type: 'tm:saveSession', windowId: 5, close: true });
  assert.deepEqual(urls(), [BASE + 'newtab.html']);
});

test('saving with nothing savable reports an error', async () => {
  const r = await send({ type: 'tm:saveSession', windowId: 5 });
  assert.equal(r.ok, false);
});

test('open collection in current window, new window and as a tab group', async () => {
  const col = collections().find((c) => c.name === 'Riset');
  tabs.length = 0;
  assert.equal((await send({ type: 'tm:openCollection', collectionId: col.id, mode: 'current' })).opened, 2);
  assert.deepEqual(urls(), ['https://one.com/', 'https://two.com/']);
  await send({ type: 'tm:openCollection', collectionId: col.id, mode: 'window' });
  assert.equal(tabs.length, 4);
  await send({ type: 'tm:openCollection', collectionId: col.id, mode: 'group' });
  assert.deepEqual(groups.at(-1), { title: 'Riset' });
});

test('close duplicate tabs keeps the active one', async () => {
  tabs.length = 0;
  tabs.push({ id: 501, url: 'https://dup.com/#a', windowId: 1, active: false });
  tabs.push({ id: 502, url: 'https://dup.com/', windowId: 1, active: true });
  tabs.push({ id: 503, url: 'https://other.com/', windowId: 1, active: false });
  const r = await send({ type: 'tm:closeDuplicates' });
  assert.equal(r.closed, 1);
  assert.deepEqual(tabs.map((t) => t.id), [502, 503]);
});

test('save tab goes to the inbox collection, created once', async () => {
  await send({ type: 'tm:saveTab', tab: { url: 'https://inbox1.com/', title: 'I1' } });
  await send({ type: 'tm:saveTab', tab: { url: 'https://inbox2.com/', title: 'I2' } });
  const inbox = collections().filter((c) => c.name === 'Disimpan');
  assert.equal(inbox.length, 1);
  assert.deepEqual(inbox[0].cards.map((c) => c.title), ['I2', 'I1']);
  assert.equal((await send({ type: 'tm:saveTab', tab: { url: 'chrome://history/' } })).ok, false);
});

test('concurrent operations are serialized (no lost writes)', async () => {
  const { id } = await send({ type: 'tm:op', op: { type: 'collection/create', name: 'Paralel' } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => send({
    type: 'tm:op',
    op: { type: 'card/add', collectionId: id, tabs: [{ url: `https://p${i}.com/` }] },
  })));
  assert.equal(collections().find((c) => c.id === id).cards.length, 20);
});

test('omnibox suggests saved tabs and escapes XML', async () => {
  await send({ type: 'tm:op', op: { type: 'collection/create', name: 'Docs', tabs: [{ url: 'https://mdn.dev/', title: 'MDN <Web> & Docs' }] } });
  await chrome.omnibox.onInputChanged.fire('mdn', (s) => omniboxSuggestions.push(...s));
  assert.equal(omniboxSuggestions[0].content, 'https://mdn.dev/');
  assert.match(omniboxSuggestions[0].description, /MDN &lt;Web&gt; &amp; Docs/);
});

test('context menu and shortcut save the session', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://menu.com/', title: 'Menu', windowId: 1, pinned: false });
  const before = collections().length;
  await chrome.contextMenus.onClicked.fire({ menuItemId: 'tm-save-session' }, { windowId: 1 });
  await chrome.commands.onCommand.fire('save-session', { windowId: 1 });
  await settle();
  assert.equal(collections().length, before + 2);
});
