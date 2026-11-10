/**
 * Opt-in knowledge library.
 *
 * Parsing an article produces *candidates*: rows in `vocabulary`, `phrases`,
 * `collocations`, `sentences`, plus the link tables. None of that is the
 * library. The library is `user_knowledge`, and a row appears there only when
 * the learner adds the entity from the reader.
 *
 * These checks pin that contract at the data layer, so no future change can
 * quietly make the library self-populating again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

/** A facade with demo articles and one analysed sentence to add. */
function makeFacade() {
  const dir = join(tmpdir(), `er-optin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const facade = createFacade({
    dataDir: dir, config: {}, demo, logger: { warn() {}, info() {} }, version: '1',
  });
  facade.seedDemo();
  const articleId = facade.listArticles({ limit: 1 }).items[0].id;

  // Insert candidates the way the analyse pipeline would, so this suite tests
  // "parsed but not added" rather than an empty database.
  const db = new DatabaseSync(join(dir, 'database', 'english-reader.sqlite'));
  const stamp = new Date().toISOString();
  // Column names differ per table (`normalized_key` vs `normalized_hash`), and
  // the cache tables require an updated_at.
  const candidates = [
    { table: 'vocabulary', id: 'voc_t1', extra: { lemma: 'habit', normalized_key: 'h1' }, updated: true },
    { table: 'phrases', id: 'phr_t1', extra: { expression: 'lead to', normalized_key: 'h2' }, updated: true },
    { table: 'collocations', id: 'col_t1', extra: { expression: 'big changes', normalized_key: 'h3' }, updated: true },
    { table: 'sentences', id: 'sen_t1', extra: { content: 'Small habits lead to big changes.', normalized_hash: 'h4' }, updated: false },
  ];
  for (const candidate of candidates) {
    const cols = ['id', 'created_at', ...Object.keys(candidate.extra)];
    const values = [candidate.id, stamp, ...Object.values(candidate.extra)];
    if (candidate.updated) { cols.push('updated_at'); values.push(stamp); }
    db.prepare(`INSERT INTO ${candidate.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values);
  }
  db.prepare(`INSERT INTO article_words (id, article_id, vocabulary_id, context_meaning, occurrences)
    VALUES (?, ?, ?, ?, ?)`).run('aw_t1', articleId, 'voc_t1', '习惯', 2);
  db.prepare(`INSERT INTO article_phrases (id, article_id, phrase_id) VALUES (?, ?, ?)`).run('ap_t1', articleId, 'phr_t1');
  db.prepare(`INSERT INTO article_collocations (id, article_id, collocation_id) VALUES (?, ?, ?)`).run('ac_t1', articleId, 'col_t1');
  db.prepare(`INSERT INTO article_sentences (id, article_id, sentence_id, paragraph_index, sentence_index,
    start_offset, end_offset, analysis_status, analysis_json, attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'as_t1', articleId, 'sen_t1', 0, 0, 0, 32, 'succeeded',
    JSON.stringify({ translation: { literal: 'a', natural: 'b' } }), 1,
  );
  db.close();
  return { facade, articleId };
}

console.log('the library starts empty even after parsing');
{
  const { facade, articleId } = makeFacade();
  for (const kind of ['word', 'phrase', 'collocation', 'sentence']) {
    check(`${kind}: nothing is listed before adding`, facade.searchKnowledge({ kind, limit: 200 }).length === 0,
      String(facade.searchKnowledge({ kind, limit: 200 }).length));
  }
  const detail = facade.getArticle(articleId);
  check('the parsed word is still offered to the reader', detail.words.length >= 1, String(detail.words.length));
  check('the word reports it is not in the library', detail.words.every((word) => word.favorite !== true));
  check('the sentence reports it is not in the library',
    detail.sentences.every((sentence) => sentence.inLibrary !== true));
  check('the review queue is empty', facade.reviewQueue().items.length === 0);
}

console.log('\nadding one entity puts exactly that entity in the library');
{
  const { facade, articleId } = makeFacade();
  facade.updateKnowledge({ entityType: 'word', entityId: 'voc_t1', favorite: true });
  check('the word is now listed', facade.searchKnowledge({ kind: 'word', limit: 200 }).length === 1,
    String(facade.searchKnowledge({ kind: 'word', limit: 200 }).length));
  check('the phrase is still absent', facade.searchKnowledge({ kind: 'phrase', limit: 200 }).length === 0);
  check('the collocation is still absent', facade.searchKnowledge({ kind: 'collocation', limit: 200 }).length === 0);

  const detail = facade.getArticle(articleId);
  check('the reader now marks the word as saved',
    detail.words.find((word) => word.id === 'voc_t1')?.favorite === true);

  facade.updateKnowledge({ entityType: 'sentence', entityId: 'sen_t1', favorite: true });
  const afterSentence = facade.getArticle(articleId);
  check('the reader now marks the sentence as saved',
    afterSentence.sentences.find((sentence) => sentence.id === 'sen_t1')?.inLibrary === true);
  check('the sentence is listed', facade.searchKnowledge({ kind: 'sentence', limit: 200 }).length === 1);
  check('the review queue now offers the added word', facade.reviewQueue().items.length === 1,
    String(facade.reviewQueue().items.length));
}

console.log('\nremoving an entity takes it out of the library');
{
  const { facade } = makeFacade();
  facade.updateKnowledge({ entityType: 'phrase', entityId: 'phr_t1', favorite: true });
  check('the phrase is listed after adding', facade.searchKnowledge({ kind: 'phrase', limit: 200 }).length === 1);
  facade.updateKnowledge({ entityType: 'phrase', entityId: 'phr_t1', favorite: false });
  // `favorite: false` still writes a row; library membership is what the join
  // reads, so a removal must delete the row rather than leave it at 0.
  const listed = facade.searchKnowledge({ kind: 'phrase', limit: 200 }).length;
  check('a removed phrase leaves the library', listed === 0, String(listed));
}

console.log('\ndeleting an entity removes the library row directly');
{
  const { facade, articleId } = makeFacade();
  const ids = { word: 'voc_t1', phrase: 'phr_t1', collocation: 'col_t1', sentence: 'sen_t1' };
  for (const [kind, id] of Object.entries(ids)) {
    facade.updateKnowledge({ entityType: kind, entityId: id, favorite: true });
  }
  for (const kind of Object.keys(ids)) {
    check(`${kind} is listed before deletion`, facade.searchKnowledge({ kind, limit: 200 }).length === 1);
  }

  const result = facade.deleteKnowledge({ entityType: 'word', entityId: 'voc_t1' });
  check('deleteKnowledge reports the removal', result.deleted === true && result.removed === 1, JSON.stringify(result));
  check('the word leaves the library', facade.searchKnowledge({ kind: 'word', limit: 200 }).length === 0);
  check('the reader no longer marks the word saved',
    facade.getArticle(articleId).words.find((word) => word.id === 'voc_t1')?.favorite !== true);

  // The underlying record belongs to the article and must survive.
  const db = new DatabaseSync(join(join(facade.dirs.root, 'database'), 'english-reader.sqlite'));
  check('the vocabulary record survives the library delete',
    db.prepare('SELECT COUNT(*) AS n FROM vocabulary WHERE id = ?').get('voc_t1').n === 1);
  db.close();

  facade.deleteKnowledge({ entityType: 'phrase', entityId: 'phr_t1' });
  facade.deleteKnowledge({ entityType: 'collocation', entityId: 'col_t1' });
  facade.deleteKnowledge({ entityType: 'sentence', entityId: 'sen_t1' });
  for (const kind of Object.keys(ids)) {
    check(`${kind} leaves the library after deletion`, facade.searchKnowledge({ kind, limit: 200 }).length === 0);
  }
  const missing = facade.deleteKnowledge({ entityType: 'word', entityId: 'voc_t1' });
  check('deleting an already-removed entity is a no-op', missing.deleted === true && missing.removed === 0, JSON.stringify(missing));
  // `deleteKnowledge` throws synchronously, so the refusal is caught directly.
  let unknown = null;
  try { facade.deleteKnowledge({ entityType: 'nope', entityId: 'x' }); } catch (error) { unknown = error; }
  check('an unknown kind is refused', unknown?.code === 'SCHEMA_VALIDATION_FAILED', unknown?.code);
}

console.log('\nthe queries use inner joins');
{
  const source = readFileSync(new URL('../lib/facade.js', import.meta.url), 'utf8');
  // The library readers must not left-join, or candidates would reappear.
  const readers = [
    /FROM vocabulary v JOIN user_knowledge k ON k\.entity_type = 'word'/,
    /FROM sentences s JOIN user_knowledge k ON k\.entity_type = 'sentence'/,
    /FROM \$\{table\} p JOIN user_knowledge k/,
  ];
  for (const pattern of readers) {
    check(`library query uses an inner join (${pattern.source.slice(0, 34)}…)`, pattern.test(source));
  }
  check('the review queue uses an inner join',
    /FROM vocabulary v JOIN user_knowledge k[\s\S]{0,120}WHERE k\.mastery_level < 3/.test(source));
}

console.log('\nthe reader exposes an add control');
{
  const reader = readFileSync(new URL('../src/80-reader.js', import.meta.url), 'utf8');
  check('a shared add control exists', reader.includes('function LibraryToggle'));
  check('word cards offer it', /LibraryToggle[\s\S]{0,120}'word'/.test(reader));
  check('phrase rows offer it', /LibraryToggle[\s\S]{0,120}'phrase'/.test(reader));
  check('collocation rows offer it', /LibraryToggle[\s\S]{0,120}'collocation'/.test(reader));
  check('the sentence pane offers it', reader.includes('onAddToLibrary'));

  const detail = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  check('the reader page writes through updateKnowledge', detail.includes("call('updateKnowledge'"));
  check('the sentence handler is wired', /onAddToLibrary: \(sentence, next\) => setInLibrary\('sentence'/.test(detail));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
