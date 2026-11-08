// Verify that the tool schemas are accepted by the real Harness registry,
// without depending on the plugin's runtime wiring.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/');
const { assertSupportedJsonSchema, validateJsonSchemaValue } = require('@deepseek-ai/dsh-tools');

const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const definitions = [];
// Extract only the `register({ ... })` calls' object literals by evaluating
// the file with stubbed dependencies.
const factorySrc = host
  .replace(/^import .*$/gm, '')
  .replace(/export \{ name, inject \};/g, '')
  .replace(/export function apply/g, 'function apply');

const registered = [];
const sandboxCtx = {
  get: () => undefined,
  effect: (fn) => { fn(); return () => {}; },
  logger: { warn() {}, info() {} },
  tools: { register: (def) => registered.push(def) },
  connection: { fetch: { register: (route) => { registered.route = route; return () => {}; } } },
};
const patched = factorySrc.replace(
  "const url = new URL('./demo-library.json', import.meta.url);",
  "const url = { href: '/tmp/does-not-exist.json' };",
);
const factory = new Function('createFacade', 'ReaderError', 'ERROR_CODES', 'readFileSync', 'join', 'homedir', `${patched}\nreturn apply;`);
/** Fixtures sized like real records, so the output schemas are exercised. */
const stubFacade = {
  seedDemo() {}, resumeInterrupted() {},
  listArticles: () => ({
    items: [{
      id: 'art_x', title: 'The Power of Small Habits', sourceName: 'Sample', cefrLevel: 'B2',
      wordCount: 296, status: 'COMPLETED', readingStatus: 'reading',
    }],
    total: 1,
    sources: ['Sample'],
  }),
  getArticle: () => ({
    article: { id: 'art_x', title: 'Sample', cefrLevel: 'B2', readingMinutes: 3, publishedAt: '2026-10-14' },
    wordCount: 296,
    sentences: [{ sentenceIndex: 0, text: 'Small habits can lead to big changes.', analysisStatus: 'done' }],
    tasks: [], analysis: { id: 'ana_x', status: 'COMPLETED' }, words: [], phrases: [], collocations: [],
    overview: null, difficulty: null, review: null, notes: [], progress: { sentenceIndex: 0, ratio: 0 },
  }),
  createArticle: () => ({ id: 'art_new', wordCount: 12, readingMinutes: 1 }),
  importUrl: async () => ({ title: 'T', text: 'body', url: 'https://example.com/a', sourceName: 'example.com', cefrLevel: 'B2' }),
  startAnalysis: () => ({ analysisId: 'ana_new', articleId: 'art_x', version: 2 }),
  analysisState: () => ({
    id: 'ana_x', status: 'COMPLETED', completed: 8, total: 8,
    stages: [{ stage: 'OVERVIEW', status: 'SUCCEEDED', error: null, progress: null }],
  }),
  retryStage: async () => ({ id: 'ana_x', status: 'PARTIAL_COMPLETED', completed: 7, total: 8, stages: [] }),
  retrySentence: async () => ({ ok: true, sentenceIndex: 0, needsReview: false }),
  cancelAnalysis: () => ({ cancelled: true }),
  revalidateSentences: () => ({ checked: 3, cleared: 2, flagged: 0, notes: 3 }),
  searchKnowledge: () => [{
    id: 'voc_x', kind: 'word', expression: 'consolidate', phonetic: '/k/', detail: [],
    cefrLevel: 'C1', sourceCount: 1, articleId: 'art_x', articleTitle: 'Sample',
    favorite: false, masteryLevel: 0,
  }],
  updateKnowledge: () => ({ entityType: 'word', entityId: 'voc_x', favorite: true, masteryLevel: 2, notes: 'n' }),
  speak: async () => ({ audio: 'AAAA', mime: 'audio/mpeg', voice: 'en-US-AriaNeural', rate: 0, bytes: 4, cached: false }),
};
const apply = factory(
  () => stubFacade,
  class extends Error { constructor(c, m) { super(m); this.code = c; } },
  { SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED', DATABASE_ERROR: 'DATABASE_ERROR' },
  readFileSync, (...a) => a.join('/'), () => '/tmp',
);
apply(sandboxCtx, {});
/**
 * Run each instrumented execute() against a stub facade whose records are fully
 * populated, then assert the returned value validates against the declared
 * output schema. This catches both undeclared fields and type drift.
 * @param {object} def tool definition.
 * @param {object} validateJsonSchemaValue registry validator.
 * @returns {string | null} violation text, or null when valid.
 */
async function checkReturnedShape(def, validateJsonSchemaValue) {
  const sampleArgs = {
    english_reader_search: { scope: 'articles', limit: 5 },
    english_reader_import: { text: 'A body with two sentences. Here is the second.' },
    english_reader_analyze: { articleId: 'art_x', action: 'status', sentenceIndex: 0 },
    english_reader_speak: { text: 'hello' },
    english_reader_knowledge: { entityType: 'word', entityId: 'voc_x' },
  }[def.name];
  if (sampleArgs === undefined) return null;
  // Tools branching on `action` return different shapes; check every branch,
  // otherwise a branch that adds a field can escape validation entirely.
  const variants = def.name === 'english_reader_analyze'
    ? [
      { ...sampleArgs, action: 'status' },
      { ...sampleArgs, action: 'retry', stage: 'SENTENCE_ANALYSIS', sentenceIndex: 0 },
      { ...sampleArgs, action: 'retry', stage: 'OVERVIEW' },
      { ...sampleArgs, action: 'revalidate' },
      { ...sampleArgs, action: 'cancel' },
      { ...sampleArgs, action: 'start' },
    ]
    : [sampleArgs];
  for (const args of variants) {
    let value;
    try {
      value = await def.execute(args, { signal: undefined });
    } catch (error) {
      return `${args.action ?? def.name}: threw ${error.message}`;
    }
    // This validator RETURNS a violation list; it does not throw. Catching an
    // exception here silently accepted every value, so the check proved nothing.
    const violations = validateJsonSchemaValue(def.output.schema, value, 'value');
    if (violations.length > 0) return `${args.action ?? def.name}: ${violations.join('; ')}`;
  }
  return null;
}

let failed = false;
console.log('registrations:', registered.length, 'route:', sandboxCtx.connection.fetch ? 'yes' : 'no');
// `ctx.tools.register` validates the raw schemas exactly as the Host does, so
// this mirror uses the same subset assertion plus an argument round trip.
for (const def of registered) {
  if (!def || typeof def.name !== 'string') continue;
  try {
    assertSupportedJsonSchema(def.parameters);
    assertSupportedJsonSchema(def.output.schema);
    const sample = {
      english_reader_search: { scope: 'articles' },
      english_reader_import: { text: 'body' },
      english_reader_analyze: { articleId: 'x', action: 'status' },
      english_reader_speak: { text: 'hello' },
      english_reader_knowledge: { entityType: 'word', entityId: 'x' },
    }[def.name] ?? {};
    const argViolations = validateJsonSchemaValue(def.parameters, sample, 'arguments');
    if (argViolations.length > 0) throw new Error(argViolations.join('; '));
    if (typeof def.execute !== 'function') throw new Error('execute is not a function');
    if (typeof def.output.render !== 'function') throw new Error('output.render is not a function');
    // Execute against the stub facade and validate the real return value:
    // a closed output schema must accept exactly what the tool produces.
    const violation = await checkReturnedShape(def, validateJsonSchemaValue);
    if (violation !== null) throw new Error(violation);
    console.log('  ✓', def.name);
  } catch (error) {
    console.log('  ✗', def.name, '-', error.message);
    failed = true;
  }
}
if (registered.length !== 5) {
  console.log(`  ✗ expected 5 tools, got ${registered.length}`);
  failed = true;
}
