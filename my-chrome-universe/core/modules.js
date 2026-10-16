// Module registry and on/off state. Importable from the service worker and extension pages.
// `panel`: popup panel script; `settings`: settings section script (render(root, ctx), summary).
export const MODULES_KEY = 'core:modules';

export const MODULES = [
  { id: 'adblock', name: 'Ad Blocker', icon: 'shield', panel: 'modules/adblock/panel.js', settings: 'modules/adblock/settings.js' },
  { id: 'tabs', name: 'Tab Manager', icon: 'layers', panel: 'modules/tabs/panel.js', settings: 'modules/tabs/settings.js' },
  { id: 'lock', name: 'Browser Lock', icon: 'lock', panel: 'modules/lock/panel.js', settings: 'modules/lock/settings.js' },
];

async function readStored() {
  const stored = (await chrome.storage.local.get(MODULES_KEY))[MODULES_KEY];
  return stored && typeof stored === 'object' ? stored : {};
}

function withDefaults(stored) {
  return Object.fromEntries(MODULES.map((m) => [m.id, stored[m.id] !== false]));
}

export async function getModuleStates() {
  return withDefaults(await readStored());
}

export async function isModuleEnabled(id) {
  return (await getModuleStates())[id] !== false;
}

// Raw write; policy (e.g. lock rules) lives in the callers.
export async function setModuleState(id, enabled) {
  const stored = await readStored();
  stored[id] = !!enabled;
  await chrome.storage.local.set({ [MODULES_KEY]: stored });
  return withDefaults(stored);
}

export function onModuleStatesChanged(cb) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(MODULES_KEY in changes)) return;
    cb(withDefaults(changes[MODULES_KEY].newValue || {}));
  });
}
