// Daily filter updates from the filter-bot feed (GitHub Pages).
//
// The extension ships static rulesets that Chrome cannot modify. To bring them up
// to date we compare each bundled ruleset with the feed's version of it:
//   - rules only in the feed      → added as dynamic rules
//   - rules only in the bundle    → disabled with updateStaticRules()
//   - element-hiding data         → replaced wholesale (it is plain data we read ourselves)
// Everything downloaded is data, verified against the SHA-256 in index.json and
// validated so that a feed can only ever block or allow requests and hide elements.

const STATE_KEY = 'ab:feed';
const cosmeticKey = (id) => `ab:feed:cosmetic:${id}`;

// Chrome's limits (constants exist from Chrome 111/121; fall back to documented values).
const MAX_DYNAMIC = () => chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000;
const MAX_DISABLED = () => chrome.declarativeNetRequest.MAX_NUMBER_OF_DISABLED_STATIC_RULES ?? 5000;
// Dynamic rules kept free for the allowlist and the user's own filters.
const USER_RESERVE = 5000;

const ALLOWED_ACTIONS = new Set(['block', 'allow', 'allowAllRequests']);
const ALLOWED_CONDITION_KEYS = new Set([
  'urlFilter', 'isUrlFilterCaseSensitive', 'requestDomains', 'excludedRequestDomains', 'initiatorDomains',
  'excludedInitiatorDomains', 'resourceTypes', 'excludedResourceTypes', 'domainType', 'requestMethods', 'excludedRequestMethods',
]);

export async function readFeedState() {
  const { [STATE_KEY]: state } = await chrome.storage.local.get(STATE_KEY);
  return state || { categories: {} };
}

async function writeFeedState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

// Forgets every downloaded update (e.g. after the extension itself was updated).
export async function clearFeedUpdates() {
  const state = await readFeedState();
  await chrome.storage.local.remove(Object.keys(state.categories || {}).map(cosmeticKey));
  await writeFeedState({ categories: {}, checkedAt: state.checkedAt || null });
}

// Dynamic rules (without ids) to add for the enabled categories.
export async function feedAdditions(enabledIds) {
  const state = await readFeedState();
  return enabledIds.flatMap((id) => state.categories[id]?.added || []);
}

export async function feedCosmetic(id) {
  const key = cosmeticKey(id);
  const { [key]: data } = await chrome.storage.local.get(key);
  return data || null;
}

// Makes Chrome's disabled-static-rule sets match the stored updates.
export async function syncDisabledStaticRules(rulesetIds) {
  const state = await readFeedState();
  for (const rulesetId of rulesetIds) {
    const want = new Set(state.categories[rulesetId]?.disabled || []);
    const current = new Set(await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId }).catch(() => []));
    const disableRuleIds = [...want].filter((id) => !current.has(id));
    const enableRuleIds = [...current].filter((id) => !want.has(id));
    if (disableRuleIds.length || enableRuleIds.length) {
      await chrome.declarativeNetRequest.updateStaticRules({ rulesetId, disableRuleIds, enableRuleIds });
    }
  }
}

// ---------- Validation ----------

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

export function validateRules(rules) {
  if (!Array.isArray(rules)) throw new Error('rules bukan array');
  for (const r of rules) {
    if (!Number.isInteger(r?.id) || r.id < 1) throw new Error('id aturan tidak valid');
    if (!Number.isInteger(r.priority) || r.priority < 1 || r.priority > 10) throw new Error(`prioritas aturan ${r.id} tidak valid`);
    if (!ALLOWED_ACTIONS.has(r.action?.type) || Object.keys(r.action).length !== 1) throw new Error(`aksi aturan ${r.id} tidak diizinkan`);
    if (!r.condition || typeof r.condition !== 'object') throw new Error(`kondisi aturan ${r.id} tidak valid`);
    for (const [k, v] of Object.entries(r.condition)) {
      if (!ALLOWED_CONDITION_KEYS.has(k)) throw new Error(`kondisi ${k} tidak diizinkan`);
      if (k.endsWith('Domains') || k.endsWith('Types') || k.endsWith('Methods')) {
        if (!isStringArray(v)) throw new Error(`kondisi ${k} tidak valid`);
      }
    }
  }
}

export function validateCosmetic(c) {
  const selectorsOk = (list) => isStringArray(list) && list.every((s) => !/[{}]/.test(s));
  if (!c || !selectorsOk(c.generic) || !selectorsOk(c.globalExceptions || [])) throw new Error('data elemen tidak valid');
  for (const map of [c.specific, c.exceptions]) {
    if (!map || typeof map !== 'object') throw new Error('data elemen tidak valid');
    for (const list of Object.values(map)) if (!selectorsOk(list)) throw new Error('selector tidak valid');
  }
  for (const k of ['noCosmetic', 'noGeneric', 'noSpecific']) if (c[k] && !isStringArray(c[k])) throw new Error('data elemen tidak valid');
}

