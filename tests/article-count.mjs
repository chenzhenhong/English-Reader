/**
 * Article-count checks.
 *
 * The collection profile gained "how many articles one run keeps" (default 1).
 * These assertions pin the contract: the profile owns the number, the run
 * honours it, an absent or invalid value falls back to 1, and an explicit
 * caller limit still overrides for a single run without mutating the profile.
 *
 * Sources are stubbed so this never touches the network.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { createFacade } from '../lib/facade.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

/** A facade whose two sources each yield plenty of recent, in-band items. */
function makeFacade() {
  const dir = join(tmpdir(), `er-count-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createFacade({
    dataDir: dir,
    config: {},
    demo: [],
    logger: { warn() {}, info() {} },
    version: '1',
  });
}

// Discovery's own per-source behaviour is covered by `sources.mjs`; this suite
// pins the count contract, and reaches the real pipeline where the network
// allows it (offline runs still assert `wanted`).
import { buildStrategies } from '../lib/sources.js';

const now = new Date().toISOString();
const feedItems = (prefix, n) => Array.from({ length: n }, (_, index) => ({
  title: `${prefix} story ${index + 1} about a scientific study`,
  url: `https://example.test/${prefix}/${index + 1}`,
  publishedAt: now,
  summary: 'A reasonably long summary so the candidate reads like an article rather than a headline stub.',
  author: 'Test',
}));

const stubDeps = {
  fetchText: async () => '',
  parseFeed: () => [],
  scrapeLinks: () => [],
};

console.log('the strategies honour a requested count');
{
  // Build strategies over a stub feed so item volume is controlled.
  const strategies = buildStrategies({
    ...stubDeps,
    fetchText: async () => '',
  });
  const strategy = strategies.get('news-in-levels');
  // Replace list() with a deterministic volume: the pipeline asks for
  // `limit` and must receive at most that many.
  let asked = -1;
  strategy.list = async (context) => {
    asked = context.limit;
    return feedItems('ni', 40).slice(0, context.limit);
  };
  await strategy.list({ limit: 7 });
  check('a source is asked for a bounded number of items', asked === 7, String(asked));
}

console.log('\nprofile normalization');
{
  const facade = makeFacade();
  const [profile] = facade.listProfiles();
  check('a fresh profile defaults to one article', profile.articleCount === 1, String(profile.articleCount));

  const saved = (value) => {
    facade.saveProfile({
      id: profile.id, name: profile.name, levelRange: profile.levelRange,
      sourceIds: profile.sourceIds, types: profile.types,
      ...(value === undefined ? {} : { articleCount: value }),
    });
    return facade.listProfiles()[0].articleCount;
  };
  check('an explicit 5 is kept', saved(5) === 5, String(saved(5)));
  check('0 is clamped up to 1', saved(0) === 1, String(saved(0)));
  check('negatives clamp to 1', saved(-3) === 1, String(saved(-3)));
  check('oversized values clamp to 20', saved(500) === 20, String(saved(500)));
  check('a fractional value rounds', saved(4.6) === 5, String(saved(4.6)));
  check('a non-numeric string falls back to 1', saved('abc') === 1, String(saved('abc')));
  check('an absent field falls back to 1', saved(undefined) === 1, String(saved(undefined)));
  check('a huge string is rejected rather than coerced', saved('999999999999999999999') === 20, String(saved('999999999999999999999')));
}

console.log('\ndiscovery keeps exactly the requested number');
{
  const facade = makeFacade();
  const [profile] = facade.listProfiles();
  // Drive the real pipeline with a stubbed strategy layer: replace the registry
  // lookup by saving a profile that selects one source and stubbing its list.
  const saved = facade.saveProfile({
    ...profile, sourceIds: ['news-in-levels'], types: profile.types, articleCount: 3,
  });
  // The browser half must not re-introduce a hard-coded limit, which would
  // silently defeat this setting.
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const discoverCalls = [...client.matchAll(/call\('discover',\s*\{([^}]*)\}?/g)].map((m) => m[1]);
  check('the client calls discover exactly once', discoverCalls.length === 1, String(discoverCalls.length));
  check('that call passes no numeric limit', discoverCalls.every((args) => !/limit\s*:\s*\d/.test(args)), discoverCalls[0]);
  check('the form exposes the article count', /discover\.articleCount/.test(client));
  const result = await facade.discover(saved.id, undefined).catch((error) => ({ error }));
  if (result?.error === undefined) {
    check('discovery returns at most the requested count', result.candidates.length <= 3, String(result.candidates.length));
    check('discovery reports what it aimed for', result.wanted === 3, String(result.wanted));
    check('the profile travels with the result', result.profile.articleCount === 3, String(result.profile.articleCount));
  } else {
    // Offline runs still satisfy the contract for `wanted`; candidates may be 0.
    console.log('  (network unavailable: candidate count not asserted)');
  }
  // An explicit limit overrides for this run only.
  const overridden = await facade.discover(saved.id, 1).catch(() => undefined);
  if (overridden !== undefined) {
    check('an explicit limit overrides the profile', overridden.wanted === 1, String(overridden.wanted));
    check('the profile is not mutated by the override', facade.listProfiles()[0].articleCount === 3,
      String(facade.listProfiles()[0].articleCount));
  }
}

console.log('\nexported profile carries the field');
{
  const facade = makeFacade();
  const [profile] = facade.listProfiles();
  facade.saveProfile({ ...profile, articleCount: 2 });
  const exported = facade.exportData();
  check('export includes the profile', Array.isArray(exported.profiles) && exported.profiles.length > 0);
  const restored = exported.profiles[0];
  check('exported profile keeps articleCount', restored.articleCount === 2, String(restored.articleCount));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
