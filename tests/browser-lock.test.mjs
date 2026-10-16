// Simulates the Chrome extension APIs in Node and drives background.js through
// the main flows. Run: node --test tests/browser-lock.test.mjs
import { test, mock } from 'node:test';
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
    id: 'testid',
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
    async update(id, props = {}) {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error('no tab');
      if (props.url) t.url = props.url;
      if (props.active) for (const o of tabs) if (o.windowId === t.windowId) o.active = o === t;
      return { ...t };
    },
    // index -1 = end of the tab's window; array order stands in for tab order
    async move(id, { index }) {
      const i = tabs.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('no tab');
      const [t] = tabs.splice(i, 1);
      if (index === -1) tabs.push(t);
      else tabs.splice(index, 0, t);
      return { ...t };
    },
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
const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
let recoveryCode = null; // the latest code handed out, as the user would have noted it

// Messages come from our own extension pages unless a test says otherwise.
const PAGE_SENDER = { id: 'testid', url: BASE + 'modules/lock/options.html' };
function send(message, sender = PAGE_SENDER) {
  return new Promise((resolve) => {
    for (const fn of chrome.runtime.onMessage.listeners) fn(message, sender, resolve);
  });
}

const { setModuleState, isModuleEnabled } = await import('../my-chrome-universe/core/modules.js');
const { lockStatus } = await import('../my-chrome-universe/core/gate.js');
const { generateRecoveryCode, normalizeRecoveryCode, verifyPassword } = await import('../my-chrome-universe/modules/lock/crypto.js');
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
  assert.equal((await send({ type: 'lock:recover', code: 'AAAA', password: 'baru1234', confirm: 'baru1234' })).ok, false);
});

test('the lock shortcut opens setup while there is no password', async () => {
  const SETUP = BASE + 'modules/lock/setup.html';
  const setupTabs = () => tabs.filter((t) => t.url === SETUP);
  await chrome.tabs.remove(setupTabs().map((t) => t.id));
  await settle();
  assert.equal(setupTabs().length, 0);
  await chrome.commands.onCommand.fire('lock-browser');
  await settle();
  assert.equal(setupTabs().length, 1, 'shortcut opens the setup page');
  // Pressed again: the existing setup tab is focused, not duplicated.
  await chrome.commands.onCommand.fire('lock-browser');
  await settle();
  assert.equal(setupTabs().length, 1);
  assert.equal(await lockStatus(), 'setup');
});

test('setup validates and stores only a hash', async () => {
  assert.equal((await send({ type: 'lock:setup', password: 'abc', confirm: 'abc' })).ok, false);
  assert.equal((await send({ type: 'lock:setup', password: 'rahasia1', confirm: 'rahasia2' })).ok, false);
  // Two setups at once (e.g. two setup tabs): exactly one wins and its recovery code stays valid.
  const [ok, second] = await Promise.all([
    send({ type: 'lock:setup', password: 'rahasia1', confirm: 'rahasia1' }),
    send({ type: 'lock:setup', password: 'hacked12', confirm: 'hacked12' }),
  ]);
  assert.equal(ok.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.recoveryCode, undefined);
  recoveryCode = ok.recoveryCode;
  const stored = chrome.storage.local.dump();
  assert.equal(await verifyPassword('rahasia1', stored['lock:auth']), true);
  assert.equal(await verifyPassword(normalizeRecoveryCode(recoveryCode), stored['lock:recovery']), true);
  const local = chrome.storage.local.dump();
  assert.ok(local['lock:auth'], 'password record is stored under lock:auth');
  assert.ok(!JSON.stringify(local).includes('rahasia1'), 'plain password must not be stored');
  assert.equal((await send({ type: 'lock:getState' })).status, 'open');
  // Re-running setup must not overwrite the existing password.
  assert.equal((await send({ type: 'lock:setup', password: 'hacked12', confirm: 'hacked12' })).ok, false);
});

