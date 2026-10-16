// End-to-end test: loads ad-blocker/ into a real Chromium (Playwright's build, which
// still honours --load-extension), serves a local page full of "ads", and checks
// what actually got blocked or hidden. Drives the browser over the DevTools Protocol.
//
// Run: node tests/ad-blocker.e2e.mjs [path-to-chrome.exe]
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'ad-blocker');
const PORT = 8766;
// YouTube is HSTS-preloaded in newer Chromium builds, so its mock must be served over HTTPS.
const TLS_PORT = 8767;
const YOUTUBE = `https://www.youtube.com:${TLS_PORT}`;
const CDP_PORT = 9333;
const SITE = `http://site.test:${PORT}`;

// Playwright's Chromium: %LOCALAPPDATA%\ms-playwright on Windows, ~/.cache/ms-playwright on Linux (CI).
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bases = [
    join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    join(process.env.HOME || '', '.cache', 'ms-playwright'),
  ];
  for (const base of bases.filter(existsSync)) {
    for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const exe of [join(base, dir, 'chrome-win64', 'chrome.exe'), join(base, dir, 'chrome-linux', 'chrome'), join(base, dir, 'chrome-linux64', 'chrome')]) {
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

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
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
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

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
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
    // GitHub's Linux runners do not allow Chromium's sandbox.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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
      if (name?.startsWith('Ad Blocker')) {
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

async function click(sessionId, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}

async function screenshot(sessionId, name) {
  if (!process.env.SHOT_DIR) return;
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
}

test('block element picker hides the clicked element and saves a filter', async () => {
  const session = await openPage(`${SITE}/page.html`);
  const tabId = await evaluate(swSession, `chrome.tabs.query({}).then(t => t.filter(x => x.url && x.url.startsWith(${JSON.stringify(SITE)})).at(-1).id)`);
  await bg({ type: 'ab:startPicker', tabId });
  await sleep(300);

  const box = await evaluate(session, `(() => { const r = document.getElementById('content').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2, w: innerWidth, h: innerHeight }; })()`);
  await click(session, box.x, box.y);
  await sleep(300);
  await screenshot(session, 'picker');

  // Panel is fixed at bottom-right (16px margin, 14px padding); "Blokir" is the last of three buttons.
  const panelWidth = Math.min(380, box.w - 32);
  await click(session, box.w - 16 - 14 - (panelWidth - 28) / 6, box.h - 16 - 14 - 17);
  await sleep(600);

  const display = await evaluate(session, `getComputedStyle(document.getElementById('content')).display`);
  assert.equal(display, 'none', 'clicked element should be hidden');
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

const bundledRules = () => JSON.parse(readFileSync(join(extDir, 'rules', 'ads.json'), 'utf8'));
const bundledCosmetic = () => JSON.parse(readFileSync(join(extDir, 'cosmetic', 'ads.json'), 'utf8'));
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

test('extension pages render without errors', async () => {
  for (const page of ['options.html', 'popup.html']) {
    const s = await openPage(`chrome-extension://${extId}/${page}`);
    const text = await evaluate(s, 'document.body.innerText');
    assert.ok(text.length > 50, `${page} looks empty`);
    await screenshot(s, page.replace('.html', ''));
  }
});
