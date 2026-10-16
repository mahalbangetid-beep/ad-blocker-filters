// End-to-end test: loads my-chrome-universe/ into a real Chromium (Playwright's build,
// which still honours --load-extension), serves a local page full of "ads", and checks
// what the ad blocker module actually blocked or hid. Drives the browser over the
// DevTools Protocol.
//
// Run: node --test tests/universe.e2e.mjs   (CHROME_PATH=... to pick a browser)
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { findChrome, platformArgs } from './chromium.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'my-chrome-universe');
const adblockDir = join(extDir, 'modules/adblock');
const PORT = 8766;
// YouTube is HSTS-preloaded in newer Chromium builds, so its mock must be served over HTTPS.
const TLS_PORT = 8767;
const YOUTUBE = `https://www.youtube.com:${TLS_PORT}`;
const CDP_PORT = 9333;
const SITE = `http://site.test:${PORT}`;


// ---------- Local site with ads ----------

const hits = [];
const PAGE = `<!doctype html><html><head><title>Uji iklan</title></head><body>
<div id="content">Konten asli</div>
<div id="ad_banner">IKLAN (generic EasyList #ad_banner)</div>
<div class="my-custom-ad">IKLAN (filter saya)</div>
<script>window.loads = {}; function mark(k, ok) { window.loads[k] = ok; }</script>
<script src="/js/flyad.js" onload="mark('pattern', true)" onerror="mark('pattern', false)"></script>
<script src="http://adnxs.com:${PORT}/ad.js" onload="mark('adserver', true)" onerror="mark('adserver', false)"></script>
<script src="http://adsterra.com:${PORT}/tp.js" onload="mark('thirdParty', true)" onerror="mark('thirdParty', false)"></script>
<script src="/custom-block.js" onload="mark('custom', true)" onerror="mark('custom', false)"></script>
<script src="/app.js" onload="mark('normal', true)" onerror="mark('normal', false)"></script>
<div id="feed-ad">IKLAN (selector dari feed)</div>
<script src="http://newad.test:${PORT}/n.js" onload="mark('feedNew', true)" onerror="mark('feedNew', false)"></script>
</body></html>`;

// Mimics how YouTube delivers ads: inside the player response (inline, via
// JSON.parse and via fetch().json()), plus an ad that is already "playing".
const AD_DATA = { adPlacements: [{ ad: 1 }], playerAds: [{ ad: 1 }], adSlots: [{ ad: 1 }], videoDetails: { videoId: 'abc' } };
const YT_PAGE = `<!doctype html><html><body>
<script>var ytInitialPlayerResponse = ${JSON.stringify(AD_DATA)};</script>
<div id="masthead-ad">IKLAN MASTHEAD</div>
<div class="html5-video-player ad-showing"><video></video>
  <button class="ytp-ad-skip-button" onclick="window.skipped = true">Lewati</button></div>
<script>
  window.parsed = JSON.parse(${JSON.stringify(JSON.stringify({ playerResponse: AD_DATA }))});
  window.fetched = fetch('/youtubei/v1/player').then((r) => r.json());
</script></body></html>`;

// Local copy of a filter-bot feed, filled by publishFeed() in the update tests.
const feedFiles = new Map();

function handle(req, res) {
  if (req.url.startsWith('/feed/')) {
    const body = feedFiles.get(req.url.slice('/feed/'.length).split('?')[0]);
    return body ? res.writeHead(200, { 'content-type': 'application/json' }).end(body) : res.writeHead(404).end();
  }
  hits.push(`${req.headers.host}${req.url}`);
  if (req.url.startsWith('/page')) return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  if (req.url.startsWith('/watch')) return res.writeHead(200, { 'content-type': 'text/html' }).end(YT_PAGE);
  if (req.url.startsWith('/youtubei/v1/player')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(AD_DATA));
  res.writeHead(200, { 'content-type': 'text/javascript' }).end('/* ok */');
}
const server = createServer(handle);
let tlsServer;

// Throwaway self-signed certificate (Chromium runs with --ignore-certificate-errors).
function selfSignedCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'];
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=www.youtube.com'], { stdio: 'ignore' });
      return { key: readFileSync(key), cert: readFileSync(cert) };
    } catch {}
  }
  throw new Error('openssl tidak ditemukan (dibutuhkan untuk halaman uji YouTube)');
}

