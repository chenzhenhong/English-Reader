/**
 * Speech playback over the Host's Edge-TTS bridge.
 *
 * One shared audio element plays at most one clip at a time; a request for new
 * text stops the current clip first. The Host caches audio, so repeated taps on
 * the same word are instant, and a failure surfaces as a coded error instead of
 * silently doing nothing.
 */

/** Currently playing clip; a new request replaces it. */
let activeAudio = null;
let activeUrl = null;
/**
 * Whether the current clip's `play()` has settled.
 *
 * `stopSpeech()` must not touch the audio while `play()` is pending: clearing
 * the media then makes the promise reject with "The play() request was
 * interrupted because the media was removed from the document", which the
 * button reports as a failure even though the clip plays.
 */
let playSettled = false;
/** Voice/rate preferences persist per browser. */
const SPEECH_PREFS_KEY = 'english-reader:speech';

/** Read saved voice preferences. */
function speechPrefs() {
  try {
    const raw = window.localStorage.getItem(SPEECH_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        voice: typeof parsed.voice === 'string' ? parsed.voice : 'en-US-AriaNeural',
        rate: Number.isFinite(parsed.rate) ? parsed.rate : 0,
      };
    }
  } catch {
    /* storage unavailable */
  }
  return { voice: 'en-US-AriaNeural', rate: 0 };
}

/** Save voice preferences for later sessions. */
function saveSpeechPrefs(next) {
  try {
    window.localStorage.setItem(SPEECH_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

/** Stop the active clip and release its object URL. */
function stopSpeech() {
  if (activeAudio !== null) {
    if (playSettled) {
      // The clip is playing: pause it. Clearing `src` here would also work,
      // but `pause()` alone leaves the element intact for the `ended` event.
      try {
        activeAudio.pause();
      } catch {
        /* already torn down */
      }
    }
    // When `play()` is still pending, leave the audio alone: it settles on
    // its own and the promise resolves or rejects without being interrupted.
    activeAudio = null;
  }
  if (activeUrl !== null) {
    try {
      URL.revokeObjectURL(activeUrl);
    } catch {
      /* already released */
    }
    activeUrl = null;
  }
  playSettled = false;
}

/**
 * Fetch audio bytes for one utterance and play them.
 * @param {string} text what to say.
 * @param {object} options {voice, rate, signal}.
 * @returns {Promise<{played: boolean, bytes?: number, code?: string, message?: string}>} outcome.
 */
async function speakText(text, options = {}) {
  const prefs = speechPrefs();
  const voice = options.voice ?? prefs.voice;
  const rate = options.rate ?? prefs.rate;
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return { played: false, code: 'SPEECH_EMPTY', message: '没有可朗读的文本' };

  stopSpeech();
  let response;
  try {
    response = await fetch('/api/english-reader', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'speak', args: { text: trimmed, voice, rate }, format: 'json' }),
      signal: options.signal,
    });
  } catch (error) {
    return { played: false, code: 'SPEECH_UNAVAILABLE', message: `无法连接语音服务（${error.message}）` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { played: false, code: 'SPEECH_FAILED', message: `语音响应无法解析（HTTP ${response.status}）` };
  }
  if (!payload || payload.ok !== true) {
    return {
      played: false,
      code: payload?.error?.code ?? 'SPEECH_FAILED',
      message: payload?.error?.message ?? '语音合成失败',
    };
  }

  const bytes = Uint8Array.from(atob(payload.value.audio), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: payload.value.mime ?? 'audio/mpeg' });
  activeUrl = URL.createObjectURL(blob);
  const audio = new Audio(activeUrl);
  activeAudio = audio;
  playSettled = false;
  audio.addEventListener('ended', () => {
    if (activeAudio === audio) stopSpeech();
  });
  try {
    await audio.play();
  } catch (error) {
    playSettled = true;
    return { played: false, code: 'SPEECH_BLOCKED', message: `浏览器阻止了播放（${error.message}）` };
  }
  playSettled = true;
  return { played: true, bytes: payload.value.bytes, cached: payload.value.cached === true };
}

/** Speak a stored sentence by index (the Host resolves the text). */
async function speakSentence(articleId, sentenceIndex, options = {}) {
  const prefs = speechPrefs();
  const voice = options.voice ?? prefs.voice;
  const rate = options.rate ?? prefs.rate;
  stopSpeech();
  let response;
  try {
    response = await fetch('/api/english-reader', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'speakSentence', args: { articleId, sentenceIndex, voice, rate }, format: 'json' }),
      signal: options.signal,
    });
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      return { played: false, code: payload?.error?.code, message: payload?.error?.message ?? '语音合成失败' };
    }
    const bytes = Uint8Array.from(atob(payload.value.audio), (char) => char.charCodeAt(0));
    activeUrl = URL.createObjectURL(new Blob([bytes], { type: payload.value.mime ?? 'audio/mpeg' }));
    const audio = new Audio(activeUrl);
    activeAudio = audio;
    playSettled = false;
    audio.addEventListener('ended', () => {
      if (activeAudio === audio) stopSpeech();
    });
    try {
      await audio.play();
    } catch (error) {
      playSettled = true;
      throw error;
    }
    playSettled = true;
    return { played: true, bytes: payload.value.bytes };
  } catch (error) {
    return { played: false, code: 'SPEECH_FAILED', message: `朗读失败（${error.message}）` };
  }
}

export { speakText, speakSentence, stopSpeech, speechPrefs, saveSpeechPrefs };
