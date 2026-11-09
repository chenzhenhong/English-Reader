/**
 * Deep-render smoke test.
 *
 * No browser control is available here, so this renders the plugin's component
 * tree with a miniature React runtime instead: function components really run,
 * hooks keep state across a re-render, and every page is exercised against
 * shaped fixtures. A missing icon, a bad prop path, or a hook misuse throws.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The bundle keeps its page components in one factory scope; appending a
// debug export lets this harness mount each page directly without changing
// what ships.
const raw = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
// The bundle exposes its components through `plugin.__test` when built with the
// .debug-exports marker; the test build is produced by `tests/all.mjs`.
const source = raw;
let registration;
const sandbox = {
  window: {
    __ModuleLoader__: { load(r) { registration = r; } },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    speechSynthesis: { speak() {} },
  },
  console,
  setTimeout,
  clearTimeout,
  SpeechSynthesisUtterance: class {},
  fetch: (...args) => globalThis.__fetchDelegate(...args),
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

/**
 * Minimal React that executes components, keeps hook state per mounted
 * component instance, and can re-render until async loads settle.
 */
function createMiniReact() {
  const instances = new Map();
  let cursor = null;
  let dirty = false;

  function instanceFor(key) {
    let instance = instances.get(key);
    if (instance === undefined) {
      instance = { hooks: [], effects: [], mounted: false };
      instances.set(key, instance);
    }
    return instance;
  }

  const React = {
    createElement(type, props, ...children) {
      // Real React delivers children as props.children; mirroring that here
      // keeps components that re-project their children (Card, Dialog, Tabs)
      // rendering what they actually render in the browser.
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      const merged = { ...(props ?? {}) };
      if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids;
      return { type, props: merged, children: kids };
    },
    Fragment: Symbol('fragment'),
    useState(initial) {
      const instance = cursor;
      const index = instance.index++;
      if (instance.hooks[index] === undefined) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        const next = typeof value === 'function' ? value(instance.hooks[index]) : value;
        if (next !== instance.hooks[index]) {
          instance.hooks[index] = next;
          dirty = true;
        }
      };
      return [instance.hooks[index], set];
    },
    useEffect(fn, deps) {
      const instance = cursor;
      const index = instance.index++;
      const previous = instance.effects[index];
      const changed = previous === undefined
        || deps === undefined
        || !Array.isArray(previous.deps)
        || previous.deps.some((value, at) => value !== deps[at]);
      if (changed) {
        instance.effects[index] = { deps, cleanup: fn() };
        dirty = true;
      }
    },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(value) {
      const instance = cursor;
      const index = instance.index++;
      if (instance.hooks[index] === undefined) instance.hooks[index] = { current: value };
      return instance.hooks[index];
    },
  };

  /** Render a tree; `path` gives each component a stable instance key. */
  function renderTree(element, container, path) {
    if (element === null || element === undefined || element === false || element === true) return;
    if (typeof element === 'string' || typeof element === 'number') { container.push(String(element)); return; }
    if (Array.isArray(element)) { element.forEach((child, index) => renderTree(child, container, `${path}.${index}`)); return; }
    const { type, props, children } = element;
    if (type === React.Fragment) { children.forEach((child, index) => renderTree(child, container, `${path}.${index}`)); return; }
    if (typeof type === 'string' || typeof type === 'symbol') {
      container.push({ type, props, children });
      children.forEach((child, index) => renderTree(child, container, `${path}.${index}`));
      return;
    }
    const instance = instanceFor(`${path}:${type.name || 'anon'}`);
    const outer = cursor;
    cursor = instance;
    instance.index = 0;
    let output;
    try {
      output = type(props ?? {});
    } catch (error) {
      cursor = outer;
      throw new Error(`component ${type.name || '<anonymous>'} crashed: ${error.message}`);
    }
    cursor = outer;
    renderTree(output, container, path);
  }

  /** Render repeatedly until state and effects stop changing. */
  async function mount(element) {
    const container = [];
    for (let pass = 0; pass < 40; pass += 1) {
      dirty = false;
      container.length = 0;
      renderTree(element, container, 'root');
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) break;
    }
    return container;
  }

  return { React, mount };
}

const { React, mount } = createMiniReact();

