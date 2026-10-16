// Unit tests for the shared Universe UI foundation (my-chrome-universe/ui).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, ic } from '../my-chrome-universe/ui/icons.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(root, 'my-chrome-universe', 'ui');
const cssFiles = readdirSync(ui).filter((f) => f.endsWith('.css'));
const read = (f) => readFileSync(join(ui, f), 'utf8');

test('ui css has no external urls', () => {
  assert.ok(cssFiles.length >= 2);
  for (const f of cssFiles) {
    const css = read(f);
    assert.ok(!/https?:/i.test(css), `${f} mentions http`);
    for (const m of css.matchAll(/url\(([^)]*)\)/g)) {
      assert.match(m[1].trim().replace(/['"]/g, ''), /^fonts\/[\w-]+\.woff2$/, `${f}: ${m[0]}`);
    }
  }
});

test('every font-face file exists', () => {
  const css = cssFiles.map(read).join('\n');
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)];
  assert.ok(faces.length >= 3);
  for (const m of css.matchAll(/url\(\s*['"]?(fonts\/[^)'"]+\.woff2)['"]?\s*\)/g)) {
    assert.ok(existsSync(join(ui, m[1])), `${m[1]} missing`);
    assert.ok(statSync(join(ui, m[1])).size > 1000);
  }
  assert.ok(existsSync(join(ui, 'fonts', 'OFL.txt')));
});

const tokens = read('tokens.css');
const block = (sel) => {
  const i = tokens.indexOf(sel + ' {');
  assert.ok(i >= 0, `${sel} block missing`);
  return tokens.slice(i, tokens.indexOf('}', i));
};
const dark = block(':root');
const light = block(':root[data-ui="light"]');
const def = (b, name) => new RegExp(`${name}\\s*:`).test(b);
// Resolve a token to hex, following var() chains; the light block falls back to dark.
const hex = (name, theme, seen = 0) => {
  assert.ok(seen < 6, `loop on ${name}`);
  const own = theme === 'light' && def(light, name) ? light : dark;
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(own);
  assert.ok(m, `${name} undefined`);
  const v = m[1].trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return hex(ref[1], theme, seen + 1);
  assert.match(v, /^#[0-9A-Fa-f]{6}$/, `${name}: ${v}`);
  return v;
};
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('light theme overrides every themed token', () => {
  for (const t of ['void', 'star', 'dust', 'faint', 'tint', 'glass', 'line-rgb', 'solar-text', 'ion-text', 'nova-text', 'title-grad', 'neb-blend']) {
    assert.ok(def(light, '--' + t), `--${t} not overridden in light`);
  }
});

test('text tokens meet 4.5:1 in both themes', () => {
  for (const theme of ['dark', 'light']) {
    for (const t of ['star', 'dust', 'faint', 'solar-text', 'ion-text', 'nova-text', 'danger-text']) {
      for (const bg of ['void', 'panel-solid']) {
        const r = contrast(hex('--' + t, theme), hex('--' + bg, theme));
        assert.ok(r >= 4.5, `${theme}: --${t} on --${bg} = ${r.toFixed(2)}`);
      }
    }
  }
});

test('accent selectors set accent, text and ink', () => {
  for (const [id, ink] of [['ion', '#04201B'], ['nova', '#2A0710']]) {
    const m = new RegExp(`:root\\[data-accent="${id}"\\]\\s*\\{([^}]*)\\}`).exec(tokens);
    assert.ok(m, id);
    assert.match(m[1], new RegExp(`--accent:\\s*var\\(--${id}\\)`));
    assert.match(m[1], new RegExp(`--accent-text:\\s*var\\(--${id}-text\\)`));
    assert.ok(m[1].includes(ink));
  }
});

test('ic returns an svg with the icon path', () => {
  const s = ic('lock');
  assert.ok(s.startsWith('<svg class="ic'));
  assert.ok(s.includes('class="shackle"'));
  assert.doesNotThrow(() => ic('nope'));
  assert.ok(ic('nope').startsWith('<svg'));
  assert.ok(!ic('nope').includes('<path'));
});

test('icons used in markup exist', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js)$/.test(e.name)) files.push(p);
    }
  };
  walk(join(root, 'my-chrome-universe'));
  assert.ok(files.length > 0);
  for (const f of files) {
    if (f.endsWith(join('ui', 'icons.js'))) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/data-ic="([\w-]+)"|\bic\(\s*'([\w-]+)'/g)) {
      const name = m[1] || m[2];
      assert.ok(name in ICONS, `${f}: unknown icon ${name}`);
    }
  }
});
