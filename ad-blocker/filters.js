// Adblock Plus / uBlock Origin / AdGuard filter syntax → Chrome declarativeNetRequest
// rules + cosmetic data. Pure JS: used by filter-bot (Node) to compile filter lists
// into static rulesets, and by background.js at runtime for the user's own filters.
//
// Supported: network filters (||, |, *, ^, $types, ~types, third-party/1p/3p,
// domain=/from=, to=, denyallow=, method=, match-case, important, document, all),
// exceptions (@@, incl. $document/$elemhide/$generichide/$specifichide), $badfilter,
// hosts-file lines, element hiding (##, #@#) and #?# filters that only use
// :-abp-has() (converted to native :has()), and !#if/!#else/!#endif directives.
// Everything else (regex filters, snippets/scriptlets, HTML filtering, CSS
// injection, $csp, $redirect, $removeparam, procedural selectors…) is skipped and
// counted rather than translated into something that behaves differently.

export const PRIORITY = { block: 1, allow: 2, important: 3, allowImportant: 4, allowlist: 100 };

const TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  beacon: 'ping',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  other: 'other',
};

// All request types a network filter without type options applies to (ABP never
// blocks the top-level document unless $document is given).
const DEFAULT_TYPES = ['script', 'image', 'stylesheet', 'object', 'xmlhttprequest', 'sub_frame', 'ping', 'media', 'font', 'websocket', 'other'];
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);

