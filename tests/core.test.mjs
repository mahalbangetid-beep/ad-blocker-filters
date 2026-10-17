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
  runtime: { id: 'testid', getURL: (p) => BASE + p, onMessage: event(), onInstalled: event(), onStartup: event() },
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
const { lockStatus, messageAllowed, guardAction, senderAllowed } = await import('../my-chrome-universe/core/gate.js');
const { registerMenuProvider, rebuildMenus } = await import('../my-chrome-universe/core/menus.js');

beforeEach(() => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
  tabs.length = 0;
  created.length = 0;
});

test('module states default to enabled', async () => {
  assert.deepEqual(await getModuleStates(), { adblock: true, tabs: true, notes: true, lock: true });
  await setModuleState('tabs', false);
  assert.equal(await isModuleEnabled('tabs'), false);
  assert.equal(await isModuleEnabled('lock'), true);
});

test('module icons are names from the shared icon set', async () => {
  const { MODULES } = await import('../my-chrome-universe/core/modules.js');
  const { ICONS } = await import('../my-chrome-universe/ui/icons.js');
  assert.deepEqual(MODULES.map((m) => m.icon), ['shield', 'layers', 'note', 'lock']);
  for (const m of MODULES) assert.ok(m.icon in ICONS, `${m.id}: unknown icon ${m.icon}`);
});

test('every module has a settings section script instead of an options page', async () => {
  const { existsSync } = await import('node:fs');
  const { MODULES } = await import('../my-chrome-universe/core/modules.js');
  const ext = new URL('../my-chrome-universe/', import.meta.url);
  for (const m of MODULES) {
    assert.equal('options' in m, false, `${m.id} still has options`);
    assert.match(m.settings || '', /^modules\/[\w-]+\/settings\.js$/, `${m.id}: settings path`);
    assert.ok(existsSync(new URL(m.settings, ext)), `${m.id}: ${m.settings} missing`);
  }
});

