// Runs in the page's MAIN world on YouTube at document_start (registered by
// background.js only while blocking is active there). Video ads cannot be blocked
// by URL: their schedule lives inside the player response, so — like the
// json-prune / set-constant snippets of Adblock Plus and uBlock Origin — we strip
// the ad fields before the player reads them. A fallback skips any ad that still
// starts playing.
(() => {
  if (window.__abYoutube) return;
  window.__abYoutube = true;

  // Paths are relative to any player response object found.
  const PRUNE = [
    'adPlacements',
    'adSlots',
    'playerAds',
    'adBreakHeartbeatParams',
    'auxiliaryUi.messageRenderers.enforcementMessageViewModel',
  ];

  function deletePath(obj, path) {
    const keys = path.split('.');
    let node = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      node = node?.[keys[i]];
      if (!node || typeof node !== 'object') return false;
    }
    const last = keys.at(-1);
    if (node && Object.prototype.hasOwnProperty.call(node, last)) {
      delete node[last];
      return true;
    }
    return false;
  }

  // Strips ad data from a player response, or from objects wrapping one.
  function prune(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      const targets = [value, value.playerResponse, value.response?.playerResponse];
      if (Array.isArray(value)) for (const item of value) targets.push(item?.playerResponse);
      for (const target of targets) {
        if (target && typeof target === 'object') for (const path of PRUNE) deletePath(target, path);
      }
    } catch {
      // Never break the page.
    }
    return value;
  }

  // 1) Inline data: `var ytInitialPlayerResponse = {...}` assigns through our setter.
  for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
    let stored;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => stored,
        set: (v) => {
          stored = prune(v);
        },
      });
    } catch {}
  }

  // 2) Data parsed later (navigation inside YouTube, /youtubei/v1/player).
  const nativeParse = JSON.parse;
  JSON.parse = function parse(...args) {
    return prune(nativeParse.apply(this, args));
  };
  // Keep it looking native for code that checks.
  JSON.parse.toString = () => nativeParse.toString();

  const nativeJson = Response.prototype.json;
  Response.prototype.json = function json(...args) {
    return nativeJson.apply(this, args).then(prune);
  };

  // 3) Fallback: if an ad still plays, mute it, jump to its end and press "Skip".
  const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button';
  function skipAd() {
    const player = document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
    if (!player) return;
    const video = player.querySelector('video');
    if (video) {
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
      video.playbackRate = 16;
    }
    for (const button of document.querySelectorAll(SKIP)) button.click();
  }

  // Close YouTube's "ad blockers are not allowed" dialog and resume playback.
  function dismissEnforcement() {
    const dialog = document.querySelector('ytd-enforcement-message-view-model');
    if (!dialog) return;
    dialog.closest('tp-yt-paper-dialog')?.remove();
    document.querySelector('tp-yt-iron-overlay-backdrop')?.remove();
    const video = document.querySelector('video');
    if (video?.paused) video.play().catch(() => {});
  }

  const observer = new MutationObserver(() => {
    skipAd();
    dismissEnforcement();
  });
  const start = () => observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });

  // Exposed for tests: window.__abYoutubePrune({...}) returns the pruned object.
  window.__abYoutubePrune = prune;
})();
