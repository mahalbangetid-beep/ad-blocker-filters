// Helpers shared by the dashboard and the popup panel.
import { STORAGE_KEY, normalize, emptyData } from './store.js';

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export const runOp = (op) => send('tm:op', { op });

export async function loadData() {
  const { [STORAGE_KEY]: data } = await chrome.storage.local.get(STORAGE_KEY);
  return normalize(data || emptyData());
}

export function onDataChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) callback(normalize(changes[STORAGE_KEY].newValue || emptyData()));
  });
}

// Uses Chrome's local favicon cache (the "favicon" permission), so no request
// leaves the browser.
export function faviconUrl(pageUrl, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

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

export function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
