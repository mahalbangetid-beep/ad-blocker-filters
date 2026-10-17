// Sticky notes: pure data rules shared by the service worker, the extension pages and the tests.
// No chrome.* here. Notes are plain text; nothing in this module (or anywhere) parses them as HTML.

export const PAGE_PREFIX = 'nt:p:';
export const INDEX_KEY = 'nt:index';
export const SETTINGS_KEY = 'nt:settings';

// Note colours: `fill` is the note's bar colour (content.js holds the full palette; the tests keep
// both in step). Extension pages use `fill` for colour dots.
export const COLORS = [
  { id: 'surya', name: 'Surya', fill: '#FFB547' },
  { id: 'ion', name: 'Ion', fill: '#5EEAD4' },
  { id: 'nova', name: 'Nova', fill: '#FF8FA8' },
  { id: 'nebula', name: 'Nebula', fill: '#A99BFF' },
  { id: 'langit', name: 'Langit', fill: '#6CB4FF' },
  { id: 'bulan', name: 'Bulan', fill: '#BBC3D9' },
  { id: 'malam', name: 'Malam', fill: '#2D355A' },
];
export const FONTS = [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']];
export const SIZES = [['s', 'Kecil'], ['m', 'Sedang'], ['l', 'Besar']];

export const SETTINGS_DEFAULTS = { color: 'surya', font: 'sans', size: 'm', showDate: true };

export const LIMITS = {
  text: 20000, title: 200, url: 4096, notesPerPage: 200, coord: 1000000,
  minW: 150, maxW: 2000, minH: 120, maxH: 2000, defW: 220, defH: 200,
};

const COLOR_IDS = new Set(COLORS.map((c) => c.id));
const FONT_IDS = new Set(FONTS.map(([id]) => id));
const SIZE_IDS = new Set(SIZES.map(([id]) => id));

// Notes belong to an http(s) page, identified by its URL without the #hash (the query stays:
// it often names the content, e.g. ?v= on video sites). null = no notes possible there.
export function pageKey(url) {
  if (typeof url !== 'string' || url.length > LIMITS.url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  return parsed.href.length > LIMITS.url ? null : parsed.href;
}

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
};

export const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// A note as stored. `prev` is the stored version being updated (its id and created time win).
export function cleanNote(input, { now = Date.now(), prev = null, id = null, color = SETTINGS_DEFAULTS.color } = {}) {
  const n = input && typeof input === 'object' ? input : {};
  return {
    id: prev?.id || id || (typeof n.id === 'string' && /^[\w-]{1,64}$/.test(n.id) ? n.id : newId()),
    text: typeof n.text === 'string' ? n.text.slice(0, LIMITS.text) : '',
    x: clamp(n.x, 0, LIMITS.coord, 0),
    y: clamp(n.y, 0, LIMITS.coord, 0),
    w: clamp(n.w, LIMITS.minW, LIMITS.maxW, LIMITS.defW),
    h: clamp(n.h, LIMITS.minH, LIMITS.maxH, LIMITS.defH),
    z: clamp(n.z, 1, 1000000, 1),
    color: COLOR_IDS.has(n.color) ? n.color : color,
    pinned: Boolean(n.pinned),
    created: prev?.created ?? clamp(n.created, 0, 8.64e15, now),
    updated: now,
  };
}

export function cleanSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    color: COLOR_IDS.has(s.color) ? s.color : SETTINGS_DEFAULTS.color,
    font: FONT_IDS.has(s.font) ? s.font : SETTINGS_DEFAULTS.font,
    size: SIZE_IDS.has(s.size) ? s.size : SETTINGS_DEFAULTS.size,
    showDate: typeof s.showDate === 'boolean' ? s.showDate : SETTINGS_DEFAULTS.showDate,
  };
}

export const cleanTitle = (t) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, LIMITS.title) : '');

// Summary row kept in nt:index for a stored page.
export function indexEntry(page) {
  return {
    title: page.title || '',
    count: page.notes.length,
    updated: page.notes.reduce((max, n) => Math.max(max, n.updated || 0), 0),
  };
}

// ---------- backup ----------

const iso = (t) => {
  const d = new Date(Number(t) || 0);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

// Spreadsheet apps run cells starting with these as formulas.
const csvCell = (value) => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(pages) {
  const rows = [['Catatan', 'URL', 'Judul halaman', 'Warna', 'Disematkan', 'Dibuat', 'Diubah']];
  for (const page of pages) {
    for (const n of page.notes) {
      rows.push([n.text, page.url, page.title, n.color || '', n.pinned ? 'ya' : 'tidak', iso(n.created), iso(n.updated)]);
    }
  }
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
}

export const BACKUP_FORMAT = 'mcu-notes';

export function makeBackup(pages, settings, now = Date.now()) {
  return { format: BACKUP_FORMAT, version: 1, exported: iso(now), settings, pages };
}

// Validates a backup file's content; throws with a user-facing message when it is not ours.
export function parseBackup(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || raw.format !== BACKUP_FORMAT || !Array.isArray(raw.pages)) {
    throw new Error('File ini bukan cadangan Catatan Tempel.');
  }
  const byUrl = new Map();
  for (const p of raw.pages) {
    const url = pageKey(p?.url);
    if (!url || !Array.isArray(p.notes)) continue;
    const page = byUrl.get(url) || { url, title: cleanTitle(p.title), notes: [] };
    for (const n of p.notes) {
      if (page.notes.length >= LIMITS.notesPerPage) break;
      if (!n || typeof n !== 'object') continue;
      const note = cleanNote(n, { now });
      note.updated = clamp(n.updated, 0, 8.64e15, now);
      page.notes.push(note);
    }
    byUrl.set(url, page);
  }
  return {
    pages: [...byUrl.values()].filter((p) => p.notes.length),
    settings: raw.settings ? cleanSettings(raw.settings) : null,
  };
}

// current: { [url]: page }. "merge" keeps existing notes (same id: the backup wins); "replace" starts over.
export function mergeBackup(current, incoming, mode) {
  const out = mode === 'replace' ? {} : structuredClone(current);
  for (const page of incoming) {
    const existing = out[page.url];
    if (!existing) {
      out[page.url] = structuredClone(page);
      continue;
    }
    const byId = new Map(existing.notes.map((n) => [n.id, n]));
    for (const n of page.notes) byId.set(n.id, n);
    existing.notes = [...byId.values()].slice(0, LIMITS.notesPerPage);
    existing.title = page.title || existing.title;
  }
  return out;
}