test('setup returns a recovery code that is stored only as a hash', async () => {
  assert.match(recoveryCode, CODE_FORMAT);
  const local = chrome.storage.local.dump();
  assert.ok(local['lock:recovery']?.hash, 'recovery code record is stored under lock:recovery');
  const dump = JSON.stringify([local, chrome.storage.session.dump()]);
  assert.ok(!dump.includes(recoveryCode), 'plain code must not be stored');
  assert.ok(!dump.includes(recoveryCode.replaceAll('-', '')), 'plain code must not be stored without dashes either');
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
  // Before the handoff the lock tab is still there and the restored tabs are in the background.
  assert.deepEqual(tabs.map((t) => t.url), [LOCK, 'https://a.com/', 'https://b.com/', 'https://c.com/']);
  assert.ok(tabs.slice(1).every((t) => !t.active));
  assert.deepEqual(await send({ type: 'lock:handoff' }), { ok: true });
  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/', 'https://b.com/', 'https://c.com/', NEWTAB]);
  assert.equal(tabs.at(-1).active, true);
  assert.equal((await chrome.storage.session.get('tm:arrive'))['tm:arrive'], true);
  assert.equal((await send({ type: 'lock:getState' })).locked, false);
  assert.equal((await chrome.storage.local.get('lock:failures'))['lock:failures'], 0);
});

test('unlock restores tabs and focuses the dashboard', async () => {
  // Tab Manager off: the first restored tab is active and the lock tab is gone.
  await setModuleState('tabs', false);
  await chrome.storage.session.remove('tm:arrive');
  await send({ type: 'lock:lock' });
  await settle();
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  assert.equal((await send({ type: 'lock:unlock', password: 'rahasia1' })).ok, true);
  await settle();
  await send({ type: 'lock:handoff' });
  assert.deepEqual(tabs.map((t) => [t.url, t.active]), [
    ['https://a.com/', true], ['https://b.com/', false], ['https://c.com/', false],
  ]);
  assert.equal((await chrome.storage.session.get('tm:arrive'))['tm:arrive'], undefined);

  // Nothing to restore and Tab Manager off: the lock tab itself becomes a plain new tab.
  tabs.length = 0;
  await send({ type: 'lock:lock' });
  await settle();
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();
  await send({ type: 'lock:handoff' });
  assert.deepEqual(tabs.map((t) => [t.url, t.active]), [[NEWTAB, true]]);
  await setModuleState('tabs', true);
});

const flush = () => new Promise((r) => setImmediate(r)); // setImmediate stays real under mock timers

test('handoff falls back when the lock page never asks', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  await send({ type: 'lock:lock' });
  await settle();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await send({ type: 'lock:unlock', password: 'rahasia1' });
    for (let i = 0; i < 20; i++) await flush();
    assert.deepEqual(tabs.map((t) => t.url), [LOCK, 'https://a.com/']);
    mock.timers.tick(4000);
    for (let i = 0; i < 20; i++) await flush();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/', NEWTAB]);
  assert.equal(tabs.at(-1).active, true);
});

test('handoff twice is harmless', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  await send({ type: 'lock:lock' });
  await settle();
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();
  await Promise.all([send({ type: 'lock:handoff' }), send({ type: 'lock:handoff' })]);
  assert.deepEqual(await send({ type: 'lock:handoff' }), { ok: true });
  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/', NEWTAB]);
});

test('handoff is refused while locked', async () => {
  await send({ type: 'lock:lock' });
  await settle();
  assert.deepEqual(await send({ type: 'lock:handoff' }), { ok: false, error: 'locked' });
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();
  await send({ type: 'lock:handoff' });
});

async function pump() { for (let i = 0; i < 30; i++) await flush(); }
const savedThree = () => chrome.storage.session.set({ 'lock:savedTabs': Array.from({ length: 30 }, (_, i) => `https://s${i}.com/`) });

test('handoff right after unlock waits for the restore (Tab Manager on)', async () => {
  tabs.length = 0;
  await send({ type: 'lock:lock' });
  await settle();
  await savedThree();
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await send({ type: 'lock:handoff' }); // no settle: restore is still running
  assert.equal(tabs.length, 31);
  assert.equal(tabs.at(-1).url, NEWTAB);
  assert.equal(tabs.at(-1).active, true);
  assert.equal(tabs.filter((t) => t.url === NEWTAB || t.url === LOCK).length, 1);
  const left = await chrome.storage.session.get(['lock:firstRestored', 'lock:handoffPending']);
  assert.deepEqual(left, {});
});

