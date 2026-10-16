// Shared appearance settings (theme, motion, accent). Safe to import in the service worker:
// nothing here touches document/window/matchMedia until a page calls a function.
export const APPEARANCE_KEY = 'core:appearance';
export const WELCOME_KEY = 'core:welcome';
export const MIRROR_KEY = 'mcu:appearance';
export const APPEARANCE_DEFAULTS = { theme: 'auto', motion: 'full', accent: 'solar', welcome: true };

const THEMES = ['auto', 'light', 'dark'];
const MOTIONS = ['full', 'balanced', 'minimal'];
const ACCENTS = ['solar', 'ion', 'nova'];

// Keep only the patch keys whose values are valid; used to store appearance sparsely.
export function validPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (THEMES.includes(patch.theme)) out.theme = patch.theme;
  if (MOTIONS.includes(patch.motion)) out.motion = patch.motion;
  if (ACCENTS.includes(patch.accent)) out.accent = patch.accent;
  if (typeof patch.welcome === 'boolean') out.welcome = patch.welcome;
  return out;
}

export function normalizeAppearance(raw, opts = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: THEMES.includes(r.theme) ? r.theme : APPEARANCE_DEFAULTS.theme,
    motion: MOTIONS.includes(r.motion) ? r.motion : (opts.reducedMotion ? 'minimal' : APPEARANCE_DEFAULTS.motion),
    accent: ACCENTS.includes(r.accent) ? r.accent : APPEARANCE_DEFAULTS.accent,
    welcome: typeof r.welcome === 'boolean' ? r.welcome : (r.welcome === undefined ? APPEARANCE_DEFAULTS.welcome : !!r.welcome),
  };
}

const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
const prefersLight = () => {
  try { return matchMedia('(prefers-color-scheme: light)').matches; } catch { return false; }
};

export async function readAppearance() {
  const got = await chrome.storage.local.get(APPEARANCE_KEY);
  return normalizeAppearance(got[APPEARANCE_KEY], { reducedMotion: reduced() });
}

export function applyAppearance(a, root = document.documentElement) {
  const light = a.theme === 'light' || (a.theme === 'auto' && prefersLight());
  root.dataset.ui = light ? 'light' : 'dark';
  root.dataset.motion = a.motion;
  root.dataset.accent = a.accent;
  try { localStorage.setItem(MIRROR_KEY, JSON.stringify(a)); } catch { /* storage may be blocked */ }
  return { light };
}

export function watchAppearance(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[APPEARANCE_KEY]) {
      cb(normalizeAppearance(changes[APPEARANCE_KEY].newValue, { reducedMotion: reduced() }));
    }
  });
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { readAppearance().then(cb).catch(() => {}); });
  } catch { /* no matchMedia */ }
}

export async function initAppearance() {
  const a = await readAppearance();
  applyAppearance(a);
  watchAppearance((next) => applyAppearance(next));
  return a;
}

// Read and clear the one-shot welcome flag raised at browser startup / first install.
export async function consumeWelcome() {
  const got = await chrome.storage.session.get(WELCOME_KEY);
  const flag = got[WELCOME_KEY] === true;
  if (flag) await chrome.storage.session.remove(WELCOME_KEY);
  return flag && (await readAppearance()).welcome;
}
