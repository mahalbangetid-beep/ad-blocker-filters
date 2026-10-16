// Browser Lock panel in the toolbar popup (formerly this module's own popup).
// The popup only opens while the lock is open, so the locked/setup states never show here.
import { send, showMessage } from './common.js';
import { loadStyles, addStyle, moduleSwitch, offNotice } from '../../core/panel.js';

const errorText = (result) => (result?.error === 'locked' ? 'Browser sedang terkunci.' : result?.error || 'Gagal menyimpan');

const CSS = `
  .lock-panel { padding: 0 14px 14px; }
  .lock-panel p.sub { margin: 14px 0 0; }
  .lock-panel button { margin-top: 10px; }
  .lock-panel .msg { margin: 8px 0 0; min-height: 0; }
  .lock-panel .row { display: flex; gap: 8px; }
`;

// Inline form; prompt() is unreliable in popups.
const DISABLE_FORM = `
  <form id="disable-form" hidden>
    <label for="disable-current">Password saat ini (wajib untuk mematikan)</label>
    <input type="password" id="disable-current" autocomplete="current-password" required>
    <div class="row">
      <button type="submit" class="danger">Matikan</button>
      <button type="button" class="secondary" id="disable-cancel">Batal</button>
    </div>
  </form>
`;

export async function status() {
  const state = await send('lock:getState');
  return state.enabled ? 'aktif' : 'nonaktif';
}

export async function render(root) {
  await loadStyles(new URL('./style.css', import.meta.url).href);
  addStyle('lock', CSS);
  const state = await send('lock:getState');

  const main = document.createElement('div');
  main.className = 'lock-panel';
  const $ = (id) => main.querySelector(`#${id}`);

  // Turning on needs nothing; turning off asks for the current password first.
  const { row, input } = moduleSwitch(state.enabled, async (on) => {
    showMessage($('enabled-msg'), '');
    if (!on) {
      input.checked = true; // stays on until the password is confirmed
      $('disable-form').hidden = false;
      $('disable-current').focus();
      return;
    }
    const result = await send('lock:setEnabled', { enabled: true });
    if (!root.isConnected) return; // panel closed meanwhile
    root.replaceChildren();
    await render(root);
    if (!result?.ok) showMessage(root.querySelector('#enabled-msg'), errorText(result));
  });

  if (state.enabled) {
    main.innerHTML = `${DISABLE_FORM}
      <p class="sub" id="status">Kunci aktif.</p>
      <button type="button" id="lock">Kunci sekarang</button>
      <p class="msg" id="enabled-msg" role="alert"></p>`;
  } else {
    main.innerHTML = '<p class="msg" id="enabled-msg" role="alert"></p>';
  }
  root.replaceChildren(row, ...(state.enabled ? [] : [offNotice()]), main);
  if (!state.enabled) return;

  $('lock').addEventListener('click', async () => {
    await send('lock:lock');
    window.close();
  });

  $('disable-cancel').addEventListener('click', () => {
    $('disable-form').reset();
    $('disable-form').hidden = true;
  });

  $('disable-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await send('lock:setEnabled', { enabled: false, current: $('disable-current').value });
    event.target.reset();
    if (!root.isConnected) return; // panel closed meanwhile
    if (result?.ok) {
      root.replaceChildren();
      await render(root);
    } else {
      showMessage($('enabled-msg'), errorText(result));
    }
  });
}
