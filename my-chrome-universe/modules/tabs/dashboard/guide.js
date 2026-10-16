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
export function showGuide({ focus = true } = {}) {
  beforeShow();
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
}

// First visit only: marked as seen as soon as it is shown, so it appears exactly once.
export async function autoShowGuide(delayMs = 1700) {
  const { [GUIDE_KEY]: seen } = await chrome.storage.local.get(GUIDE_KEY);
  if (seen) return;
  await chrome.storage.local.set({ [GUIDE_KEY]: true });
  await wait(delayMs);
  if (!guideShown()) showGuide({ focus: false });
}
