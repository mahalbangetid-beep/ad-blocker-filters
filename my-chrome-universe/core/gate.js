// Lock gate: reads storage on every call (the service worker may restart at any time).
import { isModuleEnabled } from './modules.js';

export const LOCK_PATH = 'modules/lock/lock.html';
export const SETUP_PATH = 'modules/lock/setup.html';

export async function lockStatus() {
  const { 'lock:auth': auth } = await chrome.storage.local.get('lock:auth');
  if (!auth) return 'setup';
  if (!(await isModuleEnabled('lock'))) return 'open';
  const { 'lock:unlocked': unlocked } = await chrome.storage.session.get('lock:unlocked');
  return unlocked === true ? 'open' : 'locked';
}

export const PUBLIC_MESSAGES = new Set([
  'lock:getState', 'lock:setup', 'lock:unlock', 'lock:recover', 'lock:lock', 'core:getModules',
]);

export async function messageAllowed(type) {
  return PUBLIC_MESSAGES.has(type) || (await lockStatus()) === 'open';
}

let setupInFlight = null;

async function focusOrOpenSetup() {
  const url = chrome.runtime.getURL(SETUP_PATH);
  const existing = (await chrome.tabs.query({})).find((t) => typeof t.url === 'string' && t.url.startsWith(url));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// True when actions may proceed; while no password exists, steer the user to setup instead.
export async function guardAction() {
  const status = await lockStatus();
  if (status === 'open') return true;
  if (status === 'setup') {
    if (!setupInFlight) setupInFlight = focusOrOpenSetup().finally(() => { setupInFlight = null; });
    await setupInFlight;
  }
  return false;
}
