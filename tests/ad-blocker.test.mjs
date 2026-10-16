// Unit tests for the filter converter and the element-hiding engine.
// Run: node --test tests/ad-blocker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertFilterList, parseNetworkFilter, toDnrRule, preprocess, badfilterTarget, PRIORITY } from '../my-chrome-universe/modules/adblock/filters.js';
import { createEngine, domainSuffixes } from '../my-chrome-universe/modules/adblock/cosmetic.js';

const rule = (line) => toDnrRule(parseNetworkFilter(line).filter);

test('domain anchors become requestDomains and are merged', () => {
  const { rules } = convertFilterList('||ads.example^\n||tracker.example^\n||cdn.example^$third-party');
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.requestDomains, ['ads.example', 'tracker.example']);
  assert.equal(rules[1].condition.domainType, 'thirdParty');
});

test('URL patterns, types and options', () => {
  const r = rule('/banner/*.gif$image,domain=a.com|~b.a.com,match-case').rule;
  assert.equal(r.condition.urlFilter, '/banner/*.gif');
  assert.equal(r.condition.isUrlFilterCaseSensitive, true);
  assert.deepEqual(r.condition.resourceTypes, ['image']);
  assert.deepEqual(r.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(r.condition.excludedInitiatorDomains, ['b.a.com']);
  assert.deepEqual(rule('||x.com/ads/$~script').rule.condition.excludedResourceTypes, ['script']);
  assert.equal(rule('||x.com/ads/$important').rule.priority, PRIORITY.important);
  assert.equal(rule('||x.com/*/ad.js').rule.condition.urlFilter, '||x.com/*/ad.js');
});

test('exceptions', () => {
  assert.equal(rule('@@||good.com/ads.js').rule.action.type, 'allow');
  const doc = rule('@@||good.com^$document').rule;
  assert.equal(doc.action.type, 'allowAllRequests');
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame', 'sub_frame']);
  const { cosmetic, rules } = convertFilterList('@@||quiet.com^$elemhide\n@@||lite.com^$generichide');
  assert.equal(rules.length, 0);
  assert.deepEqual(cosmetic.noCosmetic, ['quiet.com']);
  assert.deepEqual(cosmetic.noGeneric, ['lite.com']);
});

test('unsupported filters are skipped, not mistranslated', () => {
  const { rules, stats } = convertFilterList([
    '/ad[0-9]+/', // regex
    '||x.com^$popup',
    '||x.com^$csp=script-src none',
    '||x.com^$rewrite=abp-resource:blank-js',
    '||x.com^$domain=example.*', // wildcard TLD only
    'ad', // far too generic
    'x.com#$#abort-on-property-read foo',
    'x.com##div:-abp-contains(Sponsored)',
    '||ünïcödé.com^', // converted to punycode, not skipped
  ].join('\n'));
  assert.equal(rules.length, 1);
  assert.match(rules[0].condition.requestDomains[0], /^xn--[a-z0-9-]+\.com$/);
  assert.deepEqual(Object.keys(stats.skipped).sort(), ['domain', 'option:csp', 'option:rewrite', 'popup', 'procedural', 'regex', 'snippet', 'too-generic']);
});

test('cosmetic filters: generic, specific, exceptions, :-abp-has', () => {
  const { cosmetic } = convertFilterList([
    '##.ad',
    '##.promo',
    '#@#.promo', // global exception removes it
    'news.com,~m.news.com##.sidebar-ad',
    'news.com#@#.ad',
    '~shop.com##.banner',
    'site.com#?#.post:-abp-has(.sponsored)',
    'evil.com##.x { color: red }', // CSS injection attempt
  ].join('\n'));
  assert.deepEqual(cosmetic.generic, ['.ad', '.banner']);
  assert.deepEqual(cosmetic.specific['news.com'], ['.sidebar-ad']);
  assert.deepEqual(cosmetic.specific['site.com'], ['.post:has(.sponsored)']);
  assert.ok(cosmetic.exceptions['m.news.com'].includes('.sidebar-ad'));
  assert.ok(cosmetic.exceptions['shop.com'].includes('.banner'));
  assert.equal(cosmetic.specific['evil.com'], undefined);
});

test('engine builds the right stylesheet per hostname', () => {
  const { cosmetic } = convertFilterList([
    '##.ad',
    'news.com##.sidebar-ad',
    '~m.news.com##.wide',
    'news.com#@#.ad',
    '@@||quiet.com^$elemhide',
    '@@||lite.com^$generichide',
    'lite.com##.only-here',
  ].join('\n'));
  const engine = createEngine([cosmetic]);
  const css = (host) => engine.cssFor(host);

  assert.match(css('www.news.com'), /\.sidebar-ad \{ display: none !important; \}/);
  assert.doesNotMatch(css('www.news.com'), /^\.ad /m);
  assert.match(css('other.org'), /^\.ad /m);
  assert.doesNotMatch(css('m.news.com'), /\.wide/);
  assert.equal(css('quiet.com'), '');
  assert.equal(css('lite.com'), '.only-here { display: none !important; }\n');
  assert.deepEqual(domainSuffixes('a.b.c'), ['a.b.c', 'b.c', 'c']);
});

// ---------- uBlock Origin / AdGuard syntax ----------

test('!#if / !#else / !#endif directives', () => {
  const text = [
    'a',
    '!#if env_chromium',
    'b',
    '!#if env_firefox',
    'c',
    '!#else',
    'd',
    '!#endif',
    '!#endif',
    '!#if !env_mv3 || (env_safari && env_chromium)',
    'e',
    '!#endif',
    'f',
  ].join('\n');
  assert.equal(preprocess(text, { env_chromium: true, env_mv3: true }), 'a\nb\nd\nf');
});

test('$badfilter cancels the matching filter, also across lists', () => {
  assert.equal(badfilterTarget('||ads.com^$script,badfilter'), '||ads.com^$script');
  assert.equal(badfilterTarget('||ads.com^$badfilter'), '||ads.com^');
  const { rules } = convertFilterList('||ads.com^$script\n||ads.com^$script,badfilter\n||keep.com^');
  assert.deepEqual(rules.map((r) => r.condition.requestDomains), [['keep.com']]);
  const other = convertFilterList('||x.com^', { badfilters: new Set(['||x.com^']) });
  assert.equal(other.rules.length, 0);
});

test('uBO/AdGuard network options: to=, denyallow=, method=, all, 1p/3p, important exception', () => {
  assert.deepEqual(rule('*$script,to=ads.com|~ok.ads.com,domain=site.com').rule.condition, {
    requestDomains: ['ads.com'], excludedRequestDomains: ['ok.ads.com'], initiatorDomains: ['site.com'], resourceTypes: ['script'],
  });
  assert.deepEqual(rule('*$3p,denyallow=cdn.com,domain=site.com').rule.condition.excludedRequestDomains, ['cdn.com']);
  assert.deepEqual(rule('||api.com/track$method=post').rule.condition.requestMethods, ['post']);
  assert.ok(rule('||malware.com^$all').rule.condition.resourceTypes.includes('main_frame'));
  assert.equal(rule('@@||ok.com^$important').rule.priority, PRIORITY.allowImportant);
  assert.equal(parseNetworkFilter('||x.com^$removeparam=utm').skip, 'option:removeparam');
  assert.equal(parseNetworkFilter('||x.com^$redirect=noopjs').skip, 'option:redirect');
});

test('hosts lines and bare hostnames (uBO flavor) become domain rules', () => {
  const { rules } = convertFilterList('0.0.0.0 tracker.com\n127.0.0.1 localhost\nads.example.net', { flavor: 'ubo' });
  assert.deepEqual(rules[0].condition.requestDomains, ['ads.example.net', 'tracker.com']);
  // ABP treats a bare hostname as a substring pattern, so it is not rewritten there.
  assert.equal(convertFilterList('ads.example.net').rules[0].condition.urlFilter, 'ads.example.net');
});

test('AdGuard/uBO-only cosmetic syntax is skipped, not mistranslated', () => {
  const { rules, cosmetic, stats } = convertFilterList([
    'example.com#$?#body { overflow: auto !important; }',
    'example.com#$#.ad { display: none; }',
    'example.com$$script[data-ad]',
    'example.com##^script:has-text(ads)',
    'example.com##+js(set-constant, ads, false)',
    'example.com#@#+js(nobab)',
    '[$path=/news]example.com##.ad',
    'example.com#@?#.sponsor:-abp-has(.x)',
    'example.com##.fine',
    '@@||example.com^$specifichide',
  ].join('\n'), { flavor: 'adguard' });
  assert.equal(rules.length, 0);
  assert.deepEqual(cosmetic.specific['example.com'], ['.fine']);
  assert.deepEqual(cosmetic.exceptions['example.com'], ['.sponsor:has(.x)']);
  assert.deepEqual(cosmetic.noSpecific, ['example.com']);
  assert.ok(stats.skipped['unsupported-cosmetic'] >= 2);
  assert.ok(stats.skipped.scriptlet >= 2);
});

test('engine honours $specifichide', () => {
  const { cosmetic } = convertFilterList('##.generic\nsite.com##.specific\n@@||site.com^$specifichide');
  const css = createEngine([cosmetic]).cssFor('site.com');
  assert.match(css, /\.generic/);
  assert.doesNotMatch(css, /\.specific/);
});

// ---------- Feed validation (updater.js) ----------

test('feed validation only lets block/allow rules and plain selectors through', async () => {
  const { validateRules, validateCosmetic } = await import('../my-chrome-universe/modules/adblock/updater.js');
  const ok = { id: 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['a.com'] } };
  validateRules([ok]);
  const bad = [
    { ...ok, action: { type: 'redirect', redirect: { url: 'https://evil.example/' } } },
    { ...ok, action: { type: 'modifyHeaders', responseHeaders: [] } },
    { ...ok, priority: 1000 },
    { ...ok, condition: { regexFilter: '.*' } },
    { ...ok, id: 0 },
  ];
  for (const rule of bad) assert.throws(() => validateRules([rule]), JSON.stringify(rule));

  const cosmetic = { generic: ['.ad'], specific: { 'a.com': ['.x'] }, exceptions: {}, globalExceptions: [] };
  validateCosmetic(cosmetic);
  assert.throws(() => validateCosmetic({ ...cosmetic, generic: ['body { background: url(https://evil.example) }'] }));
  assert.throws(() => validateCosmetic({ ...cosmetic, specific: { 'a.com': ['.x}html{display:none'] } }));
});