// ---------- Minimal CDP client ----------

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    // Event listeners (messages without an id), e.g. Runtime.exceptionThrown.
    this.listeners = new Set();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) for (const fn of this.listeners) fn(msg);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : ok(msg.result);
      }
    });
    this.ready = new Promise((ok, fail) => {
      this.ws.addEventListener('open', ok);
      this.ws.addEventListener('error', fail);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, reject) => this.pending.set(id, { resolve: ok, reject }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chrome;
let cdp;
let profile;
let swSession;
let extId;
// One-time recovery code returned by lock:setup in before().
let recoveryCode;
const PASSWORD = 'rahasia1';

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

// Polls `expression` in the page every 100 ms until it is truthy.
async function waitFor(sessionId, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(sessionId, expression);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms: ${expression}`);
    await sleep(100);
  }
}

// Sends a message to the extension's background, like the popup would.
async function bg(message) {
  const pageSession = await openPage(`chrome-extension://${extId}/popup.html`, false);
  const value = await evaluate(pageSession, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  return value;
}

const openSessions = new Map();
async function openPage(url, fresh = true) {
  if (!fresh && openSessions.has(url)) return openSessions.get(url);
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  for (let i = 0; i < 50; i++) {
    const state = await evaluate(sessionId, 'document.readyState').catch(() => 'loading');
    if (state === 'complete') break;
    await sleep(100);
  }
  await sleep(400);
  if (!fresh) openSessions.set(url, sessionId);
  return sessionId;
}

async function loadTestPage() {
  hits.length = 0;
  const session = await openPage(`${SITE}/page.html`);
  return evaluate(session, `({
    loads: window.loads,
    adBanner: getComputedStyle(document.getElementById('ad_banner')).display,
    customAd: getComputedStyle(document.querySelector('.my-custom-ad')).display,
    feedAd: getComputedStyle(document.getElementById('feed-ad')).display,
    content: getComputedStyle(document.getElementById('content')).display,
  })`);
}

before(async () => {
  const exe = findChrome();
  assert.ok(exe, 'Chromium (Playwright) tidak ditemukan');
  await new Promise((ok) => server.listen(PORT, ok));
  profile = mkdtempSync(join(tmpdir(), 'ab-e2e-'));
  tlsServer = createTlsServer(selfSignedCert(profile), handle);
  await new Promise((ok) => tlsServer.listen(TLS_PORT, ok));
  chrome = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    `--host-resolver-rules=MAP site.test 127.0.0.1, MAP adnxs.com 127.0.0.1, MAP adsterra.com 127.0.0.1, MAP www.youtube.com 127.0.0.1, MAP newad.test 127.0.0.1, MAP feed.test 127.0.0.1`,
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=en-US',
    '--ignore-certificate-errors',
    ...platformArgs,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(200);
    wsUrl = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
  }
  assert.ok(wsUrl, 'DevTools tidak bisa dihubungi');
  cdp = new Cdp(wsUrl);
  await cdp.ready;

  // Chromium also runs built-in component extensions; find ours by its manifest name.
  for (let i = 0; i < 50 && !swSession; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const name = await evaluate(sessionId, 'chrome.runtime.getManifest().name').catch(() => null);
      if (name === 'My Chrome Universe') {
        swSession = sessionId;
        extId = new URL(t.url).host;
        break;
      }
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    if (!swSession) await sleep(200);
  }
  assert.ok(swSession, 'service worker extension tidak muncul (extension gagal dimuat?)');
  await sleep(1500); // let onInstalled finish applying rulesets

  // Until a password exists every module message is refused ('setup'), so create it first.
  assert.deepEqual(await bg({ type: 'ab:getOptions' }), { ok: false, error: 'locked' });
  const setup = await bg({ type: 'lock:setup', password: PASSWORD, confirm: PASSWORD });
  assert.equal(setup.ok, true, setup.error);
  recoveryCode = setup.recoveryCode;
  assert.ok(recoveryCode);
});

after(async () => {
  try {
    await cdp?.send('Browser.close');
  } catch {}
  chrome?.kill();
  server.close();
  tlsServer?.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
});

test('static rulesets are accepted and the defaults are enabled', async () => {
  const enabled = await evaluate(swSession, 'chrome.declarativeNetRequest.getEnabledRulesets()');
  assert.deepEqual(enabled.sort(), ['ads', 'security']);
  const available = await evaluate(swSession, 'chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
  assert.ok(available > 0, `available static rules: ${available}`);
});

test('ads are blocked and hidden, normal content is untouched', async () => {
  const r = await loadTestPage();
  assert.equal(r.loads.normal, true, 'normal script should load');
  assert.equal(r.loads.pattern, false, '/js/flyad.js should be blocked');
  assert.equal(r.loads.adserver, false, 'adnxs.com should be blocked');
  assert.equal(r.loads.thirdParty, false, 'third-party adsterra.com should be blocked');
  assert.equal(r.adBanner, 'none', '#ad_banner should be hidden');
  assert.equal(r.content, 'block');
  assert.ok(!hits.some((h) => h.includes('flyad') || h.startsWith('adnxs.com')), `blocked requests reached the server: ${hits}`);
});

test('popup state counts blocked requests on the page', async () => {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.filter((t) => t.type === 'page' && t.url.startsWith(SITE)).at(-1);
  const tabId = await evaluate(swSession, `chrome.tabs.query({}).then(t => t.find(x => x.url && x.url.startsWith(${JSON.stringify(SITE)}))?.id)`);
  assert.ok(page && tabId, 'test tab not found');
  await sleep(800);
  const state = await bg({ type: 'ab:getPopupState', tabId });
  assert.equal(state.site, 'site.test');
  assert.ok(state.pageBlocked >= 3, `pageBlocked = ${state.pageBlocked}`);
  assert.ok(state.totalBlocked >= 3, `totalBlocked = ${state.totalBlocked}`);
});

test('custom filters block and hide immediately', async () => {
  const result = await bg({ type: 'ab:saveCustomFilters', text: '/custom-block.js\nsite.test##.my-custom-ad' });
  assert.equal(result.ok, true);
  assert.equal(result.stats.network, 1);
  assert.equal(result.stats.cosmetic, 1);
  const r = await loadTestPage();
  assert.equal(r.loads.custom, false);
  assert.equal(r.customAd, 'none');
});

test('allowlisting a site turns everything off there, and back on', async () => {
  await bg({ type: 'ab:setAllowlisted', domain: 'site.test', allowlisted: true });
  let r = await loadTestPage();
  assert.equal(r.loads.pattern, true);
  assert.equal(r.loads.adserver, true);
  assert.equal(r.adBanner, 'block');

  await bg({ type: 'ab:setAllowlisted', domain: 'site.test', allowlisted: false });
  r = await loadTestPage();
  assert.equal(r.loads.pattern, false);
  assert.equal(r.adBanner, 'none');
});

test('pause disables all lists; enabling another list works', async () => {
  await bg({ type: 'ab:setPaused', paused: true });
  assert.deepEqual(await evaluate(swSession, 'chrome.declarativeNetRequest.getEnabledRulesets()'), []);
  let r = await loadTestPage();
  assert.equal(r.loads.adserver, true);
  assert.equal(r.adBanner, 'block');

  await bg({ type: 'ab:setPaused', paused: false });
  const saved = await bg({ type: 'ab:saveSettings', patch: { enabledLists: ['ads', 'indonesia', 'security', 'privacy', 'annoyances'] } });
  assert.equal(saved.ok, true);
  const enabled = await evaluate(swSession, 'chrome.declarativeNetRequest.getEnabledRulesets()');
  assert.equal(enabled.length, 5, `enabled: ${enabled}`);
  r = await loadTestPage();
  assert.equal(r.loads.adserver, false);
  assert.equal(r.loads.normal, true);
});

const enabledRulesets = () => evaluate(swSession, 'chrome.declarativeNetRequest.getEnabledRulesets()');

test('turning Ad Blocker off stops blocking and keeps pause separate', async () => {
  // Pause and the module switch are separate settings: switching the module off and on keeps the pause.
  await bg({ type: 'ab:setPaused', paused: true });
  assert.equal((await bg({ type: 'core:setModule', id: 'adblock', enabled: false })).ok, true);
  assert.equal((await bg({ type: 'core:setModule', id: 'adblock', enabled: true })).ok, true);
  assert.equal((await bg({ type: 'ab:getOptions' })).settings.paused, true);
  await bg({ type: 'ab:setPaused', paused: false });
  let r = await loadTestPage();
  assert.equal(r.loads.adserver, false, 'unpaused: blocking again');
  assert.equal(r.adBanner, 'none');

  // The switch is applied by the background after the reply (storage change), so wait for it:
  // rulesets first, then the dynamic rules (the custom filter from an earlier test).
  const dynamicCount = 'chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length)';
  const off = await bg({ type: 'core:setModule', id: 'adblock', enabled: false });
  try {
    assert.deepEqual(off.modules, { adblock: false, tabs: true, lock: true });
    await waitFor(swSession, `chrome.declarativeNetRequest.getEnabledRulesets().then(async (r) => r.length === 0 && (await ${dynamicCount}) === 0)`);
    const tabId = await evaluate(swSession, 'chrome.tabs.query({}).then((t) => t[0].id)');
    const state = await bg({ type: 'ab:getPopupState', tabId });
    assert.equal(state.disabled, true);
    assert.equal(state.paused, false);
    r = await loadTestPage();
    assert.equal(r.loads.adserver, true, 'module off: nothing blocked');
    assert.equal(r.adBanner, 'block', 'module off: nothing hidden');
    assert.deepEqual(await enabledRulesets(), []);
  } finally {
    // Switching back on restores the previous lists and filters.
    await bg({ type: 'core:setModule', id: 'adblock', enabled: true });
  }
  await waitFor(swSession, `chrome.declarativeNetRequest.getEnabledRulesets().then(async (r) => r.length === 5 && (await ${dynamicCount}) > 0)`);
  const tabId = await evaluate(swSession, 'chrome.tabs.query({}).then((t) => t[0].id)');
  r = await loadTestPage();
  assert.equal(r.loads.adserver, false);
  assert.equal(r.adBanner, 'none');
  assert.equal((await bg({ type: 'ab:getPopupState', tabId })).disabled, false);
});

const NEW_TAB_PAGE = 'chrome://new-tab-page/';
const tabUrls = () => evaluate(swSession, 'chrome.tabs.query({}).then((t) => t.map((x) => x.url || x.pendingUrl))');

test('turning Tab Manager off replaces the dashboard', async () => {
  assert.equal((await bg({ type: 'core:setModule', id: 'tabs', enabled: false })).ok, true);
  // The override still loads first, then hands the tab to Chrome's own New Tab page
  // (chrome://new-tab-page/ does not route back to the override).
  const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://newtab/' });
  await waitFor(swSession, `chrome.tabs.query({}).then((t) => t.some((x) => x.url === ${JSON.stringify(NEW_TAB_PAGE)}))`);
  await sleep(500);
  const urls = await tabUrls();
  assert.ok(!urls.includes('chrome://newtab/'), `dashboard still open: ${urls}`);
  assert.equal(urls.filter((u) => u === NEW_TAB_PAGE).length, 1, `redirect looped: ${urls}`);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});

  assert.equal((await bg({ type: 'core:setModule', id: 'tabs', enabled: true })).ok, true);
  const dash = await openPage('chrome://newtab/');
  await waitFor(dash, "document.querySelectorAll('#space-list .space').length > 0");
  assert.match(await evaluate(dash, 'location.href'), /\/modules\/tabs\/newtab\.html$/);
});

async function click(sessionId, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}

// With `selector`, only that element is captured (e.g. the 370 px popup body).
async function screenshot(sessionId, name, selector) {
  if (!process.env.SHOT_DIR) return;
  const clip = selector && await evaluate(sessionId, `(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
  })()`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip && { clip, captureBeyondViewport: true }) }, sessionId);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
}

