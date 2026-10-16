// Classic (non-module) script: a fake chrome.* API so the real newtab.html,
// popup.html and background.js can run in an ordinary browser tab for UI testing.
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

  const base = `${location.origin}/tab-manager/`;
  const local = {};
  const onChanged = event();

  let nextId = 100;
  const windows = [{ id: 1, focused: true, type: 'normal' }, { id: 2, focused: false, type: 'normal' }];
  const groups = [{ id: 7, title: 'Riset', color: 'blue', windowId: 1 }];
  const tabs = [
    { id: 1, windowId: 1, url: `${base}newtab.html`, title: 'Tab Manager', active: true, groupId: -1 },
    { id: 2, windowId: 1, url: 'https://developer.mozilla.org/', title: 'MDN Web Docs', groupId: -1 },
    { id: 3, windowId: 1, url: 'https://github.com/', title: 'GitHub', groupId: 7 },
    { id: 4, windowId: 1, url: 'https://stackoverflow.com/', title: 'Stack Overflow', groupId: 7 },
    { id: 5, windowId: 2, url: 'https://news.ycombinator.com/', title: 'Hacker News', groupId: -1 },
    { id: 6, windowId: 2, url: 'https://github.com/', title: 'GitHub (duplikat)', groupId: -1 },
  ];
  const tabEvents = Object.fromEntries(['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onActivated'].map((n) => [n, event()]));

  window.__mock = { tabs, local };

  window.chrome = {
    runtime: {
      getURL: (p) => base + String(p).replace(/^\//, ''),
      onMessage: event(),
      onInstalled: event(),
      sendMessage(message) {
        return new Promise((resolve) => {
          let handled = false;
          for (const fn of chrome.runtime.onMessage.listeners) {
            if (fn(message, {}, (r) => resolve(clone(r)))) handled = true;
          }
          if (!handled) resolve(undefined);
        });
      },
    },
    storage: {
      local: {
        async get(key) {
          if (key == null) return clone(local);
          return Object.fromEntries([].concat(key).filter((k) => k in local).map((k) => [k, clone(local[k])]));
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: local[k], newValue: clone(v) };
            local[k] = clone(v);
          }
          onChanged.fire(changes, 'local');
        },
      },
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
