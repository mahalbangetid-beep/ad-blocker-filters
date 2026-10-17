// Sticky notes board inside the Tab Manager dashboard (newtab.html?view=catatan): every page that
// has notes as a card, its notes as small sticky notes in their own colours. Click a note to show
// it on its page; copy and delete (with undo) right here. The service worker owns the data.
import { colorOf, searchNotes, INDEX_KEY } from './store.js';
import { h } from '../../core/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/motion.js';
import { favicon, STAGGER_MAX } from '../tabs/dashboard/collections.js';
import { confirmDanger } from '../tabs/dashboard/dialogs.js';

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const NF = new Intl.NumberFormat('id-ID');
const WHEN = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/i, '');

let pages = [];
let filter = '';
let enterTimer = 0;
let onChange = () => {};

export const boardPages = () => pages;
export const noteTotal = () => pages.reduce((n, p) => n + p.notes.length, 0);

export async function loadBoard() {
  const result = await send('nt:all').catch(() => null);
  pages = result?.ok ? result.pages : [];
  return pages;
}

// onChange(): the notes changed somewhere (a page, the popup, an import); the caller redraws.
export function setupBoard(options) {
  onChange = options.onChange || onChange;
  const input = $('nb-q');
  input.addEventListener('input', () => {
    filter = input.value;
    renderBoard();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !input.value) return;
    e.stopPropagation();
    input.value = '';
    filter = '';
    renderBoard();
  });
  let timer = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[INDEX_KEY]) return;
    clearTimeout(timer); // a burst of saves (typing on a page) redraws once
    timer = setTimeout(async () => {
      await loadBoard();
      onChange();
    }, 250);
  });
}

// Shows the note on its page (an open tab of the page is reused).
export async function openNote(url, id) {
  const result = await send('nt:open', { url, id });
  if (!result?.ok) toast(result?.error || 'Catatan tidak bisa ditampilkan', { icon: 'info' });
}

async function deleteNote(page, note) {
  const result = await send('nt:deleteNote', { url: page.url, id: note.id });
  if (!result?.ok) return toast(result?.error || 'Gagal menghapus', { icon: 'info' });
  toast('Catatan dihapus', {
    icon: 'trash',
    action: { label: 'Urungkan', run: () => send('nt:restoreNote', { url: page.url, title: result.title, note: result.note }) },
  });
}

async function clearPage(page) {
  const ok = await confirmDanger('Hapus catatan halaman ini?', `${NF.format(page.notes.length)} catatan di ${shortUrl(page.url)} akan dihapus dan tidak bisa dikembalikan.`);
  if (!ok) return;
  const result = await send('nt:clearPage', { url: page.url });
  toast(result?.ok ? 'Catatan halaman dihapus' : result?.error || 'Gagal menghapus', { icon: result?.ok ? 'trash' : 'info' });
}

async function copyText(note) {
  try {
    await navigator.clipboard.writeText(note.text);
    toast('Teks catatan disalin', { icon: 'copy' });
  } catch {
    toast('Gagal menyalin teks', { icon: 'info' });
  }
}

function noteView(page, note, index) {
  const c = colorOf(note.color);
  const text = note.text.trim();
  const open = h('button', { type: 'button', class: 'nb-open', title: 'Tampilkan di halamannya', onclick: () => openNote(page.url, note.id) },
    h('span', { class: `nb-text${text ? '' : ' empty'}` }, text || '(catatan kosong)'),
    h('span', { class: 'nb-meta' }, note.pinned ? icon('pin') : null, WHEN.format(new Date(note.updated || note.created))));
  return h('article', {
    class: 'nb-note',
    dataset: { id: note.id },
    style: `--bg:${c.bg};--bg2:${c.bg2};--ink:${c.ink};--sub:${c.sub};--fill:${c.fill};--j:${Math.min(index, 8)}`,
  },
  open,
  h('span', { class: 'nb-tools' },
    h('button', { type: 'button', class: 'nb-tool', title: 'Salin teks', 'aria-label': 'Salin teks catatan', onclick: () => copyText(note) }, icon('copy')),
    h('button', { type: 'button', class: 'nb-tool', title: 'Hapus catatan', 'aria-label': 'Hapus catatan', onclick: () => deleteNote(page, note) }, icon('trash'))));
}

function pageView(page, notes, i, enter) {
  const title = page.title || shortUrl(page.url);
  const card = h('section', { class: `col nb-page${enter ? ' enter' : ''}`, style: `--i:${Math.min(i, STAGGER_MAX)}`, dataset: { url: page.url } },
    h('header', { class: 'col-head nb-head' },
      favicon(page.url),
      h('span', { class: 'nb-title' }, h('b', { title }, title), h('small', { title: page.url }, shortUrl(page.url))),
      h('span', { class: 'pill' }, NF.format(notes.length)),
      h('span', { class: 'col-actions' },
        h('a', { class: 'icon-btn sm rp', href: page.url, target: '_blank', rel: 'noopener', title: 'Buka halaman', 'aria-label': `Buka ${title}` }, icon('external')),
        h('button', { type: 'button', class: 'icon-btn sm rp nb-clear', title: 'Hapus catatan halaman ini', 'aria-label': `Hapus catatan di ${title}`, onclick: () => clearPage(page) }, icon('trash')))),
    h('div', { class: 'nb-notes' }, notes.map((note, j) => noteView(page, note, j))));
  if (enter) card.addEventListener('animationend', (e) => { if (e.target === card) card.classList.remove('enter'); });
  return card;
}

// Fills the dashboard's header and grid with the board.
export function renderBoard({ enter = false } = {}) {
  const total = noteTotal();
  $('space-meta').textContent = total ? `${NF.format(total)} catatan di ${NF.format(pages.length)} halaman` : 'Belum ada catatan';
  $('space-title').replaceChildren(icon('note'), h('span', { class: 'title-text' }, 'Catatan Tempel'));
  $('main-actions').hidden = true;
  $('search-actions').hidden = true;
  $('notes-actions').hidden = false;
  $('cols').classList.add('nb-board');
  if (enter) {
    clearTimeout(enterTimer);
    $('cols').classList.add('nb-enter');
    enterTimer = setTimeout(() => $('cols').classList.remove('nb-enter'), 2400);
  }

  const matches = searchNotes(pages, filter);
  const byPage = new Map();
  for (const { page, note } of matches) {
    if (!byPage.has(page.url)) byPage.set(page.url, { page, notes: [] });
    byPage.get(page.url).notes.push(note);
  }
  // Pages keep the order of nt:all (most recently edited first); notes inside are newest first.
  const shown = pages.filter((p) => byPage.has(p.url)).map((p) => byPage.get(p.url));
  if (!shown.length) {
    $('cols').replaceChildren(total
      ? h('div', { class: 'empty-space' }, h('strong', {}, 'Tidak ada catatan yang cocok'), 'Coba kata lain, atau kosongkan pencarian.')
      : h('div', { class: 'empty-space nb-empty' }, h('strong', {}, 'Belum ada catatan'),
        'Buka halaman web mana pun, klik kanan, lalu pilih “Tempel catatan di sini”. Semua catatanmu akan terkumpul di sini.'));
    return;
  }
  $('cols').replaceChildren(...shown.map(({ page, notes }, i) => pageView(page, notes, i, enter)));
}

export function leaveBoard() {
  clearTimeout(enterTimer);
  $('notes-actions').hidden = true;
  $('cols').classList.remove('nb-board', 'nb-enter');
}
