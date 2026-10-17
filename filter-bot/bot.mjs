// Filter bot: collects filter lists from several projects (EasyList, Adblock Plus /
// AdBlock, uBlock Origin, AdGuard, ABPindo, AdBlockID …), merges them per category,
// compiles them with my-chrome-universe/modules/adblock/filters.js and publishes
// one feed that the ad blocker module of My Chrome Universe can use.
//
// Output (--out, default ./feed):
//   index.json               feed metadata: version, categories, per-source status
//   rules/<category>.json    declarativeNetRequest ruleset (ids from 1)
//   cosmetic/<category>.json element-hiding data
//   raw/<source>.txt         last good copy of every source (used when a fetch fails)
//   changes.json             what changed compared with the previous run
//
// Usage:
//   node filter-bot/bot.mjs                         fetch, build and write ./feed
//   node filter-bot/bot.mjs --out <dir>             write the feed elsewhere
//   node filter-bot/bot.mjs --update-extension      also copy the result into the extension
//   node filter-bot/bot.mjs --offline               rebuild from raw/ without fetching
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertFilterList, preprocess, collectBadfilters, combineRules, combineCosmetic, assignIds,
} from '../my-chrome-universe/modules/adblock/filters.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const flag = (name) => process.argv.includes(name);

const OUT = resolve(arg('--out') || join(root, 'feed'));
const EXT_ROOT = join(root, 'my-chrome-universe');
const EXT_DIR = join(EXT_ROOT, 'modules/adblock');
const OFFLINE = flag('--offline');
const USER_AGENT = 'ad-blocker-filter-bot/1.0 (+https://github.com/)';

// Chrome guarantees every extension this many enabled static rules; beyond it
// rules come from a pool shared by all extensions.
const GUARANTEED_STATIC_RULES = 30000;

// Tokens for !#if directives, per list dialect.
const ENV = {
  abp: {},
  ubo: { env_chromium: true, env_mv3: true, cap_user_stylesheet: true, ext_ublock: true, ext_ubol: true },
  adguard: { adguard: true, adguard_ext_chromium: true, adguard_ext_chromium_mv3: true, env_chromium: true, env_mv3: true, ext_ublock: true },
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function header(text, key) {
  return new RegExp(`^! ${key}:\\s*(.*)$`, 'mi').exec(text.slice(0, 5000))?.[1]?.trim() || null;
}

const FETCH_TIMEOUT_MS = 60000;
const DECODERS = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };

