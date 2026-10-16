// Element-hiding engine: merges the cosmetic data of the enabled lists and
// produces the stylesheet for one hostname. Pure JS (tested in Node).

export function domainSuffixes(hostname) {
  const parts = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.');
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'));
  return out;
}

export function hostMatches(hostname, domain) {
  const host = String(hostname || '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function rule(selector) {
  return `${selector} { display: none !important; }\n`;
}

export function createEngine(parts) {
  const generic = new Set();
  const globalExceptions = new Set();
  const specific = new Map();
  const exceptions = new Map();
  const noCosmetic = new Set();
  const noGeneric = new Set();
  const noSpecific = new Set();

  const addAll = (map, obj) => {
    for (const [domain, selectors] of Object.entries(obj || {})) {
      let set = map.get(domain);
      if (!set) map.set(domain, (set = new Set()));
      for (const s of selectors) set.add(s);
    }
  };

  for (const part of parts) {
    for (const s of part.generic || []) generic.add(s);
    for (const s of part.globalExceptions || []) globalExceptions.add(s);
    addAll(specific, part.specific);
    addAll(exceptions, part.exceptions);
    for (const d of part.noCosmetic || []) noCosmetic.add(d);
    for (const d of part.noGeneric || []) noGeneric.add(d);
    for (const d of part.noSpecific || []) noSpecific.add(d);
  }
  for (const s of globalExceptions) generic.delete(s);

  // The generic stylesheet is the same for almost every site, so build it once.
  let genericCss = null;
  const genericStylesheet = () => (genericCss ??= [...generic].map(rule).join(''));

  return {
    stats: { generic: generic.size, domains: specific.size },

    selectorsFor(hostname) {
      const suffixes = domainSuffixes(hostname);
      if (suffixes.some((d) => noCosmetic.has(d))) return { generic: false, selectors: [] };
      const excepted = new Set(globalExceptions);
      for (const d of suffixes) for (const s of exceptions.get(d) || []) excepted.add(s);
      const selectors = new Set();
      const useSpecific = !suffixes.some((d) => noSpecific.has(d));
      if (useSpecific) for (const d of suffixes) for (const s of specific.get(d) || []) if (!excepted.has(s)) selectors.add(s);
      const useGeneric = !suffixes.some((d) => noGeneric.has(d));
      return { generic: useGeneric, excepted, selectors: [...selectors] };
    },

    // Full stylesheet for a page on `hostname`.
    cssFor(hostname) {
      const { generic: useGeneric, excepted, selectors } = this.selectorsFor(hostname);
      let css = '';
      if (useGeneric) {
        const genericExcepted = excepted && [...excepted].some((s) => generic.has(s));
        css += genericExcepted
          ? [...generic].filter((s) => !excepted.has(s)).map(rule).join('')
          : genericStylesheet();
      }
      css += selectors.map(rule).join('');
      return css;
    },
  };
}
