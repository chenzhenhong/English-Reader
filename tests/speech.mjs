/**
 * Speech checks: Edge-TTS protocol, MP3 validation, cache behaviour, error
 * codes, and the facade's mapping of speech failures onto plugin errors.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSpeech, normalizeUtterance, SpeechError, VOICES } from '../lib/speech.js';
import { createFacade } from '../lib/facade.js';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

/** MP3 files begin with an ID3 tag or a raw MPEG frame sync. */
function looksLikeMp3(bytes) {
  if (bytes.length < 120) return false;
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

console.log('normalization');
check('trims and collapses whitespace', normalizeUtterance('  hello   world  ', 0).text === 'hello world');
check('clamps rate high', normalizeUtterance('x', 500).rate === 100);
check('clamps rate low', normalizeUtterance('x', -500).rate === -50);
try { normalizeUtterance('', 0); check('rejects empty text', false); } catch (error) { check('rejects empty text', error.code === 'SPEECH_EMPTY', error.code); }
try { normalizeUtterance('x'.repeat(1300), 0); check('rejects overlong text', false); } catch (error) { check('rejects overlong text', error.code === 'SPEECH_TOO_LONG', error.code); }

// Network work is opt-in so the suite stays usable offline.
if (process.env.ER_SPEECH_LIVE !== '1') {
  console.log('\nlive synthesis skipped (set ER_SPEECH_LIVE=1 to run)');
} else {
  console.log('\nlive synthesis');
  const dir = join(tmpdir(), `er-speech-${Date.now()}`);
  const speech = createSpeech(dir);
  const started = Date.now();
  const word = await speech.speak({ text: 'consolidate', voice: 'en-US-AriaNeural' });
  check('word returns MP3 bytes', looksLikeMp3(word.bytes), `${word.bytes.length} bytes`);
  check('first request is not cached', word.cached === false);
  check('synthesis completes in a bounded time', Date.now() - started < 20000, `${Date.now() - started} ms`);

  const again = await speech.speak({ text: 'consolidate', voice: 'en-US-AriaNeural' });
  check('identical request hits the cache', again.cached === true);
  check('cached bytes are identical', again.bytes.length === word.bytes.length);

  const sentence = await speech.speak({ text: 'Small habits can lead to big changes.', voice: 'en-GB-SoniaNeural', rate: -10 });
  check('sentence returns MP3', looksLikeMp3(sentence.bytes), `${sentence.bytes.length} bytes`);
  check('rate is clamped and recorded', sentence.rate === -10);

  const unknownVoice = await speech.speak({ text: 'hello', voice: 'xx-NotAVoice' });
  check('unknown voice falls back to the default', unknownVoice.voice === VOICES[0].id, unknownVoice.voice);

  const stats = speech.stats();
  check('stats count cached clips', stats.cachedFiles >= 2, JSON.stringify(stats));
  const cleared = speech.clearCache();
  check('cache clears', cleared.removed >= 2 && speech.stats().cachedFiles === 0, JSON.stringify(cleared));
}

console.log('\nfacade mapping');
const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));
const facade = createFacade({
  dataDir: join(tmpdir(), `er-speech-facade-${Date.now()}`),
  config: {}, demo, llm: undefined, defaultModel: undefined, web: undefined,
  logger: { warn() {}, info() {} }, version: '1',
});
facade.seedDemo();
try {
  await facade.speak({ text: '' });
  check('facade rejects empty speech', false);
} catch (error) {
  check('facade rejects empty speech with a plugin code', error.code === 'SPEECH_EMPTY', error.code);
}
if (process.env.ER_SPEECH_LIVE === '1') {
  const article = facade.listArticles({}).items[0];
  const result = await facade.speak({ text: article.title, voice: 'en-US-AriaNeural' });
  check('facade returns base64 audio', typeof result.audio === 'string' && result.audio.length > 100);
  check('facade reports mime and size', result.mime === 'audio/mpeg' && result.bytes > 0);
  const sentence = await facade.speakSentence(article.id, 0, 'en-US-GuyNeural', 0);
  check('facade resolves a stored sentence', sentence.bytes > 0 && sentence.voice === 'en-US-GuyNeural', JSON.stringify({ bytes: sentence.bytes, voice: sentence.voice }));
  const settings = facade.settings();
  check('settings advertise the speech engine', settings.speech?.engine === 'edge-tts' && settings.speech.available === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
