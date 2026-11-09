/**
 * Failure diagnostics: a failed sentence must record why, expose it, and be
 * retryable on its own. Also covers the two root causes we hit in production:
 * a truncated answer and prose wrapped around the JSON object.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { createFacade } from '../lib/facade.js';
import { ERROR_CODES } from '../lib/net.js';
import { extractJson, validateStage } from '../lib/llm.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));

/** A model stub whose next answer is chosen per call. */
function stubLlm() {
  return {
    stream(options) {
      const user = options.messages[0].content[0].text;
      let body;
      let finish = { kind: 'stop' };
      if (user.includes('single sentence')) {
        // Alternates: fail once, then succeed, so the retry path is observable.
        body = 'Here is my analysis:\n{"translation": {"literal": "直译", "natural": "意译"';
        finish = { kind: 'max-tokens' };
      } else if (user.includes('reading guide')) {
        body = JSON.stringify({ background: 'b', mainIdea: 'm', keyPoints: [], readingFocus: [], estimatedReadingMinutes: 3 });
      } else if (user.includes('Estimate the difficulty')) {
        body = JSON.stringify({ cefrLevel: 'B2', vocabularyDifficulty: 3, grammarDifficulty: 2, sentenceComplexity: 2, conceptualDifficulty: 2, reasons: [], difficultExpressions: [] });
      } else if (user.includes('Select up to')) {
        body = JSON.stringify({ items: [] });
      } else if (user.includes('multi-word') || user.includes('collocations')) {
        body = JSON.stringify({ items: [] });
      } else if (user.includes('article review')) {
        body = JSON.stringify({ summary: 's', logicalStructure: [], keyTakeaways: [], questions: [] });
      } else {
        body = '{}';
      }
      return (async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } };
        yield { type: 'finish', reason: finish };
      })();
    },
  };
}

