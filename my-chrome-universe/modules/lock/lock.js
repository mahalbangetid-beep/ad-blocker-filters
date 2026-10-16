import { send, showMessage, secondsUntil } from './common.js';

const form = document.getElementById('form');
const input = document.getElementById('password');
const button = document.getElementById('unlock');
const msg = document.getElementById('msg');

let countdown = null;

function startLockout(retryAt) {
  clearInterval(countdown);
  const tick = () => {
    const left = secondsUntil(retryAt);
    if (left <= 0) {
      clearInterval(countdown);
      button.disabled = false;
      input.disabled = false;
      showMessage(msg, '');
      input.focus();
      return;
    }
    button.disabled = true;
    input.disabled = true;
    showMessage(msg, `Terlalu banyak percobaan salah. Coba lagi dalam ${left} detik.`);
  };
  tick();
  countdown = setInterval(tick, 1000);
}

const state = await send('lock:getState');
if (!state.locked) {
  // Nothing to unlock (e.g. the page was opened manually).
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
} else if (state.lockoutUntil > Date.now()) {
  startLockout(state.lockoutUntil);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  showMessage(msg, 'Memeriksa…', 'ok');

  const result = await send('lock:unlock', { password: input.value });
  input.value = '';

  if (result.ok) {
    showMessage(msg, 'Terbuka. Memulihkan tab…', 'ok');
    return; // The background closes this tab after restoring the saved tabs.
  }

  if (result.error === 'lockout' && result.retryAt) {
    startLockout(result.retryAt);
    return;
  }

  const hint = result.attemptsLeft > 0 ? ` Sisa ${result.attemptsLeft} percobaan sebelum dijeda.` : '';
  showMessage(msg, `Password salah.${hint}`);
  button.disabled = false;
  input.focus();
});