test('onModuleStatesChanged reports full states', async () => {
  const seen = [];
  onModuleStatesChanged((s) => seen.push(s));
  await setModuleState('adblock', false);
  assert.deepEqual(seen.at(-1), { adblock: false, tabs: true, notes: true, lock: true });
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

test('a failing menu provider does not hide the other modules\' items', async () => {
  registerMenuProvider('adblock', async () => { throw new Error('boom'); });
  registerMenuProvider('tabs', async () => [1, 2].map((n) => ({ id: `tm:${n}`, title: 't' })));
  await rebuildMenus();
  assert.deepEqual(created.map((p) => p.id), ['tm:1', 'tm:2']);
  registerMenuProvider('adblock', () => { throw new Error('sync boom'); });
  await rebuildMenus();
  assert.deepEqual(created.map((p) => p.id), ['tm:1', 'tm:2']);
});

const PAGE_SENDER = { id: 'testid', url: BASE + 'popup.html' };

test('senderAllowed accepts only our extension pages (and the picker\'s ab:addFilter)', () => {
  // Extension pages: popup (no tab), options/dashboard tabs, frames inside them.
  assert.equal(senderAllowed(PAGE_SENDER, 'core:getModules'), true);
  assert.equal(senderAllowed({ id: 'testid', url: BASE + 'modules/lock/options.html', tab: { id: 1, url: BASE + 'options.html' } }, 'lock:setEnabled'), true);
  // The New Tab override reports a chrome:// tab URL but its own extension URL.
  assert.equal(senderAllowed({ id: 'testid', url: BASE + 'modules/tabs/newtab.html', tab: { id: 2, url: 'chrome://newtab/' } }, 'tm:getData'), true);
  assert.equal(senderAllowed({ id: 'testid', tab: { id: 3, url: BASE + 'options.html' } }, 'tm:getData'), true);

  // Content scripts on websites, other extensions, missing data: refused.
  const web = { id: 'testid', url: 'https://evil.test/', tab: { id: 4, url: 'https://evil.test/' } };
  for (const type of ['lock:setEnabled', 'lock:unlock', 'tm:op', 'ab:saveSettings', 'core:setModule']) {
    assert.equal(senderAllowed(web, type), false, type);
  }
  assert.equal(senderAllowed({ id: 'testid', url: 'https://evil.test/', tab: { id: 4, url: BASE + 'x.html' } }, 'tm:op'), false);
  assert.equal(senderAllowed({ id: 'other', url: BASE + 'popup.html' }, 'core:getModules'), false);
  assert.equal(senderAllowed({ id: 'other', url: 'chrome-extension://other/popup.html' }, 'core:getModules'), false);
  assert.equal(senderAllowed({ id: 'testid' }, 'core:getModules'), false);
  assert.equal(senderAllowed({ id: 'testid', url: 'chrome-extension://testidx/popup.html' }, 'core:getModules'), false);
  assert.equal(senderAllowed({}, 'core:getModules'), false);
  assert.equal(senderAllowed(undefined, 'core:getModules'), false);

  // The block-element picker runs as a content script on websites.
  assert.equal(senderAllowed(web, 'ab:addFilter'), true);
  assert.equal(senderAllowed(PAGE_SENDER, 'ab:addFilter'), true);
  assert.equal(senderAllowed({ ...web, id: 'other' }, 'ab:addFilter'), false);
});

function send(message, sender = PAGE_SENDER) {
  return new Promise((resolve) => {
    let handled = false;
    for (const fn of chrome.runtime.onMessage.listeners) if (fn(message, sender, resolve) === true) handled = true;
    if (!handled) resolve(undefined);
  });
}

test('core:setModule refuses lock, accepts adblock and is gated', async () => {
  await import('../my-chrome-universe/core/background.js');
  // No password yet ('setup'): data-changing core messages are refused.
  assert.deepEqual(await send({ type: 'core:setModule', id: 'adblock', enabled: false }), { ok: false, error: 'locked' });
  assert.deepEqual((await send({ type: 'core:getModules' })).modules, { adblock: true, tabs: true, notes: true, lock: true });

  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  await chrome.storage.session.set({ 'lock:unlocked': true });
  const refused = await send({ type: 'core:setModule', id: 'lock', enabled: false });
  assert.deepEqual(refused, { ok: false, error: 'Gunakan pengaturan Browser Lock' });
  assert.equal(await isModuleEnabled('lock'), true);
  assert.equal((await send({ type: 'core:setModule', id: 'nope', enabled: false })).ok, false);

  const r = await send({ type: 'core:setModule', id: 'adblock', enabled: false });
  assert.deepEqual(r, { ok: true, modules: { adblock: false, tabs: true, notes: true, lock: true } });
  assert.deepEqual(await send({ type: 'core:getModules' }), { ok: true, modules: { adblock: false, tabs: true, notes: true, lock: true } });
});

test('core messages from a web page are refused', async () => {
  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  await chrome.storage.session.set({ 'lock:unlocked': true });
  const web = { id: 'testid', url: 'https://evil.test/', tab: { id: 9, url: 'https://evil.test/' } };
  assert.deepEqual(await send({ type: 'core:setModule', id: 'adblock', enabled: false }, web), { ok: false, error: 'forbidden' });
  assert.deepEqual(await send({ type: 'core:getModules' }, { id: 'other', url: 'chrome-extension://other/x.html' }), { ok: false, error: 'forbidden' });
  assert.equal(await isModuleEnabled('adblock'), true);
});

test('core:setAppearance validates, merges and is gated', async () => {
  await import('../my-chrome-universe/core/background.js');
  await chrome.storage.local.set({ 'lock:auth': { hash: 'x' } });
  assert.deepEqual(await send({ type: 'core:setAppearance', patch: { theme: 'light' } }), { ok: false, error: 'locked' });
  await chrome.storage.session.set({ 'lock:unlocked': true });
  const web = { id: 'testid', url: 'https://evil.test/', tab: { id: 9, url: 'https://evil.test/' } };
  assert.deepEqual(await send({ type: 'core:setAppearance', patch: { theme: 'light' } }, web), { ok: false, error: 'forbidden' });
  const stored = async () => (await chrome.storage.local.get('core:appearance'))['core:appearance'];
  assert.deepEqual(await send({ type: 'core:setAppearance', patch: { theme: 'light' } }), { ok: true });
  assert.deepEqual(await stored(), { theme: 'light' });
  assert.deepEqual(await send({ type: 'core:setAppearance', patch: { accent: 'nova', motion: 'nope' } }), { ok: true });
  assert.deepEqual(await stored(), { theme: 'light', accent: 'nova' });
  await chrome.storage.local.set({ 'core:appearance': { theme: 'light', motion: 'minimal' } });
  assert.deepEqual(await send({ type: 'core:setAppearance', patch: { motion: 'nope', welcome: 'yes' } }), { ok: true });
  assert.deepEqual(await stored(), { theme: 'light', motion: 'minimal' });
});

test('old Tab Manager theme is migrated once', async () => {
  const { migrateAppearance } = await import('../my-chrome-universe/core/background.js');
  await chrome.storage.local.set({ 'tm:data': { settings: { theme: 'dark' } } });
  await migrateAppearance();
  assert.deepEqual((await chrome.storage.local.get('core:appearance'))['core:appearance'], { theme: 'dark' });
  await chrome.storage.local.set({ 'core:appearance': { theme: 'light', motion: 'full', accent: 'solar', welcome: true }, 'tm:data': { settings: { theme: 'dark' } } });
  await migrateAppearance();
  assert.equal((await chrome.storage.local.get('core:appearance'))['core:appearance'].theme, 'light');
});

test('startup and install raise the welcome flag', async () => {
  await import('../my-chrome-universe/core/background.js');
  await chrome.runtime.onStartup.fire();
  assert.equal((await chrome.storage.session.get('core:welcome'))['core:welcome'], true);
  chrome.storage.session.reset();
  await chrome.runtime.onInstalled.fire({ reason: 'update' });
  assert.equal('core:welcome' in chrome.storage.session.dump(), false);
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  assert.equal(chrome.storage.session.dump()['core:welcome'], true);
});
