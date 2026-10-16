// Core registry, lock gate and shared menus against a fake chrome. Run: node --test tests/core.test.mjs
import { test, beforeEach } from 'node:test';
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

const onChanged = event();

function area(name) {
  let data = {};
  return {
    dump: () => data,
    reset: () => { data = {}; },
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
      Object.assign(data, structuredClone(obj));
      await onChanged.fire(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) { changes[k] = { oldValue: data[k] }; delete data[k]; }
      await onChanged.fire(changes, name);
    },
  };
}

let nextId = 1;
const tabs = [];
const created = [];
let removeAllCalls = 0;

const chrome = {
  runtime: { getURL: (p) => BASE + p },
  storage: { local: area('local'), session: area('session'), onChanged },
  tabs: {
    async query() { return tabs.map((t) => ({ ...t })); },
    async create({ url }) {
      const tab = { id: nextId++, url, windowId: 100 };
      tabs.push(tab);
      return { ...tab };
    },
    async update(id) { return { ...tabs.find((t) => t.id === id) }; },
  },
  windows: { async update() {} },
  contextMenus: {
    removeAll(cb) {
      removeAllCalls++;
      setTimeout(() => { created.length = 0; cb(); }, 5);
    },
    create(props) { created.push(props); },
  },
};
globalThis.chrome = chrome;

const { getModuleStates, isModuleEnabled, setModuleState, onModuleStatesChanged } =
  await import('../my-chrome-universe/core/modules.js');
const { lockStatus, messageAllowed, guardAction } = await import('../my-chrome-universe/core/gate.js');
const { registerMenuProvider, rebuildMenus } = await import('../my-chrome-universe/core/menus.js');

beforeEach(() => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
  tabs.length = 0;
  created.length = 0;
});

test('module states default to enabled', async () => {
  assert.deepEqual(await getModuleStates(), { adblock: true, tabs: true, lock: true });
  await setModuleState('tabs', false);
  assert.equal(await isModuleEnabled('tabs'), false);
  assert.equal(await isModuleEnabled('lock'), true);
});

test('onModuleStatesChanged reports full states', async () => {
  const seen = [];
  onModuleStatesChanged((s) => seen.push(s));
  await setModuleState('adblock', false);
  assert.deepEqual(seen.at(-1), { adblock: false, tabs: true, lock: true });
});

test('lockStatus covers setup, locked, open and disabled lock', async () => {
  assert.equal(await lockStatus(), 'setup');
  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  assert.equal(await lockStatus(), 'locked');
  await chrome.storage.session.set({ 'lock:unlocked': true });
  assert.equal(await lockStatus(), 'open');
  chrome.storage.session.reset();
  await setModuleState('lock', false);
  assert.equal(await lockStatus(), 'open');
});

test('lockStatus reads storage every call', async () => {
  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  assert.equal(await lockStatus(), 'locked');
  await chrome.storage.session.set({ 'lock:unlocked': true });
  assert.equal(await lockStatus(), 'open');
  await chrome.storage.session.remove('lock:unlocked');
  assert.equal(await lockStatus(), 'locked');
});

test('messageAllowed lets only lock screen messages through while locked', async () => {
  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  assert.equal(await messageAllowed('lock:unlock'), true);
  assert.equal(await messageAllowed('tm:op'), false);
  assert.equal(await messageAllowed('ab:getOptions'), false);
  assert.equal(await messageAllowed('core:setModule'), false);
  await chrome.storage.session.set({ 'lock:unlocked': true });
  assert.equal(await messageAllowed('tm:op'), true);
});

test('guardAction opens setup when no password exists', async () => {
  assert.equal(await guardAction(), false);
  const setup = () => tabs.filter((t) => t.url === BASE + 'modules/lock/setup.html');
  assert.equal(setup().length, 1);
  assert.equal(await guardAction(), false);
  assert.equal(setup().length, 1);
  await Promise.all([guardAction(), guardAction()]);
  assert.equal(setup().length, 1);
});

test('guardAction passes only when open', async () => {
  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  assert.equal(await guardAction(), false);
  assert.equal(tabs.length, 0);
  await chrome.storage.session.set({ 'lock:unlocked': true });
  assert.equal(await guardAction(), true);
});

test('menus from every enabled module coexist', async () => {
  registerMenuProvider('adblock', async () => [{ id: 'ab:1', title: 'a' }]);
  registerMenuProvider('tabs', async () => [1, 2, 3, 4].map((n) => ({ id: `tm:${n}`, title: 't' })));
  await rebuildMenus();
  assert.equal(created.length, 5);
  await setModuleState('tabs', false);
  await rebuildMenus();
  assert.equal(created.length, 1);
  await setModuleState('tabs', true);
  await Promise.all([rebuildMenus(), rebuildMenus()]);
  assert.equal(created.length, 5);
});
