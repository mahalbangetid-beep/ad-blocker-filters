// Building blocks for the settings page sections (options.html). Each setting is one `.item`
// row; options.js fills `data-search` on every row after a section has rendered.
import { icon } from '../ui/icons.js';
import { shake } from '../ui/motion.js';

// Minimal DOM builder: h('div', { class: 'x', onclick }, child, 'text').
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Error/confirmation line under a control; shown at once (no entrance delay).
export function msgLine(id) {
  return h('p', { class: 'st-msg', id, role: 'alert' });
}

export function showMsg(el, text, kind = 'error') {
  el.textContent = text || '';
  el.classList.toggle('ok', kind === 'ok' && !!text);
}

export const errorText = (result, fallback = 'Gagal menyimpan') => (result?.error === 'locked'
  ? 'Browser sedang terkunci.'
  : result?.error || fallback);

// Title + description column of a row. `desc` may be a node (e.g. a live status span).
export function itemText(title, desc, { msgId } = {}) {
  const box = h('span', { class: 'item-text' }, h('span', { class: 'item-title' }, title));
  if (desc != null) box.append(desc instanceof Node ? desc : h('span', { class: 'item-desc' }, desc));
  const msg = msgLine(msgId);
  box.append(msg);
  return box;
}

export function rowMsg(item) {
  return item.querySelector('.item-text > .st-msg');
}

// Text on the left, `control` on the right. `extra` adds words for the settings search.
export function row({ title, desc, control, extra = '', block = false, tag = 'div', attrs = {} }) {
  const item = h(tag, { class: `item${block ? ' block' : ''}`, ...attrs }, itemText(title, desc), control);
  if (extra) item.dataset.searchExtra = extra.toLowerCase();
  return item;
}

export function switchEl(attrs) {
  const input = h('input', { type: 'checkbox', ...attrs });
  return { input, el: h('span', { class: 'sw' }, input, h('span', { class: 'track' }, h('span', { class: 'knob' }))) };
}

// A switch row saved at once: `save(checked)` resolves to the extension's reply; on failure
// the switch flips back and the error shows under the row.
export function toggleRow(ctx, { id, title, desc, checked, data, save }) {
  const { input, el } = switchEl({ id, checked: !!checked, dataset: data });
  const item = h('label', { class: 'item', for: id }, itemText(title, desc), el);
  input.addEventListener('change', async () => {
    const want = input.checked;
    showMsg(rowMsg(item), '');
    let result;
    try { result = await save(want); } catch (err) { result = { ok: false, error: String(err?.message || err) }; }
    if (result?.ok) return ctx.markSaved();
    input.checked = !want;
    showMsg(rowMsg(item), errorText(result));
  });
  return { item, input };
}

// Collapsible row (`.item.block` with `.x-body`); `trigger` is the control that opens it.
export function expandRow({ title, desc, trigger, body, extra }) {
  const inner = h('div', {}, body);
  const item = h('div', { class: 'item block' },
    h('div', { class: 'item-row' }, itemText(title, desc), trigger),
    h('div', { class: 'x-body' }, inner));
  if (extra) item.dataset.searchExtra = extra.toLowerCase();
  inner.inert = true;
  const setOpen = (open, focus = open) => {
    item.classList.toggle('open', open);
    inner.inert = !open;
    if (trigger.matches('button')) trigger.setAttribute('aria-expanded', String(open));
    if (focus) setTimeout(() => item.querySelector('.x-body input')?.focus({ preventScroll: true }), 60);
  };
  return { item, setOpen, isOpen: () => item.classList.contains('open') };
}

// Ghost button with a chevron that opens/closes an expandRow.
export function expandButton(label) {
  return h('button', { class: 'btn ghost sm rp x-toggle', type: 'button', 'aria-expanded': 'false' }, label, icon('chevronDown'));
}

export function field(id, label, { type = 'password', autocomplete = 'current-password' } = {}) {
  return h('div', { class: 'field' }, h('label', { for: id }, label),
    h('input', { class: 'input', id, type, autocomplete, required: true }));
}

export function button(label, { id, ic, cls = 'btn ghost sm rp', type = 'button', onclick } = {}) {
  return h('button', { class: cls, type, id, onclick }, ic && icon(ic), label);
}

// Radio segment with a sliding thumb. `onPick(value, button)` resolves true when saved.
export function segment({ id, label, options, value, onPick }) {
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label, dataset: { seg: id } }, h('span', { class: 'seg-thumb' }));
  const buttons = options.map(([v, text]) => h('button', { type: 'button', role: 'radio', dataset: { v } }, text));
  seg.append(...buttons);
  const set = (v) => {
    for (const b of buttons) {
      const on = b.dataset.v === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    moveThumb(seg);
  };
  let busy = false;
  const pick = async (b) => {
    if (busy || b.getAttribute('aria-checked') === 'true') return;
    const prev = buttons.find((x) => x.getAttribute('aria-checked') === 'true')?.dataset.v;
    busy = true;
    set(b.dataset.v);
    const ok = await onPick(b.dataset.v, b).catch(() => false);
    busy = false;
    if (!ok) set(prev);
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) pick(b);
  });
  seg.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = buttons.findIndex((x) => x.getAttribute('aria-checked') === 'true');
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.focus();
    pick(next);
  });
  set(value);
  return { el: seg, set };
}

export function moveThumb(seg) {
  const b = seg.querySelector('[aria-checked="true"]');
  const thumb = seg.querySelector('.seg-thumb');
  if (!b || !b.offsetWidth) return;
  const first = !thumb.style.width; // place the first time without sliding in from the left
  if (first) thumb.style.transition = 'none';
  thumb.style.width = `${b.offsetWidth}px`;
  thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  if (first) requestAnimationFrame(() => requestAnimationFrame(() => { thumb.style.transition = ''; }));
}

// Shows a form error at once and shakes the form.
export function formError(form, msgEl, text) {
  showMsg(msgEl, text);
  shake(form);
}
