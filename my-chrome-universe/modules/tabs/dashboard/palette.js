// Zone 4: one palette (Ctrl/⌘+K or "/") to find saved tabs and collections (store.js search(),
// the same matching as the old search box) and to run commands. ↑/↓ select, Enter runs, Esc closes.
import { search } from '../store.js';
import { searchNotes } from '../../notes/store.js';
import { h } from '../common.js';
import { icon } from '../../../ui/icons.js';
import { motionLevel } from '../../../ui/motion.js';
import { favicon, STAGGER_MAX } from './collections.js';

const $ = (id) => document.getElementById(id);
const MAX_TABS = 7;
const MAX_COLS = 4;
const MAX_NOTES = 5;

// getData(); commands(): [{ ic, label, keywords?, hint?, run }];
// onReveal(spaceId, collectionId, cardId?); onOpenCard(card); onShowAll(query);
// notes(): sticky note pages [{ url, title, notes }]; onOpenNote(url, noteId).
const ctx = {
  getData: () => null, commands: () => [], onReveal: () => {}, onOpenCard: () => {}, onShowAll: () => {},
  notes: () => [], onOpenNote: () => {},
};
const firstLine = (text) => text.split('\n').map((l) => l.trim()).find(Boolean) || '(catatan kosong)';
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
let items = []; // [{ item, el }]
let selected = 0;
let returnFocus = null;
let closeTimer = 0;
let isOpen = false; // false as soon as closing starts (the fade-out may still be running)

const fast = () => motionLevel() === 'minimal';
const wordsOf = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text, words) => words.every((w) => text.toLowerCase().includes(w));

export function setupPalette(options) {
  Object.assign(ctx, options);
  const input = $('pal-q');
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(selected + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      run(selected, { alt: e.ctrlKey || e.metaKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // focus stays in the field; arrows move the selection
    }
  });
  $('palette').addEventListener('pointerdown', (e) => {
    if (e.target === $('palette')) closePalette();
  });
}

export const paletteOpen = () => isOpen;

export function openPalette() {
  const pal = $('palette');
  clearTimeout(closeTimer);
  if (!isOpen) returnFocus = document.activeElement;
  isOpen = true;
  pal.hidden = false;
  $('pal-q').value = '';
  render();
  requestAnimationFrame(() => pal.classList.add('open'));
  $('pal-q').focus();
}

export function closePalette() {
  const pal = $('palette');
  if (!isOpen) return;
  isOpen = false;
  pal.classList.remove('open');
  const hide = () => { pal.hidden = true; };
  if (fast()) hide();
  else closeTimer = setTimeout(hide, 220);
  if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

// Label with every query word marked.
function highlight(text, words) {
  if (!words.length) return [text];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  // split() with a capturing group puts the matches at the odd indexes.
  return text.split(re).map((part, i) => (i % 2 === 1 ? h('mark', {}, part) : part)).filter((part) => part !== '');
}

function groups(query) {
  const words = wordsOf(query);
  const commands = ctx.commands().filter((c) => !words.length || matches(`${c.label} ${c.keywords || ''}`, words));
  if (!words.length) return [['Perintah', commands]];

  const results = search(ctx.getData(), query);
  const tabs = [];
  const cols = [];
  let total = 0;
  for (const { space, collection, cards } of results) {
    total += cards.length;
    if (matches(collection.name, words)) {
      cols.push({
        ic: 'layers', label: collection.name, sub: `Koleksi di ${space.name} · ${collection.cards.length} tab`,
        run: () => ctx.onReveal(space.id, collection.id),
      });
    }
    for (const card of cards) {
      if (!matches(`${card.title} ${card.url}`, words)) continue; // listed through its collection instead
      tabs.push({
        fav: card.url, label: card.title, sub: `${space.name} › ${collection.name}`,
        run: () => ctx.onReveal(space.id, collection.id, card.id),
        alt: () => ctx.onOpenCard(card),
      });
    }
  }
  const shownTabs = tabs.slice(0, MAX_TABS);
  if (total > 0) {
    shownTabs.push({ ic: 'search', label: `Tampilkan semua hasil untuk “${query}”`, sub: `${total} tab di ${results.length} koleksi`, plain: true, run: () => ctx.onShowAll(query) });
  }
  const notes = searchNotes(ctx.notes(), query).slice(0, MAX_NOTES).map(({ page, note }) => ({
    ic: 'note', label: firstLine(note.text), sub: `Catatan di ${page.title || hostOf(page.url)}`,
    run: () => ctx.onOpenNote(page.url, note.id),
  }));
  return [['Tab tersimpan', shownTabs], ['Catatan', notes], ['Koleksi', cols.slice(0, MAX_COLS)], ['Perintah', commands]];
}

function render() {
  const query = $('pal-q').value.trim();
  const words = wordsOf(query);
  const list = $('pal-list');
  items = [];
  const nodes = [];
  for (const [title, entries] of groups(query)) {
    if (!entries.length) continue;
    nodes.push(h('div', { class: 'pal-group', role: 'presentation' }, title));
    for (const item of entries) {
      const index = items.length;
      const el = h('button', {
        type: 'button', class: 'pal-item', role: 'option', id: `pal-${index}`, tabindex: '-1',
        style: `--i:${Math.min(index, STAGGER_MAX)}`,
        onclick: (e) => run(index, { alt: e.ctrlKey || e.metaKey }),
        onpointermove: () => { if (selected !== index) select(index, false); },
      },
      item.fav ? favicon(item.fav) : icon(item.ic),
      h('span', { class: 'grow' }, h('span', {}, item.plain ? item.label : highlight(item.label, words)), item.sub && h('small', {}, item.sub)),
      item.hint && h('kbd', {}, item.hint));
      items.push({ item, el });
      nodes.push(el);
    }
  }
  if (!items.length) nodes.push(h('p', { class: 'pal-empty' }, 'Tidak ada yang cocok. Coba kata lain.'));
  list.replaceChildren(...nodes);
  list.scrollTop = 0;
  select(0);
}

function select(index, scroll = true) {
  if (!items.length) return void $('pal-q').removeAttribute('aria-activedescendant');
  selected = (index + items.length) % items.length;
  items.forEach(({ el }, i) => {
    el.classList.toggle('sel', i === selected);
    el.setAttribute('aria-selected', String(i === selected));
  });
  $('pal-q').setAttribute('aria-activedescendant', `pal-${selected}`);
  if (scroll) items[selected].el.scrollIntoView({ block: 'nearest' });
}

// alt (Ctrl/⌘): a saved tab opens in a new tab instead of being shown in its collection.
function run(index, { alt = false } = {}) {
  const entry = items[index];
  if (!entry) return;
  const action = alt && entry.item.alt ? entry.item.alt : entry.item.run;
  closePalette();
  setTimeout(action, fast() ? 0 : 120);
}