// One GET with node:http(s) rather than global fetch: Node 24's fetch (undici) sometimes throws an
// internal AssertionError from a socket event ("assert(!this.paused)"), which no try/catch can
// catch and which took the whole bot down in CI. Every failure here rejects the promise instead.
function getText(url, redirects = 5) {
  return new Promise((resolveText, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'http:' ? httpRequest : target.protocol === 'https:' ? httpsRequest : null;
    if (!send) return reject(new Error(`unsupported protocol ${target.protocol}`));
    const timer = setTimeout(() => req.destroy(new Error('timeout')), FETCH_TIMEOUT_MS);
    const done = (fn, value) => { clearTimeout(timer); fn(value); };
    const req = send(target, { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, br' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return done(reject, new Error('too many redirects'));
        return done(resolveText, getText(new URL(res.headers.location, target).href, redirects - 1));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return done(reject, new Error(`HTTP ${status}`));
      }
      const decoder = DECODERS[String(res.headers['content-encoding'] || '').toLowerCase()];
      const body = decoder ? res.pipe(decoder()) : res;
      const chunks = [];
      res.on('error', (err) => done(reject, err));
      body.on('error', (err) => done(reject, err));
      body.on('data', (chunk) => chunks.push(chunk));
      body.on('end', () => done(resolveText, Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', (err) => done(reject, err));
    req.end();
  });
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await getText(url);
    } catch (err) {
      lastError = err;
      await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

// Inlines "!#include file.txt" (uBlock Origin lists split themselves this way).
// Only same-origin relative includes are followed, like uBO does.
async function resolveIncludes(text, baseUrl, depth = 0) {
  if (depth > 3 || !text.includes('!#include')) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = /^!#include\s+(\S+)/.exec(line.trim());
    if (!m) {
      out.push(line);
      continue;
    }
    const url = new URL(m[1], baseUrl);
    if (url.origin !== new URL(baseUrl).origin) continue;
    out.push(await resolveIncludes(await fetchText(url.href), url.href, depth + 1));
  }
  return out.join('\n');
}

function looksLikeFilterList(text) {
  return typeof text === 'string' && text.length > 200 && text.split('\n').length > 5 && !/^\s*<(!doctype|html)/i.test(text);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// Stable identity of a rule regardless of its id, to compute what changed.
const ruleKey = (rule) => JSON.stringify({ ...rule, id: undefined });

// ---------- 1. Fetch every source (falling back to the last good copy) ----------

const config = JSON.parse(await readFile(join(root, 'filter-bot', 'sources.json'), 'utf8'));
const previous = await readJson(join(OUT, 'index.json'), null);
await mkdir(join(OUT, 'raw'), { recursive: true });
await mkdir(join(OUT, 'rules'), { recursive: true });
await mkdir(join(OUT, 'cosmetic'), { recursive: true });

const fetched = new Map(); // source id -> { text, status, error }
const allSources = config.categories.flatMap((c) => c.sources.filter((s) => s.enabled !== false));

await Promise.all(allSources.map(async (source) => {
  const rawPath = join(OUT, 'raw', `${source.id}.txt`);
  const cached = existsSync(rawPath) ? await readFile(rawPath, 'utf8') : null;
  if (OFFLINE) {
    fetched.set(source.id, cached ? { text: cached, status: 'cached' } : { status: 'missing', error: 'offline, no cached copy' });
    return;
  }
  try {
    const text = await resolveIncludes(await fetchText(source.url), source.url);
    if (!looksLikeFilterList(text)) throw new Error('response is not a filter list');
    await writeFile(rawPath, text);
    fetched.set(source.id, { text, status: 'fresh' });
  } catch (err) {
    fetched.set(source.id, cached
      ? { text: cached, status: 'stale', error: String(err.message || err) }
      : { status: 'missing', error: String(err.message || err) });
  }
}));

// ---------- 2. Preprocess and collect $badfilter across all lists ----------

const prepared = new Map();
const badfilters = new Set();
for (const source of allSources) {
  const f = fetched.get(source.id);
  if (!f.text) continue;
  const text = preprocess(f.text, ENV[source.flavor] || {});
  prepared.set(source.id, text);
  collectBadfilters(text, badfilters);
}

// ---------- 3. Convert and merge per category ----------

const categories = [];
const changes = { from: previous?.version || null, categories: {} };

for (const category of config.categories) {
  const ruleLists = [];
  const cosmeticParts = [];
  const sources = [];

  for (const source of category.sources) {
    const base = { id: source.id, title: source.title, url: source.url, homepage: source.homepage, license: source.license, from: source.from || null };
    if (source.enabled === false) {
      sources.push({ ...base, status: 'disabled', note: source.note || null });
      continue;
    }
    const f = fetched.get(source.id);
    if (!prepared.has(source.id)) {
      sources.push({ ...base, status: f.status, error: f.error });
      continue;
    }
    const raw = f.text;
    const { rules, cosmetic, stats } = convertFilterList(prepared.get(source.id), { flavor: source.flavor, badfilters });
    ruleLists.push(rules);
    cosmeticParts.push(cosmetic);
    sources.push({
      ...base,
      status: f.status,
      error: f.error || null,
      version: header(raw, 'Version') || header(raw, 'Last modified') || header(raw, 'TimeUpdated'),
      expires: header(raw, 'Expires'),
      sha256: sha256(raw),
      networkFilters: stats.network,
      cosmeticFilters: stats.cosmetic,
      skipped: stats.skipped,
    });
  }

  const rules = assignIds(combineRules(ruleLists));
  const cosmetic = combineCosmetic(cosmeticParts);
  const rulesJson = JSON.stringify(rules);
  const cosmeticJson = JSON.stringify(cosmetic);

  // What changed since the previous run (by rule content, not id).
  const prevRules = await readJson(join(OUT, 'rules', `${category.id}.json`), []);
  const before = new Set(prevRules.map(ruleKey));
  const after = new Set(rules.map(ruleKey));
  const prevCosmetic = await readJson(join(OUT, 'cosmetic', `${category.id}.json`), { generic: [], specific: {} });
  const countSelectors = (c) => c.generic.length + Object.values(c.specific).reduce((n, s) => n + s.length, 0);
  changes.categories[category.id] = {
    rulesAdded: [...after].filter((k) => !before.has(k)).length,
    rulesRemoved: [...before].filter((k) => !after.has(k)).length,
    selectorsBefore: countSelectors(prevCosmetic),
    selectorsAfter: countSelectors(cosmetic),
  };

  await writeFile(join(OUT, 'rules', `${category.id}.json`), rulesJson);
  await writeFile(join(OUT, 'cosmetic', `${category.id}.json`), cosmeticJson);

  const used = sources.filter((s) => s.networkFilters !== undefined);
  categories.push({
    id: category.id,
    title: category.title,
    description: category.description,
    defaultEnabled: category.defaultEnabled,
    language: category.language || null,
    ruleCount: rules.length,
    networkFilters: used.reduce((n, s) => n + s.networkFilters, 0),
    cosmeticFilters: used.reduce((n, s) => n + s.cosmeticFilters, 0),
    files: {
      rules: { path: `rules/${category.id}.json`, sha256: sha256(rulesJson), bytes: Buffer.byteLength(rulesJson) },
      cosmetic: { path: `cosmetic/${category.id}.json`, sha256: sha256(cosmeticJson), bytes: Buffer.byteLength(cosmeticJson) },
    },
    sources,
  });
}

// ---------- 4. Sanity checks and index ----------

const now = new Date();
const version = now.toISOString().replace(/[-:T]/g, '').slice(0, 12); // YYYYMMDDHHmm
const defaultRules = categories.filter((c) => c.defaultEnabled).reduce((n, c) => n + c.ruleCount, 0);
const allRules = categories.reduce((n, c) => n + c.ruleCount, 0);
const problems = [];
const missing = categories.flatMap((c) => c.sources.filter((s) => s.status === 'missing').map((s) => s.id));
const stale = categories.flatMap((c) => c.sources.filter((s) => s.status === 'stale').map((s) => s.id));
if (missing.length) problems.push(`sumber tidak tersedia: ${missing.join(', ')}`);
if (stale.length) problems.push(`memakai salinan lama: ${stale.join(', ')}`);
if (defaultRules > GUARANTEED_STATIC_RULES) problems.push(`kategori bawaan memakai ${defaultRules} aturan (> ${GUARANTEED_STATIC_RULES} yang dijamin Chrome)`);

const index = {
  schema: 1,
  version,
  generatedAt: now.toISOString(),
  totals: { rules: allRules, defaultRules, guaranteedStaticRules: GUARANTEED_STATIC_RULES },
  problems,
  categories,
};
changes.to = version;
await writeFile(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
await writeFile(join(OUT, 'changes.json'), `${JSON.stringify(changes, null, 2)}\n`);

// ---------- 5. Optionally update the extension's bundled rulesets ----------

if (flag('--update-extension')) {
  await mkdir(join(EXT_DIR, 'rules'), { recursive: true });
  await mkdir(join(EXT_DIR, 'cosmetic'), { recursive: true });
  for (const c of categories) {
    await writeFile(join(EXT_DIR, 'rules', `${c.id}.json`), await readFile(join(OUT, c.files.rules.path)));
    await writeFile(join(EXT_DIR, 'cosmetic', `${c.id}.json`), await readFile(join(OUT, c.files.cosmetic.path)));
  }
  const lists = categories.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    defaultEnabled: c.defaultEnabled,
    language: c.language,
    version,
    ruleCount: c.ruleCount,
    networkFilters: c.networkFilters,
    cosmeticFilters: c.cosmeticFilters,
    sources: c.sources.filter((s) => s.status !== 'disabled').map((s) => ({ title: s.title, homepage: s.homepage, license: s.license, version: s.version })),
  }));
  const bundle = { builtAt: now.toISOString(), feedVersion: version, feedUrl: config.feedUrl || null, lists };
  await writeFile(join(EXT_DIR, 'lists.json'), `${JSON.stringify(bundle, null, 2)}\n`);

  // The manifest is shared by every module: only declarative_net_request is ours to rewrite.
  const manifestPath = join(EXT_ROOT, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.declarative_net_request = {
    rule_resources: categories.map((c) => ({ id: c.id, enabled: c.defaultEnabled, path: `modules/adblock/rules/${c.id}.json` })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ---------- Report ----------

console.log(`Feed ${version} → ${OUT}`);
for (const c of categories) {
  const ch = changes.categories[c.id];
  console.log(`- ${c.title}: ${c.ruleCount} aturan DNR, ${c.cosmeticFilters} filter elemen (+${ch.rulesAdded}/-${ch.rulesRemoved} aturan)`);
  for (const s of c.sources) {
    const detail = s.networkFilters !== undefined ? `${s.networkFilters} jaringan, ${s.cosmeticFilters} elemen` : (s.note || s.error || '');
    console.log(`    ${s.status.padEnd(8)} ${s.title}${s.version ? ` (${s.version})` : ''} — ${detail}`);
  }
}
console.log(`Total ${allRules} aturan; kategori bawaan ${defaultRules} (batas aman ${GUARANTEED_STATIC_RULES}).`);
for (const p of problems) console.log(`! ${p}`);
if (missing.length) process.exitCode = 1;
