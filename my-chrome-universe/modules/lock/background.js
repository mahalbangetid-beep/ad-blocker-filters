import { createPasswordRecord, verifyPassword, generateRecoveryCode, normalizeRecoveryCode } from './crypto.js';
import { guardAction, lockStatus, messageAllowed, senderAllowed, LOCK_PATH, SETUP_PATH } from '../../core/gate.js';
import { isModuleEnabled, setModuleState } from '../../core/modules.js';

const LOCK_URL = chrome.runtime.getURL(LOCK_PATH);
const SETUP_URL = chrome.runtime.getURL(SETUP_PATH);
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

const MIN_PASSWORD_LENGTH = 4;
const FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = { idleMinutes: 0, lockOnScreenLock: true };

// Storage layout (all keys prefixed "lock:"):
//   local:   lock:auth (password record), lock:recovery (recovery code record),
//            lock:settings, lock:failures, lock:lockoutUntil
//   session: lock:unlocked (cleared when the browser closes, so every startup is locked), lock:savedTabs
// The on/off switch lives in core:modules (core/modules.js); core/gate.js derives the status.
// Lock state lives in storage rather than in service-worker variables because
// MV3 service workers are terminated when idle.

async function getAuth() {
  const { 'lock:auth': auth } = await chrome.storage.local.get('lock:auth');
  return auth || null;
}

