// Manual live check against real YouTube (needs internet; not part of the normal suite).
// Loads ad-blocker/ into Playwright's Chromium, opens a video twice — with the
// YouTube option off (baseline) and on — and reports ad data and ad playback.
//
// Run: node tests/youtube.live.mjs [videoUrl]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'ad-blocker');
const VIDEO = process.argv[2] || 'https://www.youtube.com/watch?v=kJQP7kiw5Fk';
const CDP_PORT = 9334;
const WATCH_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const base = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = join(base, dir, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error('Chromium (Playwright) tidak ditemukan');
}

let nextId = 0;
const pending = new Map();
let ws;
function send(method, params = {}, sessionId) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}
async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

const profile = mkdtempSync(join(tmpdir(), 'ab-yt-'));
const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
  '--no-first-run', '--no-default-browser-check', '--lang=id-ID', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'about:blank',
], { stdio: 'ignore' });

try {
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(200);
    wsUrl = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
  }
  ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.fail(new Error(msg.error.message)) : p.ok(msg.result);
    }
  });
  await new Promise((ok) => ws.addEventListener('open', ok));

  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'service_worker')) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      if ((await evaluate(sessionId, 'chrome.runtime.getManifest().name').catch(() => '')).startsWith('Ad Blocker')) extId = new URL(t.url).host;
    }
    if (!extId) await sleep(200);
  }
  await sleep(1500);

  async function open(url) {
    const { targetId } = await send('Target.createTarget', { url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    return { sessionId, targetId };
  }

  const popup = await open(`chrome-extension://${extId}/popup.html`);
  await sleep(500);
  const bg = (msg) => evaluate(popup.sessionId, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

  async function run(label) {
    const { sessionId, targetId } = await open(VIDEO);
    // Record whether the player ever enters ad mode while we watch.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: '' }, sessionId);
    const started = Date.now();
    let sawAd = false;
    let info = null;
    while (Date.now() - started < WATCH_MS) {
      await sleep(1000);
      info = await evaluate(sessionId, `(() => {
        const r = window.ytInitialPlayerResponse;
        const player = document.querySelector('.html5-video-player');
        const video = document.querySelector('video');
        return {
          title: document.title,
          hasPlayerResponse: Boolean(r),
          adKeys: r ? ['adPlacements', 'playerAds', 'adSlots'].filter((k) => k in r) : null,
          adPlacements: r?.adPlacements?.length ?? 0,
          adShowing: Boolean(player && player.classList.contains('ad-showing')),
          videoTime: video ? Math.round(video.currentTime) : null,
          consent: location.hostname.startsWith('consent.'),
        };
      })()`).catch(() => info);
      if (info?.adShowing) sawAd = true;
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const shot = join(process.env.SHOT_DIR || tmpdir(), `youtube-${label}.png`);
    writeFileSync(shot, Buffer.from(data, 'base64'));
    await send('Target.closeTarget', { targetId });
    return { label, ...info, sawAdPlaying: sawAd, screenshot: shot };
  }

  await bg({ type: 'ab:saveSettings', patch: { youtube: false } });
  const baseline = await run('tanpa-modul-youtube');
  await bg({ type: 'ab:saveSettings', patch: { youtube: true } });
  const blocked = await run('dengan-modul-youtube');
  console.log(JSON.stringify({ video: VIDEO, baseline, blocked }, null, 2));
} finally {
  try {
    await send('Browser.close');
  } catch {}
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
