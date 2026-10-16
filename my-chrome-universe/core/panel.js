// Helpers for the module panels shown inside the toolbar popup (popup.js).
// The popup removes everything a panel adds to <head> when the panel closes.
import { icon } from '../ui/icons.js';

// Adds a module stylesheet once; resolves when it has loaded (or failed).
export function loadStyles(href) {
  const url = new URL(href, location.href).href;
  if ([...document.head.querySelectorAll('link[rel=stylesheet]')].some((l) => l.href === url)) return Promise.resolve();
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url });
  const loaded = new Promise((done) => { link.onload = link.onerror = done; });
  document.head.append(link);
  return loaded;
}

// Adds a panel-specific <style> block once (keyed by `key`).
export function addStyle(key, css) {
  if (document.head.querySelector(`style[data-panel="${key}"]`)) return;
  const style = document.createElement('style');
  style.dataset.panel = key;
  style.textContent = css;
  document.head.append(style);
}

// The legacy "Aktif" switch row; only the settings page still uses it (the popup's switches
// live on the module cards).
export function moduleSwitch(checked, onChange) {
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked });
  input.setAttribute('aria-label', 'Aktif');
  input.addEventListener('change', () => onChange(input.checked));
  const toggle = document.createElement('span');
  toggle.className = 'mcu-switch';
  toggle.append(input, document.createElement('i'));
  const label = document.createElement('span');
  label.className = 'mcu-switch-label';
  label.textContent = 'Aktif';
  const row = document.createElement('div');
  row.className = 'mcu-module-switch';
  row.append(label, toggle);
  return { row, input };
}

// Shown instead of the panel's controls while the module is switched off.
export function offNotice() {
  const box = document.createElement('div');
  box.className = 'mcu-off';
  const text = document.createElement('p');
  text.textContent = 'Fitur ini sedang nonaktif.';
  const hint = document.createElement('span');
  hint.textContent = 'Nyalakan lewat sakelar di kartunya pada halaman utama popup.';
  box.append(icon('pause'), text, hint);
  return box;
}

// Short error line (empty until set; shown at once, no entrance delay).
export function messageLine() {
  const p = document.createElement('p');
  p.className = 'mcu-msg';
  p.setAttribute('role', 'alert');
  return p;
}

// Stable hue per name, for letter favicons.
export const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

// Favicon from Chrome's local cache inside a coloured tile; the first letter shows if it fails.
export function favTile(pageUrl, name) {
  const tile = document.createElement('span');
  tile.className = 'fav';
  tile.style.setProperty('--h', hue(name || '?'));
  const letter = (name || '?')[0].toUpperCase();
  if (!/^https?:/i.test(pageUrl || '')) {
    tile.textContent = letter;
    return tile;
  }
  const src = new URL(chrome.runtime.getURL('/_favicon/'));
  src.searchParams.set('pageUrl', pageUrl);
  src.searchParams.set('size', '32');
  const img = Object.assign(document.createElement('img'), { src: src.href, alt: '', width: 18, height: 18 });
  img.addEventListener('error', () => img.replaceWith(letter), { once: true });
  tile.append(img);
  return tile;
}
