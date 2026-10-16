// Browser Lock section of the settings page: on/off (off needs the current password), auto-lock,
// screen lock, lock now, change password and a new one-time recovery code.
import {
  h, row, toggleRow, expandRow, expandButton, field, button, msgLine, showMsg, errorText, formError, switchEl, itemText, rowMsg,
} from '../../core/settings-ui.js';
import { guardAction } from '../../core/gate.js';
import { onModuleStatesChanged } from '../../core/modules.js';
import { lockShortcut } from './common.js';
import { collapseThenLock } from '../../ui/motion.js';

export const summary = { sub: 'Password, kunci otomatis', desc: 'Kapan browser terkunci dan cara membukanya kembali.' };

const statusText = (on) => (on
  ? 'Aktif: password diminta setiap kali browser dibuka. Mematikannya butuh password saat ini.'
  : 'Nonaktif: browser tidak dikunci saat dibuka, saat tidak ada aktivitas, saat layar dikunci, maupun lewat shortcut. Password tetap tersimpan, jadi mengaktifkan kembali tidak perlu password baru.');

export async function render(root, ctx) {
  const [state, keys] = await Promise.all([ctx.send('lock:getState'), lockShortcut()]);
  if (!state?.hasPassword) return renderSetup(root);

  let enabled = state.enabled;
  let settings = { ...state.settings };
  // Lock settings are one stored object: every save sends all latest wanted values (including
  // ones still being saved), one save at a time, so rows never overwrite each other.
  const wanted = { ...settings };
  let queue = Promise.resolve();
  function sendSettings(patch) {
    Object.assign(wanted, patch);
    const run = queue.then(async () => {
      const result = await ctx.send('lock:saveSettings', { settings: { ...wanted } });
      if (result?.ok) settings = result.settings;
      // A failed value falls back to the saved one, unless a newer change of that key is queued.
      else for (const [key, value] of Object.entries(patch)) if (wanted[key] === value) wanted[key] = settings[key];
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }
  const rows = [enabledRow(), idleRow(), screenRow(), lockNowRow(), changeRow(), recoveryRow(),
    row({ title: 'Mode Incognito', desc: 'Kunci ini mencegah orang lain memakai browser secara langsung, tapi bukan enkripsi. Agar mode Incognito juga terkunci, aktifkan "Izinkan dalam mode Incognito" di chrome://extensions.' })];
  root.replaceChildren(...rows.map((r) => r.item || r));
  const lockNow = rows[3].button;

  // ---------- on/off ----------
  function enabledRow() {
    const { input, el } = switchEl({ id: 'lock-enabled', checked: enabled, 'aria-label': 'Browser Lock aktif' });
    const status = h('span', { class: 'item-desc', id: 'lock-status' }, statusText(enabled));
    const msg = msgLine('disable-msg');
    const pass = field('disable-current', 'Password saat ini (wajib untuk mematikan)');
    const form = h('form', { class: 'mini-form row-form', id: 'disable-form' }, pass,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn danger rp', type: 'submit' }, 'Matikan Browser Lock'),
        button('Batal', { id: 'disable-cancel', cls: 'btn ghost rp' })),
      msg);
    const x = expandRow({ title: 'Browser Lock aktif', desc: status, trigger: el, body: form });

    const sync = (on) => {
      enabled = on;
      input.checked = on;
      status.textContent = statusText(on);
      if (lockNow) lockNow.disabled = !on;
      if (!on && x.isOpen()) { form.reset(); x.setOpen(false); }
    };
    input.addEventListener('change', async () => {
      showMsg(msg, '');
      showMsg(rowMsg(x.item), '');
      if (!input.checked) {
        input.checked = true; // stays on until the password is confirmed
        x.setOpen(true);
        return;
      }
      const result = await ctx.send('lock:setEnabled', { enabled: true });
      if (!result?.ok) {
        input.checked = false;
        return showMsg(rowMsg(x.item), errorText(result));
      }
      sync(true);
      ctx.markSaved();
      ctx.toast('Browser Lock diaktifkan', { icon: 'lock' });
    });
    form.querySelector('#disable-cancel').addEventListener('click', () => {
      form.reset();
      showMsg(msg, '');
      x.setOpen(false, false);
      input.focus();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = form.querySelector('#disable-current').value;
      const result = await ctx.send('lock:setEnabled', { enabled: false, current });
      form.reset();
      if (!result?.ok) return formError(form, msg, errorText(result));
      sync(false);
      ctx.markSaved();
      ctx.toast('Browser Lock dimatikan. Aktifkan lagi kapan saja tanpa password baru.', { icon: 'check' });
    });
    // Switched elsewhere (popup card, another settings tab).
    onModuleStatesChanged((states) => { if (states.lock !== enabled) sync(states.lock); });
    return x;
  }

  // ---------- auto-lock and screen lock ----------
  async function saveSettings(item, patch) {
    showMsg(rowMsg(item), '');
    const result = await sendSettings(patch).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!result?.ok) {
      showMsg(rowMsg(item), errorText(result));
      return false;
    }
    ctx.markSaved();
    return true;
  }

  function idleRow() {
    const input = h('input', { type: 'range', id: 'idle', min: '0', max: '240', step: '1', value: String(settings.idleMinutes || 0) });
    const out = h('output', { for: 'idle' });
    const show = () => {
      const v = Number(input.value);
      input.style.setProperty('--p', `${(v / 240) * 100}%`);
      out.textContent = v ? `${v} menit` : 'Mati';
      input.setAttribute('aria-valuetext', out.textContent);
    };
    show();
    const item = h('div', { class: 'item' },
      itemText(h('label', { for: 'idle' }, 'Kunci otomatis saat tidak aktif'), 'Geser ke 0 untuk mematikan kunci otomatis.'),
      h('div', { class: 'range' }, input, out));
    item.dataset.searchExtra = 'idle menit waktu';
    // Saved while dragging (debounced) and once more on release.
    // Compared with the last value sent, not the last reply: a reply can still be on its way.
    let timer = 0;
    let sent = settings.idleMinutes;
    const save = () => {
      clearTimeout(timer);
      const value = Number(input.value);
      if (value === sent) return;
      sent = value;
      saveSettings(item, { idleMinutes: value }).then((ok) => { if (!ok) sent = settings.idleMinutes; });
    };
    input.addEventListener('input', () => {
      show();
      clearTimeout(timer);
      timer = setTimeout(save, 400);
    });
    input.addEventListener('change', save);
    return item;
  }

  function screenRow() {
    return toggleRow(ctx, {
      id: 'screen-lock', title: 'Kunci saat layar komputer dikunci', checked: settings.lockOnScreenLock,
      desc: 'Browser ikut terkunci ketika kamu mengunci layar komputer.',
      save: (on) => sendSettings({ lockOnScreenLock: on }),
    }).item;
  }

  function lockNowRow() {
    const lockButton = button('Kunci', { id: 'lock-now', ic: 'lock', cls: 'btn sm rp' });
    lockButton.disabled = !enabled;
    lockButton.addEventListener('click', async () => {
      lockButton.disabled = true;
      const result = await collapseThenLock(document.getElementById('st') || document.body);
      if (result?.ok) return; // the lock sweep closes this page
      lockButton.disabled = !enabled;
      ctx.toast(errorText(result, 'Gagal mengunci browser'), { icon: 'info' });
    });
    const parts = (keys || '').split('+').filter(Boolean);
    const keyBox = h('span', { class: 'keys' });
    parts.forEach((k, i) => keyBox.append(...(i ? ['+'] : []), h('kbd', {}, k)));
    if (!parts.length) keyBox.append(h('span', {}, 'Belum ada pintasan'));
    keyBox.append(lockButton);
    const item = row({ title: 'Kunci sekarang', desc: 'Pintasan keyboard di mana saja di Chrome.', control: keyBox, extra: `${keys} shortcut` });
    return { item, button: lockButton };
  }

  // ---------- password and recovery code ----------
  function changeRow() {
    const msg = msgLine('change-msg');
    const form = h('form', { class: 'mini-form', id: 'change-form' },
      field('current', 'Password saat ini'),
      field('new-password', 'Password baru', { autocomplete: 'new-password' }),
      field('confirm', 'Ulangi password baru', { autocomplete: 'new-password' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary rp', type: 'submit' }, 'Simpan password')),
      msg);
    const trigger = expandButton('Ubah');
    const x = expandRow({ title: 'Ganti password', desc: `Butuh password saat ini. Password baru minimal ${state.minLength || 8} karakter. Kode pemulihan tetap berlaku.`, trigger, body: form });
    trigger.addEventListener('click', () => x.setOpen(!x.isOpen()));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await ctx.send('lock:changePassword', {
        current: form.querySelector('#current').value,
        password: form.querySelector('#new-password').value,
        confirm: form.querySelector('#confirm').value,
      });
      if (!result?.ok) return formError(form, msg, errorText(result));
      form.reset();
      showMsg(msg, 'Password berhasil diganti.', 'ok');
      ctx.markSaved();
    });
    return x;
  }

  function recoveryRow() {
    const msg = msgLine('recovery-msg');
    const form = h('form', { class: 'mini-form row-form', id: 'recovery-form' },
      field('recovery-current', 'Password saat ini'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary rp', type: 'submit' }, 'Buat kode pemulihan')),
      msg);
    const code = h('p', { class: 'code', id: 'recovery-code' });
    const noted = button('Saya sudah mencatatnya', { id: 'recovery-noted', cls: 'btn primary sm rp', ic: 'check' });
    const result = h('div', { class: 'code-box', id: 'recovery-result', hidden: true }, code,
      h('p', {}, 'Simpan kode pemulihan ini di tempat aman. Kode ini hanya ditampilkan sekali dan bisa membuka browser bila kamu lupa password.'),
      h('div', { class: 'btn-row' }, noted));
    const trigger = expandButton('Buat kode baru');
    // The code is removed from the page and the form comes back when it is noted or the row closes.
    const clearCode = () => {
      code.textContent = '';
      result.hidden = true;
      form.hidden = false;
    };
    const x = expandRow({
      title: 'Kode pemulihan',
      desc: 'Kode pemulihan bisa membuka browser bila kamu lupa password. Membuat kode baru membuat kode yang lama tidak berlaku.',
      trigger, body: h('div', {}, form, result),
      onToggle: (open) => { if (!open) clearCode(); },
    });
    trigger.addEventListener('click', () => x.setOpen(!x.isOpen()));
    // A new code is shown once (at once, no animation), then removed from the page.
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const reply = await ctx.send('lock:newRecoveryCode', { current: form.querySelector('#recovery-current').value });
      form.reset();
      if (!reply?.ok) return formError(form, msg, errorText(reply));
      showMsg(msg, '');
      form.hidden = true;
      code.textContent = reply.recoveryCode;
      result.hidden = false;
      noted.focus({ preventScroll: true });
      ctx.markSaved();
    });
    noted.addEventListener('click', () => {
      clearCode();
      showMsg(msg, 'Kode pemulihan baru tersimpan. Kode yang lama tidak berlaku lagi.', 'ok');
    });
    return x;
  }
}

// No password yet (normally the page is sent to setup first): only the setup button.
function renderSetup(root) {
  const go = button('Atur password', { id: 'go-setup', cls: 'btn primary sm rp', ic: 'key', onclick: () => guardAction() });
  root.replaceChildren(row({ title: 'Belum ada password', desc: 'Atur password dulu agar browser bisa dikunci.', control: go }));
}
