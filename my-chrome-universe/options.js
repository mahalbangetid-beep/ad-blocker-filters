// Shared settings page: one sidebar entry per module, content chosen by #<id>.
import { guardPage } from './core/page-guard.js';
import { MODULES } from './core/modules.js';
import { moduleSwitch, messageLine } from './core/panel.js';

await guardPage('tab');

const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const side = document.getElementById('side');
const main = document.getElementById('main');

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const currentModule = () => MODULES.find((m) => m.id === location.hash.slice(1)) || MODULES[0];

function renderMenu(active) {
  for (const a of side.querySelectorAll('a')) a.remove();
  for (const m of MODULES) {
    const a = el('a', { href: `#${m.id}` }, el('span', { textContent: m.icon }), m.name);
    if (m.id === active.id) a.setAttribute('aria-current', 'page');
    side.append(a);
  }
}

// Turning Browser Lock off needs the current password: inline field, never prompt().
function lockSwitch(enabled, msg, rerender) {
  const form = el('form', { hidden: true });
  const pass = el('input', { type: 'password', id: 'disable-current', autocomplete: 'current-password', required: true });
  const cancel = el('button', { type: 'button' }, 'Batal');
  form.append(
    el('label', { htmlFor: 'disable-current' }, 'Password saat ini (wajib untuk mematikan)'), pass,
    el('div', { className: 'row' }, el('button', { type: 'submit', className: 'danger' }, 'Matikan'), cancel),
  );
  const { row, input } = moduleSwitch(enabled, async (on) => {
    msg.textContent = '';
    if (!on) {
      input.checked = true; // stays on until the password is confirmed
      form.hidden = false;
      pass.focus();
      return;
    }
    const result = await send('lock:setEnabled', { enabled: true });
    await rerender();
    if (!result?.ok) msg.textContent = result?.error === 'locked' ? 'Browser sedang terkunci.' : result?.error || 'Gagal menyimpan';
  });
  cancel.addEventListener('click', () => { form.reset(); form.hidden = true; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await send('lock:setEnabled', { enabled: false, current: pass.value });
    form.reset();
    if (result?.ok) return void (await rerender());
    msg.textContent = result?.error === 'wrong' ? 'Password salah.' : result?.error || 'Gagal menyimpan';
  });
  return [row, form];
}

async function render() {
  const mod = currentModule();
  renderMenu(mod);
  document.title = `${mod.name} - Pengaturan`;
  const reply = await send('core:getModules');
  const enabled = reply?.modules?.[mod.id] !== false;
  const msg = messageLine();
  const rerender = () => render();

  let controls;
  if (mod.id === 'lock') {
    controls = lockSwitch(enabled, msg, rerender);
  } else {
    const { row } = moduleSwitch(enabled, async (on) => {
      const result = await send('core:setModule', { id: mod.id, enabled: on });
      await rerender();
      if (!result?.ok) main.querySelector('.mcu-msg').textContent = result?.error || 'Gagal menyimpan';
    });
    controls = [row];
  }

  const body = [];
  if (mod.options) {
    body.push(el('iframe', { id: 'frame', src: chrome.runtime.getURL(mod.options), title: `Pengaturan ${mod.name}` }));
  } else {
    body.push(el('button', {
      type: 'button',
      onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('modules/tabs/newtab.html') }),
    }, 'Buka dashboard'));
  }
  main.replaceChildren(el('h2', {}, `${mod.icon} ${mod.name}`), ...controls, msg, ...body);
}

addEventListener('hashchange', render);
await render();
