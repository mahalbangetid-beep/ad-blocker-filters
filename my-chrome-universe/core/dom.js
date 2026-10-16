// Tiny DOM helpers shared by the extension pages (popup, panels, settings, dashboard).

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

// User-facing text for a failed message reply.
export const errorText = (result, fallback = 'Gagal menyimpan') => (result?.error === 'locked'
  ? 'Browser sedang terkunci.'
  : result?.error || fallback);
