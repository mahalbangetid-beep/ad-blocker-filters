// Core service-worker wiring shared by all modules.
import { MODULES, getModuleStates, onModuleStatesChanged, setModuleState } from './modules.js';
import { messageAllowed, senderAllowed } from './gate.js';
import { rebuildMenus } from './menus.js';

// Context menus are rebuilt from the module providers whenever they may be stale.
chrome.runtime.onInstalled.addListener(() => { rebuildMenus().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { rebuildMenus().catch(() => {}); });
onModuleStatesChanged(() => { rebuildMenus().catch(() => {}); });

// Module switches. Browser Lock is switched only by lock:setEnabled, which checks the password.
const handlers = {
  async 'core:getModules'() {
    return { ok: true, modules: await getModuleStates() };
  },

  async 'core:setModule'({ id, enabled }) {
    if (id === 'lock') return { ok: false, error: 'Gunakan pengaturan Browser Lock' };
    if (!MODULES.some((m) => m.id === id)) return { ok: false, error: 'Modul tidak dikenal' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Permintaan tidak valid.' };
    return { ok: true, modules: await setModuleState(id, enabled) };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) return false;
  if (!senderAllowed(sender, type)) {
    sendResponse({ ok: false, error: 'forbidden' });
    return false;
  }
  (async () => {
    if (!(await messageAllowed(type))) return { ok: false, error: 'locked' };
    return handlers[type](message);
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