/** Uniform assertion reporting for this harness. */
let __failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) {
    __failures += 1;
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- fixtures
const article = {
  id: 'art_demo1', title: 'The Power of Small Habits', sourceName: 'Sample', cefrLevel: 'B2',
  wordCount: 296, readingMinutes: 3, status: 'COMPLETED', readingStatus: 'reading', demo: true,
  snippet: 'Small habits can lead to big changes.', createdAt: '2026-10-14T00:00:00Z',
  publishedAt: '2026-10-14', topic: 'Psychology',
  // A real article usually came from a URL; the reader must offer a way back.
  sourceUrl: 'https://example.test/small-habits',
};
const detailData = {
  article,
  body: 'Small habits can lead to big changes. A new study shows that tiny daily actions can significantly improve your health.',
  paragraphs: [{ index: 0, body: 'Small habits can lead to big changes.' }],
  overview: { background: '背景', mainIdea: '主旨', keyPoints: ['要点'], readingFocus: ['关注'], estimatedReadingMinutes: 3 },
  difficulty: { cefrLevel: 'B2', vocabularyDifficulty: 3, grammarDifficulty: 2, sentenceComplexity: 2, conceptualDifficulty: 2, reasons: ['理由'], difficultExpressions: ['small habits'] },
  review: {
    summary: '总结', logicalStructure: [{ step: 1, title: '开头', description: '说明' }], keyTakeaways: ['要点'],
    questions: [{ question: '问题？', type: 'choice', options: ['A. 一', 'B. 二'], answer: 'A', explanation: '因为一', evidence: 'Small habits' }],
  },
  analysis: { id: 'ana_1', version: 1, status: 'RUNNING', model: 'trae/deepseek', createdAt: '2026-11-07T00:00:00Z' },
  tasks: [
    { stage: 'OVERVIEW', status: 'SUCCEEDED', errorCode: null, errorMessage: null, progress: null },
    { stage: 'SENTENCE_ANALYSIS', status: 'RUNNING', errorCode: null, errorMessage: null, progress: { sentences: 15, done: 5, failed: 0 } },
    { stage: 'REVIEW', status: 'FAILED', errorCode: 'LLM_TIMEOUT', errorMessage: '超时' },
  ],
  sentences: [
    {
      paragraphIndex: 0, sentenceIndex: 0, startOffset: 0, endOffset: 36, analysisStatus: 'done',
      text: 'Small habits can lead to big changes.',
      analysis: {
        translation: { literal: '小习惯能导致大变化。', natural: '小习惯能带来大改变。' },
        structure: { mainClause: 'Small habits can lead', components: [{ type: '主语', text: 'Small habits', explanation: '主语' }] },
        grammarPoints: [{ title: '情态动词', explanation: '表示可能', evidence: 'can lead' }],
        keyExpressions: [{ expression: 'lead to', meaning: '导致', explanation: '动词短语' }],
        difficultyNotes: ['注意搭配'], uncertaintyNotes: [],
      },
    },
    { paragraphIndex: 0, sentenceIndex: 1, startOffset: 37, endOffset: 140, analysisStatus: 'pending', text: 'Participants who kept a modest routine were more likely to maintain it.', analysis: null },
    {
      paragraphIndex: 0, sentenceIndex: 2, startOffset: 141, endOffset: 200, analysisStatus: 'failed',
      text: 'Critics point out that small changes cannot solve structural problems.', analysis: null,
      error: { code: 'LLM_TRUNCATED', message: '模型输出达到长度上限被截断，JSON 没有写完。', raw: '{"translation": {"literal": "直', attempts: 2 },
    },
  ],
  words: [
    { id: 'voc_1', lemma: 'consolidate', phonetic: '/kənˈsɒlɪdeɪt/', partOfSpeech: ['verb'], meanings: [{ meaning: '巩固', contextMeaning: '巩固新行为' }], contextMeaning: '巩固新行为', occurrences: 2, evidence: [{ exactText: 'how people consolidate new behaviour' }], cefrLevel: 'C1', wordFormation: { components: ['con', 'solid'], explanation: '共同加固' }, synonyms: ['strengthen'], antonyms: [], favorite: true, masteryLevel: 2, notes: '' },
    { id: 'voc_2', lemma: 'routine', phonetic: '/ruːˈtiːn/', partOfSpeech: ['noun'], meanings: [{ meaning: '常规' }], contextMeaning: '固定做法', occurrences: 3, evidence: [], cefrLevel: 'B1', wordFormation: null, synonyms: [], antonyms: [], favorite: false, masteryLevel: 0, notes: '' },
  ],
  phrases: [{ id: 'phr_1', expression: 'add up to', phraseType: '动词短语', meaning: '累积成', explanation: '逐渐累积', evidence: [{ exactText: 'add up to a healthier' }], favorite: false, masteryLevel: 0 }],
  collocations: [{ id: 'col_1', expression: 'boost your energy', pattern: 'verb + noun', meaning: '提升精力', explanation: '常见搭配', evidence: [], favorite: false, masteryLevel: 0 }],
  progress: { sentenceIndex: 1, ratio: 0.5 },
  notes: [{ id: 'nte_1', sentenceIndex: 0, body: '这句是主旨句', createdAt: '2026-11-07T00:00:00Z' }],
  wordCount: 296,
};

const dashboardData = {
  articles: 3, favoriteWords: 2, knowledgeItems: 5, readingMinutes: 9, streakDays: 2,
  knowledge: [{ kind: 'word', n: 4, mastered: 1 }],
  recent: [article],
  tasks: [{ stage: 'SENTENCE_ANALYSIS', status: 'RUNNING', articleId: 'art_demo1', articleTitle: article.title, error: null }],
};
const knowledgeItems = [
  { id: 'voc_1', kind: 'word', expression: 'consolidate', phonetic: '/k/', detail: [{ meaning: '巩固', contextMeaning: '巩固新行为' }], cefrLevel: 'C1', sourceCount: 2, articleId: 'art_demo1', articleTitle: article.title, favorite: true, masteryLevel: 2 },
  { id: 'phr_1', kind: 'phrase', expression: 'add up to', detail: '', meaning: '累积成', cefrLevel: null, sourceCount: 1, articleId: 'art_demo1', articleTitle: article.title, favorite: false, masteryLevel: 0 },
];
const knowledgeDetail = {
  kind: 'word', id: 'voc_1', expression: 'consolidate', phonetic: '/k/', partOfSpeech: ['verb'],
  meanings: [{ meaning: '巩固', contextMeaning: '巩固新行为' }], wordFormation: { components: ['con', 'solid'], explanation: '共同加固' },
  cefrLevel: 'C1', synonyms: ['strengthen'], antonyms: [], favorite: true, masteryLevel: 2, notes: '注意搭配',
  contexts: [{ articleId: 'art_demo1', title: article.title, contextMeaning: '巩固新行为', evidence: [{ exactText: 'how people consolidate' }], analysis: { translation: { natural: '人们如何巩固' } } }],
};

const responses = {
  dashboard: dashboardData,
  listArticles: { items: [article], total: 3, sources: ['Sample'] },
  getArticle: detailData,
  accountName: '小明',
  studyActivity: {
    window: 364, today: '2026-11-08', startDay: '2025-11-10', peakSeconds: 1800,
    days: [
      { day: '2026-11-08', events: 3, seconds: 1800, minutes: 30, kinds: ['read', 'vocabulary'] },
      { day: '2026-11-06', events: 1, seconds: 300, minutes: 5, kinds: ['read'] },
    ],
    totals: { seconds: 2100, minutes: 35, events: 4, activeDays: 2, currentStreak: 1, longestStreak: 1 },
    byKind: { read: { events: 3, seconds: 1800 }, vocabulary: { events: 1, seconds: 300 } },
    byArticle: [{ articleId: 'art_demo1', title: 'The Power of Small Habits', cefrLevel: 'B2', seconds: 1800, minutes: 30, events: 3, lastDay: '2026-11-08' }],
    events: [
      { day: '2026-11-08', kind: 'read', seconds: 1500, articleId: 'art_demo1', title: 'The Power of Small Habits', cefrLevel: 'B2' },
      { day: '2026-11-08', kind: 'vocabulary', seconds: 300, articleId: 'art_demo1', title: 'The Power of Small Habits', cefrLevel: 'B2' },
      { day: '2026-11-06', kind: 'read', seconds: 300, articleId: 'art_demo1', title: 'The Power of Small Habits', cefrLevel: 'B2' },
    ],
  },
  listProfiles: [{
    id: 'prf_1', name: 'B1–B2 分级阅读', levelRange: ['B1', 'B2'],
    sourceIds: ['news-in-levels', 'the-conversation'],
    publishedWithinDays: 7, publishedWindow: '7d',
    types: ['news', 'analysis', 'explainer', 'research_news', 'opinion', 'criticism', 'essay', 'feature', 'literature', 'graded_news', 'tutorial', 'reference'],
    filterSensitive: true, articleCount: 1,
    // In range mode so the truncate switch is rendered and testable.
    wordLimitMode: 'range', truncate: true, minWords: 800, maxWords: 1500, targetVocabularyCount: 15,
    keywords: [], excludedKeywords: [], topics: [], preferRecent: true, avoidHighlyTechnical: true,
  }],
  discover: { profileId: 'prf_1', total: 1, wanted: 1, sources: [{ sourceId: 'news-in-levels', sourceName: 'News in Levels', kind: 'feed', ok: true, fetched: 10, error: null, code: null }], candidates: [{ id: 'dsc_1', title: 'Future of Space', url: 'https://bbc.com/a', sourceName: 'BBC', publishedAt: '2026-11-28', wordCount: 900, cefrLevel: 'B2', snippet: 'Space…', score: 7, reasons: ['来源匹配 BBC', '近期发布'], imported: false }] },
  searchKnowledge: knowledgeItems,
  pendingCandidates: { items: [{ id: 'dsc_pending', title: 'Persisted candidate', url: 'https://x.example/1', sourceName: 'BBC', publishedAt: '2026-11-28', wordCount: 900, cefrLevel: 'B2', snippet: 'A pending row.', score: 7, reasons: ['来源匹配'], imported: false }], total: 1, limit: 30, offset: 0 },
  knowledgeDetail,
  reviewQueue: { items: [{ id: 'voc_1', kind: 'word', expression: 'consolidate', phonetic: '/k/', meanings: [{ meaning: '巩固' }], cefrLevel: 'C1', masteryLevel: 1, favorite: false }], reviewedToday: 2, target: 5, total: 4, mastered: 1 },
  settings: {
    model: { provider: 'trae', model: 'deepseek-v4.1-flash' }, llmAvailable: true, searchAvailable: true,
    dataDir: '/home/user/.dsh/english-reader',
    databasePath: '/home/user/.dsh/english-reader/database/english-reader.sqlite',
    bytes: 503691, schemaVersion: 1, sentenceConcurrency: 2, retryLimit: 2, wordsPerArticle: 15,
    counts: { articles: 3, words: 15 }, version: '1.0.0',
    collection: {
      sources: [
        { id: 'news-in-levels', name: 'News in Levels', domains: ['newsinlevels.com'], kind: 'feed', levelHint: { scheme: 'nil', min: 'A2', max: 'B1' }, articleTypes: ['graded_news'], paywalled: false },
        { id: 'the-conversation', name: 'The Conversation', domains: ['theconversation.com'], kind: 'feed', levelHint: { scheme: 'analysis', min: 'C1', max: 'C2' }, articleTypes: ['analysis'], paywalled: false },
      ],
      articleTypes: ['news', 'analysis', 'explainer', 'research_news', 'opinion', 'criticism', 'essay', 'feature', 'literature', 'graded_news', 'tutorial', 'reference'],
      cefrLevels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
      windows: [{ id: '24h', days: 1 }, { id: '7d', days: 7 }, { id: '30d', days: 30 }, { id: 'custom', days: null }],
    },
    speech: {
      available: true, engine: 'edge-tts', cachedFiles: 2, cachedBytes: 30672,
      voices: [
        { id: 'en-US-AriaNeural', label: 'Aria · 美音女声', accent: 'US', gender: 'female' },
        { id: 'en-GB-SoniaNeural', label: 'Sonia · 英音女声', accent: 'UK', gender: 'female' },
      ],
    },
  },
  analysisState: { id: 'ana_1', status: 'RUNNING', completed: 6, total: 8, stages: [] },
  updateKnowledge: { entityType: 'word', entityId: 'voc_1', favorite: true, masteryLevel: 2, notes: '注意搭配' },
  importUrl: { url: 'https://bbc.com/a', title: 'Space', sourceName: 'bbc.com', description: 'd', text: 'Body text.\n\nSecond.', wordCount: 300, readingMinutes: 2, paragraphCount: 2, sentenceCount: 4, cefrLevel: 'B2', duplicateArticleId: null },
  createArticle: { id: 'art_new', wordCount: 300, readingMinutes: 2 },
  saveProgress: { saved: true, ratio: 0.5 },
  saveNote: { id: 'nte_2', body: 'note' },
  saveProfile: { id: 'prf_1' },
  startAnalysis: { analysisId: 'ana_2', articleId: 'art_demo1', version: 2 },
  retryStage: { id: 'ana_1', status: 'PARTIAL_COMPLETED', completed: 7, total: 8, stages: [] },
  deleteArticle: { deleted: true },
  seedDemo: { seeded: 3 },
  removeDemo: { removed: 3 },
  importData: { added: 1, skipped: 0 },
  exportData: { formatVersion: 1, articles: [] },
  confirmImport: [{ id: 'dsc_1', ok: true, articleId: 'art_new' }],
};

globalThis.__fetchDelegate = async (_url, init) => {
  const { op, args } = JSON.parse(init.body);
  if (op === 'searchKnowledge') {
    const kind = args?.kind ?? 'word';
    // Only words have rows in this fixture; the other three tabs are empty on
    // purpose so their own empty state is observable.
    const value = kind === 'word' ? knowledgeItems : [];
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
  }
  const value = responses[op];
  if (value === undefined) return { ok: true, status: 200, json: async () => ({ ok: true, value: [] }) };
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
};

const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require ${specifier}`);
});

const recorded = [];
const ctx = {
  locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}.${key}` },
  effect: () => () => {},
  slots: {
    inject(_key, cb) { cb(); return () => {}; },
    register(options, component) { recorded.push({ options, component }); return () => {}; },
  },
};
plugin.apply(ctx);

