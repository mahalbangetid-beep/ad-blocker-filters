// Sticky notes section of the settings page: how new notes look, every page that has notes
// (open or clear it), backup (JSON/CSV export, JSON import) and clearing everything.
import { COLORS, FONTS, SIZES, INDEX_KEY, colorOf } from './store.js';
import { h, row, toggleRow, expandRow, expandButton, button, segment, rowMsg, showMsg, errorText } from '../../core/settings-ui.js';
import { loadStyles, favTile } from '../../core/panel.js';
import { getModuleStates, onModuleStatesChanged } from '../../core/modules.js';
import { icon } from '../../ui/icons.js';
import { askImportMode, confirmDanger } from '../tabs/dashboard/dialogs.js';

export const summary = { sub: 'Tampilan, halaman, cadangan', desc: 'Catatan tempel di halaman web: tampilan catatan baru, daftar halaman, dan cadangannya.' };

const NF = new Intl.NumberFormat('id-ID');
const WHEN = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const PAGE_SIZE = 40;

function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/i, '');
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '?'; } };

export async function render(root, ctx) {
  await loadStyles(new URL('./settings.css', import.meta.url).href);
  const [{ settings }, first] = await Promise.all([ctx.send('nt:getSettings'), ctx.send('nt:list')]);
  let pages = first?.pages || [];

  // Settings are saved key by key; the service worker merges each patch.
  const save = async (item, patch) => {
    showMsg(rowMsg(item), '');
    const result = await ctx.send('nt:saveSettings', { patch });
    if (!result?.ok) {
      showMsg(rowMsg(item), errorText(result));
      return false;
    }
    ctx.markSaved();
    return true;
  };

  // ---------- look of new notes ----------
  const colorItem = row({ title: 'Warna catatan baru', desc: 'Warna setiap catatan tetap bisa diganti lewat menu ⋯ di catatannya.', extra: 'warna color' });
  const swatches = h('div', { class: 'swatches nt-swatches', role: 'radiogroup', 'aria-label': 'Warna catatan baru' },
    COLORS.map((c) => h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-label': c.name, title: c.name, style: `--c: ${c.fill}`, dataset: { id: c.id } })));
  const setColor = (id) => {
    for (const b of swatches.children) {
      b.setAttribute('aria-checked', String(b.dataset.id === id));
      b.tabIndex = b.dataset.id === id ? 0 : -1;
    }
  };
  setColor(settings.color);
  swatches.addEventListener('click', async (e) => {
    const b = e.target.closest('.swatch');
    if (!b || b.getAttribute('aria-checked') === 'true') return;
    const prev = swatches.querySelector('[aria-checked="true"]')?.dataset.id;
    setColor(b.dataset.id);
    if (!(await save(colorItem, { color: b.dataset.id }))) return setColor(prev);
    ctx.burst(b, 18, [b.style.getPropertyValue('--c').trim(), getComputedStyle(document.documentElement).getPropertyValue('--star').trim()]);
  });
  swatches.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const all = [...swatches.children];
    const next = all[(all.findIndex((b) => b.getAttribute('aria-checked') === 'true') + step + all.length) % all.length];
    next.focus();
    next.click();
  });
  colorItem.append(swatches);

  const fontItem = row({ title: 'Huruf', desc: 'Memakai huruf bawaan sistem, jadi tidak ada yang dimuat ke situs.', extra: 'font huruf' });
  fontItem.append(segment({ id: 'nt-font', label: 'Huruf catatan', options: FONTS, value: settings.font, onPick: (v) => save(fontItem, { font: v }) }).el);

  const sizeItem = row({ title: 'Ukuran teks', extra: 'ukuran besar kecil size' });
  sizeItem.append(segment({ id: 'nt-size', label: 'Ukuran teks catatan', options: SIZES, value: settings.size, onPick: (v) => save(sizeItem, { size: v }) }).el);

  const dateRow = toggleRow(ctx, {
    id: 'nt-date', title: 'Tanggal di bilah catatan', checked: settings.showDate,
    desc: 'Menampilkan kapan catatan terakhir diubah di bilah atasnya.',
    save: (on) => ctx.send('nt:saveSettings', { patch: { showDate: on } }),
  });

  // ---------- the board (Tab Manager dashboard) ----------
  const boardButton = button('Buka papan', {
    id: 'nt-open-board', ic: 'note',
    onclick: () => location.assign(chrome.runtime.getURL('modules/tabs/newtab.html?view=catatan')),
  });
  const boardRow = row({
    title: 'Papan semua catatan',
    desc: 'Semua catatan dari semua halaman dalam satu papan di dashboard Tab Manager (New Tab), lengkap dengan pencarian.',
    control: boardButton,
    extra: 'papan semua catatan dashboard lihat',
  });
  const syncBoard = (on) => {
    boardButton.disabled = !on;
    if (on) boardButton.removeAttribute('title');
    else boardButton.title = 'Tab Manager sedang nonaktif; isi catatan tetap bisa dilihat di daftar halaman di bawah';
  };
  syncBoard((await getModuleStates()).tabs);
  onModuleStatesChanged((states) => syncBoard(states.tabs));

  // ---------- pages with notes (each opens to show its notes) ----------
  let notesByUrl = null; // url -> notes, loaded the first time a page is opened
  const openPages = new Set();
  const loadNotes = async () => {
    const all = await ctx.send('nt:all');
    notesByUrl = new Map((all?.pages || []).map((p) => [p.url, p.notes]));
  };
  const count = h('span', { class: 'item-desc', id: 'nt-pages-desc' });
  const search = h('input', { class: 'input', type: 'search', id: 'nt-search', placeholder: 'Cari judul atau alamat…', 'aria-label': 'Cari halaman bercatatan' });
  const list = h('ul', { class: 'nt-pages', id: 'nt-pages' });
  const more = h('button', { class: 'btn ghost sm rp', type: 'button', id: 'nt-more' }, 'Tampilkan lebih banyak');
  const empty = h('p', { class: 'st-empty', id: 'nt-empty' });
  let limit = PAGE_SIZE;
  const toggle = expandButton('Lihat');
  const pagesRow = expandRow({
    title: 'Halaman dengan catatan', desc: count, trigger: toggle,
    body: [h('div', { class: 'nt-search' }, icon('search'), search), list, empty, more],
    extra: 'halaman daftar summary ringkasan url situs',
    onToggle: (open) => { toggle.firstChild.textContent = open ? 'Tutup' : 'Lihat'; },
  });
  toggle.addEventListener('click', () => pagesRow.setOpen(!pagesRow.isOpen()));

  const pageItem = (p) => {
    const del = h('button', { class: 'icon-btn sm rp nt-del', type: 'button', title: 'Hapus catatan di halaman ini', 'aria-label': `Hapus catatan di ${p.title || shortUrl(p.url)}` }, icon('trash'));
    const open = h('a', { class: 'icon-btn sm rp', href: p.url, target: '_blank', rel: 'noopener', title: 'Buka halaman', 'aria-label': `Buka ${p.title || shortUrl(p.url)}` }, icon('external'));
    const expanded = openPages.has(p.url);
    const toggle = h('button', { type: 'button', class: 'nt-page-text', 'aria-expanded': String(expanded), title: 'Tampilkan isi catatan' },
      h('b', { title: p.title || p.url }, p.title || shortUrl(p.url)),
      h('span', { title: p.url }, shortUrl(p.url)));
    const sub = h('ul', { class: 'nt-sub' });
    const fillSub = () => {
      const notes = [...(notesByUrl?.get(p.url) || [])].sort((a, b) => (b.updated || 0) - (a.updated || 0));
      sub.replaceChildren(...notes.map((n) => h('li', { style: `--c: ${colorOf(n.color).fill}` },
        h('span', { class: `nt-sub-text${n.text.trim() ? '' : ' empty'}` }, n.text.trim() || '(catatan kosong)'),
        h('span', { class: 'nt-sub-when' }, WHEN.format(new Date(n.updated || n.created))))));
    };
    toggle.addEventListener('click', async () => {
      const show = !openPages.has(p.url);
      if (show) openPages.add(p.url);
      else openPages.delete(p.url);
      if (show && !notesByUrl) await loadNotes();
      fillSub();
      li.classList.toggle('open', show);
      toggle.setAttribute('aria-expanded', String(show));
    });
    const li = h('li', { class: `nt-page-row${expanded ? ' open' : ''}` },
      h('div', { class: 'nt-page-main' },
        favTile(p.url, hostOf(p.url)),
        toggle,
        h('span', { class: 'pill', title: 'Jumlah catatan' }, NF.format(p.count)),
        h('span', { class: 'nt-day' }, p.updated ? DAY.format(new Date(p.updated)) : ''),
        open, del),
      sub);
    if (expanded) fillSub();
    del.addEventListener('click', async () => {
      if (!(await confirmDanger('Hapus catatan halaman ini?', `${NF.format(p.count)} catatan di ${shortUrl(p.url)} akan dihapus dan tidak bisa dikembalikan.`))) return;
      const result = await ctx.send('nt:clearPage', { url: p.url });
      if (!result?.ok) return showMsg(rowMsg(pagesRow.item), errorText(result, 'Gagal menghapus'));
      ctx.markSaved();
      ctx.toast('Catatan halaman dihapus', { icon: 'trash' });
    });
    return li;
  };

  const paintPages = () => {
    const total = pages.reduce((n, p) => n + p.count, 0);
    count.textContent = pages.length ? `${NF.format(total)} catatan di ${NF.format(pages.length)} halaman.` : 'Belum ada catatan. Klik kanan di halaman web → "Tempel catatan di sini".';
    toggle.disabled = !pages.length;
    if (!pages.length && pagesRow.isOpen()) pagesRow.setOpen(false, false);
    const q = search.value.trim().toLowerCase();
    const matches = q ? pages.filter((p) => p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)) : pages;
    list.replaceChildren(...matches.slice(0, limit).map(pageItem));
    more.hidden = matches.length <= limit;
    empty.hidden = matches.length > 0;
    empty.textContent = q ? 'Tidak ada halaman yang cocok.' : '';
    clearAll.disabled = !pages.length;
    exportJson.disabled = !pages.length;
    exportCsv.disabled = !pages.length;
  };
  search.addEventListener('input', () => { limit = PAGE_SIZE; paintPages(); });
  more.addEventListener('click', () => { limit += PAGE_SIZE; paintPages(); });

  // ---------- backup ----------
  const file = h('input', { type: 'file', id: 'nt-import-file', accept: '.json,application/json', hidden: true });
  const exportJson = button('Ekspor JSON', { id: 'nt-export-json', ic: 'download' });
  const exportCsv = button('Ekspor CSV', { id: 'nt-export-csv', ic: 'download' });
  const backup = row({
    title: 'Cadangan catatan',
    desc: 'JSON bisa diimpor kembali (juga di komputer lain); CSV untuk dibuka di spreadsheet.',
    control: h('span', { class: 'btn-row' }, exportJson, exportCsv, button('Impor JSON', { id: 'nt-import', ic: 'upload' }), file),
    extra: 'backup ekspor impor export import csv',
  });
  const backupMsg = rowMsg(backup);
  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportAs = async (kind) => {
    showMsg(backupMsg, '');
    const result = await ctx.send('nt:export');
    if (!result?.ok) return showMsg(backupMsg, errorText(result, 'Gagal mengekspor'));
    if (kind === 'json') download(`catatan-tempel-${stamp()}.json`, 'application/json', JSON.stringify(result.backup, null, 2));
    else download(`catatan-tempel-${stamp()}.csv`, 'text/csv;charset=utf-8', result.csv);
    ctx.toast(`Catatan diekspor ke file ${kind.toUpperCase()}`, { icon: 'download' });
  };
  exportJson.addEventListener('click', () => exportAs('json'));
  exportCsv.addEventListener('click', () => exportAs('csv'));
  backup.querySelector('#nt-import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    showMsg(backupMsg, '');
    let backupData;
    try {
      backupData = JSON.parse(await picked.text());
    } catch {
      return showMsg(backupMsg, 'File ini bukan JSON yang valid.');
    }
    const mode = await askImportMode(picked.name);
    if (!mode) return;
    const result = await ctx.send('nt:import', { backup: backupData, mode });
    if (!result?.ok) return showMsg(backupMsg, errorText(result, 'Gagal mengimpor'));
    ctx.markSaved();
    ctx.toast(`${NF.format(result.count)} catatan diimpor`, { icon: 'upload' });
  });

  const clearAll = h('button', { class: 'btn danger sm rp', type: 'button', id: 'nt-clear-all' }, icon('trash'), 'Hapus semua');
  const clearRow = row({ title: 'Hapus semua catatan', desc: 'Menghapus catatan di semua halaman. Ekspor dulu bila ingin menyimpannya.', control: clearAll, extra: 'hapus reset' });
  clearAll.addEventListener('click', async () => {
    const total = pages.reduce((n, p) => n + p.count, 0);
    if (!(await confirmDanger('Hapus semua catatan?', `${NF.format(total)} catatan di ${NF.format(pages.length)} halaman akan dihapus dan tidak bisa dikembalikan.`, 'Hapus semua'))) return;
    const result = await ctx.send('nt:clearAll');
    if (!result?.ok) return showMsg(rowMsg(clearRow), errorText(result, 'Gagal menghapus'));
    ctx.markSaved();
    ctx.toast('Semua catatan dihapus', { icon: 'trash' });
  });

  // Follow changes made anywhere (notes typed on a page, the popup, an import).
  const reload = async () => {
    const next = await ctx.send('nt:list');
    if (openPages.size) await loadNotes();
    else notesByUrl = null;
    if (next?.ok) { pages = next.pages; paintPages(); }
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[INDEX_KEY] && root.isConnected) reload();
  });

  root.replaceChildren(colorItem, fontItem, sizeItem, dateRow.item, boardRow, pagesRow.item, backup, clearRow);
  paintPages();
}
