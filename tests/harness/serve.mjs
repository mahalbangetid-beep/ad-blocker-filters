// Static server for UI testing. Serves the repo root and, for any page under
// /my-chrome-universe/modules/tabs/ requested with ?harness, injects the fake chrome API and the real
// background.js before the page's own scripts.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.PORT || 8765);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let path = decodeURIComponent(url.pathname);
  if (path.includes('/_favicon/')) path = '/my-chrome-universe/modules/tabs/icons/icon16.png';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    let body = await readFile(file);
    if (url.searchParams.has('harness') && extname(file) === '.html') {
      body = body.toString().replace('<script type="module"',
        '<script src="/tests/harness/mock-chrome.js"></script>\n  <script type="module" src="/my-chrome-universe/modules/tabs/background.js"></script>\n  <script type="module"');
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`harness on http://localhost:${port}/my-chrome-universe/modules/tabs/newtab.html?harness`));