test('handoff right after unlock waits for the restore (Tab Manager off)', async () => {
  tabs.length = 0;
  await setModuleState('tabs', false);
  await send({ type: 'lock:lock' });
  await settle();
  await savedThree();
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await send({ type: 'lock:handoff' });
  assert.equal(tabs.length, 30);
  assert.deepEqual(tabs.filter((t) => t.active).map((t) => t.url), ['https://s0.com/']);
  await setModuleState('tabs', true);
});

test('fallback does nothing when the browser was locked again', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  await send({ type: 'lock:lock' });
  await settle();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await send({ type: 'lock:unlock', password: 'rahasia1' });
    await pump();
    await send({ type: 'lock:lock' });
    await pump();
    mock.timers.tick(4000);
    await pump();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(tabs.map((t) => t.url), [LOCK]);
  assert.equal(await lockStatus(), 'locked');
  await send({ type: 'lock:unlock', password: 'rahasia1' });
  await settle();
  await send({ type: 'lock:handoff' });
});

test('pending handoff still ends in a dashboard when the lock tab is gone', async () => {
  tabs.length = 0;
  tabs.push({ id: nextId++, url: 'https://a.com/', windowId: 100, incognito: false });
  await send({ type: 'lock:lock' });
  await settle();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await send({ type: 'lock:unlock', password: 'rahasia1' });
    await pump();
    await chrome.tabs.remove(tabs.find((t) => t.url === LOCK).id);
    mock.timers.tick(4000);
    await pump();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(tabs.map((t) => t.url), ['https://a.com/', NEWTAB]);
  assert.equal(tabs.at(-1).active, true);
  await send({ type: 'lock:handoff' }); // nothing pending any more: no second tab
  assert.equal(tabs.length, 2);
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

test('lock messages from websites or other extensions are refused', async () => {
  const web = { id: 'testid', url: 'https://evil.test/', tab: { id: 999, url: 'https://evil.test/' } };
  const forbidden = { ok: false, error: 'forbidden' };
  assert.deepEqual(await send({ type: 'lock:setEnabled', enabled: false, current: 'baru1234' }, web), forbidden);
  assert.deepEqual(await send({ type: 'lock:getState' }, web), forbidden);
  assert.deepEqual(await send({ type: 'lock:lock' }, { id: 'other', url: 'chrome-extension://other/x.html' }), forbidden);
  assert.equal(await isModuleEnabled('lock'), true);
  assert.equal(await lockStatus(), 'open');
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

test('recovery codes look right and normalize', () => {
  const a = generateRecoveryCode();
  const b = generateRecoveryCode();
  assert.match(a, CODE_FORMAT);
  assert.match(b, CODE_FORMAT);
  assert.notEqual(a, b);
  assert.equal(normalizeRecoveryCode(' abcd-efgh ijkl-mnop-qrst '), 'ABCDEFGH1JK1MN0PQRST');
});

const failures = async () => (await chrome.storage.local.get('lock:failures'))['lock:failures'] ?? 0;

test('recovery code resets the password but does not unlock by itself', async () => {
  assert.equal((await send({ type: 'lock:lock' })).ok, true);
  await settle();
  assert.equal(await lockStatus(), 'locked');
  const typed = recoveryCode.toLowerCase().replaceAll('-', '');

  // An invalid new password is rejected before the code is checked, and is not counted.
  const before = await failures();
  const mismatch = await send({ type: 'lock:recover', code: typed, password: 'pulih123', confirm: 'pulih124' });
  assert.equal(mismatch.ok, false);
  assert.equal(await failures(), before);

  const r = await send({ type: 'lock:recover', code: typed, password: 'pulih123', confirm: 'pulih123' });
  assert.equal(r.ok, true);
  assert.match(r.recoveryCode, CODE_FORMAT);
  assert.notEqual(r.recoveryCode, recoveryCode);
  assert.equal(await lockStatus(), 'locked');
  assert.equal(await failures(), 0);

  assert.equal((await send({ type: 'lock:unlock', password: 'pulih123' })).ok, true);
  await settle();
  assert.equal(await lockStatus(), 'open');

  // The used code is spent.
  const old = await send({ type: 'lock:recover', code: recoveryCode, password: 'lagi1234', confirm: 'lagi1234' });
  assert.equal(old.ok, false);
  assert.equal(old.error, 'wrong');
  recoveryCode = r.recoveryCode;
  assert.equal((await send({ type: 'lock:setEnabled', enabled: false, current: 'pulih123' })).ok, true);
  assert.equal((await send({ type: 'lock:setEnabled', enabled: true })).ok, true);
});

test('wrong recovery codes are throttled like passwords', async () => {
  await chrome.storage.local.set({ 'lock:failures': 0, 'lock:lockoutUntil': 0 });
  for (let i = 0; i < 4; i++) {
    const r = await send({ type: 'lock:recover', code: 'AAAA-AAAA-AAAA-AAAA-AAAA', password: 'lagi1234', confirm: 'lagi1234' });
    assert.equal(r.error, 'wrong');
  }
  const fifth = await send({ type: 'lock:recover', code: 'AAAA-AAAA-AAAA-AAAA-AAAA', password: 'lagi1234', confirm: 'lagi1234' });
  assert.equal(fifth.error, 'lockout');
  assert.ok(fifth.retryAt > Date.now());
  // The right code is refused during the lockout, and so is the password (shared counter).
  const right = await send({ type: 'lock:recover', code: recoveryCode, password: 'lagi1234', confirm: 'lagi1234' });
  assert.equal(right.error, 'lockout');
  assert.equal((await send({ type: 'lock:setEnabled', enabled: false, current: 'pulih123' })).ok, false);
  await chrome.storage.local.set({ 'lock:failures': 0, 'lock:lockoutUntil': 0 });
});

test('a new recovery code needs the current password', async () => {
  const bad = await send({ type: 'lock:newRecoveryCode', current: 'salah' });
  assert.equal(bad.ok, false);
  assert.equal(bad.recoveryCode, undefined);
  assert.equal(await failures(), 1);

  const good = await send({ type: 'lock:newRecoveryCode', current: 'pulih123' });
  assert.equal(good.ok, true);
  assert.match(good.recoveryCode, CODE_FORMAT);
  assert.notEqual(good.recoveryCode, recoveryCode);
  assert.equal(await failures(), 0);
  // The previous code no longer works; the new one does.
  assert.equal((await send({ type: 'lock:recover', code: recoveryCode, password: 'lagi1234', confirm: 'lagi1234' })).ok, false);
  const used = await send({ type: 'lock:recover', code: good.recoveryCode, password: 'lagi1234', confirm: 'lagi1234' });
  assert.equal(used.ok, true);
  recoveryCode = used.recoveryCode;

  // Not available while locked.
  await send({ type: 'lock:lock' });
  await settle();
  assert.deepEqual(await send({ type: 'lock:newRecoveryCode', current: 'lagi1234' }), { ok: false, error: 'locked' });
  assert.equal((await send({ type: 'lock:unlock', password: 'lagi1234' })).ok, true);
  await settle();
});

test('concurrent wrong guesses are each counted', async () => {
  await chrome.storage.local.set({ 'lock:failures': 0, 'lock:lockoutUntil': 0 });
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    send({ type: 'lock:recover', code: 'AAAA-AAAA-AAAA-AAAA-AAAA', password: 'lagi1234', confirm: 'lagi1234' })));
  // Four wrong answers, the fifth starts the lockout, the sixth is refused by it (not counted).
  assert.deepEqual(results.map((r) => r.error), ['wrong', 'wrong', 'wrong', 'wrong', 'lockout', 'lockout']);
  assert.equal(await failures(), 5);
  assert.ok((await chrome.storage.local.get('lock:lockoutUntil'))['lock:lockoutUntil'] > Date.now());
  await chrome.storage.local.set({ 'lock:failures': 0, 'lock:lockoutUntil': 0 });
});
