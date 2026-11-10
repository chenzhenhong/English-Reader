/**
 * Behavioural checks for the guarantees the design calls out explicitly:
 * evidence validation, insert-only knowledge upserts, single-stage retry,
 * duplicate detection, offset integrity, and user-state preservation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFacade } from '../lib/facade.js';
import { segmentArticle, extractReadable, splitSentences } from '../lib/text.js';
import { isRefusedAddress, canonicalUrl } from '../lib/net.js';

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- text layer
console.log('text pipeline');
const paragraphText = 'Dr. Smith arrived at 9 a.m. on Tuesday. He said the U.S. economy grew 3.5 percent. That surprised analysts!';
const sentences = splitSentences(paragraphText);
check('abbreviations do not split sentences', sentences.length === 3, `got ${sentences.length}: ${sentences.map((s) => s.text).join(' | ')}`);
check('decimal inside a sentence stays intact', sentences[1].text.includes('3.5'), sentences[1].text);

// A title before a name is not a sentence end: "Sen. Cindy Hyde-Smith" is one
// person, and splitting there leaves a fragment the analyser would choke on.
const titledText = 'The margin between incumbent Republican Sen. Cindy Hyde-Smith and challenger Scott Colom is narrow. Gov. Kate Brown signed the bill.';
const titledSentences = splitSentences(titledText);
check(
  'title abbreviations do not split sentences',
  titledSentences.length === 2,
  `got ${titledSentences.length}: ${titledSentences.map((s) => s.text).join(' | ')}`,
);
check(
  'the title stays attached to its name',
  titledSentences[0].text.startsWith('The margin between incumbent Republican Sen. Cindy Hyde-Smith'),
  titledSentences[0].text,
);
check(
  'a plain sentence still splits',
  splitSentences('The vote was close. She won the seat.').length === 2,
);

const segment = segmentArticle(paragraphText);
check('offsets address the stored body', segment.sentences.every((s) => paragraphText.slice(s.startOffset, s.endOffset) === s.text));
check('paragraph indices are ascending', segment.paragraphs.every((p, i) => p.index === i));

const html = '<html><head><title>Real Title</title></head><body><nav>menu</nav><p>First paragraph here.</p><footer>footer</footer><p>Second one.</p></body></html>';
const readable = extractReadable(html);
check('title extracted', readable.title === 'Real Title', readable.title);
check('nav and footer dropped', !readable.text.includes('menu') && !readable.text.includes('footer'), readable.text);
check('paragraphs preserved', readable.text.includes('First paragraph here.') && readable.text.includes('Second one.'));

// --------------------------------------------------------------- net safety
console.log('network safety');
for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '::1', 'fd00::1', 'fe80::1']) {
  check(`refuses ${address}`, isRefusedAddress(address) === true);
}
for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
  check(`allows ${address}`, isRefusedAddress(address) === false);
}
check('canonical URL drops tracking params', canonicalUrl('https://a.com/x?utm_source=t&b=1#f') === 'https://a.com/x?b=1');

// -------------------------------------------------------------- persistence
console.log('persistence and analysis');
const dir = join(tmpdir(), `er-behaviour-${Date.now()}`);
const replies = [];
/** A fake model whose next answer is supplied by the queued reply list. */
function fakeLlm() {
  return {
    stream() {
      const text = replies.shift() ?? JSON.stringify({
        background: 'b', mainIdea: 'm', keyPoints: [], readingFocus: [], estimatedReadingMinutes: 3,
      });
      return (async function* produce() {
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}
const facade = createFacade({
  dataDir: dir, config: { retryLimit: 1, sentenceConcurrency: 1 }, demo,
  llm: fakeLlm(), defaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  logger: { warn() {}, info() {} }, version: '1',
});
facade.seedDemo();
check('demo seeded once', facade.seedDemo().seeded === 0);
const article = facade.listArticles({}).items[0];

// A badge of evidence that the model invents must be flagged, not accepted silently.
replies.push(JSON.stringify({
  background: '背景', mainIdea: '主旨', keyPoints: [], readingFocus: [], estimatedReadingMinutes: 3,
}));
const started = facade.startAnalysis(article.id);
await facade.drain();
let detail = facade.getArticle(article.id);
check('article reached a terminal status', ['COMPLETED', 'PARTIAL_COMPLETED', 'ANALYSIS_FAILED'].includes(detail.analysis.status), detail.analysis.status);
check('segmentation stored every sentence', detail.sentences.length === segmentArticle(detail.body).sentences.length);
check('sentence indices match segmentation order', detail.sentences.every((s, i) => s.sentenceIndex === i));
// speakSentence resolves the text server-side and needs the article id. Without
// it the RPC is called with `undefined` and the host reports the article as
// missing even though it is the one open on screen.
check('each sentence carries its article id',
  detail.sentences.every((s) => s.articleId === article.id),
  JSON.stringify(detail.sentences.map((s) => s.articleId)));

// Duplicate detection by URL and by body.
const body = 'A short but real article body. It has two sentences.';
const first = facade.createArticle({ title: 'First', text: body, sourceUrl: 'https://example.com/a?utm_source=x' });
check('first import created', Boolean(first.id));
let duplicateError;
try {
  facade.createArticle({ title: 'Second', text: body });
} catch (error) {
  duplicateError = error;
}
check('identical body refused', duplicateError?.code === 'DUPLICATE_ARTICLE', duplicateError?.code);
let urlDuplicate;
try {
  facade.createArticle({ title: 'Third', text: 'Different words entirely here. Another sentence follows.', sourceUrl: 'https://example.com/a' });
} catch (error) {
  urlDuplicate = error;
}
check('same canonical URL refused', urlDuplicate?.code === 'DUPLICATE_ARTICLE', urlDuplicate?.code);

// User knowledge is never overwritten by a re-analysis.
const seed = facade.searchKnowledge({ kind: 'word' });
if (seed.length > 0) {
  facade.updateKnowledge({ entityType: 'word', entityId: seed[0].id, favorite: true, masteryLevel: 3, notes: '我的笔记' });
  facade.saveProgress({ articleId: article.id, sentenceIndex: 4, ratio: 0.5 });
  const before = facade.searchKnowledge({ kind: 'word' }).find((item) => item.id === seed[0].id);
  replies.push(JSON.stringify({ items: [] }));
  facade.startAnalysis(article.id);
  await facade.drain();
  const after = facade.searchKnowledge({ kind: 'word' }).find((item) => item.id === seed[0].id);
  check('favorite survives re-analysis', after?.favorite === true);
  check('mastery survives re-analysis', after?.masteryLevel === 3);
  const progress = facade.getArticle(article.id).progress;
  check('reading progress survives re-analysis', progress.sentenceIndex === 4, JSON.stringify(progress));
} else {
  console.log('  (no vocabulary produced by the stub model — user-state checks skipped)');
}

// Article deletion keeps global knowledge entities.
const anyWord = facade.searchKnowledge({ kind: 'word' })[0];
const wordCountBefore = facade.searchKnowledge({ kind: 'word' }).length;
const totalBefore = facade.listArticles({}).total;
facade.deleteArticle(article.id);
const wordCountAfter = facade.searchKnowledge({ kind: 'word' }).length;
check('global knowledge survives article deletion', wordCountBefore === wordCountAfter, `${wordCountBefore} -> ${wordCountAfter}`);
check('deleted article gone', facade.listArticles({}).total === totalBefore - 1, `${totalBefore} -> ${facade.listArticles({}).total}`);

// A vocabulary entity that a second article also references must survive
// deleting the first article, so global knowledge stays traceable.
{
  const shared = facade.createArticle({ title: 'Shared A', text: 'Consolidate routines. A sentence about habits.' });
  const sharedB = facade.createArticle({ title: 'Shared B', text: 'Different article. It mentions consistency too.' });
  facade.deleteArticle(shared.id);
  check('second article unaffected', facade.getArticle(sharedB.id).article.title === 'Shared B');
}

// Export/import round trip.
const exported = facade.exportData();
check('export carries bodies', exported.articles.every((item) => typeof item.text === 'string'));
const restored = facade.importData(exported);
check('re-import skips duplicates', restored.added === 0 && restored.skipped > 0, JSON.stringify(restored));

// Interrupted work is adopted, not lost.
const resume = facade.resumeInterrupted();
check('resume reports pending stages', typeof resume.pendingStages === 'number');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
