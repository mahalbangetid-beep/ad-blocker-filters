// Data model and pure mutations for the tab manager. No chrome.* calls here,
// so the same code runs in the service worker, the pages, and Node tests.
//
// Shape (stored under STORAGE_KEY in chrome.storage.local):
// {
//   version: 1,
//   activeSpaceId,
//   settings: { theme: 'auto'|'light'|'dark', closeAfterSave: boolean },
//   spaces: [{ id, name, collections: [{ id, name, starred, collapsed, createdAt, cards: [Card] }] }]
// }
// Card: { id, url, title, createdAt }

export const STORAGE_KEY = 'tm:data';
export const INBOX_NAME = 'Disimpan';

const uid = () => crypto.randomUUID();

export function newSpace(name = 'Ruang Saya') {
  return { id: uid(), name, collections: [] };
}

export function newCollection(name = 'Koleksi baru', cards = []) {
  return { id: uid(), name, starred: false, collapsed: false, createdAt: Date.now(), cards };
}

export function newCard({ url, title }) {
  return { id: uid(), url, title: title || url, createdAt: Date.now() };
}

export function emptyData() {
  const space = newSpace();
  return { version: 1, activeSpaceId: space.id, settings: { theme: 'auto', closeAfterSave: false }, spaces: [space] };
}

// Repairs anything missing so older or imported data never crashes the UI.
export function normalize(data) {
  if (!data || !Array.isArray(data.spaces) || !data.spaces.length) data = { ...emptyData(), ...data, spaces: emptyData().spaces };
  data.version = 1;
  data.settings = { theme: 'auto', closeAfterSave: false, ...data.settings };
  for (const space of data.spaces) {
    space.id ||= uid();
    space.name ||= 'Ruang';
    space.collections = Array.isArray(space.collections) ? space.collections : [];
    for (const col of space.collections) {
      col.id ||= uid();
      col.name ||= 'Koleksi';
      col.starred = Boolean(col.starred);
      col.collapsed = Boolean(col.collapsed);
      col.createdAt ||= Date.now();
      col.cards = (Array.isArray(col.cards) ? col.cards : []).filter((c) => c && typeof c.url === 'string');
      for (const card of col.cards) {
        card.id ||= uid();
        card.title ||= card.url;
        card.createdAt ||= Date.now();
      }
    }
  }
  if (!data.spaces.some((s) => s.id === data.activeSpaceId)) data.activeSpaceId = data.spaces[0].id;
  return data;
}

export function isSavableUrl(url) {
  return typeof url === 'string' && /^(https?|file|ftp):/i.test(url);
}

export function findSpace(data, spaceId) {
  return data.spaces.find((s) => s.id === spaceId) || null;
}

export function findCollection(data, collectionId) {
  for (const space of data.spaces) {
    const collection = space.collections.find((c) => c.id === collectionId);
    if (collection) return { space, collection };
  }
  return null;
}

export function findCard(data, cardId) {
  for (const space of data.spaces) {
    for (const collection of space.collections) {
      const index = collection.cards.findIndex((c) => c.id === cardId);
      if (index >= 0) return { space, collection, card: collection.cards[index], index };
    }
  }
  return null;
}

function insertAt(list, item, index) {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, list.length)) : list.length;
  list.splice(i, 0, item);
}

function cleanName(name, fallback) {
  const text = String(name ?? '').trim().slice(0, 120);
  return text || fallback;
}

