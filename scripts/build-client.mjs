/**
 * Build the browser artifact.
 *
 * The Harness client loader expects one `window.__ModuleLoader__.load({ id,
 * factory })` registration per package. The plugin is authored as small plain
 * JavaScript modules (no JSX, no TypeScript) that share one factory scope,
 * which keeps the bundle dependency-free and readable.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, '..', 'src');
const outFile = join(root, '..', 'lib', 'client.js');

const order = readdirSync(srcDir)
  .filter((name) => name.endsWith('.js'))
  .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));

/** Drop `export { … };` statements: the factory shares one scope. */
function stripExports(source) {
  return source.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
}

const pieces = order.map((name) => `// ---- src/${name} ----\n${stripExports(readFileSync(join(srcDir, name), 'utf8'))}`);

const debugExports = readdirSync(join(root, '..'))
  .filter((name) => name === '.debug-exports')
  .length > 0
  ? '/** Test-only exports; enabled by an empty .debug-exports marker file. */\nconst __debugExports = { speakText, speakSentence, stopSpeech, speechPrefs, saveSpeechPrefs, EnglishReaderApp, Dashboard, Discover, Articles, ArticleDetail, KnowledgePage, KnowledgeDetail, KnowledgeCard, ReviewPage, SettingsPage, wordIndex, paragraphBlocks, SentenceFailure, SentencePane, ArticleBody, WordCard, SentenceText, DictionaryCard, DictionaryPopup, stageCounter, AnalysisProgress, StageDetailDialog, Board, Cell, SPANS, StudyHistoryPage, buildWeeks, dayKey, duration, ActivityFeed, Band, isAnalysisRunning };\n'
  : '';

const registration = `
// ------------------------------------------------------------------ panel
const NS = 'englishReader';

/** Sidebar glyph: the reader's own mark, sized by the owner. */
function EnglishReaderPanelIcon({ size }) {
  return h('span', {
    style: { display: 'grid', placeItems: 'center', width: size, height: size },
  }, h(BrandMark, { size }));
}

/**
 * Main-panel entry. The owner passes the locale-bound translate function as props.t.
 */
function EnglishReaderPanel(props) {
  return h('div', { style: { height: '100%', minHeight: 0 } },
    h('style', null, CSS),
    h(EnglishReaderApp, { t: props.t }));
}

const plugin = {
  // 'remote.session' carries the model catalog the Harness picker reads, and
  // 'sessions' the live Session projection with the current model choice.
  inject: ['slots', 'locale', 'remote.session', 'sessions'],
  apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'english-reader: dictionaries');
    // The settings page names the model the current session runs on; that value
    // only exists in the browser's Session projection, so the context is kept.
    setClientContext(ctx);
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => ctx.locale.bind(NS)('panel'),
      locale: NS,
    }, EnglishReaderPanelIcon));
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
    }, EnglishReaderPanel));
  },
};

${debugExports}
${debugExports === '' ? '' : 'plugin.__test = __debugExports;'}
return plugin;
`;

const bundle = `window.__ModuleLoader__.load({
  id: 'english-reader',
  factory(require) {
    const React = require('react');
${pieces.join('\n')}
${registration}
  },
});
`;

writeFileSync(outFile, bundle, 'utf8');
console.log(`wrote ${outFile} (${bundle.length} bytes, ${order.length} sources)`);
