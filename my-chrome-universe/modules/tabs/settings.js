// Tab Manager section of the settings page: close after saving, JSON backup and bookmark import.
// Backup logic is shared with the dashboard palette (dashboard/backup.js).
import { h, row, toggleRow, button, rowMsg, showMsg } from '../../core/settings-ui.js';
import { runOp, loadData, onDataChanged } from './common.js';
import { exportData, readImportFile, importData, importBookmarks } from './dashboard/backup.js';
import { openDialog } from './dashboard/dialogs.js';

export const summary = { sub: 'Simpan, cadangan', desc: 'Cara tab disimpan dan cadangan datanya.' };

export async function render(root, ctx) {
  const data = await loadData();

  const closeAfter = toggleRow(ctx, {
    id: 'close-after-save', title: 'Tutup tab setelah disimpan', checked: data.settings.closeAfterSave,
    desc: 'Berlaku untuk "Simpan sesi" dan tombol simpan di popup.',
    save: (on) => runOp({ type: 'settings/update', settings: { closeAfterSave: on } }),
  });
  onDataChanged((next) => { closeAfter.input.checked = next.settings.closeAfterSave; });

  // ---------- backup ----------
  const file = h('input', { type: 'file', id: 'import-file', accept: '.json,application/json', hidden: true });
  const backup = row({
    title: 'Cadangan data',
    desc: 'Ekspor semua ruang, koleksi, dan tab ke file JSON, atau pulihkan dari file (juga file ekspor Toby).',
    control: h('span', { class: 'btn-row' },
      button('Ekspor JSON', { id: 'export-json', ic: 'download' }),
      button('Impor JSON', { id: 'import-json', ic: 'upload' }),
      file),
    extra: 'backup ekspor impor toby',
  });
  const backupMsg = rowMsg(backup);
  backup.querySelector('#export-json').addEventListener('click', async () => {
    exportData(await loadData());
    ctx.toast('Data diekspor ke file JSON', { icon: 'download' });
  });
  backup.querySelector('#import-json').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    showMsg(backupMsg, '');
    let incoming;
    try {
      incoming = await readImportFile(picked);
    } catch (err) {
      return showMsg(backupMsg, `Gagal membaca file: ${err.message}`);
    }
    const choice = await openDialog({
      title: 'Impor data',
      message: `File: ${picked.name}`,
      fields: [{
        name: 'mode',
        label: 'Cara impor',
        value: 'merge',
        options: [
          { value: 'merge', label: 'Tambahkan ke data yang ada' },
          { value: 'replace', label: 'Ganti semua data yang ada' },
        ],
      }],
      submitLabel: 'Impor',
    });
    if (!choice) return;
    const result = await importData(incoming, choice.mode);
    if (!result?.ok) return showMsg(backupMsg, result?.error || 'Gagal mengimpor');
    ctx.markSaved();
    ctx.toast('Data diimpor', { icon: 'upload' });
  });

  // ---------- bookmarks ----------
  const bookmarks = row({
    title: 'Impor bookmark Chrome',
    desc: 'Setiap folder bookmark menjadi satu koleksi di ruang "Bookmark Chrome". Chrome meminta izin membaca bookmark lebih dulu.',
    control: button('Impor bookmark', { id: 'import-bookmarks', ic: 'folder' }),
    extra: 'bookmark penanda',
  });
  // Called straight from the click: the permission request needs the user gesture.
  bookmarks.querySelector('#import-bookmarks').addEventListener('click', async () => {
    showMsg(rowMsg(bookmarks), '');
    const result = await importBookmarks();
    if (!result?.ok) return showMsg(rowMsg(bookmarks), result?.error || 'Gagal mengimpor bookmark');
    ctx.markSaved();
    ctx.toast(`${result.count} folder bookmark diimpor ke ruang “Bookmark Chrome”`, { icon: 'upload' });
  });

  const dashboard = row({
    title: 'Dashboard',
    desc: 'Ruang, koleksi, dan tab tersimpan di halaman New Tab.',
    control: button('Buka dashboard', { id: 'open-dashboard', ic: 'layers', onclick: () => location.assign(chrome.runtime.getURL('modules/tabs/newtab.html')) }),
  });

  root.replaceChildren(closeAfter.item, backup, bookmarks, dashboard);
}