test('block element picker hides the clicked element and saves a filter', async () => {
  const session = await openPage(`${SITE}/page.html`);
  const tabId = await evaluate(swSession, `chrome.tabs.query({}).then(t => t.filter(x => x.url && x.url.startsWith(${JSON.stringify(SITE)})).at(-1).id)`);
  await bg({ type: 'ab:startPicker', tabId });
  await waitFor(session, "!!document.querySelector('ab-picker')");

  const box = await evaluate(session, `(() => { const r = document.getElementById('content').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2, w: innerWidth, h: innerHeight }; })()`);
  await click(session, box.x, box.y);
  await sleep(300);
  await screenshot(session, 'picker');

  // Panel is fixed at bottom-right (16px margin, 14px padding); "Blokir" is the last of three buttons.
  const panelWidth = Math.min(380, box.w - 32);
  await click(session, box.w - 16 - 14 - (panelWidth - 28) / 6, box.h - 16 - 14 - 17);
  // The picker closes itself only once ab:addFilter succeeded.
  await waitFor(session, "!document.querySelector('ab-picker')");
  await waitFor(session, "getComputedStyle(document.getElementById('content')).display === 'none'");
  const options = await bg({ type: 'ab:getOptions' });
  assert.match(options.settings.customFilters, /site\.test###content/);
});

async function loadYoutube() {
  const session = await openPage(`${YOUTUBE}/watch?v=abc`);
  await sleep(300);
  const href = await evaluate(session, 'location.href');
  assert.ok(href.startsWith(YOUTUBE), `halaman uji YouTube tidak termuat (sekarang di ${href})`);
  return evaluate(session, `(async () => ({
    inline: Object.keys(window.ytInitialPlayerResponse || {}).sort(),
    parsed: Object.keys(window.parsed.playerResponse).sort(),
    fetched: Object.keys(await window.fetched).sort(),
    skipped: Boolean(window.skipped),
    muted: document.querySelector('video').muted,
    masthead: getComputedStyle(document.getElementById('masthead-ad')).display,
  }))()`);
}

test('YouTube video ads are stripped from player data and skipped', async () => {
  const r = await loadYoutube();
  assert.deepEqual(r.inline, ['videoDetails'], 'inline ytInitialPlayerResponse');
  assert.deepEqual(r.parsed, ['videoDetails'], 'JSON.parse');
  assert.deepEqual(r.fetched, ['videoDetails'], 'fetch().json()');
  assert.equal(r.skipped, true, 'skip button clicked');
  assert.equal(r.muted, true, 'playing ad muted');
  assert.equal(r.masthead, 'none');
});

test('YouTube scripts follow pause and the YouTube setting', async () => {
  await bg({ type: 'ab:setPaused', paused: true });
  let r = await loadYoutube();
  assert.ok(r.inline.includes('adPlacements'), 'paused: player data untouched');
  await bg({ type: 'ab:setPaused', paused: false });

  await bg({ type: 'ab:saveSettings', patch: { youtube: false } });
  r = await loadYoutube();
  assert.ok(r.fetched.includes('adPlacements'), 'setting off: untouched');
  await bg({ type: 'ab:saveSettings', patch: { youtube: true } });
  r = await loadYoutube();
  assert.deepEqual(r.fetched, ['videoDetails'], 'setting back on');
});

// ---------- Daily feed updates ----------

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const FEED_URL = `http://feed.test:${PORT}/feed/`;

function publishFeed({ version, rules, cosmetic, corruptChecksum = false }) {
  const rulesJson = JSON.stringify(rules);
  const cosmeticJson = JSON.stringify(cosmetic);
  feedFiles.set('rules/ads.json', rulesJson);
  feedFiles.set('cosmetic/ads.json', cosmeticJson);
  feedFiles.set('index.json', JSON.stringify({
    schema: 1,
    version,
    categories: [{
      id: 'ads',
      title: 'Iklan',
      ruleCount: rules.length,
      files: {
        rules: { path: 'rules/ads.json', sha256: corruptChecksum ? '0'.repeat(64) : sha256(rulesJson) },
        cosmetic: { path: 'cosmetic/ads.json', sha256: sha256(cosmeticJson) },
      },
    }],
  }));
}

const bundledRules = () => JSON.parse(readFileSync(join(adblockDir, 'rules', 'ads.json'), 'utf8'));
const bundledCosmetic = () => JSON.parse(readFileSync(join(adblockDir, 'cosmetic', 'ads.json'), 'utf8'));
const disabledIds = () => evaluate(swSession, "chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: 'ads' })");
let removedRule;

test('daily update adds new rules, disables removed ones and refreshes element hiding', async () => {
  const bundled = bundledRules();
  // The feed dropped the domain group containing adnxs.com and added a new ad server.
  removedRule = bundled.find((r) => r.condition.requestDomains?.includes('adnxs.com'));
  const rules = [
    ...bundled.filter((r) => r !== removedRule).map(({ id, ...r }) => r),
    { priority: 1, action: { type: 'block' }, condition: { requestDomains: ['newad.test'] } },
  ].map((r, i) => ({ id: i + 1, ...r }));
  const cosmetic = bundledCosmetic();
  publishFeed({ version: '209901010000', rules, cosmetic: { ...cosmetic, generic: [...cosmetic.generic, '#feed-ad'] } });

  let r = await loadTestPage();
  assert.equal(r.loads.feedNew, true, 'before the update the new ad server is not known');
  assert.equal(r.feedAd, 'block');

  assert.equal((await bg({ type: 'ab:setFeedUrl', url: FEED_URL })).ok, true);
  const result = await bg({ type: 'ab:updateFilters' });
  assert.equal(result.feed.status, 'updated', result.error);
  assert.equal(result.feed.categories.ads.added.length, 1);
  assert.deepEqual(result.feed.categories.ads.disabled, [removedRule.id]);
  assert.deepEqual(await disabledIds(), [removedRule.id]);

  r = await loadTestPage();
  assert.equal(r.loads.feedNew, false, 'rule added by the feed blocks');
  assert.equal(r.feedAd, 'none', 'selector added by the feed hides');
  assert.equal(r.loads.pattern, false, 'bundled rules keep working');
  assert.equal(r.loads.normal, true);
});

test('a feed with a bad checksum is rejected and the last good update stays', async () => {
  publishFeed({ version: '209901010001', rules: [], cosmetic: bundledCosmetic(), corruptChecksum: true });
  const result = await bg({ type: 'ab:updateFilters' });
  assert.equal(result.feed.status, 'error');
  assert.match(result.error, /checksum/);
  assert.deepEqual(await disabledIds(), [removedRule.id]);
  const r = await loadTestPage();
  assert.equal(r.loads.feedNew, false);
});

test('a feed older than the bundled rules clears downloaded updates', async () => {
  publishFeed({ version: '200001010000', rules: bundledRules(), cosmetic: bundledCosmetic() });
  const result = await bg({ type: 'ab:updateFilters' });
  assert.equal(result.feed.status, 'current');
  assert.deepEqual(await disabledIds(), []);
  const r = await loadTestPage();
  assert.equal(r.loads.feedNew, true);
  assert.equal(r.feedAd, 'block');
  await bg({ type: 'ab:setFeedUrl', url: null });
});

// Opens `url` in a new tab with exception and console-error reporting attached before
// the page loads. `background` keeps the current tab active (as a real popup sees it).
async function openWatched(url, { background = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  cdp.listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') errors.push(`${p.entry.text} ${p.entry.url || ''}`);
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitFor(sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
  await sleep(300);
  return { sessionId, targetId, errors };
}

test('extension pages render without errors', async () => {
  for (const page of ['popup.html', 'modules/adblock/options.html']) {
    const { sessionId: s, targetId, errors } = await openWatched(`chrome-extension://${extId}/${page}`);
    await sleep(500);
    const text = await evaluate(s, 'document.body.innerText');
    assert.ok(text.length > 50, `${page} looks empty`);
    assert.deepEqual(errors, [], `${page} logged errors`);
    await screenshot(s, page.split('/').pop().replace('.html', ''));
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
});

// ---------- Toolbar popup ----------

const cardNames = (s) => evaluate(s, "[...document.querySelectorAll('.mcu-card .mcu-card-name')].map((n) => n.textContent)");
const cardStatus = (s, id) => evaluate(s, `document.querySelector('.mcu-card[data-id="${id}"] .mcu-card-status')?.textContent`);
const openCard = (s, id) => evaluate(s, `document.querySelector('.mcu-card[data-id="${id}"] .mcu-card-open').click()`);
const modSwitch = (id) => `document.querySelector('#mcu-home input[data-mod="${id}"]')`;
const onHome = "document.getElementById('mcu-home').classList.contains('is-on')";
const heroShown = "!document.getElementById('mcu-hero').hidden";
const bodyText = (s) => evaluate(s, 'document.body.innerText');
const panelLinks = (s) => evaluate(s, "[...document.querySelectorAll('head link[rel=stylesheet]')].map((l) => l.getAttribute('href')).filter((h) => h.includes('modules/'))");

test('popup shows the module cards and opens a panel', async () => {
  const { sessionId: s, targetId, errors } = await openWatched(`chrome-extension://${extId}/popup.html`);
  await waitFor(s, "document.querySelectorAll('.mcu-card').length === 3");
  assert.deepEqual(await cardNames(s), ['Ad Blocker', 'Tab Manager', 'Browser Lock']);
  await waitFor(s, `document.querySelector('.mcu-card[data-id="tabs"] .mcu-card-status')?.textContent.endsWith(' koleksi')`);
  assert.equal(await cardStatus(s, 'lock'), 'aktif');
  assert.equal(await evaluate(s, 'document.body.getBoundingClientRect().width'), 370);
  assert.ok(await evaluate(s, 'document.body.getBoundingClientRect().height') <= 600, 'popup fits Chrome\'s 600 px limit');
  for (const id of ['adblock', 'tabs', 'lock']) assert.equal(await evaluate(s, `${modSwitch(id)}.checked`), true, `${id} switch on the card`);
  // The popup's own tab is the active one: no website, so no hero.
  assert.equal(await evaluate(s, heroShown), false);
  assert.ok(await evaluate(s, "!!document.getElementById('mcu-lock-now')"));
  await sleep(900); // reveal
  await screenshot(s, 'popup-home', 'body');

  await openCard(s, 'adblock');
  await waitFor(s, "document.body.innerText.includes('Blokir elemen di halaman ini')");
  assert.match(await evaluate(s, "document.getElementById('mcu-title').textContent"), /Ad Blocker/);
  assert.equal(await evaluate(s, onHome), false, 'home hidden while a panel is open');
  assert.equal(await evaluate(s, "document.getElementById('mcu-back').inert"), false, 'back button usable in a panel');
  assert.ok((await panelLinks(s)).length > 0, 'the panel loads its module stylesheet');
  await sleep(700);
  await screenshot(s, 'popup-adblock', 'body');

  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, `${onHome} && document.querySelectorAll('.mcu-panel-root').length === 0`);
  assert.match(await evaluate(s, "document.getElementById('mcu-title').textContent"), /My Chrome Universe/);
  assert.ok(!(await bodyText(s)).includes('Blokir elemen di halaman ini'), 'panel removed after ←');
  assert.deepEqual(await panelLinks(s), [], 'module stylesheet removed after ←');

  // Only one panel at a time: switching modules replaces the previous one.
  await openCard(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Simpan tab ini')");
  assert.equal(await evaluate(s, "document.querySelectorAll('.mcu-panel-root').length"), 1);
  assert.deepEqual(errors, []);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
});

test('popup hero shows the active site and its blocked count', async () => {
  const site = await openWatched(`${SITE}/page.html`);
  await sleep(800);
  const tabId = await evaluate(swSession, `chrome.tabs.query({}).then(t => t.filter(x => x.url && x.url.startsWith(${JSON.stringify(SITE)})).at(-1).id)`);
  const popup = await openWatched(`chrome-extension://${extId}/popup.html`, { background: true });
  const s = popup.sessionId;
  await waitFor(s, heroShown);
  const { pageBlocked } = await bg({ type: 'ab:getPopupState', tabId });
  assert.ok(pageBlocked >= 3, `pageBlocked = ${pageBlocked}`);
  assert.match(await evaluate(s, "document.getElementById('mcu-hero').innerText"), /site\.test/);
  await waitFor(s, `document.querySelector('#mcu-hero .mcu-hero-n').textContent === ${JSON.stringify(String(pageBlocked))}`);
  await sleep(600);
  await screenshot(s, 'popup-home-hero', 'body');

  // The Ad Blocker switch on its card turns the module off: no hero, status "nonaktif".
  await evaluate(s, `${modSwitch('adblock')}.click()`);
  await waitFor(s, `document.querySelector('.mcu-card[data-id="adblock"] .mcu-card-status')?.textContent === 'nonaktif'`);
  assert.equal((await bg({ type: 'core:getModules' })).modules.adblock, false);
  await waitFor(s, `!(${heroShown})`);
  assert.equal(await evaluate(s, `document.querySelector('.mcu-card[data-id="adblock"]').classList.contains('off')`), true);
  await openCard(s, 'adblock');
  await waitFor(s, "document.body.innerText.includes('Fitur ini sedang nonaktif.')");
  assert.ok(!(await bodyText(s)).includes('Blokir elemen di halaman ini'), 'controls hidden while off');
  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, onHome);
  await evaluate(s, `${modSwitch('adblock')}.click()`);
  await waitFor(s, `document.querySelector('.mcu-card[data-id="adblock"] .mcu-card-status')?.textContent.startsWith('aktif')`);
  assert.equal((await bg({ type: 'core:getModules' })).modules.adblock, true);
  await waitFor(s, heroShown);
  assert.deepEqual(popup.errors, []);
  for (const id of [popup.targetId, site.targetId]) await cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
});

test('popup works when the active tab is not a website', async () => {
  const { targetId: blank } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const popup = await openWatched(`chrome-extension://${extId}/popup.html`, { background: true });
  const s = popup.sessionId;
  const active = await evaluate(s, 'chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t.url)');
  assert.equal(active, 'about:blank', 'the popup sees about:blank as the active tab');

  await waitFor(s, `document.querySelector('.mcu-card[data-id="adblock"] .mcu-card-status')?.textContent === 'aktif'`);
  assert.equal(await evaluate(s, heroShown), false, 'no hero without a website');
  await openCard(s, 'adblock');
  await waitFor(s, "document.body.innerText.includes('Pemblokiran tidak berlaku di halaman ini.')");
  await sleep(1200); // one live refresh
  assert.deepEqual(popup.errors, []);
  for (const id of [popup.targetId, blank]) await cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
});

test('popup card switches turn modules off and on', async () => {
  const { sessionId: s, targetId, errors } = await openWatched(`chrome-extension://${extId}/popup.html`);
  await waitFor(s, "document.querySelectorAll('.mcu-card').length === 3");

  // Tab Manager: the card switch turns it off; its panel then shows only the notice.
  await openCard(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Simpan tab ini')");
  await sleep(700);
  await screenshot(s, 'popup-tabs', 'body');
  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, onHome);
  await evaluate(s, `${modSwitch('tabs')}.click()`);
  await waitFor(s, `document.querySelector('.mcu-card[data-id="tabs"] .mcu-card-status')?.textContent === 'nonaktif'`);
  assert.equal((await bg({ type: 'core:getModules' })).modules.tabs, false);
  await openCard(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Fitur ini sedang nonaktif.')");
  assert.ok(!(await bodyText(s)).includes('Simpan tab ini'), 'save controls hidden while off');
  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, onHome);
  await evaluate(s, `${modSwitch('tabs')}.click()`);
  await waitFor(s, `document.querySelector('.mcu-card[data-id="tabs"] .mcu-card-status')?.textContent.endsWith(' koleksi')`);
  assert.equal((await bg({ type: 'core:getModules' })).modules.tabs, true);
  await openCard(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Simpan tab ini')");
  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, onHome);

  // Browser Lock: turning its card switch off opens the lock panel with the password form.
  await evaluate(s, `${modSwitch('lock')}.click()`);
  await waitFor(s, "document.querySelector('.mcu-panel-root')?.dataset.module === 'lock' && !!document.getElementById('disable-current') && !document.getElementById('disable-current').form.hidden");
  assert.match(await evaluate(s, "document.getElementById('mcu-title').textContent"), /Browser Lock/);
  assert.equal(await evaluate(s, `${modSwitch('lock')}.checked`), true, 'stays on until the password is confirmed');
  const confirmOff = (pw) => evaluate(s, `(() => {
    const input = document.getElementById('disable-current');
    input.value = ${JSON.stringify(pw)};
    input.form.requestSubmit();
  })()`);
  await confirmOff('salah-sekali');
  await waitFor(s, "document.body.innerText.includes('Password saat ini salah.')");
  await sleep(500);
  await screenshot(s, 'popup-lock', 'body');
  assert.equal((await bg({ type: 'lock:getState' })).enabled, true);
  assert.equal(await evaluate(s, `${modSwitch('lock')}.checked`), true, 'wrong password keeps the switch on');
  await confirmOff(PASSWORD);
  await waitFor(s, "document.body.innerText.includes('Fitur ini sedang nonaktif.')");
  assert.equal((await bg({ type: 'lock:getState' })).enabled, false);
  await waitFor(s, `!${modSwitch('lock')}.checked`);
  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, `${onHome} && document.querySelector('.mcu-card[data-id="lock"] .mcu-card-status')?.textContent === 'nonaktif'`);
  await evaluate(s, `${modSwitch('lock')}.click()`);
  await waitFor(s, `document.querySelector('.mcu-card[data-id="lock"] .mcu-card-status')?.textContent === 'aktif'`);
  const state = await bg({ type: 'lock:getState' });
  assert.equal(state.enabled, true);
  assert.equal(state.locked, false);
  assert.equal(await evaluate(s, `${modSwitch('lock')}.checked`), true);
  assert.deepEqual(errors, []);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
});

test('options page lists every module', async () => {
  const frameUrl = (s) => evaluate(s, "document.getElementById('frame')?.src || ''");
  const { sessionId: s, targetId, errors } = await openWatched(`chrome-extension://${extId}/options.html#lock`);
  await waitFor(s, "document.querySelectorAll('#side a').length === 3");
  const names = await evaluate(s, "[...document.querySelectorAll('#side a')].map((a) => a.textContent.trim())");
  for (const name of ['Ad Blocker', 'Tab Manager', 'Browser Lock']) {
    assert.ok(names.some((n) => n.includes(name)), `menu lacks ${name}: ${names}`);
  }
  await waitFor(s, "document.getElementById('frame')?.src.endsWith('/modules/lock/options.html')");
  await waitFor(s, "(document.getElementById('frame')?.contentDocument?.body?.innerText || '').includes('Pengaturan Browser Lock')");

  // The parent "Aktif" switch is the only on/off control: the framed lock page hides its own.
  const inFrame = (expr) => evaluate(s, `(() => { const d = document.getElementById('frame').contentDocument; return ${expr}; })()`);
  await waitFor(s, "!document.getElementById('frame').contentDocument.getElementById('has-password').hidden");
  assert.equal(await inFrame("d.getElementById('enabled').checkVisibility()"), false, 'lock page on/off switch is hidden in the frame');
  assert.equal(await inFrame("d.getElementById('enabled-section').hidden"), true);
  assert.equal(await inFrame("d.getElementById('change-form').checkVisibility()"), true, 'the rest of the lock settings stay');

  const sw = "document.querySelector('.mcu-module-switch input')";
  const confirmOff = (pw) => evaluate(s, `(() => {
    const input = document.getElementById('disable-current');
    input.value = ${JSON.stringify(pw)};
    input.form.requestSubmit();
  })()`);
  assert.equal(await evaluate(s, `${sw}.checked`), true);
  await evaluate(s, `${sw}.click()`);
  await waitFor(s, "!!document.getElementById('disable-current') && !document.getElementById('disable-current').form.hidden");
  assert.equal(await evaluate(s, `${sw}.checked`), true, 'stays on until the password is confirmed');
  await confirmOff('salah-sekali');
  await waitFor(s, "document.querySelector('.mcu-msg').textContent.includes('salah')");
  assert.equal((await bg({ type: 'lock:getState' })).enabled, true, 'wrong password keeps the lock on');
  assert.equal(await evaluate(s, `${sw}.checked`), true);
  await confirmOff(PASSWORD);
  await waitFor(s, `${sw} && !${sw}.checked`);
  assert.equal((await bg({ type: 'lock:getState' })).enabled, false);
  // Turned back on elsewhere (e.g. the popup): the parent switch follows the stored state.
  assert.equal((await bg({ type: 'lock:setEnabled', enabled: true })).ok, true);
  await waitFor(s, `${sw}.checked`);
  const state = await bg({ type: 'lock:getState' });
  assert.equal(state.enabled, true);
  assert.equal(state.locked, false);

  await evaluate(s, "location.hash = '#adblock'");
  await waitFor(s, "document.getElementById('frame')?.src.endsWith('/modules/adblock/options.html')");
  await waitFor(s, "(document.getElementById('frame')?.contentDocument?.body?.innerText || '').length > 50");
  assert.match(await frameUrl(s), /modules\/adblock\/options\.html$/);

  // Tab Manager has no options page: switch + dashboard button instead of an iframe.
  await evaluate(s, "location.hash = '#tabs'");
  await waitFor(s, "!document.getElementById('frame') && document.body.innerText.includes('Buka dashboard')");
  assert.equal(await evaluate(s, "document.querySelector('.mcu-module-switch input').checked"), true);
  assert.deepEqual(errors, [], 'options page logged errors');
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
});

// ---------- Tab Manager dashboard ----------

const dashboardUrl = () => `chrome-extension://${extId}/modules/tabs/newtab.html`;
const tmData = () => bg({ type: 'tm:getData' });
const findCol = (data, name) => {
  for (const space of data.spaces) {
    const col = space.collections.find((c) => c.name === name);
    if (col) return { space, col };
  }
  return null;
};

// Imports `spaces` next to the existing data; returns them (with ids) in the same order.
async function addSpaces(spaces) {
  assert.equal((await bg({ type: 'tm:op', op: { type: 'import', mode: 'merge', data: { spaces } } })).ok, true);
  const data = await tmData();
  return spaces.map((s) => data.spaces.filter((x) => x.name === s.name).at(-1));
}

async function removeSpaces(ids, activeId) {
  for (const spaceId of ids) await bg({ type: 'tm:op', op: { type: 'space/delete', spaceId } });
  if (activeId) await bg({ type: 'tm:op', op: { type: 'space/activate', spaceId: activeId } });
}

// Opens a collection's ⋯ menu and clicks the item whose label starts with `label`.
async function colMenu(s, colId, label) {
  const item = `[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
  await evaluate(s, `document.querySelector('.col[data-id="${colId}"] .col-more').click()`);
  await waitFor(s, `!!${item}`);
  await evaluate(s, `${item}.click()`);
}

test('dashboard keeps every collection action', async () => {
  const { activeSpaceId: prevActive } = await tmData();
  const A = 'https://a.test/', B = 'https://b.test/';
  const [src, dst] = await addSpaces([
    { name: 'Uji Aksi', collections: [{ name: 'Aksi', cards: [{ url: A, title: 'A' }, { url: B, title: 'B' }, { url: A, title: 'A lagi' }] }] },
    { name: 'Tujuan', collections: [] },
  ]);
  const colId = src.collections[0].id;
  await bg({ type: 'tm:op', op: { type: 'space/activate', spaceId: src.id } });
  const { sessionId: s, targetId, errors } = await openWatched(dashboardUrl());
  try {
    const col = `document.querySelector('#cols .col[data-id="${colId}"]')`;
    await waitFor(s, `!!${col}`);
    assert.equal(await evaluate(s, `${col}.querySelectorAll('.row[data-id]').length`), 3);
    assert.equal(await evaluate(s, "document.querySelector('#space-list .space.on')?.dataset.id"), src.id);

    // Ganti nama: inline on the collection title, Enter saves.
    await colMenu(s, colId, 'Ganti nama');
    await waitFor(s, `${col}.querySelector('.col-name').isContentEditable`);
    await evaluate(s, `(() => {
      const n = ${col}.querySelector('.col-name');
      n.textContent = 'Aksi Baru';
      n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await until(async () => findCol(await tmData(), 'Aksi Baru'), 'collection renamed');
    await waitFor(s, `${col}?.querySelector('.col-name').textContent === 'Aksi Baru'`);

    // Pindah ke ruang lain: dialog with a space picker.
    await colMenu(s, colId, 'Pindah ke ruang lain');
    await waitFor(s, "document.getElementById('dialog').open");
    await evaluate(s, `(() => {
      const f = document.getElementById('dialog-form');
      f.elements.spaceId.value = ${JSON.stringify(dst.id)};
      f.requestSubmit(f.querySelector('button[value="ok"]'));
    })()`);
    await until(async () => findCol(await tmData(), 'Aksi Baru')?.space.id === dst.id, 'collection moved');
    await waitFor(s, `!${col}`);
    await evaluate(s, `document.querySelector('#space-list .space[data-id="${dst.id}"]').click()`);
    await waitFor(s, `!!${col} && document.querySelector('#space-list .space.on')?.dataset.id === ${JSON.stringify(dst.id)}`);

    // Hapus tab ganda di koleksi ini.
    await colMenu(s, colId, 'Hapus tab ganda');
    await until(async () => findCol(await tmData(), 'Aksi Baru')?.col.cards.length === 2, 'duplicates removed');
    await waitFor(s, `${col}?.querySelectorAll('.row').length === 2`);

    // Hapus koleksi, then Urungkan from the toast.
    await colMenu(s, colId, 'Hapus koleksi');
    await until(async () => !findCol(await tmData(), 'Aksi Baru'), 'collection deleted');
    const undo = "[...document.querySelectorAll('.toast button')].find((b) => b.textContent.includes('Urungkan'))";
    await waitFor(s, `!!${undo}`);
    await evaluate(s, `${undo}.click()`);
    const restored = await until(async () => findCol(await tmData(), 'Aksi Baru'), 'collection restored');
    assert.equal(restored.space.id, dst.id);
    assert.deepEqual(restored.col.cards.map((c) => c.url), [A, B]);
    await waitFor(s, "document.querySelectorAll('#cols .col').length === 1");
    assert.deepEqual(errors, [], 'dashboard logged errors');
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await removeSpaces([src.id, dst.id], prevActive);
  }
});

test('big spaces stay fast and narrow screens do not scroll sideways', async (t) => {
  const { activeSpaceId: prevActive } = await tmData();
  const title = (i, j) => `${`Judul tab yang sangat panjang nomor ${i}-${j} `.repeat(12)}`.slice(0, 300);
  const [big] = await addSpaces([{
    name: 'Ruang besar',
    collections: Array.from({ length: 20 }, (_, i) => ({
      name: `Koleksi besar ${i + 1} ${'panjang'.repeat(20)}`,
      cards: Array.from({ length: 20 }, (_, j) => ({ url: `https://situs-${i}-${j}.test/${'jalur-panjang/'.repeat(20)}`, title: title(i, j) })),
    })),
  }]);
  await bg({ type: 'tm:op', op: { type: 'space/activate', spaceId: big.id } });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, s);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: false }, s);
  const measure = async () => {
    await waitFor(s, "performance.getEntriesByName('tm:rendered').length > 0", 10000);
    return evaluate(s, `(() => {
      const main = document.getElementById('tm-main');
      return {
        renderedAt: performance.getEntriesByName('tm:rendered')[0].startTime,
        scrollWidth: document.documentElement.scrollWidth, innerWidth,
        mainOverflow: main.scrollWidth - main.clientWidth,
        cols: document.querySelectorAll('#cols .col').length,
        rows: document.querySelectorAll('#cols .row').length,
        // A marker that stays after the animation ends (stable on slow machines and in minimal motion).
        entering: document.querySelectorAll('.col[data-entered]').length,
      };
    })()`);
  };
  try {
    await cdp.send('Page.navigate', { url: dashboardUrl() }, s);
    const m = await measure();
    assert.equal(m.cols, 20);
    assert.equal(m.rows, 400);
    assert.equal(m.innerWidth, 400);
    assert.ok(m.scrollWidth <= m.innerWidth, `page scrolls sideways: ${m.scrollWidth} > ${m.innerWidth}`);
    assert.ok(m.mainOverflow <= 0, `collections overflow sideways by ${m.mainOverflow} px`);
    assert.ok(m.renderedAt < 1500, `render took ${Math.round(m.renderedAt)} ms`);
    assert.ok(m.entering > 0 && m.entering <= 24, `${m.entering} collections animate in`);
    t.diagnostic(`400 cards rendered ${Math.round(m.renderedAt)} ms after navigation`);
    if (process.env.SHOT_DIR) await sleep(1800); // let the entrance finish
    await screenshot(s, 'dashboard-big-400');

    // More collections than the stagger cap: exactly the first 24 animate in.
    for (let i = 0; i < 8; i++) {
      await bg({ type: 'tm:op', op: { type: 'collection/create', spaceId: big.id, name: `Tambahan ${i}`, tabs: [{ url: 'https://tambahan.test/', title: 'Tambahan' }], index: 20 } });
    }
    await cdp.send('Page.navigate', { url: dashboardUrl() }, s);
    await waitFor(s, "document.querySelectorAll('#cols .col').length === 28");
    const m2 = await measure();
    assert.equal(m2.entering, 24);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await removeSpaces([big.id], prevActive);
  }
});

