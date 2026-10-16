// Browser Lock panel in the toolbar popup: padlock, facts (auto-lock, screen lock, shortcut),
// lock now, settings link, and the password form that turning the lock off requires.
// The popup only opens while the lock is open, so the locked/setup states never show here.
import { send } from './common.js';
import { loadStyles, offNotice, messageLine } from '../../core/panel.js';
import { hydrateIcons } from '../../ui/icons.js';
import { shake, wait } from '../../ui/motion.js';

const errorText = (result) => (result?.error === 'locked' ? 'Browser sedang terkunci.' : result?.error || 'Gagal menyimpan');

// Inline form; prompt() is unreliable in popups.
const MARKUP = `
  <div class="lock-hero" id="lock-hero" style="--i:0">
    <svg class="big ic" viewBox="0 0 24 24" aria-hidden="true"><rect class="ic-body" x="3" y="11" width="18" height="11" rx="2"/><path class="shackle ic-body" d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16.5" r="1.2"/></svg>
    <b>Browser terbuka</b><span>Semua modul bisa dipakai</span>
  </div>
  <ul class="facts" style="--i:1">
    <li><i data-ic="clock"></i>Kunci otomatis <b id="fact-idle"></b></li>
    <li><i data-ic="monitor"></i>Kunci saat layar dikunci <b id="fact-screen"></b></li>
    <li><i data-ic="key"></i>Pintasan <span class="k" id="fact-key"></span></li>
  </ul>
  <button class="btn primary block rp" type="button" id="lock" style="--i:2"><i data-ic="lock"></i>Kunci sekarang</button>
  <form class="off-form" id="disable-form" style="--i:3" hidden>
    <label class="lbl-sm" for="disable-current">Password saat ini (wajib untuk mematikan)</label>
    <div class="off-row">
      <input class="input" type="password" id="disable-current" autocomplete="current-password" required>
      <button class="btn danger sm rp" type="submit">Matikan</button>
      <button class="btn ghost sm rp" type="button" id="disable-cancel">Batal</button>
    </div>
  </form>
  <button class="btn ghost block sm rp" type="button" id="lock-settings" style="--i:4"><i data-ic="sliders"></i>Atur Browser Lock</button>
`;

async function shortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((c) => c.name === 'lock-browser')?.shortcut || '';
  } catch {
    return '';
  }
}

export async function status() {
  const state = await send('lock:getState');
  return state.enabled ? 'aktif' : 'nonaktif';
}

function settingsButton() {
  const template = document.createElement('template');
  template.innerHTML = '<button class="btn ghost block sm rp" type="button" style="--i:1"><i data-ic="sliders"></i>Atur Browser Lock</button>';
  hydrateIcons(template.content);
  const button = template.content.firstElementChild;
  button.addEventListener('click', openSettings);
  return button;
}

async function openSettings() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#lock') });
  window.close();
}

// `disable`: opened from the card switch being turned off, so show the password form at once.
export async function render(root, { disable = false } = {}) {
  await loadStyles(new URL('./panel.css', import.meta.url).href);
  const [state, keys] = await Promise.all([send('lock:getState'), shortcut()]);
  if (!root.isConnected) return;
  if (!state.enabled) return void root.replaceChildren(offNotice(), settingsButton());

  const template = document.createElement('template');
  template.innerHTML = MARKUP;
  hydrateIcons(template.content);
  root.replaceChildren(template.content);
  const $ = (id) => root.querySelector(`#${id}`);
  const form = $('disable-form');
  const msg = messageLine();
  form.append(msg);

  const idle = state.settings?.idleMinutes || 0;
  $('fact-idle').textContent = idle ? `${idle} menit` : 'Mati';
  $('fact-screen').textContent = state.settings?.lockOnScreenLock ? 'Aktif' : 'Mati';
  if (keys) {
    $('fact-key').classList.add('keys');
    keys.split('+').forEach((k, i) => {
      if (i) $('fact-key').append('+');
      $('fact-key').append(Object.assign(document.createElement('kbd'), { textContent: k }));
    });
  } else {
    $('fact-key').textContent = 'Belum diatur';
  }

  const showForm = () => {
    form.hidden = false;
    $('disable-current').focus({ preventScroll: true });
    form.scrollIntoView({ block: 'nearest' });
  };
  if (disable) showForm();

  $('lock').addEventListener('click', async () => {
    $('lock-hero').classList.add('locking');
    await wait(450);
    await send('lock:lock').catch(() => {});
    window.close();
  });

  $('disable-cancel').addEventListener('click', () => {
    form.reset();
    msg.textContent = '';
    form.hidden = true;
  });

  $('lock-settings').addEventListener('click', openSettings);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await send('lock:setEnabled', { enabled: false, current: $('disable-current').value });
    form.reset();
    if (!root.isConnected) return; // panel closed meanwhile
    if (result?.ok) return void (await render(root));
    msg.textContent = errorText(result); // shown at once, before the shake
    form.scrollIntoView({ block: 'nearest' });
    shake(form);
    $('disable-current').focus();
  });
}
