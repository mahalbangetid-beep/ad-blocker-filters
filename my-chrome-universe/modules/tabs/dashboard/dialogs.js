// Dashboard dialogs, popover menus and feedback, built on the shared .dialog/.menu/.toast components.
import { h } from '../common.js';
import { icon } from '../../../ui/icons.js';
import { toast } from '../../../ui/motion.js';

const $ = (id) => document.getElementById(id);

// Shows the reply's error, or `success` (text or fn(result)) when the operation worked.
export async function act(promise, success, successIcon = 'check') {
  const result = await promise;
  if (!result?.ok) toast(result?.error || 'Terjadi kesalahan', { icon: 'info' });
  else if (success) toast(typeof success === 'function' ? success(result) : success, { icon: successIcon });
  return result;
}

// Resolves to an object of field values, or null when cancelled.
export function openDialog({ title, message, fields = [], submitLabel = 'Simpan', danger = false }) {
  const dialog = $('dialog');
  const form = $('dialog-form');
  return new Promise((resolve) => {
    form.replaceChildren(...[
      h('h2', {}, title),
      message && h('p', {}, message),
      ...fields.map((f) => h('div', { class: 'field' },
        h('label', { for: `f-${f.name}` }, f.label),
        f.options
          ? h('select', { class: 'input', id: `f-${f.name}`, name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
          : h('input', { class: 'input', id: `f-${f.name}`, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, autocomplete: 'off' }))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn ghost sm rp', onclick: () => dialog.close('cancel') }, 'Batal'),
        h('button', { type: 'submit', value: 'ok', class: `btn sm rp ${danger ? 'danger' : 'primary'}` }, submitLabel)),
    ].filter(Boolean));
    dialog.returnValue = '';
    dialog.onclose = () => {
      if (dialog.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value])));
    };
    dialog.showModal();
    form.querySelector('input')?.select();
  });
}

export async function askText(title, label, value = '') {
  const result = await openDialog({ title, fields: [{ name: 'value', label, value, required: true }] });
  return result?.value.trim() || null;
}

export async function confirmDanger(title, message, submitLabel = 'Hapus') {
  return (await openDialog({ title, message, submitLabel, danger: true })) !== null;
}

// ---------- Popover menu ----------

let menuEl = null;

export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

// items: [{ label, ic, run, danger }] or '-' for a separator; falsy items are skipped.
export function showMenu(anchor, items) {
  closeMenu();
  let i = 0;
  menuEl = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((item) => (item === '-'
    ? h('hr', { class: 'menu-sep' })
    : h('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu-item${item.danger ? ' danger' : ''}`,
      style: `--i:${i++}`,
      onclick: () => { closeMenu(); item.run(); },
    }, item.ic && icon(item.ic), h('span', {}, item.label)))));
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menuEl.offsetWidth, innerWidth - menuEl.offsetWidth - 8));
  let top = r.bottom + 6;
  if (top + menuEl.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menuEl.offsetHeight - 6);
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
  menuEl.querySelector('button')?.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
