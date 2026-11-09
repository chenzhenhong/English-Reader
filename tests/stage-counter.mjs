/**
 * Stage-counter checks.
 *
 * The reported bug: `切分` showed `0/15` and `逐句` showed `4/15`, both labelled
 * "已完成". The strip had been reading a single generic `done` field, so a
 * segmentation payload (which has no `done`) rendered 0, and a sentence payload
 * reported successes only, hiding the 11 answers that were analysed but flagged
 * for review. These assertions pin the per-stage semantics.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let registration;
const sandbox = {
  window: { __ModuleLoader__: { load(r) { registration = r; } }, localStorage: { getItem: () => null, setItem() {} } },
  console,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'client.js' });

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  Fragment: 'fragment',
};
const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require ${specifier}`);
});
plugin.apply({
  effect: () => () => {},
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject(_k, cb) { cb(); return () => {}; }, register() { return () => {}; } },
});

const stageCounter = plugin.__test?.stageCounter;
if (typeof stageCounter !== 'function') {
  console.log('  ✗ stageCounter is not exported for testing');
  console.log('build the bundle with the .debug-exports marker to run this suite');
  process.exit(1);
}

console.log('segmentation reports the sentence total');
// A total, not a ratio: `15` says "cut into 15 sentences"; `15/15` reads like a
// progress bar and was mistaken for the per-sentence counter beside it.
check('shows a bare total', stageCounter('SEGMENTATION', { sentences: 15 }) === ' 15', stageCounter('SEGMENTATION', { sentences: 15 }));
check('does not render a ratio', !stageCounter('SEGMENTATION', { sentences: 15 }).includes('/'));
check('shows nothing when nothing was cut', stageCounter('SEGMENTATION', { sentences: 0 }) === '');

console.log('\nsentence analysis reports analysed/total');
check(
  'counts reviewed answers as analysed',
  stageCounter('SENTENCE_ANALYSIS', { sentences: 15, done: 4, needsReview: 11, failed: 0 }) === ' 15/15',
  stageCounter('SENTENCE_ANALYSIS', { sentences: 15, done: 4, needsReview: 11, failed: 0 }),
);
check(
  'prefers the explicit analysed field',
  stageCounter('SENTENCE_ANALYSIS', { sentences: 15, analysed: 15, done: 4 }) === ' 15/15',
);
check(
  'failed sentences do not inflate the count',
  stageCounter('SENTENCE_ANALYSIS', { sentences: 15, done: 4, needsReview: 9, failed: 2 }) === ' 13/15',
  stageCounter('SENTENCE_ANALYSIS', { sentences: 15, done: 4, needsReview: 9, failed: 2 }),
);
check('shows nothing before a total exists', stageCounter('SENTENCE_ANALYSIS', { sentences: 0 }) === '');
check('tolerates a missing payload', stageCounter('SENTENCE_ANALYSIS', undefined) === '');

console.log('\nother stages have no countable unit');
for (const id of ['OVERVIEW', 'DIFFICULTY', 'VOCABULARY', 'PHRASES', 'COLLOCATIONS', 'REVIEW']) {
  check(`${id} shows no counter`, stageCounter(id, { sentences: 15, done: 15 }) === '', stageCounter(id, { sentences: 15, done: 15 }));
}

// Render the strip with the exact payload that produced the bug.
console.log('\nrendered strip');
{
  const tasks = [
    { stage: 'SEGMENTATION', status: 'SUCCEEDED', progress: { sentences: 15 } },
    { stage: 'SENTENCE_ANALYSIS', status: 'SUCCEEDED', progress: { sentences: 15, done: 4, needsReview: 11, failed: 0 } },
    { stage: 'OVERVIEW', status: 'SUCCEEDED', progress: { evidence: { checked: 0, missing: 0 }, needsReview: false } },
  ];
  const strip = plugin.__test.AnalysisProgress({ t: (key) => key, tasks, onRetry() {}, pending: false });
  const text = JSON.stringify(strip);
  check('strip no longer shows 0/15', !text.includes('0/15'), text.slice(0, 200));
  check('strip shows 15/15 for segmentation', text.includes('15/15'));
  check('strip shows 4 successes as 15 analysed', !text.includes('4/15'));
  check('strip still surfaces the review count', text.includes('reader.needsReviewCount'));

  // A run that stopped early leaves the task at PENDING while individual
  // sentences are marked failed; the card must still open its detail, or those
  // sentences become unreachable once the summary panel is gone.
  const partial = [
    { stage: 'SENTENCE_ANALYSIS', status: 'PENDING', progress: { sentences: 51, done: 3, failed: 8 } },
  ];
  const openable = plugin.__test.AnalysisProgress({ t: (key) => key, tasks: partial, onRetry() {}, pending: false, failedCount: 8 });
  const openableText = JSON.stringify(openable);
  // The click handler is a function and JSON drops it, so the assertion looks
  // for the hit-target button that only an inspectable stage renders.
  check('a pending stage with failed sentences opens its detail', openableText.includes('er-stage-hit'), openableText.slice(0, 300));
  check('the failed sentence count is shown', openableText.includes('er-stage-failed-count'));
  check('the stage is marked inspectable', openableText.includes('"data-inspectable":true'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
