// Helpers for the module panels shown inside the toolbar popup (popup.js).
// The popup removes everything a panel adds to <head> when the panel closes.

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

// The "Aktif" switch at the top of every panel. `onChange(checked)` handles the toggle.
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
  const p = document.createElement('p');
  p.className = 'mcu-off';
  p.textContent = 'Fitur ini sedang nonaktif.';
  return p;
}

// Short error line under the switch (empty until set).
export function messageLine() {
  const p = document.createElement('p');
  p.className = 'mcu-msg';
  p.setAttribute('role', 'alert');
  return p;
}
