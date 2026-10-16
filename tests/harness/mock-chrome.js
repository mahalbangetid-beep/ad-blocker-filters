// Classic (non-module) script: a fake chrome.* API so the real newtab.html
// and background.js can run in an ordinary browser tab for UI testing.
(function () {
  const event = () => {
    const listeners = [];
    return {
      listeners,
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
      fire: (...args) => listeners.forEach((fn) => fn(...args)),
    };
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  const base = `${location.origin}/my-chrome-universe/`; // extension root
  // A password exists and the session is unlocked, so the lock gate (core/page-guard.js) reports 'open'.
  const local = { 'lock:auth': { harness: true } };
  const session = { 'lock:unlocked': true };
  const onChanged = event();

  let nextId = 100;
  const windows = [{ id: 1, focused: true, type: 'normal' }, { id: 2, focused: false, type: 'normal' }];
  const groups = [{ id: 7, title: 'Riset', color: 'blue', windowId: 1 }];
  const tabs = [
    { id: 1, windowId: 1, url: `${base}modules/tabs/newtab.html`, title: 'Tab Manager', active: true, groupId: -1 },
    { id: 2, windowId: 1, url: 'https://developer.mozilla.org/', title: 'MDN Web Docs', groupId: -1 },
    { id: 3, windowId: 1, url: 'https://github.com/', title: 'GitHub', groupId: 7 },
    { id: 4, windowId: 1, url: 'https://stackoverflow.com/', title: 'Stack Overflow', groupId: 7 },
    { id: 5, windowId: 2, url: 'https://news.ycombinator.com/', title: 'Hacker News', groupId: -1 },
    { id: 6, windowId: 2, url: 'https://github.com/', title: 'GitHub (duplikat)', groupId: -1 },
  ];
  const tabEvents = Object.fromEntries(['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated'].map((n) => [n, event()]));

  window.__mock = { tabs, local, session };

  // Shared appearance (theme/motion/accent) is written by core/background.js, which the harness
  // does not load; this stands in for its core:setAppearance handler. ?theme=light|dark presets it.
  // ?guide shows the first-visit guide, ?arrive plays the unlock arrival, ?welcome the welcome
  // (with Browser Lock off), ?motion=minimal|balanced presets the motion level.
  const params = new URLSearchParams(location.search);
  const preset = params.get('theme');
  if (preset || params.get('motion')) local['core:appearance'] = { theme: preset || 'auto', motion: params.get('motion') || 'full' };
  if (!params.has('guide')) local['tm:guideSeen'] = true;
  if (params.has('arrive')) session['tm:arrive'] = true;
  if (params.has('welcome')) {
    session['core:welcome'] = true;
    local['core:modules'] = { lock: false };
  }
  local['ab:total'] = 1284;
  // Stand-ins for the core, lock and adblock handlers the harness does not load.
  const coreHandlers = {
    async 'core:setAppearance'({ patch }) {
      const next = { ...(local['core:appearance'] || {}), ...patch };
      await chrome.storage.local.set({ 'core:appearance': next });
      return { ok: true, appearance: next };
    },
    async 'ab:getOptions'() {
      return { ok: true, totalBlocked: local['ab:total'] };
    },
    async 'lock:lock'() {
      setTimeout(() => location.reload(), 600);
      return { ok: true };
    },
  };

  function storageArea(store, areaName) {
    return {
      async get(key) {
        if (key == null) return clone(store);
        return Object.fromEntries([].concat(key).filter((k) => k in store).map((k) => [k, clone(store[k])]));
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store[k], newValue: clone(v) };
          store[k] = clone(v);
        }
        onChanged.fire(changes, areaName);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (!(k in store)) continue;
          changes[k] = { oldValue: store[k] };
          delete store[k];
        }
        if (Object.keys(changes).length) onChanged.fire(changes, areaName);
      },
    };
  }

  window.chrome = {
    runtime: {
      id: 'harness',
      getURL: (p) => base + String(p).replace(/^\//, ''),
      onMessage: (() => {
        const e = event();
        e.addListener((message, sender, reply) => {
          const fn = coreHandlers[message?.type];
          if (!fn) return false;
          fn(message).then(reply);
          return true;
        });
        return e;
      })(),
      onInstalled: event(),
      sendMessage(message) {
        return new Promise((resolve) => {
          let handled = false;
          for (const fn of chrome.runtime.onMessage.listeners) {
            // Sender as core/gate.js senderAllowed expects from one of the extension's own pages.
            if (fn(message, { id: 'harness', url: location.href }, (r) => resolve(clone(r)))) handled = true;
          }
          if (!handled) resolve(undefined);
        });
      },
    },
    storage: {
      local: storageArea(local, 'local'),
      session: storageArea(session, 'session'),
      onChanged,
    },
    tabs: {
      ...tabEvents,
      async query(q = {}) {
        return clone(tabs.filter((t) => (q.windowId ? t.windowId === q.windowId : q.currentWindow ? t.windowId === 1 : true)
          && (q.active === undefined || Boolean(t.active) === q.active)));
      },
      async getCurrent() { return clone(tabs[0]); },
      async create({ url = 'chrome://newtab/', windowId = 1, active = true } = {}) {
        const tab = { id: nextId++, windowId, url, title: url, active, groupId: -1 };
        tabs.push(tab);
        tabEvents.onCreated.fire(clone(tab));
        return clone(tab);
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          const i = tabs.findIndex((t) => t.id === id);
          if (i >= 0) tabs.splice(i, 1);
          tabEvents.onRemoved.fire(id, {});
        }
      },
      async update(id) { return clone(tabs.find((t) => t.id === id)); },
      async group() { return 8; },
    },
    tabGroups: { async query() { return clone(groups); }, async update() {}, onUpdated: event() },
    windows: {
      async getAll({ populate } = {}) {
        return windows.map((w) => ({ ...w, tabs: populate ? clone(tabs.filter((t) => t.windowId === w.id)) : undefined }));
      },
      async create({ url = [] }) {
        const id = nextId++;
        windows.push({ id, type: 'normal' });
        const created = [];
        for (const u of url) created.push(await chrome.tabs.create({ url: u, windowId: id }));
        return { id, tabs: created };
      },
      async update() {},
      onCreated: event(),
      onRemoved: event(),
    },
    contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: event() },
    commands: { onCommand: event() },
    omnibox: { setDefaultSuggestion() {}, onInputChanged: event(), onInputEntered: event() },
    permissions: { async request() { return true; } },
    bookmarks: {
      async getTree() {
        return [{ children: [{ title: 'Bookmarks bar', children: [{ title: 'Google', url: 'https://google.com/' }] }] }];
      },
    },
  };
})();