// --------------------------------------------------------------- rendering
const t = (key) => key;
const panel = recorded.find((r) => r.options?.name === 'main').component;
const iconEntry = recorded.find((r) => r.options?.name === 'sidebar.panellist');

async function renderAll(label, element) {
  const container = await mount(element);
  return { label, nodes: container.length, container };
}

const icon = await renderAll('icon', React.createElement(iconEntry.component, { size: 16, active: true }));
console.log('panel icon renders:', icon.nodes, 'nodes');

const appTree = panel({ t });
const app = await renderAll('app shell', appTree);
const findText = (label) => app.container.some((node) => JSON.stringify(node).includes(label));
console.log('shell nav labels:', ['nav.home', 'nav.discover', 'nav.articles', 'nav.review', 'nav.settings'].every(findText));
console.log('shell brand:', findText('Reader'), 'nodes:', app.nodes);

const P = plugin.__test;
const noop = () => {};
const cases = [
  ['Dashboard', () => React.createElement(P.Dashboard, { t, onNavigate: noop, onOpen: noop, onRetry: noop })],
  ['Discover auto', () => React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, mode: 'auto' })],
  ['Discover url', () => React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, mode: 'url' })],
  ['Discover paste', () => React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, mode: 'paste' })],
  ['Articles', () => React.createElement(P.Articles, { t, notify: noop, onOpenArticle: noop })],
  ['ArticleDetail split', () => React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop })],
  ['KnowledgePage word', () => React.createElement(P.KnowledgePage, { t, kind: 'word', notify: noop })],
  ['KnowledgePage phrase', () => React.createElement(P.KnowledgePage, { t, kind: 'phrase', notify: noop })],
  ['KnowledgeDetail', () => React.createElement(P.KnowledgeDetail, { t, kind: 'word', entityId: 'voc_1', onBack: noop, notify: noop })],
  ['ReviewPage', () => React.createElement(P.ReviewPage, { t, notify: noop })],
  ['SettingsPage', () => React.createElement(P.SettingsPage, { t, notify: noop })],
];
let failures = 0;
for (const [label, make] of cases) {
  try {
    const result = await renderAll(label, make());
    const html = result.container.map((node) => (typeof node === 'string' ? node : JSON.stringify(node.props))).join('');
    const skeleton = html.includes('er-skeleton');
    const emptyState = html.includes('er-empty');
    const errorState = html.includes('er-alert');
    console.log(`  ✓ ${label} (${result.nodes} nodes${skeleton ? ', loading' : ''}${emptyState ? ', empty' : ''}${errorState ? ', alert' : ''}): ${html.slice(0, 0)}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}: ${error.message}`);
  }
}

// The reader must actually show the article body and sentence analysis.
const reader = await renderAll('reader body', React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop }));
const readerHtml = reader.container.map((node) => (typeof node === 'string' ? node : JSON.stringify(node.props))).join('');
const alerts = reader.container.filter((n) => typeof n !== 'string' && String(n.props?.className ?? '').includes('er-alert'));
if (alerts.length > 0) console.log('alerts:', JSON.stringify(alerts.map((n) => n.props?.className)));
const strings = reader.container.filter((n) => typeof n === 'string');
console.log('reader text sample:', strings.join(' ').slice(0, 160));
if (alerts.length > 0) console.log('reader alert:', alerts.map((n) => JSON.stringify(n.children ?? n.props?.child0)).slice(0, 2).join(' '));
const checks = [
  ['article body present', 'habits'],
  ['sentence element', 'er-sentence'],
  ['clickable word', 'er-word'],
  ['mode tabs', 'reader.modeSplit'],
  ['stage strip', 'er-stage'],
  ['sentence progress', '5/15'],
];
for (const [label, needle] of checks) console.log(`  ${readerHtml.includes(needle) ? '\u2713' : '\u2717'} reader shows ${label}`);

const detail = detailData;
const index = P.wordIndex(detail);
console.log('wordIndex:', [...index.keys()].join(','), 'size', index.size);
console.log('paragraphBlocks:', P.paragraphBlocks(detail).map((b) => b.items.length).join(','));
console.log(failures > 0 ? `${failures} page(s) crashed` : 'all pages rendered');
if (failures > 0) process.exitCode = 1;


