// Sticky notes panel in the toolbar popup: the active page, a new note, hide/show and icon mode
// for this page's notes, the list of notes (click to jump to one), and clearing the page.
import { COLORS } from './store.js';
import { getModuleStates } from '../../core/modules.js';
import { loadStyles, offNotice, favTile } from '../../core/panel.js';
import { h, errorText } from '../../core/dom.js';
import { hydrateIcons, ic } from '../../ui/icons.js';

const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const NF = new Intl.NumberFormat('id-ID');
const FILL = Object.fromEntries(COLORS.map((c) => [c.id, c.fill]));
const when = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const MARKUP = `
  <div class="nt-page" style="--i:0"><span id="nt-fav"></span><div class="grow"><b id="nt-title"></b><span id="nt-count"></span></div></div>
  <button class="btn primary block rp" type="button" id="nt-new" style="--i:1"><i data-ic="plus"></i><span>Tempel catatan baru</span></button>
  <div class="nt-pair" style="--i:2">
    <button class="btn ghost sm rp" type="button" id="nt-hide"></button>
    <button class="btn ghost sm rp" type="button" id="nt-icons"></button>
  </div>
  <p class="mcu-msg" id="nt-msg" role="alert"></p>
  <p class="mcu-status nt-info" id="nt-info" role="status" hidden></p>
  <div class="nt-list-wrap" style="--i:3">
    <p class="lbl-sm">Catatan di halaman ini</p>
    <ul class="nt-list" id="nt-list"></ul>
  </div>
  <div class="nt-pair" style="--i:4">
    <button class="btn ghost danger sm rp" type="button" id="nt-clear" title="Hapus semua catatan di halaman ini"><i data-ic="trash"></i><span>Hapus semua</span></button>
    <button class="btn ghost sm rp" type="button" id="nt-manage"><i data-ic="sliders"></i><span>Kelola semua</span></button>
  </div>
`;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export async function status() {
  if (!(await getModuleStates()).notes) return 'nonaktif';
  const list = await send('nt:list');
  if (!list?.ok) return 'aktif';
  return list.total ? `${NF.format(list.total)} catatan` : 'belum ada catatan';
}

// First line of a note, for the list.
const excerpt = (text) => (text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

export async function render(root) {
  await loadStyles(new URL('./panel.css', import.meta.url).href);
  if (!(await getModuleStates()).notes) return void root.replaceChildren(offNotice());

  const tab = await activeTab();
  let state = tab ? await send('nt:pageState', { tabId: tab.id }) : null;
  if (!root.isConnected) return;

  const template = document.createElement('template');
  template.innerHTML = MARKUP;
  hydrateIcons(template.content);
  root.replaceChildren(template.content);
  const $ = (id) => root.querySelector(`#${id}`);
  const msg = $('nt-msg');
  const showError = (result, fallback) => { msg.textContent = errorText(result, fallback); };

  const url = tab?.url || '';
  $('nt-fav').replaceWith(favTile(url, hostOf(url) || tab?.title || '?'));
  $('nt-title').textContent = tab?.title || url || 'Tab ini';
  $('nt-title').title = tab?.title || '';

  const supported = !!(state?.ok && state.supported);
  if (!supported) {
    for (const id of ['nt-new', 'nt-hide', 'nt-icons', 'nt-clear']) $(id).disabled = true;
    if (state?.ok === false) msg.textContent = errorText(state, 'Gagal membaca halaman ini.');
    else {
      $('nt-info').hidden = false;
      $('nt-info').textContent = 'Catatan hanya bisa ditempel di halaman situs web (http/https).';
    }
  }

  const paint = () => {
    const notes = supported ? [...state.notes].sort((a, b) => (a.pinned === b.pinned ? a.y - b.y || a.x - b.x : a.pinned ? -1 : 1)) : [];
    $('nt-count').textContent = supported ? (notes.length ? `${NF.format(notes.length)} catatan di halaman ini` : 'Belum ada catatan di halaman ini') : 'Halaman ini tidak mendukung catatan';
    $('nt-hide').innerHTML = state?.hidden ? `${ic('eye')}<span>Tampilkan</span>` : `${ic('eyeOff')}<span>Sembunyikan</span>`;
    $('nt-icons').innerHTML = state?.icons ? `${ic('undo')}<span>Kembalikan</span>` : `${ic('sparkle')}<span>Jadikan ikon</span>`;
    $('nt-hide').disabled = !supported || !notes.length;
    $('nt-icons').disabled = !supported || !notes.length;
    $('nt-clear').disabled = !supported || !notes.length;
    const list = $('nt-list');
    list.replaceChildren(...notes.map((n) => h('li', {},
      h('button', { type: 'button', class: 'nt-item rp', dataset: { id: n.id }, title: 'Tampilkan catatan ini di halaman', style: `--c: ${FILL[n.color] || FILL.surya}` },
        h('span', { class: 'nt-dot' }),
        h('span', { class: `nt-text${excerpt(n.text) ? '' : ' empty'}` }, excerpt(n.text) || '(kosong)'),
        n.pinned ? h('span', { class: 'nt-pin', title: 'Disematkan' }) : null,
        h('span', { class: 'nt-when' }, when.format(new Date(n.updated || n.created)))))));
    for (const pin of list.querySelectorAll('.nt-pin')) pin.innerHTML = ic('pin');
    root.querySelector('.nt-list-wrap').hidden = !notes.length;
  };
  paint();

  const command = async (name, extra = {}) => {
    msg.textContent = '';
    const result = await send('nt:command', { tabId: tab.id, command: name, ...extra });
    if (!result?.ok) showError(result, 'Halaman tidak menjawab.');
    return result;
  };

  $('nt-new').addEventListener('click', async () => {
    if ((await command('new'))?.ok) window.close();
  });
  $('nt-hide').addEventListener('click', async () => {
    const result = await command('toggleHidden');
    if (result?.ok) { state.hidden = result.hidden; paint(); }
  });
  $('nt-icons').addEventListener('click', async () => {
    const result = await command('toggleIcons');
    if (result?.ok) { state.icons = result.icons; state.hidden = false; paint(); }
  });
  $('nt-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.nt-item');
    if (item && (await command('focus', { id: item.dataset.id }))?.ok) window.close();
  });

  // Two steps: the first click asks, the second clears (the button falls back after a while).
  let armTimer = null;
  const clear = $('nt-clear');
  const disarm = () => {
    clearTimeout(armTimer);
    clear.classList.remove('armed');
    clear.querySelector('span').textContent = 'Hapus semua';
  };
  clear.addEventListener('click', async () => {
    if (!clear.classList.contains('armed')) {
      clear.classList.add('armed');
      clear.querySelector('span').textContent = `Yakin? Hapus ${NF.format(state.notes.length)}`;
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    const result = await send('nt:clearPage', { url: state.url });
    if (!result?.ok) return showError(result, 'Gagal menghapus');
    state = { ...state, notes: [] };
    paint();
  });

  $('nt-manage').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#notes') });
    window.close();
  });
}
