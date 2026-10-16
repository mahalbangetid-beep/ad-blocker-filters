// Locates Playwright's Chromium (branded Chrome ignores --load-extension since v137).
// Install it with: npx playwright@1 install chromium   (Linux CI: add --with-deps)
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bases = [
    join(process.env.LOCALAPPDATA || '', 'ms-playwright'), // Windows
    join(process.env.HOME || '', '.cache', 'ms-playwright'), // Linux
    join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright'), // macOS
  ];
  for (const base of bases.filter(existsSync)) {
    for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const candidates = [
        join(base, dir, 'chrome-win64', 'chrome.exe'),
        join(base, dir, 'chrome-linux', 'chrome'),
        join(base, dir, 'chrome-linux64', 'chrome'),
        join(base, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ];
      for (const exe of candidates) if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// Extra flags per platform: Linux CI runners do not allow Chromium's sandbox.
export const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
