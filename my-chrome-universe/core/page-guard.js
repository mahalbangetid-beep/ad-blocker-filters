// Page-side lock gate. Every extension page except the lock screen and setup awaits
// guardPage() before reading any data: it resolves only while the lock is open and
// otherwise replaces the page with a short notice and never resolves.
import { lockStatus, guardAction, SETUP_PATH } from './gate.js';
import { MODULES_KEY } from './modules.js';

const never = () => new Promise(() => {});

// Anything that cannot determine the status counts as locked (fail closed).
async function currentStatus() {
  try {
    return await lockStatus();
  } catch {
    return 'locked';
  }
}

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function showNotice(text, button) {
  const box = el('div', {}, el('p', {}, text));
  box.style.cssText = 'padding:24px 16px;text-align:center;font:14px/1.5 system-ui,sans-serif';
  if (button) {
    const btn = el('button', { type: 'button', onclick: button.run }, button.label);
    btn.style.cssText = 'padding:7px 14px;font:inherit;cursor:pointer';
    box.append(btn);
  }
  document.body.removeAttribute('class');
  document.body.replaceChildren(box);
}

// While open, empty the page and reload as soon as the status changes to anything else.
function watch() {
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    const relevant = areaName === 'local'
      ? 'lock:auth' in changes || MODULES_KEY in changes
      : areaName === 'session' && 'lock:unlocked' in changes;
    if (!relevant || (await currentStatus()) === 'open') return;
    document.body.replaceChildren();
    location.reload();
  });
}

export async function guardPage(kind) {
  const status = await currentStatus();
  if (status === 'open') {
    watch();
    return;
  }
  if (status === 'setup') {
    if (kind === 'tab') {
      document.body.replaceChildren();
      location.replace(chrome.runtime.getURL(SETUP_PATH));
    } else {
      showNotice('Buat password terlebih dahulu.', {
        label: 'Buat password',
        run: async () => {
          await guardAction(); // opens or focuses the setup page
          if (kind === 'popup') window.close();
        },
      });
    }
  } else {
    showNotice('Browser terkunci.', kind === 'popup' && {
      label: 'Buka layar kunci',
      run: async () => {
        await chrome.runtime.sendMessage({ type: 'lock:lock' }).catch(() => {});
        window.close();
      },
    });
  }
  return never();
}
