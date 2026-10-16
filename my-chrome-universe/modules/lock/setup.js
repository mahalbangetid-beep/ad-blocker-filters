import { send, showMessage } from './common.js';
import { initAppearance, consumeWelcome } from '/ui/appearance.js';
import { hydrateIcons } from '/ui/icons.js';
import { animate, installEffects } from '/ui/motion.js';
import { createSky } from '/ui/sky.js';
import { playWelcome } from '/ui/welcome.js';

const $ = (id) => document.getElementById(id);
const scene = $('login');
const card = document.querySelector('.login-card');
const form = $('form');
const msg = $('msg');
const saveButton = $('save');
const recovery = $('recovery');
const code = $('code');

let sky = null;
let busy = false;

hydrateIcons();
installEffects();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  saveButton.classList.add('loading');
  saveButton.setAttribute('aria-busy', 'true');
  showMessage(msg, '');

  let result;
  try {
    result = await send('lock:setup', { password: $('password').value, confirm: $('confirm').value });
  } finally {
    saveButton.classList.remove('loading');
    saveButton.removeAttribute('aria-busy');
    busy = false;
  }

  if (result.ok) {
    // The recovery code exists only in this reply; show it once, at once.
    form.reset();
    form.hidden = true;
    code.textContent = result.recoveryCode;
    recovery.hidden = false;
    $('noted').focus();
    animate(card, [{ transform: 'scale(.97)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    sky?.burstAt(recovery.querySelector('.lc-mark'), 34);
  } else {
    showMessage(msg, result.error);
    $('password').focus();
  }
});

$('noted').addEventListener('click', () => {
  code.textContent = '';
  location.replace('/options.html#lock');
});

// Listeners are in place; now decide how the page enters.
const state = await send('lock:getState');
if (state.hasPassword) {
  location.replace('/options.html#lock');
} else {
  await initAppearance().catch(() => {});
  const welcome = await consumeWelcome().catch(() => false);
  // The form appears even if the sky or the welcome fails.
  try {
    sky = createSky($('sky'), { mode: welcome ? 'welcome' : 'orbit', fxCanvas: $('fx') });
    // The card stays inert (not focusable or clickable) until the welcome is over.
    if (welcome) await playWelcome($('welcome'), sky);
  } catch {
    $('welcome').hidden = true;
  } finally {
    scene.inert = false;
    scene.classList.add('is-active');
    $('password').focus({ preventScroll: true });
  }
}
