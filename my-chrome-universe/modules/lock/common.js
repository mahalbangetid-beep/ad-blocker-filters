// Helpers shared by the extension pages.

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export function showMessage(el, text, kind = 'error') {
  el.textContent = text || '';
  el.className = `msg ${text ? kind : ''}`;
}

// The key combination set for "lock-browser" in chrome://extensions/shortcuts ('' if none).
export async function lockShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((c) => c.name === 'lock-browser')?.shortcut || '';
  } catch {
    return '';
  }
}

export function secondsUntil(timestamp) {
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}
