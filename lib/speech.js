/**
 * Speech synthesis through Microsoft Edge's neural TTS endpoint.
 *
 * The plugin speaks the same WebSocket protocol `edge-tts` does, using Node's
 * built-in WebSocket — no Python, no npm package. Audio is cached on disk by
 * (voice, rate, text) so a sentence is synthesized once, and requests are
 * bounded and cancellable so a long run cannot hang the Host.
 *
 * Edge's endpoint is a public service, not an SLA: every failure maps onto a
 * `SpeechError` code and the UI falls back to the browser voice.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Public Edge client constants (the same values `edge-tts` ships). */
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const GEC_VERSION = '1-130.0.2849.68';
const ENDPOINT = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

/** Text is spoken in small pieces; a whole article is never one request. */
const MAX_TEXT_CHARS = 1200;
/** One synthesis call may not exceed this many milliseconds. */
const SYNTHESIS_TIMEOUT_MS = 20_000;

/** Voices offered in the UI, with the reading role each suits. */
export const VOICES = Object.freeze([
  { id: 'en-US-AriaNeural', label: 'Aria · 美音女声', accent: 'US', gender: 'female' },
  { id: 'en-US-GuyNeural', label: 'Guy · 美音男声', accent: 'US', gender: 'male' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia · 英音女声', accent: 'UK', gender: 'female' },
  { id: 'en-GB-RyanNeural', label: 'Ryan · 英音男声', accent: 'UK', gender: 'male' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha · 澳音女声', accent: 'AU', gender: 'female' },
]);

/** Failures a caller can distinguish. */
export class SpeechError extends Error {
  /**
   * @param {string} code stable machine code.
   * @param {string} message safe summary.
   */
  constructor(code, message) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

/** Build the anti-forgery signature Edge requires on every connection. */
function securityToken() {
  const ticks = Math.floor((Date.now() / 1000 + 11644473600) / 300) * 300 * 10000000;
  return createHash('sha256').update(`${ticks}${TRUSTED_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

/** Escape text for SSML so punctuation never becomes markup. */
function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Timestamp format Edge expects in the frame headers. */
function timestamp() {
  return new Date().toISOString();
}

/** Hex request id, one per synthesis. */
function requestId() {
  return randomHex(32);
}

function randomHex(length) {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * Normalize one utterance before synthesis.
 * @param {string} text raw text.
 * @param {number} rate percent change, -50..+100.
 * @returns {{text: string, rate: number}} clamped values.
 */
export function normalizeUtterance(text, rate) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) throw new SpeechError('SPEECH_EMPTY', 'There is no text to speak.');
  if (clean.length > MAX_TEXT_CHARS) throw new SpeechError('SPEECH_TOO_LONG', 'That passage is too long to speak in one request.');
  const numeric = Number(rate);
  const clamped = Number.isFinite(numeric) ? Math.max(-50, Math.min(100, Math.round(numeric))) : 0;
  return { text: clean, rate: clamped };
}

/** Candidate files for one utterance. */
function cachePaths(dirs, voice, rate, text) {
  const key = createHash('sha256').update(`${voice}|${rate}|${text}`, 'utf8').digest('hex').slice(0, 24);
  mkdirSync(dirs.cache, { recursive: true });
  return { file: join(dirs.cache, `${key}.mp3`), meta: join(dirs.cache, `${key}.json`) };
}

/**
 * Synthesize one utterance to MP3 bytes over a WebSocket.
 * @param {{text: string, voice: string, rate: number}} request normalized request.
 * @param {AbortSignal} signal cancellation.
 * @returns {Promise<Buffer>} MP3 payload.
 */
function synthesize(request, signal) {
  if (typeof WebSocket !== 'function') {
    return Promise.reject(new SpeechError('SPEECH_UNAVAILABLE', 'This Node runtime has no WebSocket support for speech.'));
  }
  return new Promise((resolve, reject) => {
    const audio = [];
    let settled = false;
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try {
        socket?.close();
      } catch {
        /* already closing */
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new SpeechError('SPEECH_CANCELLED', 'Speech synthesis was cancelled.'));
    const timer = setTimeout(() => finish(new SpeechError('SPEECH_TIMEOUT', 'Speech synthesis timed out.')), SYNTHESIS_TIMEOUT_MS);
    if (signal?.aborted) {
      finish(new SpeechError('SPEECH_CANCELLED', 'Speech synthesis was cancelled.'));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const url = `${ENDPOINT}?Ocp-Apim-Subscription-Key=${TRUSTED_TOKEN}`
      + `&Sec-MS-GEC=${securityToken()}&Sec-MS-GEC-Version=${GEC_VERSION}`;
    try {
      socket = new WebSocket(url, urllibLikeOptions());
    } catch (error) {
      finish(new SpeechError('SPEECH_UNAVAILABLE', `Could not open the speech channel (${error?.message ?? 'unknown'}).`));
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      const stamp = timestamp();
      socket.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        + '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
        + `<voice name='${request.voice}'><prosody pitch='+0Hz' rate='${request.rate >= 0 ? '+' : ''}${request.rate}%' volume='+0%'>`
        + `${escapeSsml(request.text)}</prosody></voice></speak>`;
      socket.send(`X-RequestId:${requestId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          if (audio.length === 0) finish(new SpeechError('SPEECH_FAILED', 'The speech service returned no audio.'));
          else finish(null, Buffer.concat(audio));
        }
        return;
      }
      // Binary frames carry `X-RequestId:…\r\nContent-Type:…\r\nPath:audio\r\n`
      // followed immediately by the MP3 payload — single CRLFs, no blank line.
      const buffer = Buffer.from(data);
      const marker = buffer.indexOf('Path:audio');
      if (marker < 0) return;
      const payloadAt = buffer.indexOf('\r\n', marker);
      if (payloadAt < 0) return;
      audio.push(buffer.subarray(payloadAt + 2));
    });
    socket.addEventListener('error', () => {
      finish(new SpeechError('SPEECH_UNAVAILABLE', 'The speech channel failed; check network access to Edge TTS.'));
    });
    socket.addEventListener('close', (event) => {
      if (!settled) {
        finish(new SpeechError('SPEECH_FAILED', `The speech channel closed unexpectedly (${event.code}).`));
      }
    });
  });
}

