import { send, showMessage } from './common.js';

const form = document.getElementById('form');
const msg = document.getElementById('msg');
const saveButton = document.getElementById('save');
const recovery = document.getElementById('recovery');
const code = document.getElementById('code');

const state = await send('lock:getState');
if (state.hasPassword) {
  location.replace('options.html');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  showMessage(msg, '');

  const result = await send('lock:setup', {
    password: document.getElementById('password').value,
    confirm: document.getElementById('confirm').value,
  });

  if (result.ok) {
    // The recovery code exists only in this reply; show it once.
    form.reset();
    form.hidden = true;
    code.textContent = result.recoveryCode;
    recovery.hidden = false;
    document.getElementById('noted').focus();
  } else {
    showMessage(msg, result.error);
    saveButton.disabled = false;
  }
});

document.getElementById('noted').addEventListener('click', () => {
  code.textContent = '';
  location.replace('options.html');
});
