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
  await waitFor(dash, "document.querySelectorAll('#space-list li').length > 0");
  assert.match(await evaluate(dash, 'location.href'), /\/modules\/tabs\/newtab\.html$/);
});

async function click(sessionId, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}

// With `selector`, only that element is captured (e.g. the 320 px popup body).
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

const tileNames = (s) => evaluate(s, "[...document.querySelectorAll('.mcu-tile .mcu-tile-name')].map((n) => n.textContent)");
const tileStatus = (s, id) => evaluate(s, `document.querySelector('.mcu-tile[data-id="${id}"] .mcu-tile-status')?.textContent`);
const openTile = (s, id) => evaluate(s, `document.querySelector('.mcu-tile[data-id="${id}"]').click()`);
const bodyText = (s) => evaluate(s, 'document.body.innerText');
const panelLinks = (s) => evaluate(s, "[...document.querySelectorAll('head link[rel=stylesheet]')].map((l) => l.getAttribute('href')).filter((h) => h.includes('modules/'))");

test('popup shows the module grid and opens a panel', async () => {
  const { sessionId: s, targetId, errors } = await openWatched(`chrome-extension://${extId}/popup.html`);
  await waitFor(s, "document.querySelectorAll('.mcu-tile').length === 3");
  assert.deepEqual(await tileNames(s), ['Ad Blocker', 'Tab Manager', 'Browser Lock']);
  await waitFor(s, `document.querySelector('.mcu-tile[data-id="tabs"] .mcu-tile-status')?.textContent.endsWith(' koleksi')`);
  assert.equal(await tileStatus(s, 'lock'), 'aktif');
  assert.equal(await evaluate(s, 'document.body.getBoundingClientRect().width'), 320);
  await screenshot(s, 'popup-grid', 'body');

  await openTile(s, 'adblock');
  await waitFor(s, "document.body.innerText.includes('Blokir elemen di halaman ini')");
  assert.match(await evaluate(s, "document.getElementById('mcu-title').textContent"), /Ad Blocker/);
  assert.equal(await evaluate(s, "document.getElementById('mcu-grid').hidden"), true, 'grid hidden while a panel is open');
  assert.ok((await panelLinks(s)).length > 0, 'the panel loads its module stylesheet');
  await screenshot(s, 'popup-adblock', 'body');

  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, "!document.getElementById('mcu-grid').hidden && document.querySelectorAll('.mcu-tile').length === 3");
  assert.ok(!(await bodyText(s)).includes('Blokir elemen di halaman ini'), 'panel removed after ←');
  assert.deepEqual(await panelLinks(s), [], 'module stylesheet removed after ←');

  // Only one panel at a time: switching modules replaces the previous one.
  await openTile(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Simpan tab ini')");
  assert.equal(await evaluate(s, "document.querySelectorAll('.mcu-panel-root').length"), 1);
  assert.deepEqual(errors, []);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
});

test('popup works when the active tab is not a website', async () => {
  const { targetId: blank } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const popup = await openWatched(`chrome-extension://${extId}/popup.html`, { background: true });
  const s = popup.sessionId;
  const active = await evaluate(s, 'chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t.url)');
  assert.equal(active, 'about:blank', 'the popup sees about:blank as the active tab');

  await waitFor(s, `document.querySelector('.mcu-tile[data-id="adblock"] .mcu-tile-status')?.textContent === 'aktif'`);
  await openTile(s, 'adblock');
  await waitFor(s, "document.body.innerText.includes('Pemblokiran tidak berlaku di halaman ini.')");
  await sleep(1200); // one live refresh
  assert.deepEqual(popup.errors, []);
  for (const id of [popup.targetId, blank]) await cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
});

test('popup panel switches turn modules off and on', async () => {
  const { sessionId: s, targetId, errors } = await openWatched(`chrome-extension://${extId}/popup.html`);
  await waitFor(s, "document.querySelectorAll('.mcu-tile').length === 3");
  const sw = "document.querySelector('.mcu-module-switch input')";

  // Tab Manager: off leaves only the switch and the notice.
  await openTile(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Simpan tab ini')");
  await screenshot(s, 'popup-tabs', 'body');
  await evaluate(s, `${sw}.click()`);
  await waitFor(s, "document.body.innerText.includes('Fitur ini sedang nonaktif.')");
  assert.equal((await bg({ type: 'core:getModules' })).modules.tabs, false);
  assert.ok(!(await bodyText(s)).includes('Simpan tab ini'), 'save controls hidden while off');
  await evaluate(s, "document.getElementById('mcu-back').click()");
  await waitFor(s, `document.querySelector('.mcu-tile[data-id="tabs"] .mcu-tile-status')?.textContent === 'nonaktif'`);
  await openTile(s, 'tabs');
  await waitFor(s, "document.body.innerText.includes('Fitur ini sedang nonaktif.')");
  await evaluate(s, `${sw}.click()`);
  await waitFor(s, "document.body.innerText.includes('Simpan tab ini')");
  assert.equal((await bg({ type: 'core:getModules' })).modules.tabs, true);
  await evaluate(s, "document.getElementById('mcu-back').click()");

  // Browser Lock: turning off asks for the current password inline.
  await openTile(s, 'lock');
  await waitFor(s, "document.body.innerText.includes('Kunci sekarang')");
  await evaluate(s, `${sw}.click()`);
  await waitFor(s, "!!document.querySelector('.mcu-panel-root input[type=password]')");
  assert.equal(await evaluate(s, `${sw}.checked`), true, 'stays on until the password is confirmed');
  const confirmOff = (pw) => evaluate(s, `(() => {
    const input = document.querySelector('.mcu-panel-root input[type=password]');
    input.value = ${JSON.stringify(pw)};
    input.form.requestSubmit();
  })()`);
  await confirmOff('salah-sekali');
  await waitFor(s, "document.body.innerText.includes('Password saat ini salah.')");
  await screenshot(s, 'popup-lock', 'body');
  assert.equal((await bg({ type: 'lock:getState' })).enabled, true);
  await confirmOff(PASSWORD);
  await waitFor(s, "document.body.innerText.includes('Fitur ini sedang nonaktif.')");
  assert.equal((await bg({ type: 'lock:getState' })).enabled, false);
  await evaluate(s, `${sw}.click()`);
  await waitFor(s, "document.body.innerText.includes('Kunci sekarang')");
  const state = await bg({ type: 'lock:getState' });
  assert.equal(state.enabled, true);
  assert.equal(state.locked, false);
  assert.deepEqual(errors, []);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
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
  await waitFor(dash, "document.querySelectorAll('#space-list li').length > 0");
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
  }, 'restored website tab and an active tab with a URL');

  // Website tabs come back in the background; extension pages (options, dashboard) are not restored.
  const restored = tabs.filter((t) => t.url.startsWith(SITE));
  assert.ok(restored.length >= 1, 'site.test tab restored');
  assert.ok(restored.every((t) => !t.active), 'restored tabs open in the background');
  assert.ok(!tabs.some((t) => t.url.includes('/modules/adblock/')), `extension pages were restored: ${tabs.map((t) => t.url)}`);

  // The dashboard is the active tab, created after the restored ones.
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
  await waitFor(sessionId, "document.querySelectorAll('#space-list li').length > 0");
  const data = await bg({ type: 'tm:getData' });
  assert.ok(Array.isArray(data.spaces), `tm:getData: ${JSON.stringify(data)}`);
  assert.ok(!data.spaces.some((s) => s.name === SECRET_SPACE), 'tm:op sent while locked was applied');
  assert.equal((await bg({ type: 'ab:getOptions' })).settings.paused, false);
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