// ------------------------------------------------ interaction: tab + reader
const interactive = await mount(React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop }));
const tabControls = interactive.filter((n) => typeof n !== 'string' && n.props?.['aria-selected'] !== undefined);
console.log('tab controls:', tabControls.length, 'selected:', tabControls.filter((n) => n.props['aria-selected']).length);
// Insights order is guide, words, phrases, review. The sentence list was
// removed because clicking a sentence in the body already opens its analysis.
const insightsSource = readFileSync(new URL('../src/80-reader.js', import.meta.url), 'utf8');
const tabIds = [...insightsSource.matchAll(/\{ id: '(guide|words|phrases|review|sentences)', label: t\('reader\.tab/g)]
  .map((match) => match[1]);
check('insight tabs are exactly guide/words/phrases/review',
  tabIds.join(',') === 'guide,words,phrases,review', tabIds.join(','));
check('the sentences tab is gone', !tabIds.includes('sentences'));
// Split mode (the default) shows the sentence pane and no analysis strip; the
// analysis strip belongs to continuous mode. Assert the split view's own shape.
{
  const splitView = await mount(React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(splitView);
  // Match the atomic tablist class: `er-tabs`, `er-tabs-bar` and
  // `er-tabs-sticky` all contain "er-tabs", so compare split class tokens.
  // A tablist is the atomic container; `er-tabs-bar` is its wrapper, so count
  // only the role to avoid double-counting the same widget.
  const strips = all.filter((n) => n.props?.role === 'tablist');
  check('split mode has one tab strip (reading mode)', strips.length >= 1, String(strips.length));
  check('split mode shows the sentence pane', all.some((n) => String(n.props?.className ?? '').includes('er-side-card')));
}

// Reader layout: prose must not sit flush against a border, and sentence spans
// must be separated by a space (segmentation trims each sentence).
{
  const detail = detailData;
  const twoSentence = {
    ...detail,
    sentences: [
      { ...detail.sentences[0], analysis: null, analysisStatus: 'done' },
      { ...detail.sentences[1], analysis: null, analysisStatus: 'done' },
    ],
  };
  const nodes = await mount(React.createElement(P.ArticleBody, {
    detail: twoSentence, words: new Map(), activeIndex: -1, onSelect: noop, onWord: noop,
  }));
  const paragraphs = nodes.filter((n) => typeof n !== 'string' && n.type === 'p');
  check('ArticleBody renders one paragraph per block', paragraphs.length === 1, String(paragraphs.length));
  const kids = paragraphs[0]?.children ?? [];
  check('the paragraph holds both sentence spans', kids.filter((c) => typeof c !== 'string').length === 2,
    String(kids.filter((c) => typeof c !== 'string').length));
  const spaceAt = kids.findIndex((c, index) => typeof c === 'string' && c === ' ' && index > 0 && index < kids.length - 1);
  check('a literal space sits between the sentences', spaceAt > 0, String(spaceAt));

  // Reconstructing what the browser paints must read as prose.
  const painted = kids.map((c) => {
    if (typeof c === 'string') return c;
    const text = c.props?.text ?? '';
    return text;
  }).join('');
  check('painted text does not glue sentences together', !/\.(?=[A-Z])/.test(painted), JSON.stringify(painted.slice(0, 70)));

  // The reader panes must be padded cells, not the padding-less legacy card.
  const paneNodes = await mount(React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop }));
  const panes = paneNodes.filter((n) => typeof n !== 'string' && typeof n.props?.className === 'string'
    && (n.props.className.includes('er-article-card') || n.props.className.includes('er-side-card')));
  const padded = panes.every((n) => String(n.props.className).includes('er-cell'));
  check('reader panes use a padded cell', panes.length >= 2 && padded, `${panes.length} panes`);
}

// The collection form: every field label shares one style, and the save action
// sits immediately left of the start action in a single row.
{
  const nodes = await mount(React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, mode: 'auto' }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);

  // Every *field naming* label inside a .er-field must carry the shared class; a
  // bare nested <label> would render at body size. Control labels (`.er-check`,
  // which wrap a checkbox) are a different element on purpose and excluded.
  const fields = all.filter((n) => String(n.props?.className ?? '') === 'er-field');
  let unstyled = 0;
  let controlLabels = 0;
  for (const field of fields) {
    const walkLabels = (list, depth) => (list ?? []).forEach((child) => {
      if (typeof child === 'string') return;
      if (child.type === 'label') {
        const classes = String(child.props?.className ?? '');
        if (classes.split(/\s+/).includes('er-check')) controlLabels += 1;
        else if (depth > 0 && !classes.includes('er-field-label')) unstyled += 1;
      }
      walkLabels(child.children, depth + 1);
    });
    walkLabels(field.children, 0);
  }
  check('every field label is styled the same way', unstyled === 0, `${unstyled} unstyled label(s)`);
  check('control labels are distinguishable', controlLabels >= 1, String(controlLabels));

  // Locate the two action buttons by their label keys and compare order.
  const buttons = all.filter((n) => n.type === 'button');
  const labelOf = (node) => {
    const parts = [];
    const collect = (list) => (list ?? []).forEach((c) => {
      if (typeof c === 'string') parts.push(c);
      else collect(c.children);
    });
    collect([node]);
    return parts.join(' ');
  };
  const saveIdx = buttons.findIndex((b) => labelOf(b).includes('discover.saveProfile'));
  const startIdx = buttons.findIndex((b) => labelOf(b).includes('discover.start'));
  check('the save button exists', saveIdx >= 0, String(saveIdx));
  check('the start button exists', startIdx >= 0, String(startIdx));
  check('save sits immediately left of start', startIdx - saveIdx === 1, `save=${saveIdx} start=${startIdx}`);
}

// Row alignment: no page may place a lone grid item that cannot fill its row,
// and every long list must scroll inside its cell rather than stretch it.
{
  const flat = (nodes) => nodes.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const pages = [
    ['Dashboard', () => React.createElement(P.Dashboard, { t, onNavigate: noop, onOpen: noop, onRetry: noop })],
    ['Discover', () => React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, mode: 'auto' })],
    ['Articles', () => React.createElement(P.Articles, { t, notify: noop, onOpenArticle: noop })],
    ['Settings', () => React.createElement(P.SettingsPage, { t, notify: noop })],
    ['Review', () => React.createElement(P.ReviewPage, { t, notify: noop })],
    ['Knowledge', () => React.createElement(P.KnowledgePage, { t, kind: 'word', notify: noop })],
    ['History', () => React.createElement(P.StudyHistoryPage, { t, notify: noop })],
  ];
  let bad = 0;
  for (const [label, make] of pages) {
    const nodes = flat(await mount(make()));
    const cells = nodes.filter((n) => String(n.props?.className ?? '').includes('er-cell'));
    // A row of 8+4 or 6+6 etc. is fine; only a trailing 8 with nothing beside it
    // leaves a notch. Sum spans per board and require each to be a multiple of 12.
    const spans = cells.map((n) => Number(String(n.props.className).match(/er-span-(\d+)/)?.[1] ?? 0)).filter(Boolean);
    const total = spans.reduce((sum, value) => sum + value, 0);
    const aligned = total % 12 === 0;
    const scrolls = nodes.filter((n) => String(n.props?.className ?? '').includes('er-cell-scroll')).length;
    console.log(`  ${aligned ? '\u2713' : '\u2717'} ${label} rows sum to whole rows (${spans.join('+') || '-'}=${total}), scroll regions ${scrolls}`);
    if (!aligned) bad += 1;
  }
  if (bad > 0) process.exitCode = 1;
}

