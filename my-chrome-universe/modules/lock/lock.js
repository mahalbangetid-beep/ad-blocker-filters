import { send, showMessage, secondsUntil } from './common.js';
import { initAppearance, consumeWelcome } from '/ui/appearance.js';
import { hydrateIcons, ic } from '/ui/icons.js';
import { animate, installEffects, motionLevel, shake, toast, wait } from '/ui/motion.js';
import { createSky } from '/ui/sky.js';
import { playWelcome } from '/ui/welcome.js';

const $ = (id) => document.getElementById(id);

const scene = $('login');
const card = document.querySelector('.login-card');

const form = $('form');
const input = $('password');
const eye = $('eye');
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
const throttled = [input, eye, button, codeInput, newPassword, confirmInput, recoverButton];

// After a successful recovery the new password stays only here, until it unlocks the browser.
let pendingPassword = null;

let countdown = null;
let busy = false;
let sky = null;

hydrateIcons();
installEffects();

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

// Turns the card like a page: half a turn out, swap the face, half a turn back in.
let flipping = false;
async function flip(view, focusEl) {
  if (flipping) return;
  flipping = true;
  try {
    await animate(card, [{ transform: 'perspective(1200px) rotateY(0)' }, { transform: 'perspective(1200px) rotateY(90deg)', opacity: 0.4 }],
      { duration: 220, easing: 'cubic-bezier(.55,0,1,.45)' }).finished;
    showView(view);
    animate(card, [{ transform: 'perspective(1200px) rotateY(-90deg)', opacity: 0.4 }, { transform: 'perspective(1200px) rotateY(0)', opacity: 1 }],
      { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    if (countdown) refreshLockout();
    else focusEl.focus({ preventScroll: true });
  } finally {
    flipping = false;
  }
}

function setLoading(btn, on) {
  btn.classList.toggle('loading', on);
  if (on) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
}

// Success: check mark, open shackle, sparks, then warp out and let the service worker turn this
// tab into the dashboard (it falls back on its own after a few seconds if this never arrives).
async function leave(btn, msgEl) {
  scene.inert = true; // nothing can flip or submit the card during the success beat
  showMessage(msgEl, 'Terbuka. Memulihkan tab…', 'ok');
  btn.classList.add('ok');
  card.classList.add('unlocked');
  const mark = card.querySelector('.face:not([hidden]) .lc-mark');
  if (mark) sky?.burstAt(mark, 34);
  await wait(600);
  sky?.warp(1100);
  scene.classList.add('leave-warp');
  await wait(700);
  send('lock:handoff').catch(() => {});
}

function enterLogin(fromStartup, savedTabs) {
  scene.inert = false;
  scene.classList.add('is-active');
  if (!fromStartup) {
    toast(savedTabs > 0
      ? `Browser dikunci. ${savedTabs} tab disimpan dan akan dipulihkan setelah dibuka.`
      : 'Browser dikunci.', { icon: 'lock' });
  }
  if (!countdown) input.focus({ preventScroll: true });
}

function showFoot(settings) {
  const minutes = settings?.idleMinutes || 0;
  if (!minutes) return;
  $('foot-text').textContent = `Kunci otomatis setelah ${minutes} menit tidak aktif`;
  $('foot').hidden = false;
}

input.addEventListener('input', () => {
  input.classList.remove('err');
  if (!countdown && msg.textContent && !msg.classList.contains('ok')) showMessage(msg, '');
  if (motionLevel() === 'full' && sky) {
    const r = input.getBoundingClientRect();
    sky.burst(r.left + Math.min(r.width - 50, 18 + input.value.length * 9), r.top + r.height / 2, 4);
  }
});

eye.addEventListener('click', () => {
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  eye.innerHTML = ic(show ? 'eyeOff' : 'eye');
  eye.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
  eye.setAttribute('aria-pressed', String(show));
  input.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || countdown) return;
  if (!input.value) {
    showMessage(msg, 'Masukkan password dulu.');
    input.classList.add('err');
    shake(card);
    input.focus();
    return;
  }
  busy = true;
  setLoading(button, true);
  showMessage(msg, '');

  let result;
  try {
    result = await send('lock:unlock', { password: input.value });
  } finally {
    input.value = '';
    setLoading(button, false);
  }

  if (result.ok) {
    leave(button, msg);
    return; // busy stays set: the tab becomes the dashboard
  }
  busy = false;

  if (result.error === 'lockout' && result.retryAt) {
    startLockout(result.retryAt);
    shake(card);
    return;
  }

  showMessage(msg, `Password salah.${attemptsHint(result)}`);
  input.classList.add('err');
  shake(card);
  input.focus();
});

$('forgot').addEventListener('click', () => flip(recoverForm, codeInput));

$('back').addEventListener('click', () => {
  recoverForm.reset();
  flip(form, input);
});

recoverForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || countdown) return;
  busy = true;
  setLoading(recoverButton, true);
  showMessage(recoverMsg, '');

  const password = newPassword.value;
  let result;
  try {
    result = await send('lock:recover', { code: codeInput.value, password, confirm: confirmInput.value });
  } finally {
    setLoading(recoverButton, false);
    busy = false;
  }

  if (result.ok) {
    // The new code is shown at once; the card only pulses around it.
    pendingPassword = password;
    recoverForm.reset();
    newCode.textContent = result.recoveryCode;
    showView(recovered);
    openButton.focus();
    animate(card, [{ transform: 'scale(.97)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    sky?.burstAt(recovered.querySelector('.lc-mark'), 22);
    return;
  }

  if (result.error === 'lockout' && result.retryAt) {
    startLockout(result.retryAt);
    shake(card);
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
  shake(card);
});

openButton.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  setLoading(openButton, true);
  let result;
  try {
    result = await send('lock:unlock', { password: pendingPassword });
  } finally {
    setLoading(openButton, false);
  }
  pendingPassword = null;
  newCode.textContent = '';

  if (result.ok) {
    leave(openButton, $('open-msg'));
    return;
  }
  busy = false;

  // Unexpected (e.g. a lockout started meanwhile): fall back to the normal password form.
  showView(form);
  if (result.error === 'lockout' && result.retryAt) startLockout(result.retryAt);
  else showMessage(msg, 'Password baru sudah tersimpan. Masukkan password baru untuk membuka browser.');
});

// Listeners are in place; now decide how the screen enters.
const state = await send('lock:getState');
if (!state.locked) {
  // Nothing to unlock (e.g. the page was opened manually).
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
} else {
  if (state.lockoutUntil > Date.now()) startLockout(state.lockoutUntil);
  showFoot(state.settings);
  await initAppearance().catch(() => {});
  const welcome = await consumeWelcome().catch(() => false);
  // The login is the only way to unlock: it appears even if the sky or the welcome fails.
  try {
    sky = createSky($('sky'), { mode: welcome ? 'welcome' : 'orbit', fxCanvas: $('fx') });
    // The card stays inert (not focusable or clickable) until the welcome is over.
    if (welcome) await playWelcome($('welcome'), sky);
    else sky.reverse(900);
  } catch {
    $('welcome').hidden = true;
  } finally {
    enterLogin(welcome, state.savedTabs);
  }
}