async function getSettings() {
  const { 'lock:settings': settings } = await chrome.storage.local.get('lock:settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function isLocked() {
  return (await lockStatus()) === 'locked';
}

function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

function isLockTab(tab) {
  return tabUrl(tab).startsWith(LOCK_URL);
}

function isWorthRestoring(tab) {
  const url = tabUrl(tab);
  if (!url || tab.incognito) return false;
  if (url.startsWith(EXTENSION_ORIGIN)) return false;
  return !['chrome://newtab/', 'about:blank', 'edge://newtab/'].includes(url);
}

// Serialize writes to savedTabs so concurrent tab events do not drop URLs.
let saveQueue = Promise.resolve();
function rememberTabs(tabs) {
  const urls = tabs.filter(isWorthRestoring).map(tabUrl);
  if (!urls.length) return saveQueue;
  saveQueue = saveQueue.then(async () => {
    const { 'lock:savedTabs': savedTabs = [] } = await chrome.storage.session.get('lock:savedTabs');
    for (const url of urls) if (!savedTabs.includes(url)) savedTabs.push(url);
    await chrome.storage.session.set({ 'lock:savedTabs': savedTabs });
  });
  return saveQueue;
}

async function removeTabs(ids) {
  if (!ids.length) return;
  await chrome.tabs.remove(ids).catch(() => {});
}

// Only one lock tab may exist; concurrent callers share one in-flight promise.
let ensuring = null;
function ensureLockTab() {
  ensuring ??= openLockTab().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function openLockTab() {
  const lockTabs = (await chrome.tabs.query({})).filter(isLockTab);
  let tab = lockTabs[0];
  await removeTabs(lockTabs.slice(1).map((t) => t.id));

  if (!tab) {
    const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !w.incognito);
    const target = windows.find((w) => w.focused) || windows[0];
    if (target) {
      tab = await chrome.tabs.create({ url: LOCK_URL, windowId: target.id, active: true });
    } else {
      const win = await chrome.windows.create({ url: LOCK_URL, focused: true });
      tab = win.tabs[0];
    }
  }

  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tab;
}

// Open the lock tab first, then close everything else, so the browser never
// ends up with zero windows (which would make it quit).
async function sweep() {
  const lockTab = await ensureLockTab();
  const others = (await chrome.tabs.query({})).filter((t) => t.id !== lockTab.id && !isLockTab(t));
  await rememberTabs(others);
  await removeTabs(others.map((t) => t.id));
}

const INTERNAL_URL = /^(chrome|edge|about|chrome-extension|devtools):/;

async function quarantine(tab) {
  if (isLockTab(tab)) return;
  // Tabs that appear while locked are usually Chrome restoring the last session,
  // so keep their URLs; but don't reopen browser-internal pages someone tried to
  // reach while locked (e.g. chrome://extensions).
  if (!INTERNAL_URL.test(tabUrl(tab))) await rememberTabs([tab]);
  await ensureLockTab();
  await removeTabs([tab.id]);
}

// Every lock path (button, shortcut, idle, screen lock) comes through here. Refused while
// there is no password or the module is switched off; when already locked it just re-sweeps,
// which brings the lock screen back to the front.
async function lock() {
  if (!(await getAuth()) || !(await isModuleEnabled('lock'))) return false;
  await chrome.storage.session.set({ 'lock:unlocked': false });
  await sweep();
  return true;
}

// Restored tabs open in the background; with Tab Manager on, a new dashboard tab
// (New Tab override) is created last so it is the one the user sees.
async function restoreTabs() {
  await saveQueue;
  const { 'lock:savedTabs': savedTabs = [] } = await chrome.storage.session.get('lock:savedTabs');
  await chrome.storage.session.remove('lock:savedTabs');

  const lockTabs = (await chrome.tabs.query({})).filter(isLockTab);
  const windowId = lockTabs[0]?.windowId;
  const dashboard = await isModuleEnabled('tabs');

  for (const [i, url] of savedTabs.entries()) {
    await chrome.tabs.create({ url, windowId, active: !dashboard && i === 0 }).catch(() => {});
  }
  if (dashboard || !savedTabs.length) {
    await chrome.tabs.create({ windowId, active: true }).catch(() => {});
  }
  await removeTabs(lockTabs.map((t) => t.id));
}

async function getThrottle() {
  const stored = await chrome.storage.local.get(['lock:failures', 'lock:lockoutUntil']);
  return { failures: stored['lock:failures'] || 0, lockoutUntil: stored['lock:lockoutUntil'] || 0 };
}

// Checks a secret (password or recovery code, stored as a record under `key`) with
// brute-force throttling: after FREE_ATTEMPTS wrong tries, each further failure doubles
// the wait (30s, 60s, ... max 15 min). Both secrets share one counter, kept in local
// storage so restarting the browser does not reset it.
async function verifyThrottled(secret, key) {
  const { failures, lockoutUntil } = await getThrottle();
  const now = Date.now();
  if (lockoutUntil > now) return { ok: false, error: 'lockout', retryAt: lockoutUntil };

  const { [key]: record } = await chrome.storage.local.get(key);
  if (record && (await verifyPassword(secret, record))) {
    await chrome.storage.local.set({ 'lock:failures': 0, 'lock:lockoutUntil': 0 });
    return { ok: true };
  }

  const nextFailures = failures + 1;
  let retryAt = 0;
  if (nextFailures >= FREE_ATTEMPTS) {
    const wait = Math.min(BASE_LOCKOUT_MS * 2 ** (nextFailures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
    retryAt = now + wait;
  }
  await chrome.storage.local.set({ 'lock:failures': nextFailures, 'lock:lockoutUntil': retryAt });
  return {
    ok: false,
    error: retryAt ? 'lockout' : 'wrong',
    retryAt,
    attemptsLeft: Math.max(FREE_ATTEMPTS - nextFailures, 0),
  };
}

// Secret checks and password writes run one at a time, so concurrent guesses are each
// counted (and see each other's lockout) and two setups cannot both store a password.
let checkQueue = Promise.resolve();
function serialized(task) {
  const run = checkQueue.then(task);
  checkQueue = run.catch(() => {});
  return run;
}

// `onSuccess` runs inside the same turn, so a recovery code is replaced before any other
// check can use it again; its result is merged into the reply.
function checkSecret(secret, key, onSuccess) {
  return serialized(async () => {
    const result = await verifyThrottled(secret, key);
    if (result.ok && onSuccess) Object.assign(result, await onSuccess());
    return result;
  });
}

const checkPassword = (password) => checkSecret(password, 'lock:auth');

// Stores a fresh recovery code (hash only, written together with `extra`) and returns
// the plain code, to be shown once.
async function rotateRecoveryCode(extra = {}) {
  const recoveryCode = generateRecoveryCode();
  await chrome.storage.local.set({
    ...extra,
    'lock:recovery': await createPasswordRecord(normalizeRecoveryCode(recoveryCode)),
  });
  return { recoveryCode };
}

// Settings pages show these instead of the raw checkPassword codes.
function currentPasswordError(check) {
  return {
    ok: false,
    error: check.error === 'lockout' ? 'Terlalu banyak percobaan. Coba lagi nanti.' : 'Password saat ini salah.',
    retryAt: check.retryAt,
  };
}

function validateNewPassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password minimal ${MIN_PASSWORD_LENGTH} karakter.`;
  }
  if (password !== confirm) return 'Kedua password tidak sama.';
  return null;
}

async function applyIdleSettings() {
  const { idleMinutes } = await getSettings();
  // The interval also matters for the "idle" state only; "locked" (screen lock) is reported regardless.
  chrome.idle.setDetectionInterval(Math.max(15, (idleMinutes || 1) * 60));
}

const handlers = {
  async 'lock:getState'() {
    const [auth, status, enabled, settings, throttle] = await Promise.all([
      getAuth(), lockStatus(), isModuleEnabled('lock'), getSettings(), getThrottle(),
    ]);
    return {
      hasPassword: Boolean(auth),
      locked: status === 'locked',
      status,
      enabled,
      settings,
      ...throttle,
      minLength: MIN_PASSWORD_LENGTH,
    };
  },

  async 'lock:setup'({ password, confirm }) {
    const exists = { ok: false, error: 'Password sudah diatur. Ganti lewat halaman Pengaturan.' };
    if (await getAuth()) return exists;
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return { ok: false, error: invalid };
    // Check again inside the queue: only the first of two concurrent setups may write.
    return serialized(async () => {
      if (await getAuth()) return exists;
      const { recoveryCode } = await rotateRecoveryCode({
        'lock:auth': await createPasswordRecord(password),
        'lock:failures': 0,
        'lock:lockoutUntil': 0,
      });
      await chrome.storage.session.set({ 'lock:unlocked': true });
      return { ok: true, recoveryCode };
    });
  },

  async 'lock:unlock'({ password }) {
    if (!(await isLocked())) return { ok: true };
    const result = await checkPassword(password);
    if (result.ok) {
      await chrome.storage.session.set({ 'lock:unlocked': true });
      restoreTabs();
    }
    return result;
  },

  // Forgotten password: a valid recovery code sets a new password and a new code (the
  // used one is spent). It never unlocks by itself; the lock screen then unlocks with
  // the new password. Works whenever a password exists, locked or not.
  async 'lock:recover'({ code, password, confirm }) {
    if (!(await getAuth())) return { ok: false, error: 'Belum ada password.' };
    // Validate the new password first so a typo does not cost an attempt.
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return { ok: false, error: invalid };
    // One write, so the used code can never outlive the password change.
    return checkSecret(normalizeRecoveryCode(code), 'lock:recovery', async () =>
      rotateRecoveryCode({ 'lock:auth': await createPasswordRecord(password) }));
  },

  async 'lock:newRecoveryCode'({ current }) {
    if ((await lockStatus()) !== 'open') return { ok: false, error: 'Browser sedang terkunci.' };
    const check = await checkSecret(current, 'lock:auth', () => rotateRecoveryCode());
    return check.ok ? check : currentPasswordError(check);
  },

  async 'lock:changePassword'({ current, password, confirm }) {
    if (await isLocked()) return { ok: false, error: 'Browser sedang terkunci.' };
    // Validated and written in the same queue turn as the check, so no other check or
    // recovery can slip in between.
    const check = await checkSecret(current, 'lock:auth', async () => {
      const invalid = validateNewPassword(password, confirm);
      if (invalid) return { invalid };
      await chrome.storage.local.set({ 'lock:auth': await createPasswordRecord(password) });
      return {};
    });
    if (!check.ok) return currentPasswordError(check);
    if (check.invalid) return { ok: false, error: check.invalid };
    return { ok: true };
  },

  // Turning the lock off needs the current password (same throttle as unlocking); the
  // password stays stored, so turning it back on needs nothing and does not lock at once.
  async 'lock:setEnabled'({ enabled, current }) {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Permintaan tidak valid.' };
    if (await isLocked()) return { ok: false, error: 'Browser sedang terkunci.' };
    if (!(await getAuth())) return { ok: false, error: 'Buat password terlebih dahulu.' };
    if (!enabled) {
      const check = await checkPassword(current);
      if (!check.ok) return currentPasswordError(check);
    } else {
      await chrome.storage.session.set({ 'lock:unlocked': true });
    }
    await setModuleState('lock', enabled);
    return { ok: true, enabled };
  },

  async 'lock:saveSettings'({ settings }) {
    if (await isLocked()) return { ok: false, error: 'Browser sedang terkunci.' };
    const clean = {
      idleMinutes: Math.max(0, Math.min(240, Number(settings?.idleMinutes) || 0)),
      lockOnScreenLock: Boolean(settings?.lockOnScreenLock),
    };
    await chrome.storage.local.set({ 'lock:settings': clean });
    await applyIdleSettings();
    return { ok: true, settings: clean };
  },

  async 'lock:lock'() {
    return { ok: await lock() };
  },
};

// Only the lock screen/setup messages (core/gate.js PUBLIC_MESSAGES) are served while
// locked or before a password exists; handlers keep their own checks as a second layer.
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

// --- Enforcement: while locked, every non-lock tab is remembered and closed. ---

chrome.tabs.onCreated.addListener(async (tab) => {
  // A tab created without any URL yet is handled by onUpdated once it has one.
  if (!tabUrl(tab)) return;
  if (await isLocked()) await quarantine(tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (await isLocked()) await quarantine(tab);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!(await isLocked())) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await quarantine(tab);
});

chrome.tabs.onRemoved.addListener(async (tabId, { isWindowClosing }) => {
  if (isWindowClosing || !(await isLocked())) return;
  const tabs = await chrome.tabs.query({});
  if (tabs.length && !tabs.some(isLockTab)) await sweep();
});

chrome.idle.onStateChanged.addListener(async (state) => {
  const { idleMinutes, lockOnScreenLock } = await getSettings();
  if ((state === 'locked' && lockOnScreenLock) || (state === 'idle' && idleMinutes > 0)) {
    await lock();
  }
});

// Without a password the shortcut leads to "Buat password" (opens or focuses setup).
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'lock-browser') return;
  if ((await lockStatus()) === 'setup') await guardAction();
  else await lock();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await getAuth())) {
    await chrome.tabs.create({ url: SETUP_URL });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  if (await isLocked()) await sweep();
});

// Runs every time the service worker starts (browser startup, extension
// re-enable/update, or a wake-up after idle). Idempotent when already locked.
async function init() {
  await applyIdleSettings();
  if (await isLocked()) await sweep();
}
init();
