// Renders the orbit logo (ui/icons.js logo()) to my-chrome-universe/icons/icon{16,32,48,128}.png
// with a transparent background, using Playwright's Chromium over the DevTools Protocol.
// No npm dependencies. Run once after changing the logo, then commit the PNGs:
//   node tools/make-icons.mjs        (CHROME_PATH=... to pick a browser)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, platformArgs } from '../tests/chromium.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'my-chrome-universe');
const SIZES = [16, 32, 48, 128];
const PORT = 8771;
const CDP_PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The ring is drawn in a mid tone that reads on light and dark toolbars; small sizes get a
// thicker ring so it survives downscaling.
const PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; background: transparent; }
  #box { display: flex; gap: 0; align-items: flex-start; }
  svg { display: block; --logo-ring: #8C96C8; }
</style></head><body><div id="box"></div><script type="module">
  import { logo } from '/ui/icons.js';
  const box = document.getElementById('box');
  for (const size of ${JSON.stringify(SIZES)}) {
    const svg = logo();
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.id = 'logo-' + size;
    // Small sizes: a bigger sun and planet and a thicker ring, so the shape still reads at 16 px.
    const small = size <= 32;
    svg.querySelector('ellipse').setAttribute('stroke-width', String(Math.max(1.3, 36 / size)));
    svg.querySelector('.core circle').setAttribute('r', small ? '10' : size <= 48 ? '8.5' : '7.5');
    if (small) {
      svg.setAttribute('viewBox', '1.5 1.5 37 37');
      svg.querySelector('.orb circle').setAttribute('r', '3.8');
    }
    box.append(svg);
  }
  window.ready = true;
</script></body></html>`;

const types = { '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  try {
    const body = readFileSync(join(extDir, path.replace(/\.\./g, '')));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
    this.ready = new Promise((ok, fail) => {
      this.ws.addEventListener('open', ok);
      this.ws.addEventListener('error', fail);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const exe = findChrome();
if (!exe) throw new Error('Chromium (Playwright) tidak ditemukan: npx playwright@1 install chromium');
const profile = mkdtempSync(join(tmpdir(), 'mcu-icons-'));
await new Promise((ok) => server.listen(PORT, ok));
const chrome = spawn(exe, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', ...platformArgs, 'about:blank'], { stdio: 'ignore' });
try {
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(200);
    wsUrl = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
  }
  if (!wsUrl) throw new Error('DevTools tidak bisa dihubungi');
  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 200, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
  for (let i = 0; i < 50 && !(await evaluate('window.ready === true')); i++) await sleep(100);
  for (const size of SIZES) {
    const r = await evaluate(`(() => { const b = document.getElementById('logo-${size}').getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: size, height: size, scale: 1 } }, sessionId);
    const out = join(extDir, 'icons', `icon${size}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(`icons/icon${size}.png`);
  }
  await cdp.send('Browser.close').catch(() => {});
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
