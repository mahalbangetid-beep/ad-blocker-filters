import { send, showMessage } from './common.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const state = await send('getState');
  $('no-password').hidden = state.hasPassword;
  $('has-password').hidden = !state.hasPassword;
  $('status').textContent = state.hasPassword ? 'Kunci aktif: password diminta setiap kali browser dibuka.' : 'Kunci belum aktif.';
  $('idle').value = String(state.settings.idleMinutes);
  $('screen-lock').checked = state.settings.lockOnScreenLock;
}

async function saveSettings() {
  const result = await send('saveSettings', {
    settings: { idleMinutes: Number($('idle').value), lockOnScreenLock: $('screen-lock').checked },
  });
  showMessage($('settings-msg'), result.ok ? 'Pengaturan tersimpan.' : result.error, result.ok ? 'ok' : 'error');
}

$('go-setup').addEventListener('click', () => location.assign('setup.html'));
$('idle').addEventListener('change', saveSettings);
$('screen-lock').addEventListener('change', saveSettings);
$('lock-now').addEventListener('click', () => send('lock'));

$('change-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await send('changePassword', {
    current: $('current').value,
    password: $('new-password').value,
    confirm: $('confirm').value,
  });
  if (result.ok) event.target.reset();
  showMessage($('change-msg'), result.ok ? 'Password berhasil diganti.' : result.error, result.ok ? 'ok' : 'error');
});

$('remove-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!confirm('Hapus password? Browser tidak akan terkunci lagi.')) return;
  const result = await send('removePassword', { current: $('remove-current').value });
  event.target.reset();
  if (result.ok) {
    await render();
  } else {
    showMessage($('remove-msg'), result.error);
  }
});

render();
