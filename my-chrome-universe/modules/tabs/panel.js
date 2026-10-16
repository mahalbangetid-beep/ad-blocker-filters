// Tab Manager panel in the toolbar popup: save the current tab to a collection (or a new
// one), save the whole window, close after saving, open the dashboard.
import { isSavableUrl, INBOX_NAME } from './store.js';
import { send, runOp, loadData, h } from './common.js';
import { getModuleStates } from '../../core/modules.js';
import { loadStyles, offNotice, favTile } from '../../core/panel.js';
import { hydrateIcons, ic } from '../../ui/icons.js';

const NEW_COLLECTION = '__new__';

const MARKUP = `
  <div class="cur-tab" style="--i:0"><span id="cur-fav"></span><div class="grow"><b id="cur-title"></b><span id="cur-url"></span></div></div>
  <label class="lbl-sm" for="target" style="--i:1">Simpan ke koleksi</label>
  <div class="select-wrap" style="--i:1"><select id="target"></select><i data-ic="chevronDown"></i></div>
  <input class="input tm-new-name" type="text" id="new-name" placeholder="Nama koleksi baru" maxlength="120" style="--i:1" hidden>
  <button class="btn primary block rp" type="button" id="save-tab" style="--i:2"><i data-ic="download"></i><span>Simpan tab ini</span></button>
  <button class="btn ghost block rp" type="button" id="save-session" style="--i:3"><i data-ic="layers"></i><span>Simpan semua tab di jendela ini</span></button>
  <label class="check" style="--i:4"><input type="checkbox" id="close-after"><span class="box"></span>Tutup tab setelah disimpan</label>
  <button class="btn ghost block sm rp" type="button" id="open-dashboard" style="--i:5"><i data-ic="external"></i>Buka Tab Manager</button>
  <p class="mcu-status" id="status" role="status" style="--i:6"></p>
`;

const shortUrl = (url) => url.replace(/^[a-z]+:\/\/(www\.)?/i, '');
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

export async function status() {
  if (!(await getModuleStates()).tabs) return 'nonaktif';
  const data = await loadData();
  return `${data.spaces.reduce((n, space) => n + space.collections.length, 0)} koleksi`;
}

export async function render(root) {
  await loadStyles(new URL('./panel.css', import.meta.url).href);
  if (!(await getModuleStates()).tabs) return void root.replaceChildren(offNotice());

  const [data, [tab]] = await Promise.all([loadData(), chrome.tabs.query({ active: true, currentWindow: true })]);
  const windowTabs = tab ? await chrome.tabs.query({ windowId: tab.windowId }) : [];
  if (!root.isConnected) return;

  const template = document.createElement('template');
  template.innerHTML = MARKUP;
  hydrateIcons(template.content);
  root.replaceChildren(template.content);
  const $ = (id) => root.querySelector(`#${id}`);
  const showStatus = (text) => { $('status').textContent = text; };

  const url = tab?.url || '';
  $('cur-fav').replaceWith(favTile(url, hostOf(url) || tab?.title || '?'));
  $('cur-title').textContent = tab?.title || url;
  $('cur-title').title = tab?.title || '';
  $('cur-url').textContent = shortUrl(url);
  $('cur-url').title = url;

  const savable = windowTabs.filter((t) => isSavableUrl(t.url || '')).length;
  $('save-session').querySelector('span').textContent = `Simpan semua tab di jendela ini (${savable})`;

  // Collection picker: inbox of the active space first, then every collection grouped by space.
  const select = $('target');
  select.append(h('option', { value: '' }, `${INBOX_NAME} (ruang aktif)`));
  const names = new Map();
  for (const space of data.spaces) {
    if (!space.collections.length) continue;
    for (const c of space.collections) names.set(c.id, c.name);
    select.append(h('optgroup', { label: space.name },
      space.collections.map((c) => h('option', { value: c.id }, `${c.starred ? '★ ' : ''}${c.name}`))));
  }
  select.append(h('option', { value: NEW_COLLECTION }, '+ Koleksi baru…'));

  if (!isSavableUrl(url)) {
    $('save-tab').disabled = true;
    select.disabled = true;
    showStatus('Halaman ini tidak bisa disimpan.');
  }

  select.addEventListener('change', () => {
    $('new-name').hidden = select.value !== NEW_COLLECTION;
    if (!$('new-name').hidden) $('new-name').focus();
  });

  $('close-after').checked = data.settings.closeAfterSave;
  $('close-after').addEventListener('change', (e) => runOp({ type: 'settings/update', settings: { closeAfterSave: e.target.checked } }));

  // Success: the button itself says where the tab went, then the popup closes.
  const done = (button, text) => {
    button.classList.add('done-state');
    button.classList.remove('primary', 'ghost');
    button.innerHTML = `${ic('check')}<span></span>`;
    button.querySelector('span').textContent = text;
    setTimeout(() => window.close(), 1100);
  };

  $('save-tab').addEventListener('click', async () => {
    const button = $('save-tab');
    if (button.classList.contains('done-state')) return;
    const info = { url, title: tab.title };
    let result;
    let target;
    if (select.value === NEW_COLLECTION) {
      target = $('new-name').value.trim() || 'Koleksi baru';
      result = await runOp({ type: 'collection/create', name: target, tabs: [info], index: 0 });
    } else {
      target = names.get(select.value) || INBOX_NAME;
      result = await send('tm:saveTab', { tab: info, collectionId: select.value || undefined });
    }
    if (!result?.ok) return showStatus(result?.error || 'Gagal menyimpan');
    if ($('close-after').checked) await chrome.tabs.remove(tab.id);
    showStatus('Tab disimpan');
    done(button, `Tersimpan di “${target}”`);
  });

  $('save-session').addEventListener('click', async () => {
    const button = $('save-session');
    if (button.classList.contains('done-state')) return;
    const result = await send('tm:saveSession', { windowId: tab?.windowId, close: $('close-after').checked });
    if (!result?.ok) return showStatus(result?.error || 'Gagal menyimpan');
    showStatus(`${result.saved} tab disimpan`);
    done(button, `${result.saved} tab tersimpan`);
  });

  $('open-dashboard').addEventListener('click', async () => {
    await chrome.tabs.create({ url: new URL('./newtab.html', import.meta.url).href });
    window.close();
  });
}
