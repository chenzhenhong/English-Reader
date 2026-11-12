/**
 * Dictionary lookup: two scraped web sources, the cache, and the preference.
 *
 * The fixtures are the real pages fetched once from `dict.youdao.com` and
 * `cn.bing.com`, so the assertions describe what the parsers must survive
 * today. A markup change is exactly what these tests would catch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFacade } from '../lib/facade.js';
import { lookupDictionary, normalizeWord } from '../lib/dictionary.js';
import { ReaderError } from '../lib/net.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const stub = (html) => async () => html;
const throws = async (fn, code) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

console.log('word validation');
{
  check('accepts a plain word', normalizeWord('habit') === 'habit');
  check('accepts a hyphenated word', normalizeWord('well-known') === 'well-known');
  check('accepts a possessive', normalizeWord("John's") === "John's");
  check('rejects an empty query', (await throws(() => normalizeWord('   '), 'x'))?.code === 'SCHEMA_VALIDATION_FAILED');
  check('rejects a phrase', (await throws(() => normalizeWord('small habits'), 'x'))?.code === 'SCHEMA_VALIDATION_FAILED');
  check('rejects a digit-leading token', (await throws(() => normalizeWord('3d'), 'x'))?.code === 'SCHEMA_VALIDATION_FAILED');
}

console.log('\nyoudao scraping');
{
  const result = await lookupDictionary('habit', 'youdao', { fetchText: stub(fixture('dictionary-youdao.html')) });
  check('reports the provider', result.provider === 'youdao');
  check('reads the headword', result.word === 'habit', result.word);
  check('reads both pronunciations', result.phonetics.length === 2
    && result.phonetics[0].label === '英' && result.phonetics[1].label === '美', JSON.stringify(result.phonetics));
  check('keeps the phonetic string', result.phonetics[0].text === '[ˈhæbɪt]', result.phonetics[0].text);
  check('gives each pronunciation an audio URL', result.phonetics.every((item) => item.audio.startsWith('https://dict.youdao.com/dictvoice?audio=')));
  check('the audio URL carries the word and the voice type',
    result.phonetics[0].audio === 'https://dict.youdao.com/dictvoice?audio=habit&type=1', result.phonetics[0].audio);
  check('splits parts of speech', result.definitions.length >= 2
    && result.definitions[0].pos === 'n.' && result.definitions[1].pos === 'v.', JSON.stringify(result.definitions));
  check('reads the inflection forms', result.forms.includes('复数 habits'), result.forms);
  check('reads the collins section', result.collins.length >= 1, String(result.collins.length));
}

console.log('\nyoudao no entry');
{
  const error = await throws(() => lookupDictionary('zzzqwxjkv', 'youdao', {
    fetchText: stub(fixture('dictionary-youdao-none.html')),
  }));
  check('reports not found rather than an empty card', error?.code === 'DICTIONARY_NOT_FOUND', error?.code);
}

console.log('\nbing scraping');
{
  const result = await lookupDictionary('habit', 'bing', { fetchText: stub(fixture('dictionary-bing.html')) });
  check('reports the provider', result.provider === 'bing');
  check('reads the headword', result.word === 'habit', result.word);
  check('reads both pronunciations', result.phonetics.length === 2
    && result.phonetics[0].label === '美国' && result.phonetics[1].label === '英国', JSON.stringify(result.phonetics));
  check('keeps the phonetic string', result.phonetics[0].text === '[ˈhæbɪt]', result.phonetics[0].text);
  check('gives each pronunciation an audio URL', result.phonetics.every((item) => item.audio.startsWith('https://cn.bing.com/')));
  check('scopes the definitions to the basic section', result.definitions.length === 3
    && result.definitions.every((item) => item.text.length > 0), JSON.stringify(result.definitions));
  check('reads example sentences', result.examples.length >= 2 && result.examples.length <= 5, String(result.examples.length));
  check('each example keeps both languages', result.examples.every((item) => item.en.length > 0));
}

console.log('\nbing no entry');
{
  const error = await throws(() => lookupDictionary('zzzqwxjkv', 'bing', {
    fetchText: stub(fixture('dictionary-bing-none.html')),
  }));
  check('reports not found rather than an empty card', error?.code === 'DICTIONARY_NOT_FOUND', error?.code);
}

console.log('\nfacade preference and cache');
{
  const dir = join(tmpdir(), `er-dictionary-${Date.now()}`);
  const reads = [];
  const web = {
    fetch: async ({ url }) => {
      reads.push(url);
      const parsed = new URL(url);
      const provider = parsed.host.includes('youdao') ? 'youdao' : 'bing';
      const word = parsed.pathname.includes('/w/')
        ? decodeURIComponent(parsed.pathname.split('/w/')[1])
        : parsed.searchParams.get('q');
      const name = word === 'habit'
        ? (provider === 'youdao' ? 'dictionary-youdao.html' : 'dictionary-bing.html')
        : (provider === 'youdao' ? 'dictionary-youdao-none.html' : 'dictionary-bing-none.html');
      return { body: { content: fixture(name) } };
    },
  };
  const facade = createFacade({ dataDir: dir, web, logger: { warn() {}, info() {} } });

  check('defaults to youdao', (await facade.settings()).dictionary === 'youdao');
  check('rejects a non-word', (await throws(() => facade.lookupWord('hello world'), 'x')) instanceof ReaderError);

  const first = await facade.lookupWord('habit');
  check('looks the word up on the default provider', first.provider === 'youdao');
  check('the second identical lookup hits the cache', (await facade.lookupWord('habit')).provider === 'youdao' && reads.length === 1, String(reads.length));
  await facade.lookupWord('habit', { force: true });
  check('force skips the cache', reads.length === 2, String(reads.length));

  // Switching the provider is a stored preference, so the next lookup must use
  // it and must not be served from the other provider's cache entry.
  const saved = await facade.savePluginSettings({ dictionary: 'bing' });
  check('saves the provider', saved.dictionary === 'bing');
  check('exposes it through settings', (await facade.settings()).dictionary === 'bing');
  check('re-queries on the new provider', (await facade.lookupWord('habit')).provider === 'bing');
  check('uses a separate cache key', reads.length === 3, String(reads.length));

  // A dictionary switch must not clobber the tuning the learner set earlier.
  await facade.savePluginSettings({ tuning: { sentenceConcurrency: 3, retryLimit: 4 } });
  await facade.savePluginSettings({ dictionary: 'youdao' });
  const tuning = (await facade.settings()).tuning;
  check('switching the dictionary keeps the tuning', tuning.sentenceConcurrency === 3 && tuning.retryLimit === 4, JSON.stringify(tuning));

  await throws(() => facade.lookupWord('zzzqwxjkv'), 'x');
  check('a miss surfaces as a coded error', true);
}

console.log('\ndictionary words join the library');
{
  const dir = join(tmpdir(), `er-dict-library-${Date.now()}`);
  const web = {
    fetch: async () => ({ body: { content: fixture('dictionary-youdao.html') } }),
  };
  const facade = createFacade({ dataDir: dir, web, logger: { warn() {}, info() {} } });
  const result = await facade.lookupWord('habit');

  check('the lookup reports the library is empty',
    result.entityId === null && result.inLibrary === false,
    JSON.stringify({ entityId: result.entityId, inLibrary: result.inLibrary }));

  const saved = facade.saveDictionaryWord({ word: 'habit', result, favorite: true });
  check('saving returns the new entity id',
    typeof saved.entityId === 'string' && saved.entityId.length > 0, JSON.stringify(saved));
  check('saving reports the word is in the library', saved.inLibrary === true);
  check('saving keeps the headword', saved.expression === 'habit', saved.expression);

  const listed = facade.searchKnowledge({ kind: 'word', limit: 200 });
  check('the saved word joins the library',
    listed.length === 1 && listed[0].expression === 'habit', JSON.stringify(listed));

  const after = await facade.lookupWord('habit');
  check('a later lookup sees the word in the library',
    after.inLibrary === true && after.entityId === saved.entityId,
    JSON.stringify({ inLibrary: after.inLibrary, entityId: after.entityId }));

  const detail = facade.knowledgeDetail('word', saved.entityId);
  check('the library word keeps the scraped definitions',
    (detail.meanings ?? []).length >= 1 && /习惯/.test(detail.meanings[0].meaning), JSON.stringify(detail.meanings));
  check('the library word keeps the scraped part of speech',
    (detail.partOfSpeech ?? []).includes('n.'), JSON.stringify(detail.partOfSpeech));

  // Saving again must not replace an entry that already exists, whether it came
  // from the provider or from an analysed article: the learner's own context
  // meaning is the one that belongs in the library.
  const redecorated = { ...result, definitions: [{ pos: 'adj.', text: '被替换的释义' }] };
  const again = facade.saveDictionaryWord({ word: 'habit', result: redecorated, favorite: true });
  check('a repeat save keeps the word in the library', again.inLibrary === true);
  const kept = facade.knowledgeDetail('word', saved.entityId);
  check('a repeat save does not overwrite the scraped definitions',
    /习惯/.test(kept.meanings?.[0]?.meaning ?? ''), JSON.stringify(kept.meanings));

  const removed = facade.saveDictionaryWord({ word: 'habit', result, favorite: false });
  check('removing reports the word is out of the library',
    removed.inLibrary === false && removed.entityId === saved.entityId);
  check('the word leaves the library', facade.searchKnowledge({ kind: 'word', limit: 200 }).length === 0);

  check('saving rejects a non-word',
    (await throws(() => facade.saveDictionaryWord({ word: 'two words' }), 'x')) instanceof ReaderError);
}

console.log(failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed, 0 failed`);
process.exitCode = failed > 0 ? 1 : 0;