/** Per-connection headers: Edge rejects an unauthenticated client shape. */
function urllibLikeOptions() {
  return { headers: { 'User-Agent': USER_AGENT, Origin: ORIGIN } };
}

/**
 * Create the speech service over one cache directory.
 * @param {string} dataDir plugin data directory.
 * @returns {object} speech operations used by the facade.
 */
export function createSpeech(dataDir) {
  const dirs = { cache: join(dataDir, 'cache', 'speech') };
  mkdirSync(dirs.cache, { recursive: true });
  let cachedBytes = 0;
  for (const name of readdirSafe(dirs.cache)) {
    try {
      if (name.endsWith('.mp3')) cachedBytes += statSync(join(dirs.cache, name)).size;
    } catch {
      /* a file may disappear between listing and stat */
    }
  }

  return {
    voices: VOICES,

    /**
     * Return MP3 bytes for one utterance, synthesizing only on a cache miss.
     * @param {{text: string, voice?: string, rate?: number}} request call.
     * @param {AbortSignal} [signal] cancellation.
     * @returns {Promise<{bytes: Buffer, voice: string, rate: number, cached: boolean}>} audio.
     */
    async speak(request, signal) {
      const { text, rate } = normalizeUtterance(request?.text, request?.rate);
      const voice = VOICES.some((item) => item.id === request?.voice) ? request.voice : VOICES[0].id;
      const paths = cachePaths(dirs, voice, rate, text);
      if (existsSync(paths.file)) {
        const bytes = readFileSync(paths.file);
        if (bytes.length > 0) return { bytes, voice, rate, cached: true };
      }
      const bytes = await synthesize({ text, voice, rate }, signal);
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (body.length === 0) throw new SpeechError('SPEECH_FAILED', 'The speech service returned empty audio.');
      try {
        writeFileSync(paths.file, body);
        writeFileSync(paths.meta, JSON.stringify({ voice, rate, text: text.slice(0, 400), at: new Date().toISOString() }), 'utf8');
        cachedBytes += body.length;
      } catch {
        /* a full disk must not fail the request that already has audio */
      }
      return { bytes: body, voice, rate, cached: false };
    },

    /** Cache facts for the settings page. */
    stats() {
      return { cachedFiles: countFiles(dirs.cache), cachedBytes, voiceCount: VOICES.length };
    },

    /** Remove every cached clip. */
    clearCache() {
      let removed = 0;
      for (const name of readdirSafe(dirs.cache)) {
        try {
          const path = join(dirs.cache, name);
          const size = statSync(path).size;
          removeFile(path);
          removed += 1;
          if (name.endsWith('.mp3')) cachedBytes = Math.max(0, cachedBytes - size);
        } catch {
          /* ignore unreadable leftovers */
        }
      }
      return { removed };
    },
  };
}

/** Directory listing that never throws. */
function readdirSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function removeFile(path) {
  unlinkSync(path);
}

function countFiles(path) {
  return readdirSafe(path).filter((name) => name.endsWith('.mp3')).length;
}