export function sessionName(date = new Date()) {
  const text = date.toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Sesi ${text}`;
}

// Applies one operation to `data` in place. Returns { ok, ...extra } or throws.
export function applyOp(data, op) {
  switch (op.type) {
    case 'space/create': {
      const space = newSpace(cleanName(op.name, 'Ruang baru'));
      data.spaces.push(space);
      data.activeSpaceId = space.id;
      return { ok: true, id: space.id };
    }
    case 'space/rename': {
      const space = findSpace(data, op.spaceId);
      if (!space) throw new Error('Ruang tidak ditemukan');
      space.name = cleanName(op.name, space.name);
      return { ok: true };
    }
    case 'space/delete': {
      if (data.spaces.length <= 1) throw new Error('Minimal harus ada satu ruang');
      data.spaces = data.spaces.filter((s) => s.id !== op.spaceId);
      if (data.activeSpaceId === op.spaceId) data.activeSpaceId = data.spaces[0].id;
      return { ok: true };
    }
    case 'space/activate': {
      if (!findSpace(data, op.spaceId)) throw new Error('Ruang tidak ditemukan');
      data.activeSpaceId = op.spaceId;
      return { ok: true };
    }
    case 'collection/create': {
      const space = findSpace(data, op.spaceId || data.activeSpaceId);
      if (!space) throw new Error('Ruang tidak ditemukan');
      const cards = (op.tabs || []).filter((t) => isSavableUrl(t.url)).map(newCard);
      const collection = newCollection(cleanName(op.name, 'Koleksi baru'), cards);
      insertAt(space.collections, collection, op.index ?? 0);
      return { ok: true, id: collection.id, saved: cards.length };
    }
    case 'collection/rename': {
      const found = findCollection(data, op.collectionId);
      if (!found) throw new Error('Koleksi tidak ditemukan');
      found.collection.name = cleanName(op.name, found.collection.name);
      return { ok: true };
    }
    case 'collection/delete': {
      const found = findCollection(data, op.collectionId);
      if (!found) throw new Error('Koleksi tidak ditemukan');
      found.space.collections = found.space.collections.filter((c) => c.id !== op.collectionId);
      return { ok: true };
    }
    case 'collection/update': {
      const found = findCollection(data, op.collectionId);
      if (!found) throw new Error('Koleksi tidak ditemukan');
      for (const key of ['starred', 'collapsed']) if (key in op) found.collection[key] = Boolean(op[key]);
      return { ok: true };
    }
    case 'collection/setCollapsedAll': {
      const space = findSpace(data, op.spaceId || data.activeSpaceId);
      for (const col of space?.collections || []) col.collapsed = Boolean(op.collapsed);
      return { ok: true };
    }
    case 'collection/move': {
      const found = findCollection(data, op.collectionId);
      const target = findSpace(data, op.toSpaceId || found?.space.id);
      if (!found || !target) throw new Error('Tujuan tidak ditemukan');
      const from = found.space.collections.indexOf(found.collection);
      found.space.collections.splice(from, 1);
      let index = op.index;
      if (target === found.space && Number.isInteger(index) && index > from) index -= 1;
      insertAt(target.collections, found.collection, index);
      return { ok: true };
    }
    case 'collection/dedupe': {
      const found = findCollection(data, op.collectionId);
      if (!found) throw new Error('Koleksi tidak ditemukan');
      const seen = new Set();
      const before = found.collection.cards.length;
      found.collection.cards = found.collection.cards.filter((c) => !seen.has(c.url) && seen.add(c.url));
      return { ok: true, removed: before - found.collection.cards.length };
    }
    case 'card/add': {
      const found = findCollection(data, op.collectionId);
      if (!found) throw new Error('Koleksi tidak ditemukan');
      const cards = (op.tabs || []).filter((t) => isSavableUrl(t.url)).map(newCard);
      let index = op.index ?? found.collection.cards.length;
      for (const card of cards) insertAt(found.collection.cards, card, index++);
      return { ok: true, saved: cards.length };
    }
    case 'card/update': {
      const found = findCard(data, op.cardId);
      if (!found) throw new Error('Tab tidak ditemukan');
      if (op.title !== undefined) found.card.title = cleanName(op.title, found.card.url);
      if (op.url !== undefined) {
        if (!isSavableUrl(op.url)) throw new Error('URL tidak valid');
        found.card.url = op.url;
      }
      return { ok: true };
    }
    case 'card/delete': {
      const found = findCard(data, op.cardId);
      if (!found) throw new Error('Tab tidak ditemukan');
      found.collection.cards.splice(found.index, 1);
      return { ok: true };
    }
    case 'card/move': {
      const found = findCard(data, op.cardId);
      const target = findCollection(data, op.toCollectionId);
      if (!found || !target) throw new Error('Tujuan tidak ditemukan');
      found.collection.cards.splice(found.index, 1);
      let index = op.index;
      // Moving down within the same list: the removal shifted later positions.
      if (found.collection === target.collection && Number.isInteger(index) && index > found.index) index -= 1;
      insertAt(target.collection.cards, found.card, index);
      return { ok: true };
    }
    case 'settings/update': {
      const allowed = {};
      if (['auto', 'light', 'dark'].includes(op.settings?.theme)) allowed.theme = op.settings.theme;
      if ('closeAfterSave' in (op.settings || {})) allowed.closeAfterSave = Boolean(op.settings.closeAfterSave);
      data.settings = { ...data.settings, ...allowed };
      return { ok: true };
    }
    case 'import': {
      const incoming = normalize(structuredClone(op.data));
      if (op.mode === 'replace') {
        data.spaces = incoming.spaces;
        data.activeSpaceId = incoming.activeSpaceId;
      } else {
        // Merge: imported spaces are added with fresh ids so nothing is overwritten.
        for (const space of incoming.spaces) {
          space.id = uid();
          for (const col of space.collections) {
            col.id = uid();
            for (const card of col.cards) card.id = uid();
          }
          data.spaces.push(space);
        }
      }
      return { ok: true };
    }
    default:
      throw new Error(`Operasi tidak dikenal: ${op.type}`);
  }
}

// Text search over all spaces. Returns [{ space, collection, cards }] where cards match.
export function search(data, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text) => words.every((w) => text.includes(w));
  const results = [];
  for (const space of data.spaces) {
    for (const collection of space.collections) {
      const nameHit = matches(collection.name.toLowerCase());
      const cards = collection.cards.filter((c) => nameHit || matches(`${c.title} ${c.url}`.toLowerCase()));
      if (cards.length || nameHit) results.push({ space, collection, cards });
    }
  }
  return results;
}
