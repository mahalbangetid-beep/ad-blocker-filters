// Helpers shared by the extension pages.

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export function showMessage(el, text, kind = 'error') {
  el.textContent = text || '';
  el.className = `msg ${text ? kind : ''}`;
}

export function secondsUntil(timestamp) {
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}
