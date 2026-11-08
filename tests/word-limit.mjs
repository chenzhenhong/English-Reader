/**
 * Word-length policy: unlimited by default, or an explicit range with optional
 * sentence-safe truncation.
 *
 * The distinction that matters: a range either rejects an over-long article or
 * cuts it, and a cut must land on a sentence boundary. Silently shipping half a
 * sentence would make the analyser treat a fragment as a full sentence.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFacade } from '../lib/facade.js';
import { truncateToWords, segmentArticle, countWords } from '../lib/text.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));

function makeFacade() {
  const dir = join(tmpdir(), `er-words-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createFacade({
    dataDir: dir, config: {}, demo, logger: { warn() {}, info() {} }, version: '1',
  });
}

// ---------------------------------------------------------------- truncation
console.log('truncation keeps whole sentences');
{
  const body = [
    'Small habits compound over time in ways that are easy to underestimate.',
    'A tiny change repeated daily becomes a large result eventually.',
    'The mechanism is simply that repetition lowers the activation cost.',
    'Effort drops when the behaviour no longer needs a decision each morning.',
  ].join(' ');
  const total = countWords(body);
  const cut = truncateToWords(body, 20);
  check('an over-long body is truncated', cut.truncated === true);
  check('the result is within budget', cut.words <= 20, String(cut.words));
  check('it keeps at least one sentence', cut.words > 0, String(cut.words));
  check('it drops the tail', cut.droppedSentences > 0, String(cut.droppedSentences));
  check('it ends on a sentence boundary', /[.!?]$/.test(cut.text.trim()), JSON.stringify(cut.text.slice(-30)));

  // Every kept sentence must appear verbatim in the source.
  const sentences = segmentArticle(body).sentences.map((s) => s.text);
  const kept = segmentArticle(cut.text).sentences.map((s) => s.text);
  check('no sentence was cut in half', kept.every((sentence) => sentences.includes(sentence)),
    JSON.stringify(kept));

  const untouched = truncateToWords(body, total + 100);
  check('a body within budget is untouched', untouched.truncated === false);
  check('and keeps its exact text', untouched.text === segmentArticle(body).text);
}

console.log('\ntruncation edge cases');
{
  const one = 'Only one short sentence here.';
  const cut = truncateToWords(one, 2);
  check('it never returns an empty body', cut.words > 0, String(cut.words));
  check('a single over-budget sentence is still kept whole', cut.truncated === true);
  check('empty input is handled', truncateToWords('', 10).words === 0);
}

// ------------------------------------------------------------------- profile
console.log('profile defaults and normalization');
{
  const facade = makeFacade();
  const [profile] = facade.listProfiles();
  check('length is unlimited by default', profile.wordLimitMode === 'unlimited', profile.wordLimitMode);
  // Off while unlimited (it cannot apply), but on the moment a range is used.
  check('truncation is off under unlimited', profile.truncate === false);
  check('the range keeps sensible defaults', profile.minWords === 800 && profile.maxWords === 1500,
    `${profile.minWords}-${profile.maxWords}`);

  const save = (patch) => {
    facade.saveProfile({
      id: profile.id, name: profile.name, levelRange: profile.levelRange,
      sourceIds: profile.sourceIds, types: profile.types, ...patch,
    });
    return facade.listProfiles()[0];
  };

  check('an explicit range is stored', save({ wordLimitMode: 'range', minWords: 200, maxWords: 400 }).wordLimitMode === 'range');
  check('truncation can be enabled inside a range',
    save({ wordLimitMode: 'range', maxWords: 400, truncate: true }).truncate === true);
  // A range saved without the field defaults to on: cutting is friendlier than
  // silently skipping an over-long article.
  const implicit = save({ wordLimitMode: 'range', maxWords: 400, truncate: undefined });
  check('truncation defaults on inside a range', implicit.truncate === true, String(implicit.truncate));
  check('truncation can still be turned off', save({ wordLimitMode: 'range', maxWords: 400, truncate: false }).truncate === false);
  // Truncation is meaningless without a range, so it must not be stored as on.
  check('truncation is forced off when unlimited',
    save({ wordLimitMode: 'unlimited', truncate: true }).truncate === false);
  check('an unknown mode falls back to unlimited',
    save({ wordLimitMode: 'bogus' }).wordLimitMode === 'unlimited');
}

// -------------------------------------------------------------- enforcement
console.log('\nthe range is enforced on import');
{
  const facade = makeFacade();
  const [profile] = facade.listProfiles();
  const source = readFileSync(new URL('../lib/facade.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function applyWordLimit'),
    source.indexOf('function applyWordLimit') + 1400);

  check('unlimited returns the text untouched', /wordLimitMode !== 'range'[\s\S]{0,120}ok: true, text/.test(helper));
  check('a short article is rejected', /words < min[\s\S]{0,80}tooShort/.test(helper));
  check('an over-long article is rejected without truncation',
    /profile\.truncate !== true[\s\S]{0,80}tooLong/.test(helper));
  check('an over-long article is cut with truncation', /truncateToWords\(text, max\)/.test(helper));
  check('a cut below the minimum is rejected',
    /cut\.words < min[\s\S]{0,80}tooShortAfterTruncate/.test(helper));

  // The import path must consult it and report the reason.
  const importBody = source.slice(source.indexOf('async function confirmImport'),
    source.indexOf('// -------------------------------------------------------------- analysis'));
  check('import applies the limit', importBody.includes('applyWordLimit'));
  check('import reports truncation', importBody.includes('truncated: limited.truncated'));
  check('import reports a rejection reason', importBody.includes('reason: limited.reason'));
}

// --------------------------------------------------------------------- form
console.log('\nsettings page controls');
{
  const page = readFileSync(new URL('../src/100-knowledge.js', import.meta.url), 'utf8');
  // SettingsPage is the last declaration in the file; slice to the end.
  const settingsBody = page.slice(page.indexOf('function SettingsPage'));
  check('the model picker offers a follow-session option',
    settingsBody.includes("settings.modelFollowSession"));
  check('the picker lists the harness models', settingsBody.includes('availableModels'));
  // A number input bound to the draft: `[^}]*` would stop at the style object's
  // closing brace, so bound the window by the value expression instead.
  const numberInputFor = (field) => new RegExp(
    `h\\(\\s*'input'[\\s\\S]{0,240}?type: 'number'[\\s\\S]{0,240}?value: draft\\.${field}`,
  ).test(settingsBody);
  check('concurrency is an editable number', numberInputFor('sentenceConcurrency'));
  check('retry is an editable number', numberInputFor('retryLimit'));
  check('the per-article vocabulary row is gone', !settingsBody.includes('settings.wordsTarget'));
  // The voice dropdown below already lists every voice, so the count row was a
  // duplicate and was removed along with its (now unused) locale keys.
  check('the redundant voice-count row is gone', !settingsBody.includes('settings.speechVoices'));
  const locale = readFileSync(new URL('../src/110-locale.js', import.meta.url), 'utf8');
  check('its locale keys were removed too', !locale.includes("'settings.speechVoices'"));
  check('the voice dropdown itself remains', settingsBody.includes("t('settings.speechVoice')"));
  // A 100%-wide control inside a flex row squeezed the label into a one-word
  // column; the picker row must stack instead.
  const cssSource = readFileSync(new URL('../src/20-style.js', import.meta.url), 'utf8');
  check('a stacked row variant exists', /\.er-set-row--stack\s*\{[^}]*flex-direction:\s*column/.test(cssSource));
  check('the model picker row is stacked',
    /className: 'er-set-row er-set-row--stack'/.test(settingsBody));
  check('row text can claim the free space',
    /\.er-set-row-text\s*\{[^}]*flex:\s*1 1 auto/.test(cssSource));
  // Edits persist immediately; a save button would only add a step to forget.
  check('edits save without a button',
    settingsBody.includes('applyDraft') && !settingsBody.includes('settings.saveTuning'));
  check('every editable control persists on change',
    (settingsBody.match(/applyDraft\(/g) ?? []).length >= 4,
    String((settingsBody.match(/applyDraft\(/g) ?? []).length));
  check('a rejected save rolls back',
    /setDraft\(previous\)/.test(settingsBody));
  // The 6+6 pair must stay half width at the 6-column breakpoint, or the model
  // and TTS cards stack instead of sitting side by side.
  const css = readFileSync(new URL('../src/20-style.js', import.meta.url), 'utf8');
  const mid = css.slice(css.indexOf('@media (max-width: 1180px)'), css.indexOf('@media (max-width: 900px)'));
  check('span-6 stays half width on the 6-column board',
    /\.er-span-6\s*\{\s*grid-column:\s*span 3/.test(mid), mid.slice(0, 160));
  const facadeSource = readFileSync(new URL('../lib/facade.js', import.meta.url), 'utf8');
  check('the override reaches the llm layer', (facadeSource.match(/modelOverride: modelOverride\(\)/g) ?? []).length >= 3,
    String((facadeSource.match(/modelOverride: modelOverride\(\)/g) ?? []).length));
  const llm = readFileSync(new URL('../lib/llm.js', import.meta.url), 'utf8');
  check('the override wins over the session default',
    llm.indexOf('deps.modelOverride') < llm.indexOf('deps.defaultModel'));
  check('the settings payload no longer exposes wordsPerArticle',
    !/wordsPerArticle: config/.test(facadeSource));
  // `listModels` takes the provider ID. Passing the provider object made every
  // provider report the same models.
  check('the model list passes the provider id to listModels',
    /listModels\?\.\(id\)/.test(facadeSource) && !/listModels\?\.\(provider\)/.test(facadeSource));
  check('the model list has a single implementation',
    (facadeSource.match(/async function availableModelList/g) ?? []).length === 1);
}

console.log('\nmodel list and validation');
{
  const llm = {
    listProviders: () => [{ id: 'alpha' }, { id: 'beta' }],
    listModels: async (id) => (id === 'alpha'
      ? [{ id: 'a-1', name: 'Alpha One' }]
      : [{ id: 'b-1', name: 'Beta One' }]),
  };
  const facade = createFacade({
    dataDir: join(tmpdir(), `er-models-${Date.now()}`),
    config: { sentenceConcurrency: 2, retryLimit: 2 }, demo: [], llm,
    logger: { warn() {}, info() {} }, version: '1',
  });
  const settings = await facade.settings();
  check('each provider contributes its own models',
    settings.availableModels.length === 2
    && settings.availableModels[0].model === 'a-1'
    && settings.availableModels[1].model === 'b-1',
    JSON.stringify(settings.availableModels));
  // The picker groups by provider route, the way the Harness picker does.
  check('the roster is grouped by provider',
    settings.availableModels.length === 2
    && settings.availableModels[0].provider === 'alpha'
    && settings.availableModels[0].model === 'a-1'
    && settings.availableModels[1].provider === 'beta'
    && settings.availableModels[1].label === 'Beta One',
    JSON.stringify(settings.availableModels));
  check('a fresh install follows the session model', settings.modelOverride === null);

  const picked = await facade.savePluginSettings({
    tuning: { sentenceConcurrency: 2, retryLimit: 2 },
    modelOverride: { provider: 'beta', model: 'b-1' },
  });
  check('a known model is accepted', picked.saved === true && picked.modelOverride.model === 'b-1',
    JSON.stringify(picked));

  const stale = await facade.savePluginSettings({
    tuning: { sentenceConcurrency: 2, retryLimit: 2 },
    modelOverride: { provider: 'beta', model: 'gone' },
  });
  check('an unknown model is rejected', stale.saved === false && stale.reason === 'unknown-model',
    JSON.stringify(stale));
  check('a rejected save keeps the previous pick',
    (await facade.settings()).modelOverride.model === 'b-1');

  const cleared = await facade.savePluginSettings({
    tuning: { sentenceConcurrency: 2, retryLimit: 2 }, modelOverride: null,
  });
  check('clearing returns to the session model',
    cleared.saved === true && cleared.modelOverride === null);
}

console.log('\nsettings payload shape');
{
  const facade = makeFacade();
  const settings = await facade.settings();
  // The bug this pins down: `speech.stats()` returned `voices: <count>` and the
  // spread overwrote the voice ARRAY, so the settings page crashed on `.map`
  // and unmounted the whole plugin.
  check('speech.voices is the voice list, not a count',
    Array.isArray(settings.speech?.voices), typeof settings.speech?.voices);
  check('each voice has an id and a label',
    (settings.speech?.voices ?? []).every((voice) => typeof voice?.id === 'string' && typeof voice?.label === 'string'));
  check('the count lives under its own key',
    typeof settings.speech?.voiceCount === 'number', String(settings.speech?.voiceCount));
  const speech = readFileSync(new URL('../lib/speech.js', import.meta.url), 'utf8');
  check('stats no longer emits a colliding voices key',
    !/stats\(\)\s*\{[^}]*voices:/.test(speech));
  const settingsPage = readFileSync(new URL('../src/100-knowledge.js', import.meta.url), 'utf8');
  check('the voice select guards against a non-array payload',
    /Array\.isArray\(settings\.speech\?\.voices\)/.test(settingsPage));
}

console.log('\nthe form offers two modes');
{
  const form = readFileSync(new URL('../src/60-discover.js', import.meta.url), 'utf8');
  check('a mode choice exists', form.includes("value: 'unlimited'") && form.includes("value: 'range'"));
  check('the range inputs are conditional on the mode', form.includes("profile.wordLimitMode === 'range'"));
  check('truncation only appears inside a range',
    form.indexOf('truncateOn') > form.indexOf("profile.wordLimitMode === 'range'"));
  // The clear runs through a spread so it stays conditional; match the intent
  // (unlimited implies truncate:false) rather than an exact expression.
  check('switching modes sets truncation by mode',
    /truncate: option\.value === 'range'/.test(form),
    form.slice(form.indexOf('wordLimitMode: option.value'), form.indexOf('wordLimitMode: option.value') + 200));
  check('re-clicking the active mode changes nothing',
    /if \(\(profile\.wordLimitMode === 'range'\) === \(option\.value === 'range'\)\) return;/.test(form));
  // The switch is a single checkbox beside the inputs, not a pair of chips.
  check('truncation is a single checkbox',
    /h\('input', \{\s*type: 'checkbox',\s*checked: profile\.truncate === true/.test(form));
  check('no truncate chip pair remains', !form.includes("value: true, label: t('discover.truncateOn')"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
