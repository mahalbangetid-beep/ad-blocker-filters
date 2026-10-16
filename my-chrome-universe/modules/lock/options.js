import { send, showMessage } from './common.js';
import { guardPage } from '../../core/page-guard.js';

// Also shown inside the shared settings page's iframe.
const inFrame = window.top !== window;
await guardPage(inFrame ? 'frame' : 'tab');

const $ = (id) => document.getElementById(id);

// In the settings page the parent's "Aktif" switch is the single on/off control.
if (inFrame) $('enabled-section').hidden = true;

const errorText = (result) => (result.error === 'locked' ? 'Browser sedang terkunci.' : result.error);

async function render() {
  const state = await send('lock:getState');
  $('no-password').hidden = state.hasPassword;
  $('has-password').hidden = !state.hasPassword;
  $('status').textContent = !state.hasPassword
    ? 'Kunci belum aktif.'
    : state.enabled
      ? 'Kunci aktif: password diminta setiap kali browser dibuka.'
      : 'Browser Lock nonaktif: browser tidak dikunci. Password tetap tersimpan.';
  $('enabled').checked = state.enabled;
  $('disable-form').hidden = true;
  $('lock-now').disabled = !state.enabled;
  $('idle').value = String(state.settings.idleMinutes);
  $('screen-lock').checked = state.settings.lockOnScreenLock;
}

async function saveSettings() {
  const result = await send('lock:saveSettings', {
    settings: { idleMinutes: Number($('idle').value), lockOnScreenLock: $('screen-lock').checked },
  });
  showMessage($('settings-msg'), result.ok ? 'Pengaturan tersimpan.' : errorText(result), result.ok ? 'ok' : 'error');
}

$('go-setup').addEventListener('click', () => location.assign('setup.html'));
$('idle').addEventListener('change', saveSettings);
$('screen-lock').addEventListener('change', saveSettings);
$('lock-now').addEventListener('click', () => send('lock:lock'));

$('change-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await send('lock:changePassword', {
    current: $('current').value,
    password: $('new-password').value,
    confirm: $('confirm').value,
  });
  if (result.ok) event.target.reset();
  showMessage($('change-msg'), result.ok ? 'Password berhasil diganti.' : errorText(result), result.ok ? 'ok' : 'error');
});

// A new recovery code is shown once, then removed from the page.
$('recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await send('lock:newRecoveryCode', { current: $('recovery-current').value });
  event.target.reset();
  if (!result.ok) {
    showMessage($('recovery-msg'), errorText(result));
    return;
  }
  showMessage($('recovery-msg'), '');
  $('recovery-form').hidden = true;
  $('recovery-code').textContent = result.recoveryCode;
  $('recovery-result').hidden = false;
  $('recovery-noted').focus();
});

$('recovery-noted').addEventListener('click', () => {
  $('recovery-code').textContent = '';
  $('recovery-result').hidden = true;
  $('recovery-form').hidden = false;
  showMessage($('recovery-msg'), 'Kode pemulihan baru tersimpan. Kode yang lama tidak berlaku lagi.', 'ok');
});

// Turning on needs nothing; turning off asks for the current password first.
$('enabled').addEventListener('change', async () => {
  showMessage($('enabled-msg'), '');
  if (!$('enabled').checked) {
    $('enabled').checked = true; // stays on until the password is confirmed
    $('disable-form').hidden = false;
    $('disable-current').focus();
    return;
  }
  const result = await send('lock:setEnabled', { enabled: true });
  await render();
  showMessage($('enabled-msg'), result.ok ? 'Browser Lock diaktifkan.' : errorText(result), result.ok ? 'ok' : 'error');
});

$('disable-cancel').addEventListener('click', () => {
  $('disable-form').reset();
  $('disable-form').hidden = true;
});

$('disable-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await send('lock:setEnabled', { enabled: false, current: $('disable-current').value });
  event.target.reset();
  if (result.ok) {
    await render();
    showMessage($('enabled-msg'), 'Browser Lock dimatikan.', 'ok');
  } else {
    showMessage($('enabled-msg'), errorText(result));
  }
});

render();
