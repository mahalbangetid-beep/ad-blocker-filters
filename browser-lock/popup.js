import { send } from './common.js';

const $ = (id) => document.getElementById(id);
const state = await send('getState');

if (state.locked) {
  $('status').textContent = 'Browser sedang terkunci.';
  $('options').hidden = true;
} else if (state.hasPassword) {
  $('status').textContent = 'Kunci aktif.';
  $('lock').hidden = false;
} else {
  $('status').textContent = 'Password belum diatur.';
  $('setup').hidden = false;
}

$('lock').addEventListener('click', async () => {
  await send('lock');
  window.close();
});
$('setup').addEventListener('click', () => {
  chrome.tabs.create({ url: 'setup.html' });
  window.close();
});
$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
