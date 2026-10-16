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
const LOCK = BASE + 'modules/lock/lock.html';
const NEWTAB = 'chrome://newtab/';

function send(message) {
  return new Promise((resolve) => {
    for (const fn of chrome.runtime.onMessage.listeners) fn(message, {}, resolve);
  });
}

const { setModuleState, isModuleEnabled } = await import('../my-chrome-universe/core/modules.js');
const { lockStatus } = await import('../my-chrome-universe/core/gate.js');
await import('../my-chrome-universe/modules/lock/background.js');
await settle();

test('install opens setup page', async () => {
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.ok(tabs.some((t) => t.url === BASE + 'modules/lock/setup.html'));
  assert.equal((await send({ type: 'lock:getState' })).status, 'setup');
});

test('lock cannot be disabled before a password exists', async () => {
  assert.equal((await send({ type: 'lock:setEnabled', enabled: false })).ok, false);
  assert.equal((await send({ type: 'lock:setEnabled', enabled: false, current: '' })).ok, false);
  assert.equal(await isModuleEnabled('lock'), true);
  assert.equal((await send({ type: 'lock:lock' })).ok, false);
});

test('setup validates and stores only a hash', async () => {
  assert.equal((await send({ type: 'lock:setup', password: 'abc', confirm: 'abc' })).ok, false);
  assert.equal((await send({ type: 'lock:setup', password: 'rahasia1', confirm: 'rahasia2' })).ok, false);
  const ok = await send({ type: 'lock:setup', password: 'rahasia1', confirm: 'rahasia1' });
  assert.equal(ok.ok, true);
  const local = chrome.storage.local.dump();
  assert.ok(local['lock:auth'], 'password record is stored under lock:auth');
  assert.ok(!JSON.stringify(local).includes('rahasia1'), 'plain password must not be stored');
  assert.equal((await send({ type: 'lock:getState' })).status, 'open');
  // Re-running setup must not overwrite the existing password.
  assert.equal((await send({ type: 'lock:setup', password: 'hacked12', confirm: 'hacked12' })).ok, false);
});

test('browser restart locks and hides existing tabs', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  tabs.push({ id: nextId++, url: 'https://b.com/', windowId: 100, incognito: false });
  chrome.storage.session.reset(); // session storage is empty after a restart

  await chrome.runtime.onStartup.fire();
  await settle();

  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  const { 'lock:savedTabs': savedTabs } = await chrome.storage.session.get('lock:savedTabs');
  assert.deepEqual(savedTabs, ['https://a.com/', 'https://b.com/']);
  const state = await send({ type: 'lock:getState' });
  assert.equal(state.locked, true);
  assert.equal(state.status, 'locked');
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
  const r = await send({ type: 'lock:saveSettings', settings: { idleMinutes: 5 } });
  assert.equal(r.ok, false);
  const c = await send({ type: 'lock:changePassword', current: 'rahasia1', password: 'new12345', confirm: 'new12345' });
  assert.equal(c.ok, false);
});

test('messages other than the lock screen ones are refused while locked', async () => {
  assert.deepEqual(await send({ type: 'lock:saveSettings', settings: { idleMinutes: 5 } }), { ok: false, error: 'locked' });
  assert.deepEqual(await send({ type: 'lock:setEnabled', enabled: false, current: 'rahasia1' }), { ok: false, error: 'locked' });
  assert.equal(await isModuleEnabled('lock'), true);
  assert.equal((await chrome.storage.local.get('lock:settings'))['lock:settings'], undefined);
  // The lock screen itself still gets its state.
  assert.equal((await send({ type: 'lock:getState' })).locked, true);
});

test('wrong passwords are throttled', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await send({ type: 'lock:unlock', password: 'salah' });
    assert.equal(r.error, 'wrong');
  }
  const fifth = await send({ type: 'lock:unlock', password: 'salah' });
  assert.equal(fifth.error, 'lockout');
  assert.ok(fifth.retryAt > Date.now());
  // Even the correct password is refused during the lockout.
  assert.equal((await send({ type: 'lock:unlock', password: 'rahasia1' })).ok, false);
  await chrome.storage.local.set({ 'lock:lockoutUntil': 0 });
});

test('correct password unlocks and restores tabs', async () => {
  const r = await send({ type: 'lock:unlock', password: 'rahasia1' });
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/', 'https://b.com/', 'https://c.com/', NEWTAB]);
  assert.equal((await send({ type: 'lock:getState' })).locked, false);
  assert.equal((await chrome.storage.local.get('lock:failures'))['lock:failures'], 0);
});

