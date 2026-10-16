// Page-side lock gate. Every extension page except the lock screen and setup awaits
// guardPage('tab' | 'popup') before reading any data: it resolves only while the lock is
// open and otherwise replaces the page with a short notice and never resolves.
import { lockStatus, guardAction, SETUP_PATH } from './gate.js';
import { MODULES_KEY } from './modules.js';
import { logo } from '../ui/icons.js';

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

// The notice uses the shared Universe styles; pages that do not load them get them here.
function ensureStyles() {
  for (const path of ['ui/tokens.css', 'ui/components.css']) {
    const href = chrome.runtime.getURL(path);
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) continue;
    document.head.append(el('link', { rel: 'stylesheet', href }));
  }
}

// A card with the orbit logo, a title, one line of help and an optional button. Shows no module data.
function showNotice(kind, title, text, button) {
  ensureStyles();
  const card = el('section', { className: 'guard-notice', role: 'alert' },
    logo(), el('h1', {}, title), el('p', {}, text));
  if (button) {
    const btn = el('button', { type: 'button', className: 'btn primary block rp', onclick: button.run }, button.label);
    card.append(btn);
  }
  const nebula = el('div', { className: 'nebula' }, el('i'), el('i'), el('i'));
  nebula.setAttribute('aria-hidden', 'true');
  document.body.removeAttribute('class');
  document.body.replaceChildren(el('main', { className: `guard guard-${kind === 'popup' ? 'popup' : 'tab'}` }, nebula, card));
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
      showNotice(kind, 'Buat password terlebih dahulu.', 'Browser Lock butuh password sebelum modul lain bisa dipakai.', {
        label: 'Buat password',
        run: async () => {
          await guardAction(); // opens or focuses the setup page
          if (kind === 'popup') window.close();
        },
      });
    }
  } else {
    showNotice(kind, 'Browser terkunci.', kind === 'popup'
      ? 'Buka layar kunci dan masukkan password untuk melanjutkan.'
      : 'Masukkan password di layar kunci untuk melanjutkan.', kind === 'popup' && {
      label: 'Buka layar kunci',
      run: async () => {
        await chrome.runtime.sendMessage({ type: 'lock:lock' }).catch(() => {});
        window.close();
      },
    });
  }
  return never();
}
