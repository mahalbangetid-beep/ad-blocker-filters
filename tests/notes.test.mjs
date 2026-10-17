// Tests for the sticky notes module: pure store logic plus background.js driven through a
// simulated chrome.* API. Run: node --test tests/notes.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageKey, cleanNote, cleanSettings, cleanTitle, toCsv, parseBackup, mergeBackup, indexEntry, searchNotes, colorOf,
  SETTINGS_DEFAULTS, COLORS, LIMITS, PAGE_PREFIX,
} from '../my-chrome-universe/modules/notes/store.js';

// ---------- store.js ----------

test('pageKey keeps http(s) pages without the hash and refuses everything else', () => {
  assert.equal(pageKey('https://example.com/a?b=1#top'), 'https://example.com/a?b=1');
  assert.equal(pageKey('http://Example.com'), 'http://example.com/');
  assert.equal(pageKey('chrome://extensions/'), null);
  assert.equal(pageKey('file:///home/x.html'), null);
  assert.equal(pageKey('not a url'), null);
  assert.equal(pageKey(undefined), null);
  assert.equal(pageKey(`https://x.com/${'a'.repeat(LIMITS.url)}`), null);
});

test('cleanNote fills defaults and clamps every field', () => {
  const n = cleanNote({ text: 'hai', x: -50, y: 1e9, w: 10, h: 9999, z: 'x', color: 'rainbow', pinned: 'yes' }, { now: 5, id: 'id1' });
  assert.equal(n.id, 'id1');
  assert.equal(n.text, 'hai');
  assert.equal(n.x, 0);
  assert.equal(n.y, LIMITS.coord);
  assert.equal(n.w, LIMITS.minW);
  assert.equal(n.h, LIMITS.maxH);
  assert.equal(n.z, 1);
  assert.equal(n.color, SETTINGS_DEFAULTS.color);
  assert.equal(n.pinned, true);
  assert.equal(n.created, 5);
  assert.equal(n.updated, 5);
});

test('cleanNote keeps text as plain text, trims to the limit and keeps the existing id/created', () => {
  const prev = { id: 'keep', created: 1, text: 'lama' };
  const n = cleanNote({ id: 'other', text: `<img src=x onerror=alert(1)>${'a'.repeat(LIMITS.text)}` }, { now: 9, prev });
  assert.equal(n.id, 'keep');
  assert.equal(n.created, 1);
  assert.equal(n.updated, 9);
  assert.equal(n.text.length, LIMITS.text);
  assert.ok(n.text.startsWith('<img'), 'text is stored verbatim, never parsed');
  assert.equal(cleanNote({ text: 42 }, { now: 1, id: 'a' }).text, '');
});

test('cleanNote accepts every palette colour', () => {
  for (const c of COLORS) assert.equal(cleanNote({ color: c.id }, { now: 1, id: 'a' }).color, c.id);
});

test('cleanSettings keeps only known values', () => {
  assert.deepEqual(cleanSettings(null), SETTINGS_DEFAULTS);
  assert.deepEqual(cleanSettings({ color: 'ion', font: 'mono', size: 'l', showDate: false, evil: 1 }),
    { color: 'ion', font: 'mono', size: 'l', showDate: false });
  assert.deepEqual(cleanSettings({ color: 'x', font: 'comic', size: 'xxl', showDate: 'no' }), SETTINGS_DEFAULTS);
});

test('cleanTitle and indexEntry', () => {
  assert.equal(cleanTitle('  Judul\n halaman '), 'Judul halaman');
  assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle('x'.repeat(500)).length, LIMITS.title);
  assert.deepEqual(indexEntry({ title: 'T', notes: [{ updated: 3 }, { updated: 7 }] }), { title: 'T', count: 2, updated: 7 });
});

test('searchNotes matches every word in text, title or address, newest first', () => {
  const pages = [
    { url: 'https://a.com/resep', title: 'Resep', notes: [{ id: 1, text: 'beli gula', updated: 1 }, { id: 2, text: 'Gula aren', updated: 5 }] },
    { url: 'https://b.com/', title: 'Belanja', notes: [{ id: 3, text: 'kopi', updated: 3 }] },
  ];
  assert.deepEqual(searchNotes(pages, 'gula').map((r) => r.note.id), [2, 1]);
  assert.deepEqual(searchNotes(pages, 'resep  BELI').map((r) => r.note.id), [1]);
  assert.deepEqual(searchNotes(pages, 'b.com kopi').map((r) => r.note.id), [3]);
  assert.deepEqual(searchNotes(pages, '').map((r) => r.note.id), [2, 3, 1]);
  assert.equal(colorOf('nope').id, 'surya');
});

