import { createPasswordRecord, verifyPassword } from './crypto.js';

const LOCK_URL = chrome.runtime.getURL('modules/lock/lock.html');
const SETUP_URL = chrome.runtime.getURL('modules/lock/setup.html');
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

const MIN_PASSWORD_LENGTH = 4;
const FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = { idleMinutes: 0, lockOnScreenLock: true };

// Storage layout:
//   local:   auth (password record), settings, failures, lockoutUntil
//   session: unlocked (cleared when the browser closes, so every startup is locked), savedTabs
// Lock state lives in storage rather than in service-worker variables because
// MV3 service workers are terminated when idle.

async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth || null;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function isLocked() {
  const [{ auth }, { unlocked }] = await Promise.all([
    chrome.storage.local.get('auth'),
    chrome.storage.session.get('unlocked'),
  ]);
  return Boolean(auth) && !unlocked;
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
    const { savedTabs = [] } = await chrome.storage.session.get('savedTabs');
    for (const url of urls) if (!savedTabs.includes(url)) savedTabs.push(url);
    await chrome.storage.session.set({ savedTabs });
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

async function lock() {
  if (!(await getAuth())) return false;
  await chrome.storage.session.set({ unlocked: false });
  await sweep();
  return true;
}

async function restoreTabs() {
  await saveQueue;
  const { savedTabs = [] } = await chrome.storage.session.get('savedTabs');
  await chrome.storage.session.remove('savedTabs');

  const lockTabs = (await chrome.tabs.query({})).filter(isLockTab);
  const windowId = lockTabs[0]?.windowId;

  if (savedTabs.length) {
    for (const [i, url] of savedTabs.entries()) {
      await chrome.tabs.create({ url, windowId, active: i === 0 }).catch(() => {});
    }
  } else {
    await chrome.tabs.create({ windowId, active: true }).catch(() => {});
  }
  await removeTabs(lockTabs.map((t) => t.id));
}

async function getThrottle() {
  const { failures = 0, lockoutUntil = 0 } = await chrome.storage.local.get(['failures', 'lockoutUntil']);
  return { failures, lockoutUntil };
}

// Checks the password with brute-force throttling: after FREE_ATTEMPTS wrong
// tries, each further failure doubles the wait (30s, 60s, ... max 15 min).
// The counter is in local storage so restarting the browser does not reset it.
async function checkPassword(password) {
  const { failures, lockoutUntil } = await getThrottle();
  const now = Date.now();
  if (lockoutUntil > now) return { ok: false, error: 'lockout', retryAt: lockoutUntil };

  const auth = await getAuth();
  if (auth && (await verifyPassword(password, auth))) {
    await chrome.storage.local.set({ failures: 0, lockoutUntil: 0 });
    return { ok: true };
  }

  const nextFailures = failures + 1;
  let retryAt = 0;
  if (nextFailures >= FREE_ATTEMPTS) {
    const wait = Math.min(BASE_LOCKOUT_MS * 2 ** (nextFailures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
    retryAt = now + wait;
  }
  await chrome.storage.local.set({ failures: nextFailures, lockoutUntil: retryAt });
  return {
    ok: false,
    error: retryAt ? 'lockout' : 'wrong',
    retryAt,
    attemptsLeft: Math.max(FREE_ATTEMPTS - nextFailures, 0),
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
  async getState() {
    const [auth, locked, settings, throttle] = await Promise.all([getAuth(), isLocked(), getSettings(), getThrottle()]);
    return { hasPassword: Boolean(auth), locked, settings, ...throttle, minLength: MIN_PASSWORD_LENGTH };
  },

  async setup({ password, confirm }) {
    if (await getAuth()) return { ok: false, error: 'Password sudah diatur. Ganti lewat halaman Pengaturan.' };
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return { ok: false, error: invalid };
    await chrome.storage.local.set({ auth: await createPasswordRecord(password), failures: 0, lockoutUntil: 0 });
    await chrome.storage.session.set({ unlocked: true });
    return { ok: true };
  },

  async unlock({ password }) {
    if (!(await isLocked())) return { ok: true };
    const result = await checkPassword(password);
    if (result.ok) {
      await chrome.storage.session.set({ unlocked: true });
      restoreTabs();
    }
    return result;
  },

  async changePassword({ current, password, confirm }) {
    if (await isLocked()) return { ok: false, error: 'Browser sedang terkunci.' };
    const check = await checkPassword(current);
    if (!check.ok) {
      return { ok: false, error: check.error === 'lockout' ? 'Terlalu banyak percobaan. Coba lagi nanti.' : 'Password saat ini salah.', retryAt: check.retryAt };
    }
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return { ok: false, error: invalid };
    await chrome.storage.local.set({ auth: await createPasswordRecord(password) });
    return { ok: true };
  },

  async removePassword({ current }) {
    if (await isLocked()) return { ok: false, error: 'Browser sedang terkunci.' };
    const check = await checkPassword(current);
    if (!check.ok) return { ok: false, error: 'Password saat ini salah.', retryAt: check.retryAt };
    await chrome.storage.local.remove('auth');
    return { ok: true };
  },

  async saveSettings({ settings }) {
    if (await isLocked()) return { ok: false, error: 'Browser sedang terkunci.' };
    const clean = {
      idleMinutes: Math.max(0, Math.min(240, Number(settings?.idleMinutes) || 0)),
      lockOnScreenLock: Boolean(settings?.lockOnScreenLock),
    };
    await chrome.storage.local.set({ settings: clean });
    await applyIdleSettings();
    return { ok: true, settings: clean };
  },

  async lock() {
    return { ok: await lock() };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
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

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'lock-browser') await lock();
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