// Real key presses through DevTools (Ctrl+K, /, Enter, Escape).
const KEYS = {
  k: { code: 'KeyK', keyCode: 75, text: 'k' },
  '/': { code: 'Slash', keyCode: 191, text: '/' },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
};
async function press(sessionId, key, { ctrl = false } = {}) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: ctrl ? 2 : 0 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text && !ctrl && { text: k.text }) }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
}
const dashReady = "document.getElementById('tm')?.classList.contains('ready')";
const swSession_ = (expr) => evaluate(swSession, expr);
const sessionValue = (key) => swSession_(`chrome.storage.session.get(${JSON.stringify(key)}).then((g) => g[${JSON.stringify(key)}] ?? null)`);
const localValue = (key) => swSession_(`chrome.storage.local.get(${JSON.stringify(key)}).then((g) => g[${JSON.stringify(key)}] ?? null)`);

test('palette finds saved tabs and runs commands', async () => {
  const { activeSpaceId: prevActive } = await tmData();
  const [space] = await addSpaces([{
    name: 'Uji Palet',
    collections: [
      { name: 'Lain', cards: [{ url: 'https://lain.test/', title: 'Lain' }] },
      { name: 'Bacaan', cards: [{ url: 'https://palet.test/komet', title: 'Panduan Komet Halley' }] },
    ],
  }]);
  const colId = space.collections[1].id;
  const { sessionId: s, targetId, errors } = await openWatched(dashboardUrl());
  try {
    await waitFor(s, dashReady);
    const items = "[...document.querySelectorAll('#pal-list .pal-item')].map((b) => b.textContent)";

    await press(s, 'k', { ctrl: true });
    await waitFor(s, "!document.getElementById('palette').hidden && document.activeElement?.id === 'pal-q'");
    await cdp.send('Input.insertText', { text: 'komet halley' }, s);
    await waitFor(s, `${items}[0]?.includes('Panduan Komet Halley')`);
    if (process.env.SHOT_DIR) await sleep(500); // let the palette fade in
    await screenshot(s, 'dashboard-palette');
    // The collection is revealed in its own space and flashes (recorded, the class is removed after the animation).
    await evaluate(s, `(() => {
      window.flashed = new Set();
      new MutationObserver((list) => {
        for (const m of list) if (m.target.classList?.contains('flash')) window.flashed.add(m.target.dataset.id);
      }).observe(document.getElementById('cols'), { subtree: true, attributes: true, attributeFilter: ['class'] });
    })()`);
    await press(s, 'Enter');
    await waitFor(s, `window.flashed.has(${JSON.stringify(colId)})`);
    await waitFor(s, "document.getElementById('palette').hidden");
    assert.equal(await evaluate(s, "document.querySelector('#space-list .space.on')?.dataset.id"), space.id);

    // "/" opens it too; commands are found by name (not run here: it would lock the browser).
    await press(s, '/');
    await waitFor(s, "!document.getElementById('palette').hidden && document.activeElement?.id === 'pal-q'");
    assert.equal(await evaluate(s, "document.getElementById('pal-q').value"), '');
    await cdp.send('Input.insertText', { text: 'kunci' }, s);
    await waitFor(s, `${items}.some((t) => t.includes('Kunci browser sekarang'))`);
    await press(s, 'Escape');
    await waitFor(s, "document.getElementById('palette').hidden");
    assert.deepEqual(errors, [], 'dashboard logged errors');
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await removeSpaces([space.id], prevActive);
  }
});