// ---------- Fetching ----------

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function fetchVerified(base, file) {
  const text = await fetchText(new URL(file.path, base).href);
  if ((await sha256(text)) !== file.sha256) throw new Error(`checksum ${file.path} tidak cocok`);
  return JSON.parse(text);
}

// Key that identifies a rule by content, ignoring its id.
const ruleKey = ({ id, ...rest }) => JSON.stringify(rest);

/**
 * Checks the feed and stores updates for the enabled categories.
 * @param {object} p
 * @param {string} p.feedUrl     base URL ending in "/"
 * @param {object} p.bundle      lists.json of the installed extension
 * @param {string[]} p.enabled   enabled category ids
 * @param {number} p.userRules   dynamic rules already used by allowlist + own filters
 * @param {boolean} p.force      refetch even if the version did not change
 * @returns {Promise<object>} the new feed state
 */
export async function checkForUpdates({ feedUrl, bundle, enabled, userRules = 0, force = false }) {
  const state = await readFeedState();
  state.checkedAt = new Date().toISOString();
  try {
    const index = JSON.parse(await fetchText(new URL('index.json', feedUrl).href));
    if (index.schema !== 1 || !/^\d{12}$/.test(index.version) || !Array.isArray(index.categories)) {
      throw new Error('format feed tidak dikenal');
    }

    // The bundled rulesets are already at least this new: nothing to add.
    if (bundle.feedVersion && index.version <= bundle.feedVersion) {
      await clearFeedUpdates();
      const fresh = await readFeedState();
      Object.assign(fresh, { checkedAt: state.checkedAt, status: 'current', feedVersion: index.version, error: null });
      await writeFeedState(fresh);
      return fresh;
    }

    const bundledIds = new Set(bundle.lists.map((l) => l.id));
    let addedBudget = MAX_DYNAMIC() - USER_RESERVE - userRules;
    let disabledBudget = MAX_DISABLED();
    // Budgets already taken by categories we keep as they are.
    for (const [id, cat] of Object.entries(state.categories)) {
      if (enabled.includes(id) && cat.version === index.version && !force) {
        addedBudget -= cat.added.length;
        disabledBudget -= cat.disabled.length;
      }
    }

    const warnings = [];
    for (const id of enabled) {
      const remote = index.categories.find((c) => c.id === id);
      if (!remote || !bundledIds.has(id)) continue;
      if (state.categories[id]?.version === index.version && !force) continue;

      const [rules, cosmetic] = await Promise.all([fetchVerified(feedUrl, remote.files.rules), fetchVerified(feedUrl, remote.files.cosmetic)]);
      validateRules(rules);
      validateCosmetic(cosmetic);

      const bundled = await fetch(chrome.runtime.getURL(`rules/${id}.json`)).then((r) => r.json());
      const bundledKeys = new Map(bundled.map((r) => [ruleKey(r), r.id]));
      const remoteKeys = new Set(rules.map(ruleKey));
      let added = rules.filter((r) => !bundledKeys.has(ruleKey(r))).map(({ id: _, ...r }) => r);
      let disabled = bundled.filter((r) => !remoteKeys.has(ruleKey(r))).map((r) => r.id);

      // Too far behind to patch within Chrome's limits: keep the bundled network
      // rules (still update element hiding) until the extension itself is updated.
      let networkSkipped = false;
      if (added.length > addedBudget || disabled.length > disabledBudget) {
        warnings.push(`${remote.title}: perubahan terlalu besar (${added.length} aturan baru, ${disabled.length} dihapus); perbarui extension`);
        added = [];
        disabled = [];
        networkSkipped = true;
      }
      addedBudget -= added.length;
      disabledBudget -= disabled.length;

      await chrome.storage.local.set({ [cosmeticKey(id)]: cosmetic });
      state.categories[id] = { version: index.version, added, disabled, networkSkipped, rules: rules.length };
    }

    Object.assign(state, {
      status: warnings.length ? 'partial' : 'updated',
      feedVersion: index.version,
      updatedAt: new Date().toISOString(),
      error: warnings.length ? warnings.join('; ') : null,
    });
  } catch (err) {
    // Keep whatever was applied before; just record the failure.
    Object.assign(state, { status: 'error', error: String(err?.message || err) });
  }
  await writeFeedState(state);
  return state;
}
