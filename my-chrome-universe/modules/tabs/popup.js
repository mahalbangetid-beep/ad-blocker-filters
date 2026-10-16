import { isSavableUrl, INBOX_NAME } from './store.js';
import { send, runOp, loadData, faviconUrl, h, applyTheme } from './common.js';
import { guardPage } from '../../core/page-guard.js';

await guardPage('popup');

const $ = (id) => document.getElementById(id);
const NEW_COLLECTION = '__new__';

const data = await loadData();
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
applyTheme(data.settings.theme);

function status(text) {
  $('status').textContent = text;
}

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
  status('Halaman ini tidak bisa disimpan.');
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
  if (!result?.ok) return status(result?.error || 'Gagal menyimpan');
  if ($('close-after').checked) await chrome.tabs.remove(tab.id);
  status('Tab disimpan ✓');
  setTimeout(() => window.close(), 700);
});

$('save-session').addEventListener('click', async () => {
  const result = await send('tm:saveSession', { windowId: tab?.windowId, close: $('close-after').checked });
  if (!result?.ok) return status(result?.error || 'Gagal menyimpan');
  status(`${result.saved} tab disimpan ✓`);
  setTimeout(() => window.close(), 700);
});

$('open-dashboard').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'newtab.html' });
  window.close();
});