test('theme button switches every open page', async () => {
  const before = await localValue('core:appearance');
  await swSession_(`chrome.storage.local.set({ 'core:appearance': { ...${JSON.stringify(before || {})}, theme: 'light' } })`);
  const a = await openWatched(dashboardUrl());
  const b = await openWatched(dashboardUrl());
  try {
    for (const p of [a, b]) await waitFor(p.sessionId, `${dashReady} && document.documentElement.dataset.ui === 'light'`);
    await evaluate(b.sessionId, 'window.notReloaded = true');
    await evaluate(a.sessionId, "document.getElementById('theme-btn').click()");
    for (const p of [a, b]) await waitFor(p.sessionId, "document.documentElement.dataset.ui === 'dark'");
    assert.equal(await evaluate(b.sessionId, 'window.notReloaded'), true, 'the other page changed without a reload');
    assert.equal((await localValue('core:appearance')).theme, 'dark');
    assert.deepEqual([...a.errors, ...b.errors], []);
  } finally {
    for (const p of [a, b]) await cdp.send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
    await swSession_(before
      ? `chrome.storage.local.set({ 'core:appearance': ${JSON.stringify(before)} })`
      : "chrome.storage.local.remove('core:appearance')");
  }
});

// A tab on a unique blank URL, its chrome.tabs id, and a session with error reporting; then `url` is loaded.
async function openTabWithId(url, mark) {
  const blank = `about:blank#${mark}`;
  const { targetId } = await cdp.send('Target.createTarget', { url: blank });
  const tabId = await until(() => swSession_(`chrome.tabs.query({}).then((t) => t.find((x) => x.url === ${JSON.stringify(blank)})?.id ?? null)`), `tab ${mark}`);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  cdp.listeners.add((msg) => {
    if (msg.sessionId === sessionId && msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId, tabId, errors, load: () => cdp.send('Page.navigate', { url }, sessionId) };
}

test('arrival plays only after unlock', async () => {
  // The service worker stores the id of the lock tab that becomes the dashboard; only that tab arrives.
  const mine = await openTabWithId(dashboardUrl(), 'arrive-mine');
  const other = await openTabWithId(dashboardUrl(), 'arrive-other');
  const isArriving = (p) => evaluate(p.sessionId, "document.getElementById('tm').classList.contains('arrive')");
  try {
    await swSession_(`chrome.storage.session.set({ 'tm:arrive': ${mine.tabId} })`);
    await other.load();
    await waitFor(other.sessionId, dashReady);
    assert.equal(await isArriving(other), false, 'another new tab does not arrive');
    assert.equal(await sessionValue('tm:arrive'), mine.tabId, 'and leaves the flag for its tab');

    await mine.load();
    await waitFor(mine.sessionId, `${dashReady} && document.getElementById('tm').classList.contains('arrive')`);
    assert.equal(await sessionValue('tm:arrive'), null, 'arrival flag removed by its tab');
    await cdp.send('Page.reload', {}, mine.sessionId);
    await waitFor(mine.sessionId, dashReady, 8000);
    assert.equal(await isArriving(mine), false, 'a reload does not arrive again');
    assert.deepEqual([...mine.errors, ...other.errors], []);
  } finally {
    for (const p of [mine, other]) await cdp.send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
    await swSession_("chrome.storage.session.remove('tm:arrive')");
  }
});

test('welcome plays on the dashboard when Browser Lock is off', async () => {
  assert.equal((await bg({ type: 'lock:setEnabled', enabled: false, current: PASSWORD })).ok, true);
  let page;
  try {
    await swSession_("chrome.storage.session.set({ 'core:welcome': true })");
    page = await openWatched(dashboardUrl());
    const s = page.sessionId;
    await waitFor(s, "!!document.querySelector('#welcome.welcome:not([hidden])')");
    assert.equal(await sessionValue('core:welcome'), null, 'welcome flag consumed');
    assert.equal(await evaluate(s, dashReady), false, 'the dashboard waits for the welcome');
    await evaluate(s, "document.querySelector('.w-skip').click()");
    await waitFor(s, `${dashReady} && document.querySelectorAll('#space-list .space').length > 0`);
    assert.deepEqual(page.errors, []);
  } finally {
    if (page) await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    assert.equal((await bg({ type: 'lock:setEnabled', enabled: true })).ok, true);
  }
});

test('guide shows once', async () => {
  await swSession_("chrome.storage.local.remove('tm:guideSeen')");
  // Leaving the first New Tab before the guide appears (e.g. typing in the omnibox) keeps it for the next one.
  const early = await openWatched(dashboardUrl());
  await waitFor(early.sessionId, dashReady);
  await cdp.send('Page.navigate', { url: `${SITE}/page.html` }, early.sessionId);
  await sleep(2500);
  assert.equal(await localValue('tm:guideSeen'), null, 'guide marked seen without being shown');
  await cdp.send('Target.closeTarget', { targetId: early.targetId }).catch(() => {});

  const { sessionId: s, targetId, errors } = await openWatched(dashboardUrl());
  const shown = "(() => { const g = document.getElementById('guide-card'); return !!g && g.checkVisibility(); })()";
  try {
    await waitFor(s, shown, 6000);
    await until(async () => (await localValue('tm:guideSeen')) === true, 'guide marked seen once shown');
    if (process.env.SHOT_DIR) await sleep(800);
    await screenshot(s, 'dashboard-guide');
    assert.equal(await evaluate(s, "document.getElementById('tm').classList.contains('guiding')"), true);
    await evaluate(s, "document.getElementById('guide-close').click()");
    await waitFor(s, `!${shown}`);
    assert.equal(await localValue('tm:guideSeen'), true);

    await cdp.send('Page.reload', {}, s);
    await waitFor(s, dashReady, 8000);
    await sleep(2500); // longer than the automatic delay
    assert.equal(await evaluate(s, shown), false, 'guide shown again after reload');
    // Still available from the (?) button.
    await evaluate(s, "document.getElementById('guide-btn').click()");
    await waitFor(s, shown);
    assert.deepEqual(errors, []);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
});

// ---------- Lock gate (keep these last: they lock the browser) ----------

const extUrl = (path) => `chrome-extension://${extId}/${path}`;
const LOCK_PAGE = () => extUrl('modules/lock/lock.html');
const pageTargets = async () => (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');

// Polls an async Node-side check every 100 ms until it returns something truthy.
async function until(check, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms: ${what}`);
    await sleep(100);
  }
}

// The lock sweep closes the page bg() talks through, so forget it; the next bg() opens a fresh one.
function forgetBgPage() {
  openSessions.delete(extUrl('popup.html'));
}

// Locks and waits until the lock screen is the only page left; returns a session on it.
async function lockBrowser() {
  // The page sending lock:lock is itself closed by the sweep and its reply never arrives
  // (CDP leaves the evaluation pending), so send it like bg() but without awaiting the reply.
  const session = await openPage(extUrl('popup.html'), false);
  forgetBgPage();
  await evaluate(session, "void chrome.runtime.sendMessage({ type: 'lock:lock' }).catch(() => {})");
  await until(async () => {
    const pages = await pageTargets();
    return pages.length === 1 && pages[0].url.startsWith(LOCK_PAGE());
  }, 'only the lock screen is open');
  const [lockTarget] = await pageTargets();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: lockTarget.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor(sessionId, "document.readyState === 'complete'");
  return sessionId;
}

// Sends a message from the lock screen (the only extension page allowed while locked).
const fromLock = (session, message) => evaluate(session, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);

// Waits for the unlock to finish restoring tabs (the lock tab is closed last).
async function waitUnlocked() {
  await until(async () => !(await pageTargets()).some((t) => t.url.startsWith(LOCK_PAGE())), 'lock screen closed');
}

let lockSession;
const SECRET_SPACE = 'Ruang saat terkunci';

test('locking closes every extension page and refuses module messages', async () => {
  const dash = await openPage('chrome://newtab/');
  await waitFor(dash, "document.querySelectorAll('#space-list .space').length > 0");
  const options = await openPage(extUrl('modules/adblock/options.html'));
  assert.ok((await evaluate(options, 'document.body.innerText')).length > 50, 'options page did not render');
  // A website tab to be remembered and restored.
  await openPage(`${SITE}/page.html`);

  lockSession = await lockBrowser();
  assert.equal((await fromLock(lockSession, { type: 'lock:getState' })).locked, true);
  assert.deepEqual(
    await fromLock(lockSession, { type: 'tm:op', op: { type: 'space/create', name: SECRET_SPACE } }),
    { ok: false, error: 'locked' },
  );
  assert.deepEqual(await fromLock(lockSession, { type: 'tm:getData' }), { ok: false, error: 'locked' });
  assert.deepEqual(await fromLock(lockSession, { type: 'ab:getOptions' }), { ok: false, error: 'locked' });
  assert.deepEqual(await fromLock(lockSession, { type: 'core:setModule', id: 'lock', enabled: false }), { ok: false, error: 'locked' });

  // An extension page opened while locked is closed again.
  const { targetId } = await cdp.send('Target.createTarget', { url: extUrl('popup.html') });
  await until(async () => !(await pageTargets()).some((t) => t.targetId === targetId), 'popup opened while locked is closed');
  const pages = await pageTargets();
  assert.deepEqual(pages.map((t) => t.url.split('?')[0]), [LOCK_PAGE()], 'only the lock screen remains');
});

test('unlock restores tabs and shows the dashboard', async () => {
  const wrong = await fromLock(lockSession, { type: 'lock:unlock', password: 'salah' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'wrong');

  assert.equal((await fromLock(lockSession, { type: 'lock:unlock', password: PASSWORD })).ok, true);
  await waitUnlocked();
  const tabs = await until(async () => {
    const all = await evaluate(swSession, "chrome.tabs.query({}).then((t) => t.map((x) => ({ url: x.url || x.pendingUrl || '', active: x.active, index: x.index, windowId: x.windowId })))");
    return all.some((t) => t.url.startsWith(SITE)) && all.some((t) => t.active && t.url) && all;
  }, 'restored website tab and an active tab with a URL', 20000);

  // Website tabs come back in the background; extension pages (options, dashboard) are not restored.
  const restored = tabs.filter((t) => t.url.startsWith(SITE));
  assert.ok(restored.length >= 1, 'site.test tab restored');
  assert.ok(restored.every((t) => !t.active), 'restored tabs open in the background');
  assert.ok(!tabs.some((t) => t.url.includes('/modules/adblock/')), `extension pages were restored: ${tabs.map((t) => t.url)}`);

  // The dashboard is the lock tab turned into New Tab and moved to the end; it is the only active tab.
  const active = tabs.filter((t) => t.active);
  assert.equal(active.length, 1, `active tabs: ${JSON.stringify(active)}`);
  assert.match(active[0].url, /^(chrome:\/\/newtab\/|chrome-extension:\/\/[a-z]+\/modules\/tabs\/newtab\.html)$/);
  const inWindow = tabs.filter((t) => t.windowId === active[0].windowId);
  assert.equal(active[0].index, Math.max(...inWindow.map((t) => t.index)), 'dashboard is the last tab');
  assert.equal(new Set(tabs.map((t) => t.windowId)).size, 1, 'everything is in the lock screen window');

  // The dashboard renders again, and nothing sent while locked was applied.
  const dashTarget = (await pageTargets()).find((t) => t.url === active[0].url || t.url.endsWith('/modules/tabs/newtab.html'));
  assert.ok(dashTarget, 'dashboard target not found');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: dashTarget.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor(sessionId, "document.querySelectorAll('#space-list .space').length > 0");
  const data = await bg({ type: 'tm:getData' });
  assert.ok(Array.isArray(data.spaces), `tm:getData: ${JSON.stringify(data)}`);
  assert.ok(!data.spaces.some((s) => s.name === SECRET_SPACE), 'tm:op sent while locked was applied');
  assert.equal((await bg({ type: 'ab:getOptions' })).settings.paused, false);
});

// ---------- Lock screen UI (welcome, form unlock) ----------

// True when `sel` exists and is rendered (not display:none / visibility:hidden / [hidden]).
const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.checkVisibility({ visibilityProperty: true }); })()`;

test('startup shows the welcome, then the login card', async () => {
  // The service worker raises this flag on browser startup; the lock screen consumes it once.
  await evaluate(swSession, "chrome.storage.session.set({ 'core:welcome': true })");
  lockSession = await lockBrowser();
  await waitFor(lockSession, visible('#welcome'));
  await screenshot(lockSession, 'lock-welcome');
  // The card behind the welcome can be neither focused nor clicked.
  assert.equal(await evaluate(lockSession, "!!document.querySelector('.login-card').closest('[inert]')"), true);
  await waitFor(lockSession, "document.activeElement?.classList.contains('w-skip')");
  assert.equal(await evaluate(swSession, "chrome.storage.session.get('core:welcome').then((g) => g['core:welcome'] ?? null)"), null, 'welcome flag consumed');

  await evaluate(lockSession, "document.querySelector('.w-skip').click()");
  await waitFor(lockSession, `${visible('#form')} && document.activeElement?.id === 'password'`);
  await waitFor(lockSession, `!${visible('#welcome')}`);
  assert.equal(await evaluate(lockSession, "!!document.querySelector('.login-card').closest('[inert]')"), false);
  await sleep(1200);
  await screenshot(lockSession, 'lock-login');
});

test('wrong password message appears at once in minimal motion', async () => {
  const before = await evaluate(swSession, "chrome.storage.local.get('core:appearance').then((g) => g['core:appearance'] ?? null)");
  await evaluate(swSession, `chrome.storage.local.set({ 'core:appearance': { ...${JSON.stringify(before || {})}, motion: 'minimal' } })`);
  try {
    await waitFor(lockSession, "document.documentElement.dataset.motion === 'minimal'");
    // Time from the background's reply to the visible message (the password check itself is not animation).
    const timing = await evaluate(lockSession, `new Promise((resolve) => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      let replyAt = 0;
      chrome.runtime.sendMessage = (...a) => orig(...a).then((r) => { replyAt = performance.now(); return r; });
      const msg = document.getElementById('msg');
      const t0 = performance.now();
      const obs = new MutationObserver(() => {
        if (msg.textContent.includes('Password salah')) {
          obs.disconnect();
          const now = performance.now();
          resolve({ afterReply: now - replyAt, total: now - t0 });
        }
      });
      obs.observe(msg, { childList: true, characterData: true, subtree: true });
      document.getElementById('password').value = 'salah';
      document.getElementById('form').requestSubmit();
      setTimeout(() => resolve(null), 5000);
    })`);
    assert.ok(timing, '"Password salah" never appeared');
    assert.ok(timing.afterReply <= 300, `message took ${Math.round(timing.afterReply)} ms after the reply`);
    assert.match(await evaluate(lockSession, "document.getElementById('msg').textContent"), /Sisa \d percobaan/);
  } finally {
    await evaluate(swSession, before
      ? `chrome.storage.local.set({ 'core:appearance': ${JSON.stringify(before)} })`
      : "chrome.storage.local.remove('core:appearance')");
  }
});

test('unlocking from the form turns the lock tab into the dashboard', async () => {
  const [lockTarget] = (await pageTargets()).filter((t) => t.url.startsWith(LOCK_PAGE()));
  assert.ok(lockTarget, 'lock screen target');
  await waitFor(lockSession, "document.documentElement.dataset.motion === 'full'");
  // Record that the page itself sends lock:handoff (the service worker would otherwise do it after 4 s).
  await evaluate(lockSession, `(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (m, ...rest) => {
      if (m?.type === 'lock:handoff') await chrome.storage.session.set({ 'test:handoff': Date.now() });
      return orig(m, ...rest);
    };
  })()`);
  await evaluate(lockSession, `document.getElementById('password').value = ${JSON.stringify(PASSWORD)}; document.getElementById('form').requestSubmit()`);
  await waitFor(lockSession, "document.querySelector('.login-card').classList.contains('unlocked')");

  const dashUrl = /^(chrome:\/\/newtab\/|chrome-extension:\/\/[a-z]+\/modules\/tabs\/newtab\.html)$/;
  await until(async () => (await pageTargets()).some((t) => t.targetId === lockTarget.targetId && dashUrl.test(t.url)),
    'the lock tab itself becomes the dashboard', 15000);
  const sent = await evaluate(swSession, "chrome.storage.session.get('test:handoff').then((g) => g['test:handoff'] ?? null)");
  assert.ok(sent, 'the lock page sent lock:handoff');
  await evaluate(swSession, "chrome.storage.session.remove('test:handoff')");

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: lockTarget.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor(sessionId, "document.querySelectorAll('#space-list .space').length > 0");
  assert.equal((await bg({ type: 'lock:getState' })).locked, false);
  // The dashboard arrives (warp + depth) and consumes the flag the service worker raised.
  await waitFor(sessionId, "document.getElementById('tm').classList.contains('arrive')");
  assert.equal(await evaluate(swSession, "chrome.storage.session.get('tm:arrive').then((g) => g['tm:arrive'] ?? null)"), null);
});

test('manual lock shows no welcome', async () => {
  await evaluate(swSession, "chrome.storage.session.remove('core:welcome')");
  const session = await lockBrowser();
  for (let i = 0; i < 10; i++) {
    assert.equal(await evaluate(session, visible('#welcome')), false, 'welcome shown after a manual lock');
    await sleep(100);
  }
  await waitFor(session, `${visible('#form')} && document.activeElement?.id === 'password'`);
  assert.equal(await evaluate(session, "!!document.querySelector('.login-card').closest('[inert]')"), false);
  // Leave the browser open for the next test.
  assert.equal((await fromLock(session, { type: 'lock:unlock', password: PASSWORD })).ok, true);
  await waitUnlocked();
});

test('the Kunci button collapses the dashboard, then locks', async () => {
  const dash = await openWatched(dashboardUrl());
  const s = dash.sessionId;
  await waitFor(s, `${dashReady} && !document.getElementById('tm-lock').hidden`);
  forgetBgPage();
  // Record when lock:lock leaves the page, relative to the click (the page is closed by the sweep).
  const collapsing = await evaluate(s, `(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (m, ...rest) => {
      if (m?.type === 'lock:lock') await chrome.storage.session.set({ 'test:lockAfter': performance.now() - window.clickedAt });
      return orig(m, ...rest);
    };
    window.clickedAt = performance.now();
    document.getElementById('tm-lock').click();
    return document.getElementById('tm').classList.contains('collapsing');
  })()`);
  assert.equal(collapsing, true, 'the collapse starts on click');
  await until(async () => {
    const pages = await pageTargets();
    return pages.length === 1 && pages[0].url.startsWith(LOCK_PAGE());
  }, 'locked: only the lock screen is open');
  const after = await sessionValue('test:lockAfter');
  assert.ok(after >= 300 && after <= 600, `lock:lock sent ${Math.round(after)} ms after the click`);
  await swSession_("chrome.storage.session.remove('test:lockAfter')");
  const [lockTarget] = await pageTargets();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: lockTarget.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await waitFor(sessionId, "document.readyState === 'complete'");
  assert.equal((await fromLock(sessionId, { type: 'lock:unlock', password: PASSWORD })).ok, true);
  await waitUnlocked();
});

test('recovery code opens the browser and replaces the password', async () => {
  const NEW_PASSWORD = 'baru-rahasia2';
  lockSession = await lockBrowser();

  const recovered = await fromLock(lockSession, { type: 'lock:recover', code: recoveryCode, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
  assert.equal(recovered.ok, true, recovered.error);
  assert.ok(recovered.recoveryCode && recovered.recoveryCode !== recoveryCode, 'a new recovery code is issued');
  // Recovery replaces the password but does not unlock by itself.
  assert.equal((await fromLock(lockSession, { type: 'lock:getState' })).locked, true);

  // The used code is spent and the old password no longer works.
  const reused = await fromLock(lockSession, { type: 'lock:recover', code: recoveryCode, password: 'lagi1234', confirm: 'lagi1234' });
  assert.equal(reused.ok, false);
  assert.equal(reused.error, 'wrong');
  const old = await fromLock(lockSession, { type: 'lock:unlock', password: PASSWORD });
  assert.equal(old.ok, false);
  assert.equal(old.error, 'wrong');

  // The new password opens the browser (and leaves it open for the end of the suite).
  assert.equal((await fromLock(lockSession, { type: 'lock:unlock', password: NEW_PASSWORD })).ok, true);
  await waitUnlocked();
  const state = await bg({ type: 'lock:getState' });
  assert.equal(state.locked, false);
  assert.equal(state.failures, 0, 'a successful unlock resets the failure counter');
  assert.equal((await bg({ type: 'ab:getOptions' })).settings.paused, false);
});
