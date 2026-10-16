import { send, showMessage, secondsUntil } from './common.js';

const $ = (id) => document.getElementById(id);

const form = $('form');
const input = $('password');
const button = $('unlock');
const msg = $('msg');

const recoverForm = $('recover-form');
const codeInput = $('code');
const newPassword = $('new-password');
const confirmInput = $('confirm');
const recoverButton = $('recover');
const recoverMsg = $('recover-msg');

const recovered = $('recovered');
const newCode = $('new-code');
const openButton = $('open');

// Password and recovery code share one attempt counter, so a lockout disables both forms.
const throttled = [input, button, codeInput, newPassword, confirmInput, recoverButton];

// After a successful recovery the new password stays only here, until it unlocks the browser.
let pendingPassword = null;

let countdown = null;

function visibleMessage() {
  return recoverForm.hidden ? msg : recoverMsg;
}

function focusVisible() {
  (recoverForm.hidden ? input : codeInput).focus();
}

function startLockout(retryAt) {
  clearInterval(countdown);
  const tick = () => {
    const left = secondsUntil(retryAt);
    if (left <= 0) {
      clearInterval(countdown);
      countdown = null;
      for (const el of throttled) el.disabled = false;
      showMessage(visibleMessage(), '');
      focusVisible();
      return;
    }
    for (const el of throttled) el.disabled = true;
    showMessage(visibleMessage(), `Terlalu banyak percobaan salah. Coba lagi dalam ${left} detik.`);
  };
  tick();
  countdown = setInterval(tick, 1000);
}

function attemptsHint(result) {
  return result.attemptsLeft > 0 ? ` Sisa ${result.attemptsLeft} percobaan sebelum dijeda.` : '';
}

function showView(view) {
  form.hidden = view !== form;
  recoverForm.hidden = view !== recoverForm;
  recovered.hidden = view !== recovered;
  showMessage(msg, '');
  showMessage(recoverMsg, '');
}

async function refreshLockout() {
  const state = await send('lock:getState');
  if (state.lockoutUntil > Date.now()) startLockout(state.lockoutUntil);
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

  showMessage(msg, `Password salah.${attemptsHint(result)}`);
  button.disabled = false;
  input.focus();
});

$('forgot').addEventListener('click', () => {
  showView(recoverForm);
  if (countdown) refreshLockout();
  else codeInput.focus();
});

$('back').addEventListener('click', () => {
  recoverForm.reset();
  showView(form);
  if (countdown) refreshLockout();
  else input.focus();
});

recoverForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  recoverButton.disabled = true;
  showMessage(recoverMsg, 'Memeriksa…', 'ok');

  const password = newPassword.value;
  const result = await send('lock:recover', { code: codeInput.value, password, confirm: confirmInput.value });

  if (result.ok) {
    pendingPassword = password;
    recoverForm.reset();
    newCode.textContent = result.recoveryCode;
    showView(recovered);
    openButton.focus();
    return;
  }

  if (result.error === 'lockout' && result.retryAt) {
    startLockout(result.retryAt);
    return;
  }

  // 'wrong' means the code was checked; anything else is a message about the new password.
  if (result.error === 'wrong') {
    showMessage(recoverMsg, `Kode pemulihan salah.${attemptsHint(result)}`);
    codeInput.focus();
  } else {
    showMessage(recoverMsg, result.error);
    newPassword.focus();
  }
  recoverButton.disabled = false;
});

openButton.addEventListener('click', async () => {
  openButton.disabled = true;
  const result = await send('lock:unlock', { password: pendingPassword });
  pendingPassword = null;
  newCode.textContent = '';

  if (result.ok) {
    showMessage($('open-msg'), 'Terbuka. Memulihkan tab…', 'ok');
    return; // The background closes this tab after restoring the saved tabs.
  }

  // Unexpected (e.g. a lockout started meanwhile): fall back to the normal password form.
  showView(form);
  if (result.error === 'lockout' && result.retryAt) startLockout(result.retryAt);
  else showMessage(msg, 'Password baru sudah tersimpan. Masukkan password baru untuk membuka browser.');
});