test('toCsv quotes fields and starts with a BOM', () => {
  const csv = toCsv([{ url: 'https://a.com/', title: 'A "x"', notes: [{ text: 'baris 1\nbaris, 2', created: 0, updated: 86400000, color: 'ion', pinned: false }] }]);
  const [head, row] = csv.slice(1).split('\r\n');
  assert.equal(csv[0], '﻿');
  assert.equal(head, 'Catatan,URL,Judul halaman,Warna,Disematkan,Dibuat,Diubah');
  assert.ok(row.startsWith('"baris 1\nbaris, 2",https://a.com/,"A ""x""",ion,tidak,1970-01-01T00:00:00.000Z,'));
});

test('toCsv neutralises spreadsheet formulas', () => {
  const csv = toCsv([{ url: 'https://a.com/', title: '=HYPERLINK("x")', notes: [{ text: '+1+1', created: 0, updated: 0 }] }]);
  assert.ok(csv.includes(`"'+1+1"`));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});

test('parseBackup accepts our export and drops invalid pages and notes', () => {
  const backup = {
    format: 'mcu-notes', version: 1,
    pages: [
      { url: 'https://a.com/#x', title: 'A', notes: [{ id: 'n1', text: 'a', x: 1, y: 2 }, 'junk'] },
      { url: 'javascript:alert(1)', notes: [{ text: 'no' }] },
      { url: 'https://b.com/', notes: [] },
    ],
    settings: { color: 'nova' },
  };
  const parsed = parseBackup(backup, { now: 4 });
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].url, 'https://a.com/');
  assert.equal(parsed.pages[0].notes.length, 1);
  assert.equal(parsed.pages[0].notes[0].id, 'n1');
  assert.equal(parsed.settings.color, 'nova');
  assert.throws(() => parseBackup({ format: 'other' }), /bukan cadangan/i);
  assert.throws(() => parseBackup(null), /bukan cadangan/i);
});

test('parseBackup merges duplicate page URLs and caps notes per page', () => {
  const many = Array.from({ length: LIMITS.notesPerPage + 5 }, (_, i) => ({ id: `n${i}`, text: String(i) }));
  const parsed = parseBackup({ format: 'mcu-notes', version: 1, pages: [
    { url: 'https://a.com/', notes: many.slice(0, 100) },
    { url: 'https://a.com/#again', notes: many.slice(100) },
  ] });
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].notes.length, LIMITS.notesPerPage);
});

test('mergeBackup: merge keeps existing notes and replaces same ids; replace starts over', () => {
  const current = { 'https://a.com/': { url: 'https://a.com/', title: 'A', notes: [{ id: 'n1', text: 'lama' }, { id: 'n2', text: 'tetap' }] } };
  const incoming = [{ url: 'https://a.com/', title: 'A2', notes: [{ id: 'n1', text: 'baru' }] }, { url: 'https://c.com/', title: 'C', notes: [{ id: 'n3', text: 'c' }] }];
  const merged = mergeBackup(current, incoming, 'merge');
  assert.deepEqual(merged['https://a.com/'].notes.map((n) => n.text), ['baru', 'tetap']);
  assert.equal(merged['https://c.com/'].notes.length, 1);
  const replaced = mergeBackup(current, incoming, 'replace');
  assert.deepEqual(replaced['https://a.com/'].notes.map((n) => n.text), ['baru']);
  assert.equal(PAGE_PREFIX, 'nt:p:');
});

// ---------- background.js against a fake chrome ----------

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
  };
}

