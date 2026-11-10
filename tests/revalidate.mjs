/**
 * Revalidation checks: a stored analysis is re-examined against the article so
 * historical rows get a verdict from evidence, not from a stale flag.
 *
 * Background: an earlier build marked a sentence `needs_review` whenever the
 * model declared uncertainty, so sentences whose quotes all matched were
 * labelled as needing review. Migration must not guess which rows were
 * mislabelled; this audited pass re-reads the evidence instead.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createFacade } from '../lib/facade.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));
const dir = join(tmpdir(), `er-revalidate-${Date.now()}`);
const facade = createFacade({
  dataDir: dir, config: {}, demo,
  logger: { warn() {}, info() {} }, version: '1',
});
facade.seedDemo();
const article = facade.listArticles({}).items[0];
const body = facade.getArticle(article.id).body;

// Seed a version-1 analysis with three hand-written sentence rows:
// 1) quotes resolve + declared uncertainty  → must be `done`
// 2) quotes resolve, no uncertainty         → stays `done`
// 3) one quote does not resolve             → must be `needs_review`
const db = new DatabaseSync(join(dir, 'database', 'english-reader.sqlite'));
const { randomUUID } = await import('node:crypto');
const analysisId = `ana_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
db.prepare('INSERT INTO article_analyses (id, article_id, version, status, created_at) VALUES (?, ?, 1, ?, ?)')
  .run(analysisId, article.id, 'PARTIAL_COMPLETED', new Date().toISOString());
db.prepare('INSERT INTO analysis_tasks (id, analysis_id, stage, status, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run(`tsk_${randomUUID()}`, analysisId, 'SENTENCE_ANALYSIS', 'SUCCEEDED', new Date().toISOString());

const goodQuote = body.split(/\s+/).slice(0, 4).join(' ');
function makeAnalysis(quote, notes) {
  return JSON.stringify({
    translation: { literal: '直译', natural: '意译' },
    structure: { mainClause: quote, components: [{ type: '主语', text: quote, explanation: '' }] },
    grammarPoints: [{ title: '点', explanation: '说明', evidence: quote }],
    keyExpressions: [{ expression: quote, meaning: '意思', explanation: '' }],
    difficultyNotes: [],
    uncertaintyNotes: notes,
  });
}

const rows = [
  { quote: goodQuote, notes: ['这里是模型主动说明的不确定性。'], label: 'uncertainty only' },
  { quote: goodQuote, notes: [], label: 'plain success' },
  { quote: 'a phrase that is not in the article at all', notes: [], label: 'invented quote' },
];
for (const [index, row] of rows.entries()) {
  const sentenceId = `snt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.prepare('INSERT INTO sentences (id, normalized_hash, content, created_at) VALUES (?, ?, ?, ?)')
    .run(sentenceId, `h${index}${randomUUID().slice(0, 8)}`, `fixture sentence ${index}`, new Date().toISOString());
  db.prepare(`INSERT INTO article_sentences (id, article_id, sentence_id, paragraph_index, sentence_index,
    start_offset, end_offset, analysis_json, analysis_status, attempts) VALUES (?, ?, ?, 0, ?, 0, 10, ?, 'needs_review', 1)`)
    .run(`as_${randomUUID()}`, article.id, sentenceId, index, makeAnalysis(row.quote, row.notes));
}
db.close();

const result = facade.revalidateSentences(article.id);
check('checks every analysed sentence', result.checked === 3, String(result.checked));
check('clears the ones whose evidence holds', result.cleared === 2, String(result.cleared));
check('keeps the invented quote flagged', result.flagged === 0, String(result.flagged));

const detail = facade.getArticle(article.id);
const statuses = detail.sentences.map((item) => item.analysisStatus);
check('uncertainty-only sentence is now done', statuses[0] === 'done', statuses[0]);
check('plain success stays done', statuses[1] === 'done', statuses[1]);
check('invented quote stays needs_review', statuses[2] === 'needs_review', statuses[2]);
check('declared uncertainty is not lost', JSON.parse(detail.sentences[0].analysis.uncertaintyNotes.length ? '{"n":1}' : '{"n":0}').n === 1);

const stage = detail.tasks.find((task) => task.stage === 'SENTENCE_ANALYSIS');
check('stage reflects the audited rows', stage?.status === 'FAILED' || stage?.status === 'SUCCEEDED', stage?.status);

// The detail dialog needs to say *which* quotes failed, so the sentence payload
// carries them instead of leaving the client to re-derive the evidence check.
const flagged = detail.sentences.find((item) => item.analysisStatus === 'needs_review');
check('the flagged sentence carries its missing quotes',
  flagged?.review?.missing?.includes('a phrase that is not in the article at all'),
  JSON.stringify(flagged?.review));
check('a done sentence carries no review detail',
  detail.sentences.filter((item) => item.analysisStatus === 'done').every((item) => item.review === null));

// Idempotent: a second pass changes nothing.
const again = facade.revalidateSentences(article.id);
check('second pass changes nothing', again.cleared === 0 && again.flagged === 0, JSON.stringify(again));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
