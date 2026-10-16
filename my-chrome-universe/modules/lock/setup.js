import { send, showMessage } from './common.js';

const form = document.getElementById('form');
const msg = document.getElementById('msg');
const saveButton = document.getElementById('save');

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
    form.reset();
    showMessage(msg, 'Password tersimpan. Browser akan terkunci setiap kali dibuka. Tab ini bisa ditutup.', 'ok');
    saveButton.textContent = 'Buka Pengaturan';
    saveButton.disabled = false;
    saveButton.type = 'button';
    saveButton.onclick = () => location.replace('options.html');
  } else {
    showMessage(msg, result.error);
    saveButton.disabled = false;
  }
});
