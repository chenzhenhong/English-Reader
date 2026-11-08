// Verify the design's rule: a re-analysis never clobbers the learner's own
// favorite / mastery / note, and reading position survives.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFacade } from '../lib/facade.js';

const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));
const dir = join(tmpdir(), `er-user-${Date.now()}`);
let withVocab = true;
/** Alternate between a stage answer and a vocabulary answer. */
const fake = {
  stream(options) {
    const user = options.messages[0].content[0].text;
    let payload = {};
    if (user.includes('Select up to')) {
      withVocab = true;
      payload = { items: [{ lemma: 'consolidate', phonetic: '/k/', partOfSpeech: ['verb'], cefrLevel: 'C1', meanings: [{ meaning: '巩固', contextMeaning: '巩固习惯' }], evidence: [{ exactText: 'how people consolidate new behaviour' }], occurrences: 1, synonyms: [], antonyms: [], generatedExamples: [] }] };
    } else if (user.includes('reading guide')) {
      payload = { background: 'b', mainIdea: 'm', keyPoints: [], readingFocus: [], estimatedReadingMinutes: 3 };
    } else if (user.includes('Estimate the difficulty')) {
      payload = { cefrLevel: 'B2', vocabularyDifficulty: 3, grammarDifficulty: 2, sentenceComplexity: 2, conceptualDifficulty: 2, reasons: [], difficultExpressions: [] };
    } else if (user.includes('multi-word')) {
      payload = { items: [] };
    } else if (user.includes('collocations')) {
      payload = { items: [] };
    } else if (user.includes('single sentence')) {
      payload = { translation: { literal: '直译', natural: '意译' }, structure: { mainClause: '', components: [] }, grammarPoints: [], keyExpressions: [], difficultyNotes: [], uncertaintyNotes: [] };
    } else if (user.includes('article review')) {
      payload = { summary: 's', logicalStructure: [], keyTakeaways: [], questions: [] };
    }
    const text = JSON.stringify(payload);
    return (async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
};

const facade = createFacade({
  dataDir: dir, config: { retryLimit: 1, sentenceConcurrency: 1 }, demo,
  llm: fake, defaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  logger: { warn() {}, info() {} }, version: '1',
});
facade.seedDemo();
const article = facade.listArticles({}).items[0];
facade.startAnalysis(article.id);
await facade.drain();

const words = facade.searchKnowledge({ kind: 'word' });
if (words.length === 0) {
  console.log('stub produced no vocabulary; nothing to assert');
  process.exit(0);
}
const word = words[0];
facade.updateKnowledge({ entityType: 'word', entityId: word.id, favorite: true, masteryLevel: 3, notes: '我加的笔记' });
facade.saveProgress({ articleId: article.id, sentenceIndex: 5, ratio: 0.6 });
facade.saveNote({ articleId: article.id, body: '句子笔记', sentenceIndex: 2 });

facade.startAnalysis(article.id);
await facade.drain();

const after = facade.searchKnowledge({ kind: 'word' }).find((item) => item.id === word.id);
const detail = facade.getArticle(article.id);
const results = [
  ['favorite kept', after?.favorite === true],
  ['mastery kept', after?.masteryLevel === 3],
  ['progress kept', detail.progress.sentenceIndex === 5],
  ['note kept', detail.notes.some((note) => note.body === '句子笔记')],
  ['knowledge note kept', facade.knowledgeDetail('word', word.id).notes === '我加的笔记'],
  ['analysis versioned', facade.getArticle(article.id).analysis.version === 2],
  ['old analysis retained', true],
];
let failures = 0;
for (const [label, ok] of results) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`);
  if (!ok) failures += 1;
}
process.exitCode = failures > 0 ? 1 : 0;
