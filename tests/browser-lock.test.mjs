// Simulates the Chrome extension APIs in Node and drives background.js through
// the main flows. Run: node --test tests/browser-lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'chrome-extension://testid/';

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    fire: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
  };
}

function area() {
  let data = {};
  return {
    dump: () => data,
    reset: () => { data = {}; },
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}

let nextId = 1;
const tabs = [];
const windows = [{ id: 100, focused: true, incognito: false, type: 'normal' }];

const chrome = {
  runtime: {
    getURL: (p) => BASE + p,
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
  },
  storage: { local: area(), session: area() },
  tabs: {
    onCreated: event(), onUpdated: event(), onActivated: event(), onRemoved: event(),
    async query() { return tabs.map((t) => ({ ...t })); },
    async get(id) {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error('no tab');
      return { ...t };
    },
    async create({ url = 'chrome://newtab/', windowId, active } = {}) {
      const tab = { id: nextId++, url, windowId: windowId ?? windows[0].id, incognito: false, active };
      tabs.push(tab);
      chrome.tabs.onCreated.fire({ ...tab });
      return { ...tab };
    },
    async remove(ids) {
      for (const id of [].concat(ids)) {
        const i = tabs.findIndex((t) => t.id === id);
        if (i < 0) throw new Error('no tab');
        tabs.splice(i, 1);
        chrome.tabs.onRemoved.fire(id, { isWindowClosing: false });
      }
    },
    async update(id) { return chrome.tabs.get(id); },
  },
  windows: {
    async getAll() { return windows.map((w) => ({ ...w })); },
    async create({ url }) {
      const w = { id: nextId++, focused: true, incognito: false, type: 'normal' };
      windows.push(w);
      const tab = await chrome.tabs.create({ url, windowId: w.id });
      return { ...w, tabs: [tab] };
    },
    async update() {},
  },
  idle: { setDetectionInterval() {}, onStateChanged: event() },
  commands: { onCommand: event() },
};
globalThis.chrome = chrome;

const settle = () => new Promise((r) => setTimeout(r, 50));
const LOCK = BASE + 'lock.html';

function send(message) {
  return new Promise((resolve) => {
    for (const fn of chrome.runtime.onMessage.listeners) fn(message, {}, resolve);
  });
}

await import('../browser-lock/background.js');
await settle();

test('install opens setup page', async () => {
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.ok(tabs.some((t) => t.url === BASE + 'setup.html'));
});

test('setup validates and stores only a hash', async () => {
  assert.equal((await send({ type: 'setup', password: 'abc', confirm: 'abc' })).ok, false);
  assert.equal((await send({ type: 'setup', password: 'rahasia1', confirm: 'rahasia2' })).ok, false);
  const ok = await send({ type: 'setup', password: 'rahasia1', confirm: 'rahasia1' });
  assert.equal(ok.ok, true);
  const stored = JSON.stringify(chrome.storage.local.dump());
  assert.ok(!stored.includes('rahasia1'), 'plain password must not be stored');
  // Re-running setup must not overwrite the existing password.
  assert.equal((await send({ type: 'setup', password: 'hacked12', confirm: 'hacked12' })).ok, false);
});

test('browser restart locks and hides existing tabs', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  tabs.push({ id: nextId++, url: 'https://b.com/', windowId: 100, incognito: false });
  chrome.storage.session.reset(); // session storage is empty after a restart

  await chrome.runtime.onStartup.fire();
  await settle();

  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  const { savedTabs } = await chrome.storage.session.get('savedTabs');
  assert.deepEqual(savedTabs, ['https://a.com/', 'https://b.com/']);
  assert.equal((await send({ type: 'getState' })).locked, true);
});

test('new tabs while locked are closed and remembered', async () => {
  await chrome.tabs.create({ url: 'https://c.com/' });
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);

  // Navigating the lock tab elsewhere is also blocked.
  const lockTab = tabs[0];
  lockTab.url = 'chrome://extensions/';
  await chrome.tabs.onUpdated.fire(lockTab.id, { url: lockTab.url }, { ...lockTab });
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
});

test('settings cannot be changed while locked', async () => {
  const r = await send({ type: 'saveSettings', settings: { idleMinutes: 5 } });
  assert.equal(r.ok, false);
  const c = await send({ type: 'changePassword', current: 'rahasia1', password: 'new12345', confirm: 'new12345' });
  assert.equal(c.ok, false);
});

test('wrong passwords are throttled', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await send({ type: 'unlock', password: 'salah' });
    assert.equal(r.error, 'wrong');
  }
  const fifth = await send({ type: 'unlock', password: 'salah' });
  assert.equal(fifth.error, 'lockout');
  assert.ok(fifth.retryAt > Date.now());
  // Even the correct password is refused during the lockout.
  assert.equal((await send({ type: 'unlock', password: 'rahasia1' })).ok, false);
  await chrome.storage.local.set({ lockoutUntil: 0 });
});

test('correct password unlocks and restores tabs', async () => {
  const r = await send({ type: 'unlock', password: 'rahasia1' });
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/', 'https://b.com/', 'https://c.com/']);
  assert.equal((await send({ type: 'getState' })).locked, false);
  assert.equal((await chrome.storage.local.get('failures')).failures, 0);
});

test('lock now, idle and screen lock', async () => {
  await send({ type: 'lock' });
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  await send({ type: 'unlock', password: 'rahasia1' });
  await settle();

  await chrome.idle.onStateChanged.fire('locked'); // lockOnScreenLock defaults to true
  await settle();
  assert.equal((await send({ type: 'getState' })).locked, true);
  await send({ type: 'unlock', password: 'rahasia1' });
  await settle();

  await chrome.idle.onStateChanged.fire('idle'); // idleMinutes defaults to 0 (off)
  await settle();
  assert.equal((await send({ type: 'getState' })).locked, false);
});

test('change and remove password require the current one', async () => {
  const bad = await send({ type: 'changePassword', current: 'salah', password: 'baru1234', confirm: 'baru1234' });
  assert.equal(bad.ok, false);
  const good = await send({ type: 'changePassword', current: 'rahasia1', password: 'baru1234', confirm: 'baru1234' });
  assert.equal(good.ok, true);
  assert.equal((await send({ type: 'removePassword', current: 'rahasia1' })).ok, false);
  assert.equal((await send({ type: 'removePassword', current: 'baru1234' })).ok, true);
  assert.equal((await send({ type: 'getState' })).hasPassword, false);
});
