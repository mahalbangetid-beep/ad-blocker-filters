// Framework guide: numbered tags on the four zones plus a card explaining them. Shown
// automatically once (storage.local['tm:guideSeen']) and any time from the (?) button.
import { wait } from '../../../ui/motion.js';

const $ = (id) => document.getElementById(id);
export const GUIDE_KEY = 'tm:guideSeen';

let beforeShow = () => {};

export function setupGuide(options = {}) {
  beforeShow = options.beforeShow || beforeShow;
  $('guide-btn').addEventListener('click', () => (guideShown() ? hideGuide() : showGuide()));
  $('guide-close').addEventListener('click', hideGuide);
}

export const guideShown = () => !$('guide-card').hidden;

// focus: move focus to "Mengerti" (not when it appears by itself, so typing is never interrupted).
// auto: the one-time automatic show, which leaves an open drawer alone.
export function showGuide({ focus = true, auto = false } = {}) {
  if (!auto) beforeShow();
  $('tm').classList.add('guiding');
  $('guide-card').hidden = false;
  $('guide-btn').setAttribute('aria-expanded', 'true');
  if (focus) $('guide-close').focus({ preventScroll: true });
}

export function hideGuide() {
  if (!guideShown()) return;
  const hadFocus = $('guide-card').contains(document.activeElement);
  $('tm').classList.remove('guiding');
  $('guide-card').hidden = true;
  $('guide-btn').setAttribute('aria-expanded', 'false');
  if (hadFocus) $('guide-btn').focus({ preventScroll: true });
  markSeen();
}

const markSeen = () => chrome.storage.local.set({ [GUIDE_KEY]: true }).catch(() => {});

// First visit only. The flag is written once the card is actually on screen (or dismissed), so
// leaving the first New Tab before the delay keeps the guide for the next one.
export async function autoShowGuide(delayMs = 1700) {
  const { [GUIDE_KEY]: seen } = await chrome.storage.local.get(GUIDE_KEY);
  if (seen) return;
  await wait(delayMs);
  if (document.hidden) await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
  if (guideShown()) return markSeen();
  if (document.getElementById('tm-open')?.classList.contains('open')) return; // the user is busy in the drawer
  showGuide({ focus: false, auto: true });
  if (guideShown()) await markSeen();
}