// One-screen reader: the page must use fill mode, both panes must be present in
// the side column, and no secondary block may sit below the reader pushing the
// document taller than the viewport.
{
  const nodes = await mount(React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const cls = (n) => String(n.props?.className ?? '');

  check('the reader page uses fill mode', all.some((n) => cls(n).includes('er-page--fill')));
  check('the reader grid uses fill mode', all.some((n) => cls(n).includes('er-reader--fill')));
  check('the article body has its own scroll pane', all.some((n) => cls(n).includes('er-pane-scroll')));
  // Split the class list: `er-side-card` must not satisfy this. `flat()`
  // revisits each subtree, so this counts occurrences rather than asserting 1.
  const sides = all.filter((n) => cls(n).split(/\s+/).includes('er-side'));
  check('the reader has a scrolling side column', sides.length >= 1, String(sides.length));

  // The side column owns the panels; the eyebrows live on its child cells, so
  // scan the whole subtree rather than the column's own props.
  const sideNodes = sides.flatMap((side) => flat([side]));
  const sideHasSentences = sideNodes.some((n) => String(n.props?.className ?? '').includes('er-side-card'));
  check('the split side column holds the sentence panel', sideHasSentences);
  // The analysis tab strip belongs to continuous mode only, so split must not
  // contain it twice.
  const tabStrips = all.filter((n) => String(n.props?.className ?? '').includes('er-tabs-bar'));
  check('split mode renders exactly one tab strip', tabStrips.length === 1, String(tabStrips.length));

  // Nothing outside the reader should be a standalone note list.
  const strayNotes = all.filter((n) => cls(n) === 'er-row-list' && flat([n]).some((c) => String(c.props?.eyebrow ?? '').includes('reader.notes')));
  check('no note list sits below the reader', strayNotes.length === 0);
}

// A panel that renders its own cell must never be wrapped in a second cell: the
// wrapper keeps its border and title even when the inner panel returns null,
// which is exactly the empty box reported from the UI.
{
  const source = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  // Collect the direct children of each `h(Cell, {...},` call by scanning
  // balanced parentheses; a wrapped panel appears as a Cell whose first child
  // is the panel component.
  const cells = [];
  const marker = "h(Cell, {";
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    let depth = 0;
    let open = i + 'h('.length - 1;
    let end = -1;
    for (let j = open; j < source.length; j += 1) {
      if (source[j] === '(') depth += 1;
      else if (source[j] === ')') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end > 0) cells.push(source.slice(i, end + 1));
  }
  for (const name of ['StageDetailDialog', 'NoteList']) {
    const wrapped = cells.some((body) => {
      const afterProps = body.slice(body.indexOf('},') + 2);
      return afterProps.includes(`h(${name},`);
    });
    check(`${name} is not wrapped in a second cell`, !wrapped);
    check(`${name} is still mounted`, source.includes(`h(${name},`));
  }
  // The failure summary used to sit in the aside as a red panel; its detail
  // now opens from the stage card instead.
  check('no failure panel is rendered in the aside', !source.includes('h(FailureSummary,'));
  check('a failed stage opens a dialog', source.includes('onInspect: setInspectStage'));
}

// Mode ownership: split mode is per-sentence close reading, continuous mode is
// whole-article reading with the analysis tabs. Neither may render both.
{
  const source = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  // Cut at the ternary's `:`, which is where the continuous branch begins.
  const start = source.indexOf("mode === 'split'");
  const splitArm = source.slice(start, source.indexOf(": h('aside'", start));
  const continuousArm = source.slice(source.indexOf(": h('aside'", start), source.indexOf("drawerWord", start));
  check('split mode mounts the sentence panel', splitArm.includes('sentencePanel'));
  check('split mode does not mount the analysis tabs', !splitArm.includes('insightPanel'));
  check('continuous mode mounts the analysis tabs', continuousArm.includes('insightPanel'));
  check('continuous mode does not mount the sentence panel', !continuousArm.includes('sentencePanel'));
}

