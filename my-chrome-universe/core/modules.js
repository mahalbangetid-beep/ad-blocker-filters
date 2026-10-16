// Module registry and on/off state. Importable from the service worker and extension pages.
export const MODULES_KEY = 'core:modules';

export const MODULES = [
  { id: 'adblock', name: 'Ad Blocker', icon: 'shield', panel: 'modules/adblock/panel.js', options: 'modules/adblock/options.html' },
  { id: 'tabs', name: 'Tab Manager', icon: 'layers', panel: 'modules/tabs/panel.js', options: null },
  { id: 'lock', name: 'Browser Lock', icon: 'lock', panel: 'modules/lock/panel.js', options: 'modules/lock/options.html' },
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
