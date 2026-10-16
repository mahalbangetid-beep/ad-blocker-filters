// Core service-worker wiring shared by all modules.
import { MODULES, getModuleStates, onModuleStatesChanged, setModuleState } from './modules.js';
import { messageAllowed, senderAllowed } from './gate.js';
import { rebuildMenus } from './menus.js';
import { APPEARANCE_KEY, APPEARANCE_DEFAULTS, WELCOME_KEY, normalizeAppearance } from '../ui/appearance.js';

// Context menus are rebuilt from the module providers whenever they may be stale.
chrome.runtime.onInstalled.addListener((details) => {
  rebuildMenus().catch(() => {});
  if (details?.reason === 'install') chrome.storage.session.set({ [WELCOME_KEY]: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  rebuildMenus().catch(() => {});
  chrome.storage.session.set({ [WELCOME_KEY]: true }).catch(() => {});
});
onModuleStatesChanged(() => { rebuildMenus().catch(() => {}); });

// One-time import of the old Tab Manager theme into the shared appearance.
export async function migrateAppearance() {
  const got = await chrome.storage.local.get([APPEARANCE_KEY, 'tm:data']);
  if (got[APPEARANCE_KEY]) return;
  const theme = got['tm:data']?.settings?.theme;
  if (['auto', 'light', 'dark'].includes(theme)) {
    await chrome.storage.local.set({ [APPEARANCE_KEY]: { ...APPEARANCE_DEFAULTS, theme } });
  }
}
migrateAppearance().catch(() => {});

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

  async 'core:setAppearance'({ patch }) {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Permintaan tidak valid.' };
    const got = await chrome.storage.local.get(APPEARANCE_KEY);
    const appearance = normalizeAppearance({ ...normalizeAppearance(got[APPEARANCE_KEY]), ...patch });
    await chrome.storage.local.set({ [APPEARANCE_KEY]: appearance });
    return { ok: true, appearance };
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