// domains # [@] [?$%] # body
const COSMETIC_RE = /^([^/|@"!#\s]*?)#(@)?([?$%])?#(.+)$/;
// AdGuard/uBO-only cosmetic separators: #$?# #?$# #@%# #^# ##^ $$ $@$
const UNSUPPORTED_COSMETIC_RE = /^[^/|@"!\s]*?(#@?\$\?#|#@?\?\$#|#@?%#|#@?\^#|##\^|\$@?\$)/;
const OPTIONS_RE = /\$(~?[\w-]+(?:=[^,]*)?(?:,~?[\w-]+(?:=[^,]*)?)*)$/;
const PROCEDURAL_RE = /:(-abp-|style\(|remove\(|matches-|xpath\(|has-text|upward\(|contains\(|min-text|watch-attr|others\(|remove-attr|remove-class|nth-ancestor|if\(|if-not\()/i;
const HOSTS_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/;
const PLAIN_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?$/i;

// Lowercase ASCII (punycode) hostname, or null if it is not a plain hostname.
export function toAsciiDomain(domain) {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, '');
  if (!d || /[*/\\\s?#@:[\]]/.test(d)) return null;
  if (/^[a-z0-9.-]+$/.test(d)) return d;
  try {
    const host = new URL(`http://${d}/`).hostname;
    return /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function splitDomains(list, separator) {
  const include = [];
  const exclude = [];
  for (const raw of list.split(separator)) {
    if (!raw.trim()) continue;
    const negated = raw.trim().startsWith('~');
    const domain = toAsciiDomain(negated ? raw.trim().slice(1) : raw);
    if (!domain) continue;
    (negated ? exclude : include).push(domain);
  }
  return { include, exclude };
}

function hasIncludes(list, separator) {
  return list.split(separator).some((d) => d.trim() && !d.trim().startsWith('~'));
}

function isValidSelector(selector) {
  if (!selector || selector.length > 1500) return false;
  if (/[{}]/.test(selector)) return false; // would allow injecting CSS declarations
  if (PROCEDURAL_RE.test(selector)) return false;
  return true;
}

// ---------- Preprocessing (!#if / !#else / !#endif) ----------

// Evaluates a directive expression such as "env_chromium && !env_mobile".
function evalCondition(expr, env) {
  const tokens = expr.match(/\(|\)|&&|\|\||!|[\w-]+/g) || [];
  let i = 0;
  const parseOr = () => {
    let v = parseAnd();
    while (tokens[i] === '||') {
      i++;
      v = parseAnd() || v;
    }
    return v;
  };
  const parseAnd = () => {
    let v = parseNot();
    while (tokens[i] === '&&') {
      i++;
      v = parseNot() && v;
    }
    return v;
  };
  const parseNot = () => {
    if (tokens[i] === '!') {
      i++;
      return !parseNot();
    }
    if (tokens[i] === '(') {
      i++;
      const v = parseOr();
      i++; // ')'
      return v;
    }
    const name = tokens[i++];
    return name === 'true' || Boolean(env[name]);
  };
  return parseOr();
}

// Removes lines inside inactive !#if blocks. `env` maps token → boolean.
export function preprocess(text, env = {}) {
  const out = [];
  const stack = []; // one { active } per open !#if block
  const active = () => stack.every((s) => s.active);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('!#if')) {
      const cond = evalCondition(t.slice(4).trim(), env);
      stack.push({ active: cond });
    } else if (t.startsWith('!#else')) {
      const top = stack.at(-1);
      if (top) top.active = !top.active;
    } else if (t.startsWith('!#endif')) {
      stack.pop();
    } else if (active()) {
      out.push(line);
    }
  }
  return out.join('\n');
}

// ---------- $badfilter ----------

// The filter a "$badfilter" line cancels: the same line without that option.
export function badfilterTarget(line) {
  const m = OPTIONS_RE.exec(line);
  if (!m) return null;
  const options = m[1].split(',').filter((o) => o.toLowerCase() !== 'badfilter');
  if (options.length === m[1].split(',').length) return null;
  const base = line.slice(0, m.index);
  return options.length ? `${base}$${options.join(',')}` : base;
}

export function collectBadfilters(text, into = new Set()) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || !line.includes('badfilter')) continue;
    const target = badfilterTarget(line);
    if (target) into.add(target);
  }
  return into;
}

// ---------- Network filters ----------

// Parses one network filter line. Returns { filter } or { skip: reason }.
export function parseNetworkFilter(line) {
  let text = line;
  const exception = text.startsWith('@@');
  if (exception) text = text.slice(2);

  let pattern = text;
  let optionText = '';
  const optMatch = OPTIONS_RE.exec(text);
  if (optMatch) {
    optionText = optMatch[1];
    pattern = text.slice(0, optMatch.index);
  }

  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) return { skip: 'regex' };

  const filter = {
    exception,
    pattern,
    types: null, // null = default set
    excludedTypes: [],
    thirdParty: null, // true | false | null
    domains: { include: [], exclude: [] },
    to: { include: [], exclude: [] },
    methods: { include: [], exclude: [] },
    matchCase: false,
    important: false,
    document: false,
    elemhide: false,
    generichide: false,
    specifichide: false,
  };

  if (optionText) {
    for (const raw of optionText.split(',')) {
      const [nameRaw, ...rest] = raw.split('=');
      const value = rest.join('=');
      const negated = nameRaw.startsWith('~');
      const name = (negated ? nameRaw.slice(1) : nameRaw).toLowerCase();

      if (name in TYPE_MAP) {
        if (negated) filter.excludedTypes.push(TYPE_MAP[name]);
        else (filter.types ||= []).push(TYPE_MAP[name]);
      } else if (name === 'all') {
        filter.types = [...DEFAULT_TYPES, 'main_frame'];
      } else if (name === 'third-party' || name === '3p') {
        filter.thirdParty = !negated;
      } else if (name === 'first-party' || name === '1p') {
        filter.thirdParty = negated;
      } else if (name === 'domain' || name === 'from') {
        const d = splitDomains(value, '|');
        // If every included domain was unusable (e.g. example.*), the filter would apply everywhere.
        if (hasIncludes(value, '|') && !d.include.length) return { skip: 'domain' };
        filter.domains = d;
      } else if (name === 'to' || name === 'denyallow') {
        const d = splitDomains(value, '|');
        if (name === 'to') {
          if (hasIncludes(value, '|') && !d.include.length) return { skip: 'domain' };
          filter.to.include.push(...d.include);
          filter.to.exclude.push(...d.exclude);
        } else {
          filter.to.exclude.push(...d.include);
        }
      } else if (name === 'method') {
        for (const m of value.toLowerCase().split('|')) {
          const neg = m.startsWith('~');
          const method = neg ? m.slice(1) : m;
          if (!METHODS.has(method)) return { skip: 'option:method' };
          (neg ? filter.methods.exclude : filter.methods.include).push(method);
        }
      } else if (name === 'match-case') {
        filter.matchCase = !negated;
      } else if (name === 'important') {
        filter.important = true;
      } else if (name === 'document' || name === 'doc') {
        filter.document = true;
      } else if (name === 'elemhide' || name === 'ehide') {
        filter.elemhide = true;
      } else if (name === 'generichide' || name === 'ghide') {
        filter.generichide = true;
      } else if (name === 'specifichide' || name === 'shide') {
        filter.specifichide = true;
      } else if (name === 'genericblock' || name === 'reason' || /^_+$/.test(name)) {
        // genericblock has no DNR equivalent and only relaxes blocking; "_" is a no-op
        // separator; uBO's reason= is only the text shown on its warning page.
      } else if (name === 'badfilter') {
        return { skip: 'badfilter' };
      } else if (name === 'popup' || name === 'popunder') {
        return { skip: 'popup' };
      } else {
        return { skip: `option:${name}` };
      }
    }
  }

  // Exceptions that only toggle element hiding have no network rule.
  const cosmeticOnly = (filter.elemhide || filter.generichide || filter.specifichide) && !filter.document && !filter.types;
  if (cosmeticOnly && !exception) return { skip: 'option:elemhide' };
  return { filter, cosmeticOnly };
}

// Converts the URL pattern into DNR condition parts.
function patternCondition(pattern) {
  let p = pattern;
  // Pure domain anchors (||example.com^) are best expressed as requestDomains.
  const domainOnly = /^\|\|([^/^*|:?]+)\^?\|?$/.exec(p);
  if (domainOnly) {
    const domain = toAsciiDomain(domainOnly[1]);
    if (!domain) return { skip: 'non-ascii' };
    return { requestDomains: [domain] };
  }

  if (p.startsWith('||')) {
    const rest = p.slice(2);
    const host = /^[^/^*|:?]+/.exec(rest);
    if (host && !/^[\x00-\x7f]*$/.test(host[0])) {
      const ascii = toAsciiDomain(host[0]);
      if (!ascii) return { skip: 'non-ascii' };
      p = `||${ascii}${rest.slice(host[0].length)}`;
    }
    p = p.replace(/^\|\|\*+/, '');
  }
  // Leading/trailing wildcards are implied.
  if (!p.startsWith('|')) p = p.replace(/^\*+/, '');
  if (!p.endsWith('|')) p = p.replace(/\*+$/, '');
  if (!/^[\x00-\x7f]*$/.test(p)) return { skip: 'non-ascii' };
  if (!p || p === '|' || p === '||') return {};
  return { urlFilter: p };
}

// Converts a parsed network filter into a DNR rule (without id) or { skip }.
export function toDnrRule(filter) {
  const cond = patternCondition(filter.pattern);
  if (cond.skip) return { skip: cond.skip };

  const condition = {};
  if (cond.requestDomains && filter.to.include.length) return { skip: 'to-conflict' };
  const requestDomains = cond.requestDomains || (filter.to.include.length ? filter.to.include : null);
  if (requestDomains) condition.requestDomains = requestDomains;
  if (filter.to.exclude.length) condition.excludedRequestDomains = filter.to.exclude;
  if (cond.urlFilter) {
    condition.urlFilter = cond.urlFilter;
    condition.isUrlFilterCaseSensitive = filter.matchCase;
  }

  const hasDomainLimit = filter.domains.include.length > 0 || Boolean(requestDomains);
  const bare = !cond.urlFilter && !requestDomains;
  // A rule without a URL pattern would match far too much unless limited by domain.
  if (bare && !hasDomainLimit) return { skip: 'too-generic' };
  if (cond.urlFilter) {
    const meaningful = cond.urlFilter.replace(/[|^*]/g, '');
    if (meaningful.length < 3 && !hasDomainLimit) return { skip: 'too-generic' };
  }

  if (filter.domains.include.length) condition.initiatorDomains = filter.domains.include;
  if (filter.domains.exclude.length) condition.excludedInitiatorDomains = filter.domains.exclude;
  if (filter.thirdParty === true) condition.domainType = 'thirdParty';
  if (filter.thirdParty === false) condition.domainType = 'firstParty';
  if (filter.methods.include.length) condition.requestMethods = filter.methods.include;
  if (filter.methods.exclude.length) condition.excludedRequestMethods = filter.methods.exclude;

  let action;
  let priority;
  if (filter.exception && filter.document) {
    action = { type: 'allowAllRequests' };
    priority = PRIORITY.allow;
    condition.resourceTypes = ['main_frame', 'sub_frame'];
  } else {
    action = { type: filter.exception ? 'allow' : 'block' };
    if (filter.exception) priority = filter.important ? PRIORITY.allowImportant : PRIORITY.allow;
    else priority = filter.important ? PRIORITY.important : PRIORITY.block;
    let types = filter.types ? [...new Set(filter.types)] : null;
    if (filter.document && !filter.exception) types = [...(types || []), 'main_frame'];
    if (types) {
      types = [...new Set(types)].filter((t) => !filter.excludedTypes.includes(t));
      if (!types.length) return { skip: 'no-types' };
      condition.resourceTypes = types;
    } else if (filter.excludedTypes.length) {
      const remaining = DEFAULT_TYPES.filter((t) => !filter.excludedTypes.includes(t));
      if (!remaining.length) return { skip: 'no-types' };
      condition.excludedResourceTypes = [...new Set(filter.excludedTypes)];
    }
  }
  return { rule: { priority, action, condition } };
}

// ---------- Cosmetic filters ----------

export function emptyCosmetic() {
  return { generic: [], specific: {}, exceptions: {}, globalExceptions: [], noCosmetic: [], noGeneric: [], noSpecific: [] };
}

function pushTo(map, key, value) {
  (map[key] ||= []).push(value);
}

// Adds one cosmetic filter (a COSMETIC_RE match) to `out`. Returns null or a skip reason.
export function addCosmeticFilter(out, match) {
  const [, domainText, at, type, bodyRaw] = match;
  const isException = Boolean(at);
  if (type === '$' || type === '%') return 'snippet';
  let selector = bodyRaw.trim();
  if (selector.startsWith('+js(')) return 'scriptlet';
  if (selector.startsWith('^')) return 'html-filter';
  if (type === '?') selector = selector.replace(/:-abp-has\(/g, ':has(');
  if (!isValidSelector(selector)) return 'procedural';

  const { include, exclude } = splitDomains(domainText, ',');
  if (hasIncludes(domainText, ',') && !include.length) return 'domain';

  if (isException) {
    if (!include.length) out.globalExceptions.push(selector);
    for (const d of include) pushTo(out.exceptions, d, selector);
    return null;
  }

  if (!include.length) {
    out.generic.push(selector);
    for (const d of exclude) pushTo(out.exceptions, d, selector);
  } else {
    for (const d of include) pushTo(out.specific, d, selector);
    for (const d of exclude) pushTo(out.exceptions, d, selector);
  }
  return null;
}

// ---------- Whole list ----------

// Rewrites hosts-file lines (and, for uBO/AdGuard lists, bare hostnames) as ||host^.
function normalizeLine(line, flavor) {
  const hosts = HOSTS_RE.exec(line);
  if (hosts) {
    const host = hosts[1].toLowerCase();
    if (['localhost', 'localhost.localdomain', 'local', 'broadcasthost', '0.0.0.0'].includes(host)) return null;
    return `||${host}^`;
  }
  if (flavor !== 'abp' && PLAIN_HOST_RE.test(line)) return `||${line.replace(/\.$/, '')}^`;
  return line;
}

// Parses a filter list. Returns { rules (DNR, without ids), cosmetic, stats }.
// options.flavor: 'abp' (default) | 'ubo' | 'adguard'
// options.badfilters: Set of filter texts cancelled by $badfilter (e.g. from other lists)
export function convertFilterList(text, options = {}) {
  const flavor = options.flavor || 'abp';
  const badfilters = collectBadfilters(text, new Set(options.badfilters || []));
  const rules = [];
  const cosmetic = emptyCosmetic();
  const stats = { lines: 0, network: 0, cosmetic: 0, skipped: {} };
  const skip = (reason) => {
    stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') && !line.startsWith('##') && !line.startsWith('#@#') && !line.startsWith('#?#')) continue;
    if (line.startsWith('[')) {
      // "[Adblock Plus 2.0]" headers, or AdGuard "[$path=...]" modifiers we cannot express.
      if (/^\[\$/.test(line)) skip('adguard-modifier');
      continue;
    }
    stats.lines++;
    if (badfilters.has(line)) {
      skip('badfilter');
      continue;
    }

    if (UNSUPPORTED_COSMETIC_RE.test(line)) {
      skip('unsupported-cosmetic');
      continue;
    }
    const cos = COSMETIC_RE.exec(line);
    if (cos) {
      const reason = addCosmeticFilter(cosmetic, cos);
      if (reason) skip(reason);
      else stats.cosmetic++;
      continue;
    }

    line = normalizeLine(line, flavor);
    if (!line) continue;
    const parsed = parseNetworkFilter(line);
    if (parsed.skip) {
      skip(parsed.skip);
      continue;
    }
    const { filter, cosmeticOnly } = parsed;

    // $elemhide / $generichide / $specifichide exceptions switch off cosmetic filtering on a domain.
    if (filter.exception && (filter.elemhide || filter.generichide || filter.specifichide)) {
      const host = /^\|\|([^/^*|:?]+)\^?\|?$/.exec(filter.pattern);
      const targets = host ? [toAsciiDomain(host[1])] : filter.domains.include;
      for (const d of targets.filter(Boolean)) {
        if (filter.elemhide) cosmetic.noCosmetic.push(d);
        if (filter.generichide) cosmetic.noGeneric.push(d);
        if (filter.specifichide) cosmetic.noSpecific.push(d);
      }
      if (cosmeticOnly) {
        stats.cosmetic++;
        continue;
      }
    }

    const converted = toDnrRule(filter);
    if (converted.skip) {
      skip(converted.skip);
      continue;
    }
    rules.push(converted.rule);
    stats.network++;
  }

  return { rules: mergeDomainRules(dedupeRules(rules)), cosmetic: dedupeCosmetic(cosmetic), stats };
}

function dedupeRules(rules) {
  const seen = new Set();
  return rules.filter((rule) => {
    const key = JSON.stringify(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Rules that differ only in requestDomains are merged into one rule, which keeps
// big lists far below Chrome's rule limits.
export function mergeDomainRules(rules) {
  const merged = new Map();
  const out = [];
  for (const rule of rules) {
    if (!rule.condition.requestDomains) {
      out.push(rule);
      continue;
    }
    const { requestDomains, ...rest } = rule.condition;
    const key = JSON.stringify([rule.priority, rule.action, rest]);
    const existing = merged.get(key);
    if (existing && existing.condition.requestDomains.length < 1000) {
      existing.condition.requestDomains.push(...requestDomains);
    } else {
      const copy = { ...rule, condition: { ...rest, requestDomains: [...requestDomains] } };
      merged.set(key, copy);
      out.push(copy);
    }
  }
  for (const rule of out) {
    if (rule.condition.requestDomains) rule.condition.requestDomains = [...new Set(rule.condition.requestDomains)];
  }
  return out;
}

function dedupeCosmetic(c) {
  const uniq = (a) => [...new Set(a)];
  const globalEx = new Set(c.globalExceptions);
  const out = {
    generic: uniq(c.generic).filter((s) => !globalEx.has(s)),
    specific: {},
    exceptions: {},
    globalExceptions: uniq(c.globalExceptions),
    noCosmetic: uniq(c.noCosmetic),
    noGeneric: uniq(c.noGeneric),
    noSpecific: uniq(c.noSpecific),
  };
  for (const [d, sels] of Object.entries(c.specific)) {
    const list = uniq(sels).filter((s) => !globalEx.has(s));
    if (list.length) out.specific[d] = list;
  }
  for (const [d, sels] of Object.entries(c.exceptions)) out.exceptions[d] = uniq(sels);
  return out;
}

// Gives rules sequential ids starting at `firstId`.
export function assignIds(rules, firstId = 1) {
  return rules.map((rule, i) => ({ id: firstId + i, ...rule }));
}

// ---------- Combining several lists into one ruleset ----------

// Merges the DNR rules of several converted lists, dropping duplicates.
export function combineRules(ruleLists) {
  return mergeDomainRules(dedupeRules(ruleLists.flat()));
}

// Merges the cosmetic data of several converted lists.
export function combineCosmetic(parts) {
  const out = emptyCosmetic();
  for (const p of parts) {
    out.generic.push(...p.generic);
    out.globalExceptions.push(...p.globalExceptions);
    out.noCosmetic.push(...p.noCosmetic);
    out.noGeneric.push(...p.noGeneric);
    out.noSpecific.push(...(p.noSpecific || []));
    for (const [d, s] of Object.entries(p.specific)) (out.specific[d] ||= []).push(...s);
    for (const [d, s] of Object.entries(p.exceptions)) (out.exceptions[d] ||= []).push(...s);
  }
  return dedupeCosmetic(out);
}
