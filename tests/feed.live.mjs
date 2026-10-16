// Manual live check (needs internet; not part of the normal suite): loads ad-blocker/
// into Playwright's Chromium and runs "update now" against the real GitHub Pages
// feed, then prints what the updater applied.
//
// Run: node tests/feed.live.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, platformArgs } from './chromium.mjs';

const extDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'my-chrome-universe/modules/adblock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = findChrome();
if (!exe) throw new Error('Chromium (Playwright) tidak ditemukan');
const profile = mkdtempSync(join(tmpdir(), 'ab-live-'));
const chrome = spawn(exe, [...platformArgs, '--headless=new', '--remote-debugging-port=9335', `--user-data-dir=${profile}`,
  `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let id = 0;
const pending = new Map();
let ws;
const send = (method, params = {}, sessionId) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  return new Promise((ok, fail) => pending.set(n, { ok, fail }));
};
const evaluate = async (sessionId, expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};

try {
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(200);
    wsUrl = await fetch('http://127.0.0.1:9335/json/version').then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
  }
  ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result);
    }
  });
  await new Promise((ok) => ws.addEventListener('open', ok));
  let extId;
  let swSession;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'service_worker')) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      if ((await evaluate(sessionId, 'chrome.runtime.getManifest().name').catch(() => '')).startsWith('Ad Blocker')) {
        extId = new URL(t.url).host;
        swSession = sessionId;
      }
    }
    if (!extId) await sleep(200);
  }
  await sleep(3000); // let the install-time update finish
  const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(800);
  const result = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'ab:updateFilters' })`);
  const bundle = await evaluate(sessionId, `fetch('lists.json').then(r => r.json()).then(b => b.feedVersion)`);
  const dynamic = await evaluate(swSession, 'chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)');
  const disabled = await evaluate(swSession, "chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: 'ads' }).then(r => r.length)");
  const f = result.feed;
  console.log(JSON.stringify({
    bundleVersion: bundle,
    feedVersion: f.feedVersion,
    status: f.status,
    error: f.error,
    categories: Object.fromEntries(Object.entries(f.categories).map(([k, v]) => [k, { added: v.added.length, disabled: v.disabled.length, networkSkipped: v.networkSkipped }])),
    chrome: { dynamicRules: dynamic, adsDisabledStaticRules: disabled },
  }, null, 2));
} finally {
  try { await send('Browser.close'); } catch {}
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
