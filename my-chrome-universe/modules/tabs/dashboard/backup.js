// Backup and import of Tab Manager data (export JSON, import JSON, import Chrome bookmarks).
// No UI here: the dashboard palette and the settings page wrap these with their own dialogs/toasts.
import { isSavableUrl } from '../store.js';
import { runOp } from '../common.js';

// Downloads `data` as tab-manager-YYYY-MM-DD.json.
export function exportData(data) {
  const payload = { format: 'tab-manager', version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tab-manager-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Accepts this extension's export, a raw data object, or a Toby-style export ({ lists: [...] }).
export function toImportData(json) {
  if (json?.format === 'tab-manager' && json.data) return json.data;
  if (Array.isArray(json?.spaces)) return json;
  if (Array.isArray(json?.lists)) {
    return {
      spaces: [{
        name: 'Impor Toby',
        collections: json.lists.map((list) => ({
          name: list.title || 'Koleksi',
          cards: (list.cards || []).map((c) => ({ url: c.url, title: c.customTitle || c.title })),
        })),
      }],
    };
  }
  throw new Error('Format file tidak dikenali');
}

// Reads a picked File; throws an Error with a readable message when it is not importable.
export async function readImportFile(file) {
  return toImportData(JSON.parse(await file.text()));
}

// mode: 'merge' (add next to the existing data) or 'replace'.
export function importData(incoming, mode) {
  return runOp({ type: 'import', data: incoming, mode });
}

// Imports every bookmark folder with links as a collection in the space "Bookmark Chrome".
// Must be called from a user gesture (it asks for the optional bookmarks permission).
// Resolves to the runOp reply plus { count }, or { ok: false, error }.
export async function importBookmarks() {
  try {
    return await bookmarksToSpace();
  } catch (err) {
    return { ok: false, error: `Gagal mengimpor bookmark: ${err?.message || err}` };
  }
}

async function bookmarksToSpace() {
  const granted = await chrome.permissions.request({ permissions: ['bookmarks'] });
  if (!granted) return { ok: false, error: 'Izin bookmark ditolak' };
  const [root] = await chrome.bookmarks.getTree();
  const collections = [];
  (function walk(node, path) {
    const links = (node.children || []).filter((c) => c.url && isSavableUrl(c.url));
    if (links.length) collections.push({ name: path.join(' / ') || 'Bookmark', cards: links.map((l) => ({ url: l.url, title: l.title })) });
    for (const child of node.children || []) if (!child.url) walk(child, child.title ? [...path, child.title] : path);
  })(root, []);
  if (!collections.length) return { ok: false, error: 'Tidak ada bookmark' };
  const result = await runOp({ type: 'import', mode: 'merge', data: { spaces: [{ name: 'Bookmark Chrome', collections }] } });
  return { ...result, count: collections.length };
}
