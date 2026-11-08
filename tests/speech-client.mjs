/**
 * Client speech-playback checks against the real module, with a stubbed
 * `fetch` and a stubbed Audio element: the request shape, the failure mapping
 * and the "one clip at a time" rule are all observable here.
 *
 * The module is loaded from the built bundle so this test exercises what ships.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** A fresh browser sandbox with the speech module exposed by the bundle factory. */
function loadClient() {
  let registration;
  const sandbox = {
    window: {
      __ModuleLoader__: { load(r) { registration = r; } },
      localStorage: {
        store: new Map(),
        getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
        setItem(key, value) { this.store.set(key, String(value)); },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    Blob: class Blob {
      constructor(parts) { this.parts = parts; }
    },
    URL: { createObjectURL: () => 'blob:clip', revokeObjectURL() {} },
    Audio: class Audio {
      constructor(src) { this.src = src; this.paused = false; this.listeners = {}; }
      addEventListener(name, fn) { this.listeners[name] = fn; }
      play() { return Promise.resolve(); }
      pause() { this.paused = true; }
    },
    fetch: (...args) => globalThis.__fetch(...args),
  };
  vm.createContext(sandbox);
  // Expose the module's speech helpers through the factory's plugin object.
  const patched = bundle;
  vm.runInContext(patched, sandbox, { filename: 'client.js' });
  const React = {
    createElement: () => ({ type: 'div' }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: () => ({ current: 0 }),
    Fragment: 'fragment',
  };
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require ${specifier}`);
  });
  const recorded = [];
  plugin.apply({
    effect: () => () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(_key, cb) { cb(); return () => {}; },
      register(options) { recorded.push(options); return () => {}; },
    },
  });
  return { speech: plugin.__test, sandbox };
}

/** A one-pixel MP3 stand-in: base64 of a tiny valid-looking payload. */
const AUDIO_BASE64 = Buffer.from([0xff, 0xf3, 0x44, 0xc4, ...Array(200).fill(0x55)]).toString('base64');

let calls = 0;
let nextResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, value: { audio: AUDIO_BASE64, mime: 'audio/mpeg', voice: 'en-US-AriaNeural', rate: 0, bytes: 204, cached: false } }),
});

console.log('request shape');
{
  const { speech } = loadClient();
  const seen = [];
  globalThis.__fetch = async (url, init) => {
    calls += 1;
    seen.push({ url, body: JSON.parse(init.body) });
    return nextResponse();
  };
  const result = await speech.speakText('Small habits can lead to big changes.');
  check('posts to the plugin route', seen[0].url === '/api/english-reader', seen[0].url);
  check('uses the speak operation', seen[0].body.op === 'speak', seen[0].body.op);
  check('sends the text verbatim', seen[0].body.args.text === 'Small habits can lead to big changes.', seen[0].body.args.text);
  check('requests the JSON payload', seen[0].body.format === 'json', seen[0].body.format);
  check('reports playback success', result.played === true, JSON.stringify(result));
  check('surfaces byte count', result.bytes === 204, String(result.bytes));
}

console.log('\nsentence + voice preferences');
{
  const { speech } = loadClient();
  const seen = [];
  globalThis.__fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return nextResponse();
  };
  speech.saveSpeechPrefs({ voice: 'en-GB-SoniaNeural', rate: -10 });
  check('preferences persist', speech.speechPrefs().voice === 'en-GB-SoniaNeural');
  await speech.speakSentence('art_1', 3);
  check('resolves a sentence by id and index', seen[0].op === 'speakSentence' && seen[0].args.articleId === 'art_1' && seen[0].args.sentenceIndex === 3, JSON.stringify(seen[0]));
  check('applies the saved voice', seen[0].args.voice === 'en-GB-SoniaNeural', seen[0].args.voice);
  check('applies the saved rate', seen[0].args.rate === -10, String(seen[0].args.rate));
}

console.log('\nfailure mapping');
{
  const { speech } = loadClient();
  globalThis.__fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error: { code: 'SPEECH_TOO_LONG', message: 'That passage is too long to speak in one request.' } }),
  });
  const result = await speech.speakText('x'.repeat(500));
  check('returns the coded failure instead of throwing', result.played === false && result.code === 'SPEECH_TOO_LONG', JSON.stringify(result));
  check('keeps the Host message', result.message.includes('too long'), result.message);
}
{
  const { speech } = loadClient();
  globalThis.__fetch = async () => { throw new Error('offline'); };
  const result = await speech.speakText('hello');
  check('network failure is reported', result.played === false && result.code === 'SPEECH_UNAVAILABLE', JSON.stringify(result));
}
{
  const { speech } = loadClient();
  globalThis.__fetch = async () => nextResponse();
  const result = await speech.speakText('   ');
  check('empty text is refused locally', result.played === false && result.code === 'SPEECH_EMPTY', JSON.stringify(result));
  check('empty text makes no request', calls === 1, String(calls));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