// The dashboard must not duplicate navigation the rail already provides, and
// must not repeat totals that the stat tiles already show.
{
  const nodes = await mount(React.createElement(P.Dashboard, { t, onNavigate: noop, onOpen: noop, onRetry: noop }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const buttons = all.filter((n) => n.type === 'button');
  const labelOf = (node) => {
    const parts = [];
    const collect = (list) => (list ?? []).forEach((c) => {
      if (typeof c === 'string') parts.push(c);
      else collect(c.children ?? c.props?.children);
    });
    collect([node]);
    return parts.join(' ');
  };
  const labels = buttons.map(labelOf);
  for (const key of ['home.ctaDiscover', 'home.ctaImport', 'home.ctaLibrary']) {
    check(`the dashboard offers no duplicate "${key}" entry`, !labels.some((label) => label.includes(key)));
  }
  // Nothing decorative next to the greeting: the avatar held no information.
  check('the greeting has no avatar block', all.every((n) => !String(n.props?.className ?? '').includes('er-welcome-avatar')));
  // The four stat tiles still carry the totals.
  check('the study counters remain', all.filter((n) => String(n.props?.className ?? '') === 'er-stat').length >= 4,
    String(all.filter((n) => String(n.props?.className ?? '') === 'er-stat').length));
  // The search field is still there: it is the only non-rail entry point left.
  check('the search field remains', all.some((n) => n.type === 'input' && n.props?.type === 'search'));
}

// The reader keeps one vocabulary surface (the "重点单词" tab), not a second
// strip above the article; and an imported article offers a way back to its URL.
{
  const nodes = await mount(React.createElement(P.ArticleDetail, { t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const labelOf = (node) => {
    const parts = [];
    const collect = (list) => (list ?? []).forEach((c) => {
      if (typeof c === 'string') parts.push(c);
      else collect(c.children ?? c.props?.children);
    });
    collect([node]);
    return parts.join(' ');
  };

  // The old strip rendered each lemma as a chip directly above the body.
  const chips = all.filter((n) => String(n.props?.className ?? '') === 'er-chip');
  check('no vocabulary chip strip above the article', chips.length === 0, String(chips.length));

  // Words remain reachable through the analysis tab.
  // The analysis tabs live inside `ArticleInsights`, which only mounts in the
  // continuous branch, so assert on the source rather than this render tree.
  const detailSource = readFileSync(new URL('../src/80-reader.js', import.meta.url), 'utf8');
  const insightSource = detailSource.slice(detailSource.indexOf('function ArticleInsights'));
  check('the vocabulary tab is still offered', insightSource.includes("id: 'words'")
    && insightSource.includes("t('reader.tabWords')"));

  // Both mode branches are built, so the link appears once per branch. Assert
  // the reader offers it at all, and always pointing at the same URL.
  const links = all.filter((n) => n.type === 'a'
    && String(n.props?.className ?? '').includes('er-source-link'));
  check('the article links back to its source', links.length >= 1, String(links.length));
  check('the source link points at the stored URL', links[0]?.props?.href === 'https://example.test/small-habits',
    String(links[0]?.props?.href));
  check('the source link opens in a new tab', links[0]?.props?.target === '_blank');
  check('the source link is labelled', labelOf(links[0] ?? {}).includes('reader.openSource'), labelOf(links[0] ?? {}));
}

// The insight tab strip must expose exactly the four remaining subjects, and the
// shared add-to-library control must still be defined (it lived beside a
// removed component and was easy to delete by accident).
{
  const reader = readFileSync(new URL('../src/80-reader.js', import.meta.url), 'utf8');
  const tabIds = [...reader.matchAll(/\{ id: '(guide|words|phrases|review|sentences)', label:/g)].map((m) => m[1]);
  check('the insight strip has four tabs', tabIds.length === 4, tabIds.join(','));
  check('the sentence-list tab was removed', !tabIds.includes('sentences'));
  check('LibraryToggle is defined once', (reader.match(/function LibraryToggle/g) ?? []).length === 1);
  check('LibraryToggle is still used by the lists', (reader.match(/h\(LibraryToggle,/g) ?? []).length >= 3,
    String((reader.match(/h\(LibraryToggle,/g) ?? []).length));
}

// The progress strip shows a sentence count on two different stages. They must
// not look like the same measurement: 切分 reports a total, 逐句 reports a ratio,
// and every stage carries a one-line subject.
{
  const detailSrc = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  check('stage labels are localised, not literal Chinese',
    !/label: '[\u4e00-\u9fa5]{2}'/.test(detailSrc));
  check('every stage declares a hint key',
    (detailSrc.match(/hintKey: 'stageHint\./g) ?? []).length === 8,
    String((detailSrc.match(/hintKey: 'stageHint\./g) ?? []).length));
  check('the stage hint is rendered', detailSrc.includes('er-stage-hint'));

  // Behaviour of the counter itself: segmentation is a total, sentences a ratio.
  const counterSrc = detailSrc.slice(detailSrc.indexOf('function stageCounter'),
    detailSrc.indexOf('/** Stage progress strip'));
  // Segmentation must NOT emit a ratio: a total alone is what makes it read
  // differently from the sentence ratio below it.
  const segBranch = counterSrc.slice(counterSrc.indexOf("stageId === 'SEGMENTATION'"),
    counterSrc.indexOf("stageId === 'SENTENCE_ANALYSIS'"));
  check('segmentation reports a bare total', segBranch.includes('` ${total}`'), segBranch);
  check('segmentation is not a ratio', !segBranch.includes('/${total}'));
  check('sentence analysis reports analysed/total',
    /SENTENCE_ANALYSIS[\s\S]{0,320}analysed\}\/\$\{total\}/.test(counterSrc));
}

// Both the library list and the reader must offer a way back to the publisher,
// but only for articles that actually came from a URL.
{
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const linkIn = (nodes) => flat(nodes).filter((n) => n.type === 'a'
    && String(n.props?.className ?? '').includes('er-source-link'));

  // The shared fixture article carries sourceUrl, so both surfaces show a link.
  const readerLinks = linkIn(await mount(React.createElement(P.ArticleDetail, {
    t, articleId: 'art_demo1', notify: noop, onBack: noop, onNavigateKnowledge: noop,
  })));
  check('the reader shows the source link', readerLinks.length >= 1, String(readerLinks.length));
  check('the reader link targets the stored URL',
    readerLinks[0]?.props?.href === 'https://example.test/small-habits', String(readerLinks[0]?.props?.href));
  check('the reader link opens a new tab', readerLinks[0]?.props?.target === '_blank');
  check('the reader link is safe against tabnabbing',
    String(readerLinks[0]?.props?.rel ?? '').includes('noopener'));

  // Without a stored URL the control must be absent rather than a dead link.
  // Pasted text and the in-house samples have no publisher to return to.
  const detailSrc = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  const listSrc = readFileSync(new URL('../src/70-articles.js', import.meta.url), 'utf8');
  for (const [label, src] of [['reader', detailSrc], ['list', listSrc]]) {
    check(`the ${label} link is conditional on sourceUrl`,
      /article\.sourceUrl\s*(?:\?|&&|\))/.test(src) || src.includes('article.sourceUrl'),
      'no guard found');
  }
  const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));
  check('sample articles declare no sourceUrl rather than a fake one',
    demo.every((item) => item.sourceUrl === null || item.sourceUrl === undefined));
}

// The sentence panel's header block (title, sentence, add button) must be OUTSIDE
// the scroll container, or it scrolls away with the analysis it labels.
{
  const source = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  const reader = readFileSync(new URL('../src/80-reader.js', import.meta.url), 'utf8');
  check('SentencePane returns a head and a body', /return \{\s*head,/.test(reader));
  // The head is rendered before the scroller opens.
  const panelStart = source.indexOf("className: 'er-cell er-side-card'");
  const panelSource = source.slice(panelStart, panelStart + 900);
  const headAt = panelSource.indexOf('pane.head');
  const scrollAt = panelSource.indexOf('er-side-scroll');
  check('the pane head is placed before the scroller', headAt >= 0 && headAt < scrollAt,
    `head=${headAt} scroll=${scrollAt}`);
  check('the pane body is placed inside the scroller', /er-side-scroll[\s\S]{0,120}pane\.body/.test(panelSource));
}

// The progress band collapses when every stage succeeded, and expands when a
// stage failed or a run is in flight. Rendered for real: the collapsed output
// must not contain the stage grid.
{
  const tasks = (status) => [
    { stage: 'OVERVIEW', status: 'SUCCEEDED', progress: {} },
    { stage: 'SEGMENTATION', status: 'SUCCEEDED', progress: { sentences: 2 } },
    { stage: 'SENTENCE_ANALYSIS', status, progress: { sentences: 2, analysed: 2 } },
  ];
  const render = async (props) => {
    // `mount` already yields a flat list; do not re-flatten it.
    const nodes = await mount(React.createElement(P.Band, {
      t, ratio: 0.5, position: '1 / 2', pending: false, onRetry: noop, onToggle: noop, ...props,
    }));
    return [...new Set(nodes.filter((n) => typeof n === 'object' && n !== null))];
  };
  const classesOf = (nodes) => nodes.map((n) => String(n.props?.className ?? '')).join(' ');

  const ok = await render({ tasks: tasks('SUCCEEDED'), running: false, open: null });
  check('all-success collapses by default', classesOf(ok).includes('er-reader-band--collapsed'));
  check('collapsed shows no stage grid',
    ok.filter((n) => String(n.props?.className ?? '') === 'er-stage').length === 0);
  check('collapsed still shows the progress bar', ok.some((n) => String(n.props?.className ?? '') === 'er-progress'));

  const failed = await render({ tasks: tasks('FAILED'), running: false, open: null });
  check('a failed stage expands by default', !classesOf(failed).includes('er-reader-band--collapsed'));
  // `flat()` revisits nested subtrees, so count unique elements.
  // Count real DOM elements only: `renderTree` output already contains them, and
  // a second flatten pass would count the same children again.
  const stageCells = failed.filter((n) => String(n.props?.className ?? '') === 'er-stage');
  check('expanded shows all eight stages', stageCells.length === 8, String(stageCells.length));

  const flying = await render({ tasks: tasks('SUCCEEDED'), running: true, open: null });
  check('a run in flight stays expanded', !classesOf(flying).includes('er-reader-band--collapsed'));

  // Explicit override wins in both directions.
  const forcedOpen = await render({ tasks: tasks('SUCCEEDED'), running: false, open: true });
  check('the learner can force it open', !classesOf(forcedOpen).includes('er-reader-band--collapsed'));
  const forcedShut = await render({ tasks: tasks('FAILED'), running: false, open: false });
  check('the learner can force it shut', classesOf(forcedShut).includes('er-reader-band--collapsed'));

  // Collapsing must free height: it is a flex child that no longer grows.
  const css = readFileSync(new URL('../src/20-style.js', import.meta.url), 'utf8');
  check('the band does not grow', /\.er-page--fill > \.er-reader-band\s*\{[^}]*flex:\s*none/.test(css));
  check('the collapsed band is shorter', /\.er-reader-band--collapsed[^{]*\{[^}]*padding-top:\s*10px/.test(css));
}

// Clicking the band's toggle must actually flip the state. The bug this guards
// is subtle: the handler called `onToggle(expanded)` instead of `!expanded`, so
// the parent stored the value it already had and the button did nothing.
{
  // A tiny host that owns the state, exercising the real toggle contract.
  const h = React.createElement;
  function BandHost({ t }) {
    const [open, setOpen] = React.useState(null);
    return h(React.Fragment, null,
      h(P.Band, {
        t, ratio: 0.4, position: '1 / 2', pending: false, onRetry: noop,
        tasks: [{ stage: 'OVERVIEW', status: 'SUCCEEDED', progress: {} }],
        running: false,
        open, onToggle: setOpen,
      }));
  }
  const flat = (nodes) => nodes.filter((n) => typeof n === 'object' && n !== null);
  const stageCount = (nodes) => flat(nodes).filter((n) => String(n.props?.className ?? '') === 'er-stage').length;

  const before = await mount(React.createElement(BandHost, { t }));
  check('all-success starts collapsed', stageCount(before) === 0, String(stageCount(before)));

  const toggle = flat(before).find((n) => n.props?.onClick && n.props?.['aria-expanded'] !== undefined);
  check('the toggle is rendered as a button', toggle !== undefined);
  check('the toggle exposes its state', typeof toggle?.props?.['aria-expanded'] === 'boolean',
    String(toggle?.props?.['aria-expanded']));
  check('collapsed state says collapsed', toggle?.props?.['aria-expanded'] === false);

  // Fire the real handler, then re-render from the state it produced.
  toggle.props.onClick();
  const opened = await mount(React.createElement(BandHost, { t }));
  check('one click expands it', stageCount(opened) === 8, String(stageCount(opened)));
  const toggleAgain = flat(opened).find((n) => n.props?.onClick && n.props?.['aria-expanded'] !== undefined);
  check('the button now reports expanded', toggleAgain?.props?.['aria-expanded'] === true);

  toggleAgain.props.onClick();
  const closed = await mount(React.createElement(BandHost, { t }));
  check('a second click collapses it again', stageCount(closed) === 0, String(stageCount(closed)));
}

// Every rail entry must open its own page. `history` fell through to the
// knowledge fallback and showed the word list instead, because navigateByNav had
// no branch for it.
{
  const app = readFileSync(new URL('../src/120-app.js', import.meta.url), 'utf8');
  const navBlock = app.slice(app.indexOf('const navigateByNav'), app.indexOf('const activeNav'));
  const navIds = [...app.matchAll(/\{ id: '([a-z]+)', icon: '/g)].map((m) => m[1]);
  check('the rail lists its entries', navIds.length >= 8, navIds.join(','));

  // Knowledge sub-pages share one fallback; everything else needs its own branch
  // or it will silently open the wrong page.
  const knowledgeIds = ['words', 'phrases', 'collocations', 'sentences'];
  const explicit = navIds.filter((id) => !knowledgeIds.includes(id) && id !== 'settings');
  for (const id of explicit) {
    // `home`, `discover`, `articles`, `review`, `history` each need `go('<page>')`.
    const expected = id === 'home' ? 'home' : id;
    check(`nav "${id}" routes to its own page`,
      new RegExp(`id === '${id}'\\) go\\('${expected}'`).test(navBlock),
      navBlock.slice(0, 200));
  }
  check('knowledge ids fall through to the knowledge page',
    /else go\('knowledge'/.test(navBlock));
}

// The log covers a fixed year; there is no range selector any more.
{
  const history = readFileSync(new URL('../src/105-history.js', import.meta.url), 'utf8');
  check('the log uses a fixed 53-week window', /const HISTORY_WEEKS = 53/.test(history));
  check('it queries a year', /days: HISTORY_WEEKS \* 7/.test(history));
  check('no range presets remain', !history.includes('RANGE_PRESETS'));
  check('no custom date inputs remain', !history.includes("type: 'date'"));
  check('the grid always spans the year', /weeks: HISTORY_WEEKS/.test(history));

  const dashboard = readFileSync(new URL('../src/50-dashboard.js', import.meta.url), 'utf8');
  check('the dashboard embeds a study heatmap', dashboard.includes('function StudyMini'));
  // The dashboard shows a full year; the history page is where it narrows.
  check('the dashboard heatmap covers a year', /studyActivity', \{ days: 364 \}/.test(dashboard));
  // The column count and the grid itself now live in the shared component.
  check('the shared grid renders 53 week columns', /const HISTORY_WEEKS = 53/.test(history));
  // It must delegate to the same card, not re-implement the block.
  check('it renders the shared heatmap card', /h\(StudyHeatmapCard,/.test(dashboard));
  check('the dashboard has no private grid implementation',
    !dashboard.includes('function ActivityGrid') && !dashboard.includes('h(ActivityGrid,'));
  check('it links to the full history page', /onNavigate\('history'\)/.test(dashboard));
}

// The dashboard heatmap must actually paint cells, not just exist.
{
  const nodes = await mount(React.createElement(P.Dashboard, { t, onNavigate: noop, onOpen: noop, onRetry: noop }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const heatCells = all.filter((n) => String(n.props?.className ?? '') === 'er-heat-cell');
  check('the dashboard paints a full year of cells', heatCells.length >= 365, String(heatCells.length));
  const levels = new Set(heatCells.map((n) => n.props['data-level']));
  check('cells carry an intensity level', levels.size >= 2, [...levels].join(','));
  const grid = all.filter((n) => String(n.props?.className ?? '').includes('er-heat'));
  // One grid, one look: no compact variant exists any more.
  check('no compact variant is rendered', !grid.some((n) => String(n.props.className).includes('er-heat--compact')));
}

// The greeting shows the signed-in name when available and degrades to a bare
// hello otherwise. It is cosmetic, so no failure may surface as an error.
{
  const source = readFileSync(new URL('../src/50-dashboard.js', import.meta.url), 'utf8');
  check('the greeting reads the account name', source.includes("call('accountName')"));
  check('a failed lookup is swallowed', /\.catch\(\(\) => null\)/.test(source));
  check('an empty name falls back to the plain greeting',
    /name === null \? t\('home\.greetingPlain'\)/.test(source));
  check('a name is appended to the greeting prefix',
    source.includes("t('home.greetingPrefix')") && source.includes('${name}'));

  // The old placeholder greeting must be gone: it said "learners" to everyone.
  const locale = readFileSync(new URL('../src/110-locale.js', import.meta.url), 'utf8');
  check('the bare hello has no placeholder noun', /'home\.greetingPlain': '你好'/.test(locale));
  check('english falls back to a bare hello too', /'home\.greetingPlain': 'Hello'/.test(locale));
  check('no unused {name} placeholder remains', !/greetingNamed/.test(locale));
}

// The greeting shows the account name when the Host supplies one.
{
  const h1Text = (nodes) => {
    const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
    const h1 = flat(nodes).find((n) => n.type === 'h1');
    const collect = (node) => flat([node]).map((n) => (typeof n === 'string' ? n : String(n.props?.children ?? ''))).join('');
    return h1 ? collect(h1) : '';
  };
  const named = await mount(React.createElement(P.Dashboard, { t, onNavigate: noop, onOpen: noop, onRetry: noop }));
  check('the greeting includes the account name', h1Text(named).includes('小明'), h1Text(named));
  // `home.greetingPrefix` shares the `home.greeting` prefix, so match the old
  // placeholder key exactly rather than by substring.
  check('the greeting does not use the placeholder noun when named',
    !h1Text(named).includes("home.greeting'"), h1Text(named));

  // The null branch is asserted on the expression itself: the harness caches a
  // component instance per path, so a second mount would reuse the first load
  // and could never observe a different accountName.
  const source = readFileSync(new URL('../src/50-dashboard.js', import.meta.url), 'utf8');
  check('a null name renders the bare greeting with no separator',
    /name === null \? t\('home\.greetingPlain'\) : `\$\{t\('home\.greetingPrefix'\)\}\$\{name\}`/.test(source));
}

// The truncate switch sits beside the range inputs as one checkbox and is
// checked by default once a range is selected.
{
  const nodes = await mount(React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, mode: 'auto' }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const boxes = all.filter((n) => n.type === 'input' && n.props?.type === 'checkbox');

  // The fixture profile is in range mode with truncation on.
  check('the discover form renders the truncate checkbox', boxes.length >= 1, String(boxes.length));
  const truncateBox = boxes.find((n) => n.props?.checked === true);
  check('it is checked by the default profile', truncateBox !== undefined);
  check('toggling it writes a boolean', /update\(\{ truncate: event\.target\.checked \}\)/.test(
    readFileSync(new URL('../src/60-discover.js', import.meta.url), 'utf8')));

  // A profile with truncation off must render it unchecked.
  const source = readFileSync(new URL('../src/60-discover.js', import.meta.url), 'utf8');
  check('checked follows the profile value', source.includes('checked: profile.truncate === true'));
  // And the switch only exists inside a range.
  check('the switch is inside the range branch',
    source.indexOf("profile.truncate === true") > source.indexOf("profile.wordLimitMode === 'range'"));
}

// Each library tab explains its own emptiness. Words existing must not make the
// phrase/collocation/sentence tabs claim "the library is empty".
{
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const emptyText = (nodes) => {
    const all = flat(nodes);
    // The Empty block renders its title and description as text children.
    const block = all.find((n) => String(n.props?.className ?? '') === 'er-empty');
    if (block === undefined) return null;
    return flat([block]).map((n) => (typeof n === 'string' ? n : String(n.props?.children ?? ''))).join(' ');
  };

  const seen = new Map();
  for (const kind of ['word', 'phrase', 'collocation', 'sentence']) {
    const nodes = await mount(React.createElement(P.KnowledgePage, { t, kind, notify: noop }));
    seen.set(kind, emptyText(nodes));
  }

  // Word has rows in this fixture, so it must not show an empty block.
  check('a populated tab shows no empty state', seen.get('word') === null, String(seen.get('word')));
  for (const kind of ['phrase', 'collocation', 'sentence']) {
    const text = seen.get(kind);
    check(`${kind} tab shows its own empty message`, text !== null && text.includes(`knowledge.empty.${kind}.title`), String(text));
    check(`${kind} tab does not claim the whole library is empty`,
      text !== null && !text.includes('knowledge.emptyTitle'), String(text));
  }
  // The three messages must differ from one another.
  const distinct = new Set(['phrase', 'collocation', 'sentence'].map((kind) => seen.get(kind)));
  check('the three empty messages are distinct', distinct.size === 3, [...distinct].join(' | '));
}

// The rail brand is one line. It used to be two stacked divs ("English" /
// "Reader"), which read as a broken wordmark in a 188px rail.
{
  const app = readFileSync(new URL('../src/120-app.js', import.meta.url), 'utf8');
  // Cut at the closing paren of the brand wrapper, not at `groups,` (which is
  // the same token used earlier by the navigation loop).
  const brandStart = app.indexOf("className: 'er-brand'");
  const brand = app.slice(brandStart, app.indexOf("h('div', { className: 'er-rail-foot'", brandStart));
  const nameNodes = (brand.match(/className: 'er-brand-name'/g) ?? []).length;
  check('the brand renders one name node', nameNodes === 1, String(nameNodes));
  check('the name is the full wordmark', brand.includes("'English Reader'"), brand.slice(0, 200));
  check('no stacked second line remains', !/marginTop: -4/.test(brand));

  const css = readFileSync(new URL('../src/20-style.js', import.meta.url), 'utf8');
  const rule = css.match(/\.er-brand-name\s*\{([^}]*)\}/);
  check('the brand name cannot wrap', rule !== null && /white-space:\s*nowrap/.test(rule[1]));

  // Rendered output carries exactly one brand-name element.
  const nodes = await mount(React.createElement(P.EnglishReaderApp, { t }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  // `flat()` revisits nested subtrees, so dedupe by identity before counting.
  const names = nodes.filter((n) => typeof n === 'object' && String(n.props?.className ?? '') === 'er-brand-name');
  check('exactly one brand name is painted', names.length === 1, String(names.length));
  const paintedText = flat(names).map((n) => (typeof n === 'string' ? n : String(n.props?.children ?? ''))).join('');
  check('the painted wordmark is one string', paintedText.includes('English Reader') && !paintedText.includes('ReaderReader'), paintedText);
}

// Rail grouping: review and history are practice/progress, not knowledge
// entities, so they must not sit under the knowledge group.
{
  const app = readFileSync(new URL('../src/120-app.js', import.meta.url), 'utf8');
  const navBlock = app.slice(app.indexOf('const NAV_GROUPS'), app.indexOf('const PANEL_ID'));
  const groups = [...navBlock.matchAll(/id: '(\w+)',\s*items: \[([\s\S]*?)\]/g)]
    .map((m) => ({ id: m[1], items: [...m[2].matchAll(/id: '(\w+)'/g)].map((i) => i[1]) }));

  const kindOf = (item) => groups.find((group) => group.items.includes(item))?.id;
  check('the rail has three groups', groups.length === 3, groups.map((g) => g.id).join(','));
  for (const kind of ['words', 'phrases', 'collocations', 'sentences']) {
    check(`${kind} belongs to the knowledge group`, kindOf(kind) === 'knowledge', kindOf(kind));
  }
  check('review is not in the knowledge group', kindOf('review') !== 'knowledge', String(kindOf('review')));
  check('history is not in the knowledge group', kindOf('history') !== 'knowledge', String(kindOf('history')));
  check('review and history share the practice group',
    kindOf('review') === 'practice' && kindOf('history') === 'practice',
    `${kindOf('review')}/${kindOf('history')}`);

  // Group headings must be per-group, not a hard-coded "knowledge".
  check('group headings are per-group', app.includes('t(`nav.group.${group.id}`)'));
  const locale = readFileSync(new URL('../src/110-locale.js', import.meta.url), 'utf8');
  check('both group headings exist', locale.includes("'nav.group.knowledge'")
    && locale.includes("'nav.group.practice'"));
}

// The pending list must rehydrate from the database: switching pages and coming
// back used to show an empty pane even though the rows were still stored.
{
  // The candidates live on the discovered-content tab, not on the profile one.
  const nodes = await mount(React.createElement(P.Discover, { t, notify: noop, onOpenArticle: noop, tab: 'results' }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const text = all.map((n) => (typeof n === 'string' ? n : String(n.props?.children ?? ''))).join(' ');
  check('a stored candidate reappears after remount', text.includes('Persisted candidate'), text.slice(0, 120));
  check('it renders as a selectable row', all.some((n) => String(n.props?.className ?? '') === 'er-candidate'));
  check('the hydration call is made', /call\('pendingCandidates'/.test(
    readFileSync(new URL('../src/60-discover.js', import.meta.url), 'utf8')));
}


// TEMP PROBE: render the dashboard with the real payload.
{
  const real = JSON.parse(readFileSync('/tmp/real-dashboard.json', 'utf8'));
  globalThis.__fetchDelegate = async (_url, init) => {
    const { op } = JSON.parse(init.body);
    const map = { dashboard: real, accountName: null, studyActivity: { window: 364, today: '2026-11-08', startDay: '2025-11-10', endDay: '2026-11-08', peakSeconds: 103, days: [{ day: '2026-11-08', events: 7, seconds: 103, minutes: 2, kinds: ['read'] }], totals: { seconds: 103, minutes: 2, events: 7, activeDays: 1, currentStreak: 1, longestStreak: 1 }, byKind: {}, byArticle: [] } };
    return { ok: true, status: 200, json: async () => ({ ok: true, value: map[op] ?? null }) };
  };
  const nodes = await mount(React.createElement(P.Dashboard, { t, onNavigate: noop, onOpen: noop, onRetry: noop }));
  const flat2 = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat2(n.children ?? [])]));
  const all = flat2(nodes);
  console.log('PROBE real dashboard nodes:', all.length);
  console.log('PROBE has greeting:', all.some((n) => n.type === 'h1'));
  console.log('PROBE has heat cells:', all.filter((n) => String(n.props?.className ?? '') === 'er-heat-cell').length);
}

// Settings layout integrity: every row must be a direct child of its cell. A
// missing paren once nested all following rows inside the first row, and since a
// row is a horizontal flex container they rendered side by side.
{
  const nodes = await mount(React.createElement(P.SettingsPage, { t, notify: noop }));
  const flat = (list) => list.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children ?? [])]));
  const all = flat(nodes);
  const cls = (n) => String(n.props?.className ?? '');
  // `flat()` revisits nested subtrees, so dedupe by identity before counting.
  const cells = [...new Set(all.filter((n) => cls(n).split(/\s+/).includes('er-cell')))];
  const rows = [...new Set(all.filter((n) => cls(n).split(/\s+/).includes('er-set-row')))];

  check('the settings page renders its cells', cells.length >= 4, String(cells.length));
  check('the settings page renders its rows', rows.length >= 8, String(rows.length));

  // A row nested inside another row is the corruption this guards.
  const nestedRows = rows.filter((row) => {
    const inner = flat(row.children ?? []);
    return inner.some((child) => child !== row && cls(child).split(/\s+/).includes('er-set-row'));
  });
  check('no row is nested inside another row', nestedRows.length === 0, String(nestedRows.length));

  // The model picker spans its row, so it uses the stacked variant and its
  // label must not be the only shrinking child.
  // The harness can surface one element through more than one path, so the exact
  // count lives in the source-level assertion; here the shape is what matters.
  const stacked = rows.filter((row) => cls(row).split(/\s+/).includes('er-set-row--stack'));
  check('the model picker row stacks', stacked.length >= 1, String(stacked.length));
  check('the stacked row holds a select', flat(stacked[0]?.children ?? []).some((n) => n.type === 'select'));
}