test('unlock restores tabs and focuses the dashboard', async () => {
  // Tab Manager on: restored tabs stay in the background, a new dashboard tab is created last and active.
  assert.deepEqual(tabs.map((t) => [t.url, t.active]), [
    ['https://a.com/', false], ['https://b.com/', false], ['https://c.com/', false], [NEWTAB, true],
  ]);

  // Tab Manager off: no extra tab, the first restored tab is active.
  await setModuleState('tabs', false);
  await send({ type: 'lock:lock' });
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  assert.equal((await send({ type: 'lock:unlock', password: 'rahasia1' })).ok, true);
  await settle();
  assert.deepEqual(tabs.map((t) => [t.url, t.active]), [
    ['https://a.com/', true], ['https://b.com/', false], ['https://c.com/', false],
  ]);

  // Nothing to restore and Tab Manager off: one plain new tab so the window stays usable.
  tabs.length = 0;
  await send({ type: 'lock:lock' });
  await settle();
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();
  assert.deepEqual(tabs.map((t) => [t.url, t.active]), [[NEWTAB, true]]);
  await setModuleState('tabs', true);
});

test('lock now, idle and screen lock', async () => {
  await send({ type: 'lock:lock' });
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();

  await chrome.idle.onStateChanged.fire('locked'); // lockOnScreenLock defaults to true
  await settle();
  assert.equal((await send({ type: 'lock:getState' })).locked, true);
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();

  await chrome.idle.onStateChanged.fire('idle'); // idleMinutes defaults to 0 (off)
  await settle();
  assert.equal((await send({ type: 'lock:getState' })).locked, false);
});

test('restart while lock module is disabled does not lock', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  await setModuleState('lock', false);
  chrome.storage.session.reset();

  await chrome.runtime.onStartup.fire();
  await settle();

  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/']);
  const state = await send({ type: 'lock:getState' });
  assert.equal(state.locked, false);
  assert.equal(state.status, 'open');
  assert.equal(state.enabled, false);
  assert.equal(state.hasPassword, true);

  await setModuleState('lock', true);
  await chrome.storage.session.set({ 'lock:unlocked': true });
});

test('disabling the lock needs the current password', async () => {
  const failures = async () => (await chrome.storage.local.get('lock:failures'))['lock:failures'] ?? 0;
  const before = await failures();
  const bad = await send({ type: 'lock:setEnabled', enabled: false, current: 'salah' });
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, 'string');
  assert.equal(await failures(), before + 1);
  assert.equal(await isModuleEnabled('lock'), true);

  const good = await send({ type: 'lock:setEnabled', enabled: false, current: 'rahasia1' });
  assert.equal(good.ok, true);
  assert.equal(await isModuleEnabled('lock'), false);
  assert.equal(await failures(), 0);
  assert.equal((await send({ type: 'lock:getState' })).enabled, false);

  // While disabled nothing locks: not the button, the shortcut, idle or screen lock.
  const urls = tabs.map((t) => t.url);
  assert.equal((await send({ type: 'lock:lock' })).ok, false);
  await chrome.commands.onCommand.fire('lock-browser');
  await chrome.idle.onStateChanged.fire('locked');
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), urls);
  assert.equal(await lockStatus(), 'open');

  // Re-enabling needs no password and does not lock straight away.
  await chrome.storage.session.remove('lock:unlocked');
  const on = await send({ type: 'lock:setEnabled', enabled: true });
  assert.equal(on.ok, true);
  assert.equal(await isModuleEnabled('lock'), true);
  assert.equal(await lockStatus(), 'open');
  assert.deepEqual(tabs.map((t) => t.url), urls);
});

test('change password requires the current one', async () => {
  const bad = await send({ type: 'lock:changePassword', current: 'salah', password: 'baru1234', confirm: 'baru1234' });
  assert.equal(bad.ok, false);
  const good = await send({ type: 'lock:changePassword', current: 'rahasia1', password: 'baru1234', confirm: 'baru1234' });
  assert.equal(good.ok, true);
  assert.equal((await send({ type: 'lock:setEnabled', enabled: false, current: 'rahasia1' })).ok, false);
  assert.equal((await send({ type: 'lock:setEnabled', enabled: false, current: 'baru1234' })).ok, true);
  assert.equal((await send({ type: 'lock:setEnabled', enabled: true })).ok, true);
  // The old removePassword message is gone; the password stays.
  assert.equal((await send({ type: 'lock:getState' })).hasPassword, true);
});

test('unknown and old unprefixed messages are ignored', () => {
  for (const type of ['getState', 'removePassword', 'lock:removePassword', 'constructor', 'lock:constructor']) {
    let answered = false;
    for (const fn of chrome.runtime.onMessage.listeners) {
      assert.equal(fn({ type }, {}, () => { answered = true; }), false, type);
    }
    assert.equal(answered, false, type);
  }
});