function area() {
  let data = {};
  return {
    dump: () => data,
    reset: () => { data = {}; },
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}

const EXT = 'chrome-extension://testid/';
const local = area();
const session = area();
const sentToTabs = [];
const registered = [];
let tabs = [];
globalThis.chrome = {
  runtime: {
    id: 'testid',
    getURL: (p = '') => EXT + p.replace(/^\//, ''),
    onMessage: event(), onInstalled: event(), onStartup: event(),
  },
  storage: { local, session, onChanged: event() },
  tabs: {
    query: async () => tabs,
    get: async (id) => tabs.find((t) => t.id === id),
    create: async ({ url, active }) => { const tab = { id: 100 + tabs.length, url, active, status: 'complete', windowId: 1 }; tabs.push(tab); return tab; },
    update: async (id, props) => Object.assign(tabs.find((t) => t.id === id), props),
    sendMessage: async (tabId, message) => { sentToTabs.push({ tabId, message }); return { ok: true, hidden: false, icons: false }; },
  },
  scripting: {
    getRegisteredContentScripts: async () => registered.slice(),
    registerContentScripts: async (list) => { registered.push(...list); },
    unregisterContentScripts: async () => { registered.length = 0; },
    executeScript: async () => [],
  },
  windows: { update: async () => ({}) },
  contextMenus: { create: () => {}, removeAll: (cb) => cb?.(), onClicked: event() },
  commands: { onCommand: event() },
  webNavigation: { onHistoryStateUpdated: event() },
};

const { handlers } = await import('../my-chrome-universe/modules/notes/background.js');

const PAGE = 'https://site.test/artikel?id=1';
const web = (url = PAGE, extra = {}) => ({ id: 'testid', url, tab: { id: 7, url, title: 'Artikel' }, frameId: 0, ...extra });
const call = (type, payload = {}, sender = web()) => handlers[type]({ type, ...payload }, sender);

beforeEach(() => {
  local.reset();
  session.reset();
  sentToTabs.length = 0;
  tabs = [];
});

test('save creates a note for the sender page and load returns it', async () => {
  const saved = await call('nt:save', { note: { text: 'halo', x: 10, y: 20 } });
  assert.equal(saved.ok, true);
  assert.match(saved.note.id, /^[\w-]{8,}$/);
  const loaded = await call('nt:load', {}, web(`${PAGE}#bagian`));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.notes.length, 1);
  assert.equal(loaded.notes[0].text, 'halo');
  assert.deepEqual(loaded.settings, SETTINGS_DEFAULTS);
  assert.deepEqual(local.dump()['nt:index'][PAGE], { title: 'Artikel', count: 1, updated: saved.note.updated });
});

test('the page comes from the sender, never from the message', async () => {
  await call('nt:save', { note: { text: 'a' }, url: 'https://other.test/' });
  assert.ok(local.dump()[`nt:p:${PAGE}`]);
  assert.equal(local.dump()['nt:p:https://other.test/'], undefined);
});

test('web messages are refused from sub-frames and non-web pages', async () => {
  assert.equal((await call('nt:load', {}, web(PAGE, { frameId: 3 }))).ok, false);
  assert.equal((await call('nt:save', { note: { text: 'x' } }, web('chrome://settings/'))).ok, false);
  assert.equal((await call('nt:save', { note: { text: 'x' } }, { id: 'testid', url: PAGE })).ok, false);
});

test('updating keeps the id and created time; delete removes the page when empty', async () => {
  const { note } = await call('nt:save', { note: { text: 'a' } });
  const { note: again } = await call('nt:save', { note: { ...note, text: 'b', x: 99 } });
  assert.equal(again.id, note.id);
  assert.equal(again.created, note.created);
  assert.equal((await call('nt:load')).notes[0].text, 'b');
  assert.equal((await call('nt:delete', { id: note.id })).ok, true);
  assert.equal(local.dump()[`nt:p:${PAGE}`], undefined);
  assert.equal(local.dump()['nt:index'][PAGE], undefined);
});

test('a page holds at most the note limit', async () => {
  const notes = Array.from({ length: LIMITS.notesPerPage }, (_, i) => ({ id: `n${i}`, text: '' }));
  await local.set({ [`nt:p:${PAGE}`]: { url: PAGE, title: '', notes } });
  const result = await call('nt:save', { note: { text: 'lagi' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /batas/i);
});

test('saving tells other tabs on the same page to refresh', async () => {
  tabs = [{ id: 7, url: PAGE }, { id: 8, url: `${PAGE}#lain` }, { id: 9, url: 'https://x.test/' }];
  await call('nt:save', { note: { text: 'a' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sentToTabs.filter((s) => s.message.type === 'nt:refresh').map((s) => s.tabId), [8]);
});

test('extension pages: list, settings, clear page, export and import', async () => {
  const ext = { id: 'testid', url: `${EXT}options.html` };
  await call('nt:save', { note: { text: 'a' } });
  await call('nt:save', { note: { text: 'b' } }, web('https://b.test/', {}));
  const list = await call('nt:list', {}, ext);
  assert.deepEqual(list.pages.map((p) => [p.url, p.count]).sort(), [['https://b.test/', 1], [PAGE, 1]]);
  assert.equal(list.total, 2);

  assert.equal((await call('nt:saveSettings', { patch: { size: 'l', font: 'nope' } }, ext)).settings.size, 'l');
  assert.equal((await call('nt:load')).settings.size, 'l');

  const exported = await call('nt:export', {}, ext);
  assert.equal(exported.backup.format, 'mcu-notes');
  assert.equal(exported.backup.pages.length, 2);
  assert.ok(exported.csv.includes('https://b.test/'));

  assert.equal((await call('nt:clearPage', { url: 'https://b.test/#x' }, ext)).ok, true);
  assert.equal((await call('nt:list', {}, ext)).total, 1);

  const imported = await call('nt:import', { backup: exported.backup, mode: 'replace' }, ext);
  assert.equal(imported.ok, true);
  assert.equal((await call('nt:list', {}, ext)).total, 2);

  assert.equal((await call('nt:clearAll', {}, ext)).ok, true);
  assert.equal((await call('nt:list', {}, ext)).total, 0);
  assert.equal(Object.keys(local.dump()).filter((k) => k.startsWith('nt:p:')).length, 0);
});

test('pageState refuses pages notes cannot live on', async () => {
  tabs = [{ id: 3, url: 'chrome://extensions/' }];
  const state = await call('nt:pageState', { tabId: 3 }, { id: 'testid', url: `${EXT}popup.html` });
  assert.equal(state.ok, true);
  assert.equal(state.supported, false);
});

// ---------- palette (content.js) ----------

test('note palette keeps 4.5:1 text contrast and matches the colour dots', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../my-chrome-universe/modules/notes/content.js', import.meta.url), 'utf8');
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const c of COLORS) {
    const m = new RegExp(`\\.c-${c.id}\\s*\\{([^}]*)\\}`).exec(src);
    assert.ok(m, `palette for ${c.id}`);
    const v = (name) => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(m[1])?.[1];
    assert.equal(v('bar').toUpperCase(), c.fill.toUpperCase(), `${c.id}: store fill = content bar`);
    for (const key of ['bg', 'bg2', 'ink', 'sub']) assert.equal(v(key).toUpperCase(), c[key].toUpperCase(), `${c.id}: store ${key} = content`);
    for (const bg of ['bg', 'bg2', 'bar']) {
      const r = contrast(v('ink'), v(bg));
      assert.ok(r >= 4.5, `${c.id}: ink on ${bg} = ${r.toFixed(2)}`);
    }
    for (const bg of ['bg', 'bg2']) {
      const r = contrast(v('sub'), v(bg));
      assert.ok(r >= 4.5, `${c.id}: sub on ${bg} = ${r.toFixed(2)}`);
    }
  }
});

test('nt:all lists every page with its notes, newest page first', async () => {
  const ext = { id: 'testid', url: `${EXT}modules/tabs/newtab.html` };
  await call('nt:save', { note: { text: 'lama' } });
  await new Promise((r) => setTimeout(r, 2));
  await call('nt:save', { note: { text: 'baru' } }, web('https://b.test/'));
  const all = await call('nt:all', {}, ext);
  assert.equal(all.ok, true);
  assert.deepEqual(all.pages.map((p) => p.url), ['https://b.test/', PAGE]);
  assert.equal(all.pages[1].title, 'Artikel');
  assert.equal(all.pages[1].notes[0].text, 'lama');
});

test('nt:deleteNote and nt:restoreNote round trip from an extension page', async () => {
  const ext = { id: 'testid', url: `${EXT}modules/tabs/newtab.html` };
  const { note } = await call('nt:save', { note: { text: 'simpan', color: 'ion' } });
  const removed = await call('nt:deleteNote', { url: `${PAGE}#x`, id: note.id }, ext);
  assert.equal(removed.ok, true);
  assert.equal(removed.note.text, 'simpan');
  assert.equal(removed.title, 'Artikel');
  assert.equal(local.dump()[`nt:p:${PAGE}`], undefined);
  assert.equal((await call('nt:deleteNote', { url: PAGE, id: 'nope' }, ext)).ok, false);
  const restored = await call('nt:restoreNote', { url: PAGE, title: removed.title, note: removed.note }, ext);
  assert.equal(restored.ok, true);
  const [back] = (await call('nt:load')).notes;
  assert.deepEqual({ id: back.id, text: back.text, color: back.color, created: back.created }, { id: note.id, text: 'simpan', color: 'ion', created: note.created });
  assert.equal((await call('nt:restoreNote', { url: 'chrome://x/', note: removed.note }, ext)).ok, false);
});

test('nt:open reuses a tab already on the page, otherwise opens one, then focuses the note', async () => {
  const ext = { id: 'testid', url: `${EXT}modules/tabs/newtab.html` };
  tabs = [{ id: 7, url: `${PAGE}#bagian`, status: 'complete', windowId: 1 }];
  assert.equal((await call('nt:open', { url: PAGE, id: 'n1' }, ext)).ok, true);
  assert.equal(tabs.length, 1, 'the open tab is reused');
  assert.equal(tabs[0].active, true);
  assert.deepEqual(sentToTabs.filter((s) => s.message.type === 'nt:focus').map((s) => [s.tabId, s.message.id]), [[7, 'n1']]);
  sentToTabs.length = 0;
  assert.equal((await call('nt:open', { url: 'https://c.test/x', id: 'n2' }, ext)).ok, true);
  assert.equal(tabs.at(-1).url, 'https://c.test/x');
  assert.deepEqual(sentToTabs.filter((s) => s.message.type === 'nt:focus').map((s) => s.tabId), [tabs.at(-1).id]);
  assert.equal((await call('nt:open', { url: 'javascript:alert(1)', id: 'x' }, ext)).ok, false);
});