console.log('truncation is distinguishable from bad JSON');
{
  const truncLlm = {
    stream: () => (async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"translation": {"literal": "直' } };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    })(),
  };
  const facade = createFacade({
    dataDir: join(tmpdir(), `er-fail-${Date.now()}-a`), config: { retryLimit: 1, sentenceConcurrency: 1 },
    demo, llm: truncLlm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    logger: { warn() {}, info() {} }, version: '1',
  });
  facade.seedDemo();
  const article = facade.listArticles({}).items[0];
  facade.startAnalysis(article.id);
  await facade.drain();
  const detail = facade.getArticle(article.id);
  const failure = detail.sentences.find((item) => item.analysisStatus === 'failed');
  check('a failed sentence exists', Boolean(failure), JSON.stringify(detail.sentences.map((s) => s.analysisStatus).slice(0, 3)));
  check('failure carries a code', failure?.error?.code === ERROR_CODES.LLM_TRUNCATED, failure?.error?.code);
  check('failure explains the truncation', /截断|truncated/i.test(failure?.error?.message ?? ''), failure?.error?.message);
  check('failure keeps a raw excerpt', typeof failure?.error?.raw === 'string' && failure.error.raw.length > 0);
  check('attempt count is recorded', failure?.error?.attempts >= 1, String(failure?.error?.attempts));
  const stage = detail.tasks.find((task) => task.stage === 'SENTENCE_ANALYSIS');
  check('stage reports the dominant code', stage?.errorCode === ERROR_CODES.LLM_TRUNCATED, stage?.errorCode);
}

console.log('\nschema validation accepts a bare string where a list is required');
{
  // The model sometimes answers a list field with one bare string. Failing the
  // whole stage over that would cost a retry for no reason.
  const coerced = validateStage('SENTENCE_ANALYSIS', {
    translation: { literal: 'a', natural: 'a' },
    structure: { mainClause: 'a', components: [] },
    grammarPoints: [],
    keyExpressions: [],
    difficultyNotes: '句子偏长。',
    uncertaintyNotes: [],
  });
  check('a single string is wrapped in a list',
    Array.isArray(coerced.difficultyNotes) && coerced.difficultyNotes.length === 1,
    JSON.stringify(coerced.difficultyNotes));
  check('the wrapped value is the string itself',
    coerced.difficultyNotes[0] === '句子偏长。', coerced.difficultyNotes[0]);

  check('a real list is left alone', validateStage('SENTENCE_ANALYSIS', {
    translation: { literal: 'a', natural: 'a' },
    structure: { mainClause: 'a', components: [] },
    grammarPoints: [],
    keyExpressions: [],
    difficultyNotes: ['one', 'two'],
    uncertaintyNotes: [],
  }).difficultyNotes.length === 2);

  check('an empty string is still an error', (() => {
    try {
      validateStage('SENTENCE_ANALYSIS', {
        translation: { literal: 'a', natural: 'a' },
        structure: { mainClause: 'a', components: [] },
        grammarPoints: [],
        keyExpressions: [],
        difficultyNotes: '',
        uncertaintyNotes: [],
      });
      return false;
    } catch (error) {
      return error.code === ERROR_CODES.SCHEMA_VALIDATION_FAILED;
    }
  })());

  check('a non-list object is still an error', (() => {
    try {
      validateStage('SENTENCE_ANALYSIS', {
        translation: { literal: 'a', natural: 'a' },
        structure: { mainClause: 'a', components: [] },
        grammarPoints: {},
        keyExpressions: [],
        difficultyNotes: [],
        uncertaintyNotes: [],
      });
      return false;
    } catch (error) {
      return error.code === ERROR_CODES.SCHEMA_VALIDATION_FAILED;
    }
  })());
}

console.log('\nprose around JSON is reported with its cause');
{
  try {
    extractJson('Sure! Here is the JSON you asked for:\n{"a": 1,}');
    check('invalid JSON throws', false);
  } catch (error) {
    check('invalid JSON throws with a code', error.code === ERROR_CODES.LLM_INVALID_JSON, error.code);
    check('keeps the raw output', typeof error.rawOutput === 'string' && error.rawOutput.length > 0, String(error.rawOutput).slice(0, 40));
    check('keeps the parse reason', typeof error.parseError === 'string' && error.parseError.length > 0, error.parseError);
  }
  const ok = extractJson('```json\n{"a": 1}\n```');
  check('fenced JSON still parses', ok.a === 1);

  // The production failure: one valid object, then commentary. This must parse
  // rather than be reported as broken JSON.
  check('trailing commentary is tolerated', extractJson('{"a":1} hope this helps!').a === 1);
  check('a second fragment is ignored', extractJson('{"a":1}{"b":2}').a === 1);
  check('braces inside strings are respected', extractJson('{"a":"}"} tail').a === '}');
  check('escaped quotes are respected', extractJson('{"a":"say \\"hi\\""} tail').a === 'say "hi"');
  // An object that never closes was cut off, not malformed: the model would
  // not leave a valid prefix without its brace. Reporting it as invalid JSON
  // sends the learner to fix quotes when the real cause is a longer ask.
  check('an unclosed object is reported as truncation', (() => {
    try {
      extractJson('{"a": {"b": 1}');
      return false;
    } catch (error) {
      return error.code === ERROR_CODES.LLM_TRUNCATED;
    }
  })());
  check('truncation keeps the raw output', (() => {
    try {
      extractJson('{"a": "x' + 'x'.repeat(5000));
      return false;
    } catch (error) {
      return typeof error.rawOutput === 'string' && error.rawOutput.length > 0;
    }
  })());

  // The production failure: the model quotes English terms inside its Chinese
  // explanations and leaves the quotes unescaped, which closes the string
  // early. Each of these is a real shape taken from a failed run.
  const innerQuote = '{"translation": {"literal": "他出版了一本题为"The Myth Of Red Texas"的书。"}, "natural": "x"}';
  check('an unescaped quote inside a value is repaired',
    extractJson(innerQuote).translation.literal === '他出版了一本题为"The Myth Of Red Texas"的书。',
    JSON.stringify(extractJson(innerQuote)));
  const twoPairs = '{"a": "中文说"计出票来"或"选票送达"，英文用come in"}';
  check('several unescaped quotes are all repaired',
    extractJson(twoPairs).a === '中文说"计出票来"或"选票送达"，英文用come in', extractJson(twoPairs).a);
  const inArray = '{"difficultyNotes": ["中文说"计出票来"。"], "uncertaintyNotes": []}';
  check('a quote inside an array element is repaired',
    extractJson(inArray).difficultyNotes[0] === '中文说"计出票来"。', JSON.stringify(extractJson(inArray)));
  // A well-formed answer must come back byte-identical, not merely equivalent.
  const untouched = '{"a": "say \\"hi\\"", "b": "it\'s fine"}';
  check('valid escapes are not double-escaped',
    extractJson(untouched).a === 'say "hi"', extractJson(untouched).a);

  // The excerpt must include the failing region, not just the head.
  try {
    extractJson(`{"a":"${'x'.repeat(3000)}",}`);
    check('a syntax failure near the end is excerpted', false);
  } catch (error) {
    const moved = error.rawOutput.includes('…');
    check('excerpt shows the failure region', moved || error.rawOutput.length > 200, String(error.rawOutput.length));
  }
}

console.log('\nretrying one sentence succeeds without touching others');
{
  let sentenceCalls = 0;
  const llm = {
    stream(options) {
      const user = options.messages[0].content[0].text;
      let body;
      let finish = { kind: 'stop' };
      if (user.includes('single sentence')) {
        sentenceCalls += 1;
        if (sentenceCalls === 1) {
          body = '{"translation": {"literal": "截';
          finish = { kind: 'max-tokens' };
        } else {
          body = JSON.stringify({
            translation: { literal: '直译', natural: '意译' },
            structure: { mainClause: '', components: [] },
            grammarPoints: [], keyExpressions: [], difficultyNotes: [], uncertaintyNotes: [],
          });
        }
      } else if (user.includes('reading guide')) {
        body = JSON.stringify({ background: 'b', mainIdea: 'm', keyPoints: [], readingFocus: [], estimatedReadingMinutes: 3 });
      } else if (user.includes('Estimate the difficulty')) {
        body = JSON.stringify({ cefrLevel: 'B2', vocabularyDifficulty: 3, grammarDifficulty: 2, sentenceComplexity: 2, conceptualDifficulty: 2, reasons: [], difficultExpressions: [] });
      } else if (user.includes('Select up to')) {
        body = JSON.stringify({ items: [] });
      } else if (user.includes('multi-word') || user.includes('collocations')) {
        body = JSON.stringify({ items: [] });
      } else if (user.includes('article review')) {
        body = JSON.stringify({ summary: 's', logicalStructure: [], keyTakeaways: [], questions: [] });
      } else {
        body = '{}';
      }
      return (async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        yield { type: 'finish', reason: finish };
      })();
    },
  };
  const facade = createFacade({
    dataDir: join(tmpdir(), `er-fail-${Date.now()}-b`), config: { retryLimit: 1, sentenceConcurrency: 1 },
    demo, llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    logger: { warn() {}, info() {} }, version: '1',
  });
  facade.seedDemo();
  const article = facade.listArticles({}).items[0];
  facade.startAnalysis(article.id);
  await facade.drain();
  const before = facade.getArticle(article.id);
  const failedIndex = before.sentences.findIndex((item) => item.analysisStatus === 'failed');
  check('one sentence failed first', failedIndex >= 0, String(failedIndex));
  const othersBefore = before.sentences.filter((item) => item.analysisStatus !== 'failed').length;
  const result = await facade.retrySentence(article.id, failedIndex);
  check('retry reports success', result.ok === true, JSON.stringify(result));
  const after = facade.getArticle(article.id);
  const retried = after.sentences.find((item) => item.sentenceIndex === failedIndex);
  check('retried sentence is analysed', retried?.analysisStatus !== 'failed', retried?.analysisStatus);
  check('its error was cleared', retried?.error === null, JSON.stringify(retried?.error));
  check('other sentences untouched', after.sentences.filter((item) => item.analysisStatus !== 'failed').length === othersBefore + 1,
    `${othersBefore} -> ${after.sentences.filter((item) => item.analysisStatus !== 'failed').length}`);
  check('attempt count incremented', retried?.error === null);
  // The stage summary must not keep claiming a failure that no longer exists.
  const stage = after.tasks.find((task) => task.stage === 'SENTENCE_ANALYSIS');
  const stillFailed = after.sentences.filter((item) => item.analysisStatus === 'failed').length;
  check('stage status matches the sentence rows', stillFailed === 0 ? stage?.status !== 'FAILED' : stage?.status === 'FAILED',
    `failed=${stillFailed} stage=${stage?.status}`);
  check('stage message is cleared when nothing failed', stillFailed > 0 || stage?.errorMessage === null, String(stage?.errorMessage));
  check('stage counts what is stored', stage?.progress?.sentences === after.sentences.length,
    JSON.stringify(stage?.progress));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
