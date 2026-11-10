/**
 * Prompt composition: a sentence analysis must present the sentence, not the
 * article headline, as the thing to analyse.
 *
 * The headline used to ride along as the <article title=...> attribute while the
 * single sentence was the body. A model could then answer about the headline
 * instead of the sentence, which is exactly the mismatch a learner sees when the
 * stored analysis quotes text that is nowhere in the sentence.
 */
import { buildPrompt } from '../lib/llm.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const sentence = 'In fact, the administration wants to overhaul several billion dollars in homelessness spending.';
const headline = 'Homelessness in the U.S. saw its largest drop in more than a decade last year';

console.log('sentence analysis prompt');
{
  const prompt = buildPrompt('SENTENCE_ANALYSIS', {
    text: sentence,
    sentence,
    context: 'The agency had not yet posted a detailed report. So far that has been blocked by courts.',
    title: headline,
  });
  check('the sentence gets its own tag', prompt.user.includes('<sentence>'), prompt.user.slice(0, 160));
  check('the sentence is inside the tag', /<sentence>\n\s*In fact, the administration/.test(prompt.user), prompt.user.slice(0, 200));
  check('the headline is not wrapped as the article', !/<article title=/.test(prompt.user), prompt.user.slice(0, 200));
  check('the headline is labelled context-only', /Article title \(context only, never analyse it\): Homelessness/.test(prompt.user));
  check('the neighbours it is told to use are supplied', /Neighbouring sentences \(context only, never analyse them\):/.test(prompt.user));
  check('the neighbours carry their text', prompt.user.includes('blocked by courts'));
  check('the analysis instruction follows the context', /Analyse this single sentence/.test(prompt.user));
  check('the stage instruction names the sentence, not the headline', prompt.user.indexOf('<sentence>') < prompt.user.indexOf(headline));
}

console.log('\narticle-level stages keep the article wrapper');
{
  const prompt = buildPrompt('OVERVIEW', { text: 'Some body text.', title: headline });
  check('the article tag carries the title', prompt.user.includes(`<article title=${JSON.stringify(headline)}>`), prompt.user.slice(0, 160));
  check('the body is inside the article tag', /<article title=.*>\nSome body text\.\n<\/article>/.test(prompt.user), prompt.user.slice(0, 200));
  check('no sentence tag leaks into article stages', !/<sentence>/.test(prompt.user));
}

console.log('\na sentence analysis without a title or neighbours');
{
  const prompt = buildPrompt('SENTENCE_ANALYSIS', { text: sentence, sentence });
  check('it still wraps the sentence', /<sentence>\n\s*In fact/.test(prompt.user), prompt.user.slice(0, 200));
  check('it omits the neighbour block', !/Neighbouring sentences/.test(prompt.user));
  check('it omits the title block', !/Article title/.test(prompt.user));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
