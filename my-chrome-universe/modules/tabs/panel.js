// Tab Manager panel in the toolbar popup (formerly this module's own popup).
import { isSavableUrl, INBOX_NAME } from './store.js';
import { send, runOp, loadData, faviconUrl, h, applyTheme } from './common.js';
import { getModuleStates } from '../../core/modules.js';
import { loadStyles, addStyle, moduleSwitch, offNotice, messageLine } from '../../core/panel.js';

const NEW_COLLECTION = '__new__';

const CSS = `
  html, body { height: auto; }
  body { display: block; }
  .tm-panel { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .tm-panel .current { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); min-width: 0; }
  .tm-panel .current img { width: 16px; height: 16px; flex: none; }
  .tm-panel .current span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tm-panel select, .tm-panel input[type="text"] { width: 100%; padding: 7px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  .tm-panel hr { border: 0; border-top: 1px solid var(--border); margin: 2px 0; width: 100%; }
  .tm-panel .status { min-height: 1.3em; margin: 0; font-size: 13px; color: var(--muted); }
  .tm-panel button:disabled, .tm-panel select:disabled { opacity: .5; cursor: not-allowed; }
`;

const MARKUP = `
  <div class="current" id="current"></div>
  <label class="check" for="target">Simpan tab ini ke:</label>
  <select id="target"></select>
  <input type="text" id="new-name" placeholder="Nama koleksi baru" hidden>
  <button class="primary-btn" id="save-tab">Simpan tab ini</button>

  <hr>
  <button class="ghost-btn" id="save-session">Simpan semua tab di jendela ini</button>
  <label class="check"><input type="checkbox" id="close-after"> Tutup tab setelah disimpan</label>

  <hr>
  <button class="ghost-btn" id="open-dashboard">Buka Tab Manager</button>
  <p class="status" id="status" role="status"></p>
`;

export async function status() {
  if (!(await getModuleStates()).tabs) return 'nonaktif';
  const data = await loadData();
  return `${data.spaces.reduce((n, space) => n + space.collections.length, 0)} koleksi`;
}

export async function render(root) {
  await loadStyles(new URL('./newtab.css', import.meta.url).href);
  addStyle('tabs', CSS);
  const enabled = (await getModuleStates()).tabs;

  const { row } = moduleSwitch(enabled, async (on) => {
    const result = await send('core:setModule', { id: 'tabs', enabled: on });
    if (!root.isConnected) return; // panel closed meanwhile
    root.replaceChildren();
    await render(root);
    if (!result?.ok) root.querySelector('.mcu-msg').textContent = result?.error || 'Gagal menyimpan';
  });
  root.replaceChildren(row, messageLine());
  if (!enabled) return void root.append(offNotice());

  const main = document.createElement('div');
  main.className = 'tm-panel';
  main.innerHTML = MARKUP;
  root.append(main);

  const $ = (id) => main.querySelector(`#${id}`);
  const data = await loadData();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  applyTheme(data.settings.theme);

  const showStatus = (text) => { $('status').textContent = text; };

  const url = tab?.url || '';
  $('current').append(h('img', { src: faviconUrl(url), alt: '' }), h('span', { title: url }, tab?.title || url));

  // Collection picker: inbox of the active space first, then every collection grouped by space.
  const select = $('target');
  select.append(h('option', { value: '' }, `${INBOX_NAME} (ruang aktif)`));
  for (const space of data.spaces) {
    if (!space.collections.length) continue;
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

  $('save-tab').addEventListener('click', async () => {
    const info = { url, title: tab.title };
    let result;
    if (select.value === NEW_COLLECTION) {
      const name = $('new-name').value.trim() || 'Koleksi baru';
      result = await runOp({ type: 'collection/create', name, tabs: [info], index: 0 });
    } else {
      result = await send('tm:saveTab', { tab: info, collectionId: select.value || undefined });
    }
    if (!result?.ok) return showStatus(result?.error || 'Gagal menyimpan');
    if ($('close-after').checked) await chrome.tabs.remove(tab.id);
    showStatus('Tab disimpan ✓');
    setTimeout(() => window.close(), 700);
  });

  $('save-session').addEventListener('click', async () => {
    const result = await send('tm:saveSession', { windowId: tab?.windowId, close: $('close-after').checked });
    if (!result?.ok) return showStatus(result?.error || 'Gagal menyimpan');
    showStatus(`${result.saved} tab disimpan ✓`);
    setTimeout(() => window.close(), 700);
  });

  $('open-dashboard').addEventListener('click', async () => {
    await chrome.tabs.create({ url: new URL('./newtab.html', import.meta.url).href });
    window.close();
  });
}
