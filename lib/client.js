window.__ModuleLoader__.load({
  id: 'english-reader',
  factory(require) {
    const React = require('react');
// ---- src/10-api.js ----
/**
 * Client data layer: one authenticated JSON route to the Host half, plus tiny
 * loading helpers and formatting utilities shared by every view.
 */

/** Call one Host operation, surfacing the coded error message. */
async function call(op, args) {
  let response;
  try {
    response = await fetch('/api/english-reader', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args: args ?? {} }),
    });
  } catch (error) {
    throw new Error(`English Reader could not reach the Host (${error.message}).`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`English Reader received an unreadable response (HTTP ${response.status}).`);
  }
  if (!payload || payload.ok !== true) {
    const error = new Error(payload?.error?.message ?? `Request failed (HTTP ${response.status}).`);
    error.code = payload?.error?.code ?? 'UNKNOWN';
    throw error;
  }
  return payload.value;
}

/** Load once (and when the dependency list changes), keeping the last good data. */
function useLoad(loader, deps) {
  const [state, setState] = React.useState({ status: 'loading', data: undefined, error: null });
  const tick = React.useRef(0);
  React.useEffect(() => {
    let alive = true;
    const current = ++tick.current;
    setState((previous) => ({ status: 'loading', data: previous.data, error: null }));
    loader()
      .then((data) => {
        if (alive && current === tick.current) setState({ status: 'ready', data, error: null });
      })
      .catch((error) => {
        if (alive && current === tick.current) setState({ status: 'error', data: undefined, error });
      });
    return () => {
      alive = false;
    };
  }, deps);
  return {
    ...state,
    reload: () => {
      tick.current += 1;
      setState((previous) => ({ ...previous, status: 'loading' }));
      loader().then(
        (data) => setState({ status: 'ready', data, error: null }),
        (error) => setState({ status: 'error', data: undefined, error }),
      );
    },
  };
}

/** Run an action with pending/error state and an optional refresh hook. */
function useAction() {
  const [state, setState] = React.useState({ pending: false, error: null, notice: null });
  const run = React.useCallback(async (fn, successText) => {
    setState({ pending: true, error: null, notice: null });
    try {
      const value = await fn();
      setState({ pending: false, error: null, notice: successText ?? null });
      return value;
    } catch (error) {
      setState({ pending: false, error, notice: null });
      return undefined;
    }
  }, []);
  return { ...state, run, clear: () => setState({ pending: false, error: null, notice: null }) };
}

/** CEFR badge classes: A levels mild, B green, C amber. */
function cefrTone(level) {
  if (!level) return 'neutral';
  if (level.startsWith('A')) return 'soft';
  if (level.startsWith('B')) return 'blue';
  return 'amber';
}

/** Human label for a stage status. */
const STATUS_LABELS = {
  PENDING: '待执行',
  // A stage that started, stopped part-way and has not been retried. It is
  // stored as PENDING so it stays retryable, but "待执行" would claim it never
  // ran while its partial results are already on screen.
  INTERRUPTED: '已中断',
  RUNNING: '进行中',
  SUCCEEDED: '已完成',
  NEEDS_REVIEW: '待复核',
  FAILED: '失败',
  SKIPPED: '已跳过',
};

/** Human label for an article status. */
const ARTICLE_STATUS_LABELS = {
  DISCOVERED: '已发现',
  FETCHING: '抓取中',
  FETCHED: '已导入',
  ANALYZING: '解析中',
  PARTIAL_COMPLETED: '部分完成',
  COMPLETED: '解析完成',
  FETCH_FAILED: '抓取失败',
  ANALYSIS_FAILED: '解析失败',
};

/** Heading label for a reading status. */
const READING_LABELS = { unread: '未读', reading: '在读', completed: '已读完' };

/** Compact date for cards. */
function shortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Relative day label for lists. */
function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return shortDate(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return shortDate(value);
}

/** Bytes for the settings page. */
function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Deterministic pastel gradient per article id, used as artwork. */
function artGradient(id) {
  const palettes = [
    ['#cfe0ff', '#b8c6ff', '#8fa8f7'],
    ['#ffe6d5', '#ffd2c2', '#f7a8a0'],
    ['#d9f0e6', '#bfe3d8', '#8ec7b6'],
    ['#e8dcff', '#d5c3fb', '#ab8ff0'],
    ['#ffe9f2', '#ffd6e5', '#f0a9c6'],
  ];
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  const [a, b, c] = palettes[hash % palettes.length];
  return `linear-gradient(135deg, ${a} 0%, ${b} 52%, ${c} 100%)`;
}

// ---- src/15-speech.js ----
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
    try {
      activeAudio.pause();
      activeAudio.src = '';
    } catch {
      /* already torn down */
    }
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
  audio.addEventListener('ended', () => {
    if (activeAudio === audio) stopSpeech();
  });
  try {
    await audio.play();
  } catch (error) {
    return { played: false, code: 'SPEECH_BLOCKED', message: `浏览器阻止了播放（${error.message}）` };
  }
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
    audio.addEventListener('ended', () => {
      if (activeAudio === audio) stopSpeech();
    });
    await audio.play();
    return { played: true, bytes: payload.value.bytes };
  } catch (error) {
    return { played: false, code: 'SPEECH_FAILED', message: `朗读失败（${error.message}）` };
  }
}


// ---- src/20-style.js ----
/**
 * Bento Grid 2.0 surface for English Reader.
 *
 * Implements `docs/bento-grid-2.0.md`. The rules that matter most here:
 * - a 12-column board with spans from the spec (never ad-hoc widths);
 * - one `gap` value across the whole board;
 * - radius grows with cell area (18 / 24 / 28px);
 * - two shadow layers maximum: a 1px contact plus one wide ambient;
 * - colour resolves through `--dsw-alias-*` (or a mix of them) so light and dark
 *   both work; the board's own tints stay ≤ 12%.
 */

const CSS = `
.er-root {
  /* ---------------------------------------------------------------- palette */
  --er-violet: #7b6cf6;
  --er-violet-2: #a78bfa;
  --er-violet-soft: #eeebfd;
  --er-blue: #4f7cf7;
  --er-blue-soft: #e8eeff;
  --er-mint: #34b98a;
  --er-mint-soft: #e2f6ee;
  --er-amber: #d98b21;
  --er-amber-soft: #fdf0dc;
  --er-pink: #db6d9b;
  --er-pink-soft: #fdeaf2;

  --er-ink: var(--dsw-alias-label-primary);
  --er-ink-2: var(--dsw-alias-label-secondary);
  --er-ink-3: var(--dsw-alias-label-tertiary);
  --er-card: var(--dsw-alias-bg-layer-1);
  --er-line: color-mix(in srgb, var(--dsw-alias-border-l2) 82%, var(--er-violet) 6%);

  /* ------------------------------------------------------------- geometry */
  --er-r-xs: 8px;
  --er-r-sm: 12px;
  --er-r-md: 18px;
  --er-r-lg: 24px;
  --er-r-xl: 28px;
  --er-s-1: 4px;
  --er-s-2: 8px;
  --er-s-3: 12px;
  --er-s-4: 16px;
  --er-s-5: 20px;
  --er-s-6: 24px;
  --er-s-8: 32px;
  /* Shared bottom gutter: the rail's last item aligns with the content edge. */
  --er-gutter-bottom: 20px;

  /* Two layers only: 1px contact + one wide ambient. */
  --er-lift-1: 0 1px 1px color-mix(in srgb, var(--er-ink) 5%, transparent),
    0 16px 32px -26px color-mix(in srgb, var(--er-violet) 34%, transparent);
  --er-lift-2: 0 2px 2px color-mix(in srgb, var(--er-ink) 6%, transparent),
    0 30px 56px -32px color-mix(in srgb, var(--er-violet) 38%, transparent);
  --er-lift-3: 0 3px 4px color-mix(in srgb, var(--er-ink) 8%, transparent),
    0 44px 76px -38px color-mix(in srgb, var(--er-violet) 42%, transparent);

  display: flex;
  height: 100%;
  min-height: 0;
  color: var(--er-ink);
  font-family: var(--dsw-font-family, inherit);
  background:
    radial-gradient(980px 520px at 4% -10%, color-mix(in srgb, var(--er-violet) 11%, transparent), transparent 62%),
    radial-gradient(820px 460px at 98% 4%, color-mix(in srgb, var(--er-blue) 9%, transparent), transparent 58%),
    color-mix(in srgb, var(--dsw-alias-bg-base) 92%, var(--er-violet-soft) 8%);
}

body[data-ds-dark-theme] .er-root {
  --er-violet: #9b8bff;
  --er-violet-2: #c4b5fd;
  --er-violet-soft: #221f3a;
  --er-blue: #7d9bff;
  --er-blue-soft: #1b2038;
  --er-mint: #4bd3a3;
  --er-mint-soft: #14261f;
  --er-amber: #e8ae5e;
  --er-amber-soft: #2a2114;
  --er-pink: #e795ba;
  --er-pink-soft: #2a1a22;
  background:
    radial-gradient(980px 520px at 4% -10%, color-mix(in srgb, var(--er-violet) 10%, transparent), transparent 62%),
    radial-gradient(820px 460px at 98% 4%, color-mix(in srgb, var(--er-blue) 8%, transparent), transparent 58%),
    color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #16132a 6%);
}

/* ------------------------------------------------------------------- rail */
.er-rail {
  flex: none;
  width: 188px;
  display: flex;
  flex-direction: column;
  gap: var(--er-s-1);
  padding: var(--er-s-4) var(--er-s-3) var(--er-gutter-bottom);
  overflow-y: auto;
  border-right: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-card) 70%, transparent);
  backdrop-filter: blur(20px);
}
.er-brand { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: var(--er-s-2) 0 var(--er-s-5); }
.er-brand-mark {
  display: grid; place-items: center; width: 46px; height: 46px; border-radius: var(--er-r-md);
  background: linear-gradient(155deg, color-mix(in srgb, var(--er-violet) 12%, var(--er-card)), var(--er-card) 70%);
  border: 1px solid color-mix(in srgb, var(--er-violet) 22%, transparent);
  box-shadow: var(--er-lift-1);
}
.er-brand-mark svg { width: 28px; height: 28px; }
.er-brand-name {
  font-size: 12.5px; font-weight: 650; line-height: 16px;
  color: var(--er-ink); text-align: center;
  /* One line, always: the label must never re-wrap into "English / Reader". */
  white-space: nowrap;
  max-width: 100%;
}
.er-brand-sub { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--er-ink-3); }

.er-nav-item {
  display: flex; align-items: center; gap: var(--er-s-2);
  padding: 8px 10px; border-radius: var(--er-r-sm); border: 1px solid transparent;
  font-size: 12.5px; line-height: 18px; color: var(--er-ink-2); cursor: pointer;
  background: transparent; width: 100%; text-align: left; font-family: inherit;
  transition: background .13s ease, color .13s ease, border-color .13s ease;
}
.er-nav-item:hover { background: color-mix(in srgb, var(--er-violet) 7%, transparent); color: var(--er-ink); }
.er-nav-item[aria-current="true"] {
  color: var(--er-ink); font-weight: 600;
  background: color-mix(in srgb, var(--er-violet) 10%, var(--er-card));
  border-color: color-mix(in srgb, var(--er-violet) 26%, transparent);
}
.er-nav-icon { flex: none; display: grid; place-items: center; width: 18px; height: 18px; color: currentColor; opacity: .8; }
.er-nav-icon svg { width: 15px; height: 15px; }
.er-nav-group { margin: var(--er-s-3) 0 var(--er-s-1); padding: 0 10px; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--er-ink-3); }
.er-rail-foot { margin-top: auto; padding-top: var(--er-s-3); }

/* ----------------------------------------------------------------- content */
.er-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.er-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--er-s-5) var(--er-s-6) var(--er-gutter-bottom);
}
.er-page {
  max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--er-s-3);
  /* The page is a flex item of the scroll shell: without this it keeps its
     content's min-content width and the shell scrolls sideways. */
  min-width: 0;
}
.er-topbar { display: flex; align-items: center; gap: var(--er-s-3); }
.er-crumb { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--er-ink-3); min-width: 0; }
.er-crumb-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .5; flex: none; }
.er-topbar-spacer { flex: 1; }

/* ------------------------------------------------------------------ board */
/* The board is one grid; every child is a cell with an explicit span. */
.er-board {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--er-s-3);
  /* stretch, not start: a short cell beside a tall one left a visible notch
     under its border. Rows still size to their tallest cell. */
  align-items: stretch;
}
.er-span-12 { grid-column: span 12; }
.er-span-8 { grid-column: span 8; }
.er-span-6 { grid-column: span 6; }
.er-span-4 { grid-column: span 4; }
.er-span-3 { grid-column: span 3; }

/* ------------------------------------------------------------------- cells */
.er-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* The cell is a grid item: the min-width above lets it shrink, and this
     keeps the box from growing past its column. */
  max-width: 100%;
  padding: var(--er-s-5);
  border-radius: var(--er-r-md);
  border: 1px solid color-mix(in srgb, var(--er-line) 82%, transparent);
  background: var(--er-card);
  box-shadow: var(--er-lift-1);
  transition: box-shadow .15s ease, border-color .15s ease;
}
.er-cell:hover { box-shadow: var(--er-lift-2); border-color: color-mix(in srgb, var(--er-violet) 24%, var(--er-line)); }
/* Area-scaled radius: feature cells are rounder than small ones. */
.er-cell--feature { padding: var(--er-s-6); border-radius: var(--er-r-xl); box-shadow: var(--er-lift-2); }
.er-cell--feature:hover { box-shadow: var(--er-lift-3); }
.er-cell--compact { padding: var(--er-s-4); }
/* Optional emphasis: a tint gradient at ≤12%, never a shadow stack. */
.er-cell--tint {
  background: linear-gradient(158deg,
    color-mix(in srgb, var(--er-violet) 11%, var(--er-card)) 0%,
    var(--er-card) 62%);
}
.er-cell--flush { padding: 0; overflow: hidden; }

/* Content that would otherwise stretch the cell scrolls inside it. */
.er-cell-scroll {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* A visible maximum keeps one long list from owning the whole page. */
  max-height: var(--er-cell-max, 420px);
  /* Room for the scrollbar so text never sits under it. */
  padding-right: 4px;
  /* The list never scrolls sideways: a wide row would draw a second bar. */
  overflow-x: hidden;
}
.er-cell-scroll::-webkit-scrollbar { width: 8px; }
.er-cell-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--er-ink-3) 30%, transparent);
}

.er-card { /* legacy alias kept so older markup keeps the cell surface */
  position: relative; min-width: 0;
  border-radius: var(--er-r-md);
  border: 1px solid color-mix(in srgb, var(--er-line) 82%, transparent);
  background: var(--er-card);
  box-shadow: var(--er-lift-1);
}
.er-card-pad { padding: var(--er-s-5); }
.er-card-head {
  display: flex; align-items: center; gap: var(--er-s-2);
  padding: var(--er-s-4) var(--er-s-5) 0;
}
.er-card-title { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 650; letter-spacing: .01em; color: var(--er-ink); }
.er-card-title svg { width: 14px; height: 14px; color: var(--er-violet); }
.er-card-sub { font-size: 11px; color: var(--er-ink-3); }

/* A cell's own header: eyebrow + figure + support. */
.er-eyebrow {
  display: flex; align-items: center; gap: 6px;
  font-size: 9.5px; font-weight: 600; letter-spacing: .13em; text-transform: uppercase;
  color: var(--er-ink-3);
}
.er-eyebrow svg { width: 12px; height: 12px; color: var(--er-violet); }

/* ------------------------------------------------------------- welcome cell */
.er-welcome { display: flex; flex-direction: column; gap: var(--er-s-4); }
.er-welcome h1 { margin: 0; font-size: 26px; line-height: 33px; font-weight: 720; letter-spacing: -.015em; }
.er-welcome p { margin: 3px 0 0; font-size: 12.5px; line-height: 19px; color: var(--er-ink-2); }
.er-welcome-body { display: flex; align-items: center; gap: var(--er-s-5); flex-wrap: wrap; }
.er-books { position: relative; flex: none; width: 118px; height: 78px; }
.er-books span { position: absolute; left: 0; right: 0; border-radius: var(--er-r-xs); }
.er-books .b3 { bottom: 0; height: 18px; left: 8px; right: 2px; background: linear-gradient(135deg, var(--er-pink-soft), color-mix(in srgb, var(--er-pink) 44%, var(--er-card))); }
.er-books .b2 { bottom: 18px; height: 16px; left: 0; right: 10px; background: linear-gradient(135deg, var(--er-violet-soft), color-mix(in srgb, var(--er-violet) 40%, var(--er-card))); }
.er-books .b1 { bottom: 34px; height: 14px; left: 14px; right: 0; background: linear-gradient(135deg, var(--er-blue-soft), color-mix(in srgb, var(--er-blue) 34%, var(--er-card))); }
.er-books .b0 { bottom: 48px; height: 13px; left: 2px; right: 14px; background: linear-gradient(135deg, var(--er-mint-soft), color-mix(in srgb, var(--er-mint) 30%, var(--er-card))); }
.er-books .open {
  position: absolute; bottom: 20px; left: 30px; width: 58px; height: 40px;
  border-radius: var(--er-r-xs);
  background: linear-gradient(160deg, var(--er-violet-2), var(--er-violet));
  box-shadow: 0 14px 24px -16px color-mix(in srgb, var(--er-violet) 80%, transparent);
}

/* ----------------------------------------------------------------- search */
.er-search {
  display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 11px;
  border-radius: var(--er-r-xs); border: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-card) 88%, var(--er-violet-soft));
}
.er-search svg { width: 14px; height: 14px; color: var(--er-ink-3); flex: none; }
.er-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; font-size: 12px; color: var(--er-ink); }
.er-search input::placeholder { color: var(--er-ink-3); }

/* --------------------------------------------------------- reader band */
/* The band is a flex child of the fill page, so collapsing it hands the freed
   height straight to the reader below: no measurement, no JS. */
.er-page--fill > .er-reader-band { flex: none; }
.er-reader-band--collapsed { padding-top: 10px; padding-bottom: 10px; }
.er-reader-band--collapsed > div { gap: 0; }

/* -------------------------------------------------------------- stat cells */
.er-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--er-s-3); }
.er-stat {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--er-s-3) var(--er-s-4);
  border-radius: var(--er-r-sm);
  background: color-mix(in srgb, var(--er-card) 80%, var(--er-violet-soft));
  border: 1px solid color-mix(in srgb, var(--er-line) 70%, transparent);
}
.er-stat-icon { width: 24px; height: 24px; border-radius: var(--er-r-xs); display: grid; place-items: center; color: var(--er-violet); background: color-mix(in srgb, var(--er-violet) 10%, var(--er-card)); margin-bottom: 4px; }
.er-stat-icon svg { width: 13px; height: 13px; }
.er-stat-value { font-size: 21px; line-height: 26px; font-weight: 720; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.er-stat-value small { font-size: 10.5px; font-weight: 500; color: var(--er-ink-3); margin-left: 3px; }
.er-stat-label { font-size: 10.5px; color: var(--er-ink-3); }
.er-stat-delta { font-size: 10px; color: var(--er-mint); font-weight: 600; }

/* ----------------------------------------------------------- article rows */
.er-row-list { display: flex; flex-direction: column; }
.er-row {
  display: flex; align-items: center; gap: var(--er-s-3); padding: 10px var(--er-s-5);
  border: 1px solid transparent; border-radius: var(--er-r-sm); background: transparent;
  text-align: left; font-family: inherit; color: inherit; width: 100%; cursor: pointer;
  /* A full-width row plus the list's own padding overflowed the box, which
     drew a horizontal scrollbar under the list. */
  box-sizing: border-box; min-width: 0;
  transition: background .13s ease;
}
.er-row:hover { background: color-mix(in srgb, var(--er-violet) 6%, transparent); }
.er-thumb { flex: none; width: 54px; height: 40px; border-radius: var(--er-r-sm); position: relative; overflow: hidden; border: 1px solid color-mix(in srgb, var(--er-line) 60%, transparent); }
.er-thumb::after { content: ""; position: absolute; inset: 0; background: radial-gradient(120% 80% at 22% 8%, color-mix(in srgb, white 42%, transparent), transparent 62%); }
.er-row-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.er-row-title { font-size: 13px; font-weight: 620; line-height: 19px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-row-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--er-ink-3); flex-wrap: wrap; min-width: 0; }
.er-row-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.er-row-side { flex: none; display: flex; align-items: center; gap: var(--er-s-2); font-size: 11px; color: var(--er-ink-3); }

/* The article list fills the page: the cell owns the screen and the list
   scrolls inside it, so the list never grows past the viewport. */
.er-articles-cell { flex: 1; min-height: 0; }
.er-articles-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 8px 6px 14px;
}
.er-articles-list::-webkit-scrollbar { width: 8px; }
.er-articles-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--er-ink-3) 30%, transparent);
}

/* ---------------------------------------------------------------- badges */
.er-badge {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px;
  border-radius: var(--er-r-xs); font-size: 10px; font-weight: 600; letter-spacing: .02em; white-space: nowrap;
  border: 1px solid transparent;
}
.er-badge.blue { color: var(--er-blue); background: var(--er-blue-soft); border-color: color-mix(in srgb, var(--er-blue) 20%, transparent); }
.er-badge.violet { color: var(--er-violet); background: var(--er-violet-soft); border-color: color-mix(in srgb, var(--er-violet) 22%, transparent); }
.er-badge.mint { color: var(--er-mint); background: var(--er-mint-soft); border-color: color-mix(in srgb, var(--er-mint) 24%, transparent); }
.er-badge.amber { color: var(--er-amber); background: var(--er-amber-soft); border-color: color-mix(in srgb, var(--er-amber) 24%, transparent); }
.er-badge.pink { color: var(--er-pink); background: var(--er-pink-soft); border-color: color-mix(in srgb, var(--er-pink) 24%, transparent); }
.er-badge.soft { color: var(--er-ink-2); background: color-mix(in srgb, var(--er-ink-3) 10%, transparent); border-color: var(--er-line); }
.er-badge.neutral, .er-badge.plain { color: var(--er-ink-3); background: transparent; border-color: var(--er-line); }

/* ---------------------------------------------------------------- controls */
.er-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 13px; border-radius: var(--er-r-sm);
  font-family: inherit; font-size: 12px; font-weight: 550; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--er-line); background: var(--er-card); color: var(--er-ink);
  transition: background .13s ease, border-color .13s ease, box-shadow .13s ease;
}
.er-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--er-card) 86%, var(--er-violet-soft)); border-color: color-mix(in srgb, var(--er-violet) 22%, var(--er-line)); }
.er-btn:active:not(:disabled) { box-shadow: inset 0 1px 2px color-mix(in srgb, var(--er-ink) 12%, transparent); }
.er-btn:disabled { opacity: .5; cursor: default; }
.er-btn svg { width: 13px; height: 13px; }
.er-btn.primary {
  border-color: color-mix(in srgb, var(--er-violet) 46%, transparent); color: #fff;
  background: linear-gradient(140deg, var(--er-blue) 0%, var(--er-violet) 62%, var(--er-violet-2) 100%);
  box-shadow: 0 1px 1px color-mix(in srgb, var(--er-violet) 40%, transparent), 0 14px 26px -18px color-mix(in srgb, var(--er-violet) 78%, transparent);
}
.er-btn.primary:hover:not(:disabled) { background: linear-gradient(140deg, var(--er-blue) 0%, var(--er-violet) 58%, var(--er-violet-2) 96%); }
.er-btn.ghost { border-color: transparent; background: transparent; color: var(--er-ink-2); }
.er-btn.ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--er-violet) 8%, transparent); border-color: transparent; }
.er-btn.sm { height: 26px; padding: 0 9px; font-size: 11px; border-radius: var(--er-r-xs); }
.er-btn.icon { width: 28px; height: 28px; padding: 0; }
.er-btn.wide { width: 100%; }

/* ------------------------------------------------------------------- tabs */
.er-tabs { display: flex; align-items: center; gap: 2px; }
.er-tab {
  height: 30px; padding: 0 12px; border-radius: var(--er-r-xs); border: 1px solid transparent;
  background: transparent; color: var(--er-ink-2); font-family: inherit; font-size: 12px; cursor: pointer;
  transition: color .13s ease, background .13s ease;
}
.er-tab:hover { color: var(--er-ink); background: color-mix(in srgb, var(--er-violet) 7%, transparent); }
.er-tab[aria-selected="true"] {
  color: var(--er-ink); font-weight: 620;
  background: var(--er-card); border-color: var(--er-line);
}
.er-tabs-bar {
  display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-3);
  padding: 4px; border-radius: var(--er-r-md);
  background: color-mix(in srgb, var(--er-card) 74%, var(--er-violet-soft));
  border: 1px solid var(--er-line);
}
/* Pin a tab strip to the top of whatever scroll container holds it. The
   negative top and matching padding keep the strip's own border off the edge. */
.er-tabs-sticky {
  position: sticky;
  top: 0;
  z-index: 3;
  /* Opaque so panels scrolling underneath do not show through the strip. */
  background: color-mix(in srgb, var(--er-card) 97%, var(--er-violet-soft));
  box-shadow: 0 6px 12px -10px color-mix(in srgb, var(--er-ink) 40%, transparent);
}

/* ----------------------------------------------------------------- fields */
.er-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.er-field > label,
.er-field-label {
  font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--er-ink-3); line-height: 16px;
}
.er-input, .er-select, .er-textarea {
  width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px;
  border-radius: var(--er-r-xs); border: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-card) 94%, var(--er-violet-soft)); color: var(--er-ink);
  font-family: inherit; font-size: 12px; outline: none;
}
.er-textarea { height: auto; min-height: 104px; padding: 9px 10px; line-height: 19px; resize: vertical; }
.er-input:focus, .er-select:focus, .er-textarea:focus { border-color: color-mix(in srgb, var(--er-violet) 52%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--er-violet) 14%, transparent); }
.er-select {
  appearance: none; padding-right: 26px;
  background-image: linear-gradient(45deg, transparent 50%, var(--er-ink-3) 50%), linear-gradient(135deg, var(--er-ink-3) 50%, transparent 50%);
  background-position: calc(100% - 14px) 14px, calc(100% - 9px) 14px;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.er-check { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--er-ink-2); cursor: pointer; }
.er-check input { width: 14px; height: 14px; accent-color: var(--er-violet); cursor: pointer; margin: 0; }
.er-form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--er-s-3); }
.er-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.er-chip {
  height: 25px; padding: 0 9px; border-radius: var(--er-r-xs); font-family: inherit; font-size: 11px; cursor: pointer;
  border: 1px solid var(--er-line); background: var(--er-card); color: var(--er-ink-2);
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.er-chip:hover { border-color: color-mix(in srgb, var(--er-violet) 28%, var(--er-line)); }
.er-chip[aria-pressed="true"] { color: var(--er-violet); border-color: color-mix(in srgb, var(--er-violet) 42%, transparent); background: var(--er-violet-soft); font-weight: 600; }

/* -------------------------------------------------------------- candidates */
.er-candidate {
  display: flex; align-items: center; gap: var(--er-s-3); padding: 10px var(--er-s-4);
  border-radius: var(--er-r-sm); border: 1px solid var(--er-line); background: var(--er-card);
  transition: border-color .13s ease, box-shadow .13s ease;
}
.er-candidate[data-selected="true"] { border-color: color-mix(in srgb, var(--er-violet) 40%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--er-violet) 12%, transparent); }
/* A candidate that refused to import keeps its reason on the row, so the
   reader sees why instead of a silent no-op. */
.er-candidate[data-failed="true"] { border-color: color-mix(in srgb, var(--er-amber) 45%, transparent); }
.er-candidate-error { margin-top: 4px; font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-state-error-primary); }
.er-candidate .er-thumb { width: 78px; height: 54px; border-radius: var(--er-r-sm); }
.er-reasons { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }

/* ----------------------------------------------------------------- reader */
.er-reader { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: var(--er-s-3); align-items: stretch; }

/* Fill mode: the page is exactly one viewport tall and each pane scrolls
   inside its own border. This is what keeps the reader on one screen. */
.er-scroll--fill { overflow: hidden; display: flex; padding-bottom: var(--er-gutter-bottom); }
.er-page--fill { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.er-page--fill > .er-topbar { flex: none; }

/* The discover page: one tab strip, then a pane that fills the rest of the
   screen and scrolls inside its own border. */
.er-discover-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--er-s-3); }
.er-discover-pane > .er-tabs-bar { flex: none; }
.er-discover-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: var(--er-s-3);
}
.er-discover-spec, .er-discover-results { display: flex; flex-direction: column; gap: var(--er-s-3); }
/* The results board fills the pane and each cell scrolls inside its border, so
   the candidate list uses the whole screen instead of leaving dead space. */
.er-discover-results { flex: 1; min-height: 0; }
.er-discover-results .er-board { flex: 1; min-height: 0; }
.er-discover-results .er-cell { min-height: 0; }
/* The results pane owns the scroll itself, so the board inside it can be
   taller than the viewport without growing the page. */
.er-discover-body--fixed { overflow: hidden; }
.er-discover-body--fixed .er-discover-results { overflow-y: auto; }
.er-discover-results .er-cell-scroll {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
/* The candidate list owns its own gap so the trailing "load more" row sits
   right under the last candidate. */
.er-candidate-scroll { display: flex; flex-direction: column; gap: 8px; }
.er-more { display: flex; justify-content: center; padding: 6px 0 2px; }
.er-more--end { color: var(--er-ink-3); font-size: 11px; }
.er-discover-body::-webkit-scrollbar { width: 8px; }
.er-discover-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--er-ink-3) 32%, transparent);
  border-radius: 999px;
}
.er-discover-body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--er-ink-3) 52%, transparent);
}

.er-reader--fill { flex: 1; min-height: 0; }
.er-reader--fill > .er-cell,
.er-reader--fill > .er-side { min-height: 0; overflow: hidden; }
/* The article pane is a column: fixed header, scrolling body. */
.er-reader--fill > .er-cell { display: flex; flex-direction: column; }
.er-reader--fill .er-pane-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 6px;
}
.er-reader--fill .er-side {
  display: flex;
  flex-direction: column;
  gap: var(--er-s-3);
  /* Fixed frame: the column itself does not scroll, so no border drifts. */
  min-height: 0;
  overflow: hidden;
}
.er-pane-scroll::-webkit-scrollbar,
.er-side-scroll::-webkit-scrollbar { width: 8px; }
.er-pane-scroll::-webkit-scrollbar-thumb,
.er-side-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--er-ink-3) 30%, transparent);
}
/* The main panel of the side column fills the remaining height and scrolls its
   own body. Both branch classes are listed: split uses .er-side-card,
   continuous uses .er-insights, and they must behave identically or one column
   ends shorter than the article beside it. */
.er-reader--fill .er-side > .er-cell.er-side-card,
.er-reader--fill .er-side > .er-cell.er-insights {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* Card bodies scroll inside their fixed border. */
.er-side-card > .er-side-scroll,
.er-insights > .er-insights-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
}
/* Section headings inside the insights cell: the cell owns the only border, so
   these must not draw one of their own. */
.er-insight-section { display: flex; flex-direction: column; gap: 10px; }
.er-insight-head { display: flex; align-items: center; gap: 8px; }
.er-insight-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 650; color: var(--er-ink);
}
.er-insight-title svg { width: 14px; height: 14px; color: var(--er-violet); }
.er-insight-title .er-card-sub { font-weight: 500; }

/* Secondary panels (failure summary, notes) are bounded so they cannot crowd out
   the main one. Both excluded classes are the panels that must fill the column. */
.er-reader--fill .er-side > .er-cell:not(.er-side-card):not(.er-insights) {
  flex: none;
  max-height: 40%;
  overflow-y: auto;
}
.er-article-card { display: flex; flex-direction: column; gap: var(--er-s-4); }
.er-article-title { margin: 0; font-size: 21px; line-height: 29px; font-weight: 700; letter-spacing: -.012em; }
.er-article-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11px; color: var(--er-ink-3); }
/* Back to the publisher: reads as metadata, not as a call to action. */
.er-source-link {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 7px 1px 5px; border-radius: var(--er-r-xs);
  font-size: 10.5px; font-weight: 550; text-decoration: none;
  color: var(--er-violet);
  background: color-mix(in srgb, var(--er-violet) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--er-violet) 22%, transparent);
  transition: background .13s ease, border-color .13s ease;
}
.er-source-link:hover { background: color-mix(in srgb, var(--er-violet) 16%, transparent); border-color: color-mix(in srgb, var(--er-violet) 34%, transparent); }
.er-source-link svg { width: 11px; height: 11px; }
.er-prose { font-size: 14.5px; line-height: 28px; color: var(--er-ink); }
.er-prose p { margin: 0 0 14px; }
.er-prose p:last-child { margin-bottom: 0; }
.er-sentence { cursor: pointer; border-radius: var(--er-r-xs); padding: 1px 2px; margin: 0 -2px; transition: background .13s ease, box-shadow .13s ease; }
.er-sentence:hover { background: color-mix(in srgb, var(--er-blue) 11%, transparent); }
.er-sentence[data-active="true"] { background: color-mix(in srgb, var(--er-violet) 16%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--er-violet) 20%, transparent); }
.er-word { cursor: pointer; border-radius: 4px; padding: 0 1px; border-bottom: 1.5px dotted color-mix(in srgb, var(--er-violet) 50%, transparent); }
.er-word:hover { background: var(--er-violet-soft); }
.er-word[data-known="true"] { border-bottom-color: color-mix(in srgb, var(--er-mint) 66%, transparent); }

.er-side { display: flex; flex-direction: column; gap: var(--er-s-3); min-width: 0; }
.er-side-card { display: flex; flex-direction: column; gap: var(--er-s-3); }
.er-side-head { display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-2); }

/* The side column scrolls as one region, so the sentence panel's own header and
   sentence must pin to the top of that scroll area; without this the panel title
   and the sentence you are reading scroll away with the analysis below them. */
.er-side {
  /* One source of truth for the sticky stack; the sentence header offsets by
     the panel header's measured height. */
  --er-side-head-h: 33px;
}
/* Both the panel title and the sentence it explains are part of the fixed
   frame: they sit outside .er-side-scroll, so no sticky trickery is needed. */
.er-side-card > .er-side-head {
  flex: none;
  padding-bottom: var(--er-s-2);
  border-bottom: 1px solid var(--er-line);
}
.er-side-card > .er-sentence-head {
  flex: none;
  /* Slight tint so the pinned block reads as a header, not as content. */
  background: var(--er-card);
}
.er-side-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; }
.er-side-title svg { width: 14px; height: 14px; color: var(--er-violet); }
.er-sentence-head { font-size: 13px; line-height: 21px; font-weight: 620; padding-bottom: var(--er-s-2); border-bottom: 1px solid var(--er-line); }

/* The note composer ends the panel body instead of pinning to its bottom. */
.er-note-compose {
  margin-top: 2px; padding-top: 12px;
  border-top: 1px dashed var(--er-line);
}

.er-kv { display: flex; flex-direction: column; gap: 3px; }
.er-kv-label { font-size: 9.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--er-ink-3); }
.er-kv-value { font-size: 12px; line-height: 19px; color: var(--er-ink-2); }
.er-token { display: inline-flex; align-items: center; height: 21px; padding: 0 7px; border-radius: var(--er-r-xs); font-size: 11px; background: var(--er-blue-soft); color: var(--er-blue); border: 1px solid color-mix(in srgb, var(--er-blue) 20%, transparent); }
.er-struct { display: flex; flex-direction: column; gap: 6px; }
.er-struct-item { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--er-r-sm); background: color-mix(in srgb, var(--er-violet) 5%, transparent); border: 1px solid var(--er-line); }
.er-struct-type { align-self: flex-start; font-size: 10px; font-weight: 600; color: var(--er-violet); }
.er-struct-text { font-size: 12px; line-height: 19px; color: var(--er-ink); }
.er-en { font-family: var(--ds-font-family-code, inherit); font-size: 11.5px; color: var(--er-ink); }
.er-phonetic { font-family: var(--ds-font-family-code, inherit); font-size: 11px; color: var(--er-ink-3); }

.er-dict-head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.er-dict-word { font-size: 23px; font-weight: 720; letter-spacing: -.022em; }
.er-meaning { display: flex; flex-direction: column; gap: 1px; padding: 7px 0; border-bottom: 1px solid var(--er-line); }
.er-meaning:last-child { border-bottom: none; }
.er-meaning-cn { font-size: 12.5px; font-weight: 550; }
.er-meaning-ctx { font-size: 11px; line-height: 17px; color: var(--er-ink-3); }
.er-example { font-size: 11px; line-height: 17px; color: var(--er-ink-2); padding: 7px 9px; border-radius: var(--er-r-xs); background: var(--er-violet-soft); }

/* --------------------------------------------------------------- progress */
.er-progress { height: 5px; border-radius: var(--er-r-xs); background: color-mix(in srgb, var(--er-ink-3) 14%, transparent); overflow: hidden; }
.er-progress > span { display: block; height: 100%; border-radius: var(--er-r-xs); background: linear-gradient(90deg, var(--er-blue), var(--er-violet)); }
.er-ring { position: relative; width: 88px; height: 88px; display: grid; place-items: center; flex: none; }
.er-ring svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.er-ring-value { font-size: 19px; font-weight: 720; font-variant-numeric: tabular-nums; z-index: 1; }
.er-ring-label { font-size: 10px; color: var(--er-ink-3); z-index: 1; }

/* ----------------------------------------------------------------- study history */
/* A contribution grid: 7 rows (weekdays) x N week columns. Cells are square via
   aspect-ratio so the board stays a grid at any width. */
.er-heat { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.er-heat-rows { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.er-heat-months {
  display: grid; gap: 3px; padding-left: 26px;
  font-size: 9.5px; color: var(--er-ink-3); line-height: 12px;
}
.er-heat-body { display: flex; gap: 6px; min-width: 0; }
.er-heat-weekdays {
  flex: none; display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px;
  font-size: 9px; color: var(--er-ink-3); width: 20px; align-items: center;
}
/* The grid never grows past this height: a year of days is a fixed band, not a
   block that scales with the window width. */
.er-heat-grid { flex: 1; display: grid; gap: 3px; min-width: 0; max-height: 210px; }
.er-heat-week { display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; min-width: 0; }
.er-heat-cell {
  /* Square, sized by its grid track: many columns -> small cells, few columns ->
     larger ones, never taller than the row allows. */
  aspect-ratio: 1;
  width: 100%;
  min-width: 0;
  border-radius: 3px;
  background: color-mix(in srgb, var(--er-ink-3) 12%, transparent);
  border: 1px solid transparent;
  transition: transform .1s ease, border-color .1s ease;
}
.er-heat-cell[data-level="1"] { background: color-mix(in srgb, var(--er-violet) 26%, transparent); }
.er-heat-cell[data-level="2"] { background: color-mix(in srgb, var(--er-violet) 45%, transparent); }
.er-heat-cell[data-level="3"] { background: color-mix(in srgb, var(--er-violet) 66%, transparent); }
.er-heat-cell[data-level="4"] { background: var(--er-violet); }
.er-heat-cell[data-future="true"] { background: transparent; border-color: color-mix(in srgb, var(--er-line) 60%, transparent); }
.er-heat-grid .er-heat-cell:hover { border-color: color-mix(in srgb, var(--er-violet) 70%, transparent); transform: scale(1.18); }
.er-heat-legend { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.er-heat-legend .er-heat-cell { width: 10px; height: 10px; aspect-ratio: auto; }
/* -------------------------------------------------------------- study feed */
.er-feed { display: flex; flex-direction: column; gap: 0; }
.er-feed-headline { margin: 0; font-size: 17px; line-height: 24px; font-weight: 680; letter-spacing: -.01em; }
.er-feed-day { display: flex; flex-direction: column; gap: 6px; padding: 14px 0; }
/* Only the first rule draws a divider: the list reads as one continuous feed. */
.er-feed-day + .er-feed-day { border-top: 1px solid var(--er-line); }
.er-feed-dayhead { display: flex; align-items: center; gap: 8px; }
.er-feed-date { font-size: 12px; font-weight: 650; letter-spacing: .01em; }
.er-feed-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; border-radius: var(--er-r-sm);
  transition: background .12s ease;
}
.er-feed-row:hover { background: color-mix(in srgb, var(--er-violet) 5%, transparent); }
.er-feed-icon {
  flex: none; width: 24px; height: 24px; border-radius: var(--er-r-xs);
  display: grid; place-items: center;
  color: var(--er-violet);
  background: color-mix(in srgb, var(--er-violet) 9%, var(--er-card));
}
.er-feed-icon svg { width: 13px; height: 13px; }
.er-feed-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.er-feed-title { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-feed-meta { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--er-ink-3); flex-wrap: wrap; }
.er-feed-time { flex: none; font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--er-ink-2); }

/* -------------------------------------------------------------- knowledge */
.er-kgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--er-s-3); }
.er-kcard {
  display: flex; flex-direction: column; gap: 6px; padding: var(--er-s-4);
  border-radius: var(--er-r-md); border: 1px solid var(--er-line); background: var(--er-card);
  box-shadow: var(--er-lift-1); cursor: pointer; text-align: left; font-family: inherit; color: inherit;
  transition: box-shadow .13s ease;
}
.er-kcard:hover { box-shadow: var(--er-lift-2); }
.er-kcard-top { display: flex; align-items: baseline; gap: 6px; }
.er-kcard-word { font-size: 15.5px; font-weight: 680; letter-spacing: -.01em; }
.er-kcard-meaning { font-size: 11.5px; line-height: 18px; color: var(--er-ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.er-kcard-foot {
  display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--er-ink-3); margin-top: auto;
}
.er-dots { display: inline-flex; gap: 3px; }
.er-dot { width: 6px; height: 6px; border-radius: 50%; background: color-mix(in srgb, var(--er-ink-3) 22%, transparent); }
.er-dot[data-on="true"] { background: var(--er-mint); }

/* --------------------------------------------------------------- flashcard */
.er-flash {
  display: flex; flex-direction: column; align-items: center; gap: var(--er-s-3);
  padding: var(--er-s-8);
  border-radius: var(--er-r-xl);
  border: 1px solid color-mix(in srgb, var(--er-violet) 20%, var(--er-line));
  background: linear-gradient(158deg, color-mix(in srgb, var(--er-violet) 11%, var(--er-card)) 0%, var(--er-card) 62%);
  box-shadow: var(--er-lift-2);
}
.er-flash-word { font-size: 29px; font-weight: 720; letter-spacing: -.024em; }
.er-flash-answers { display: flex; gap: 7px; flex-wrap: wrap; justify-content: center; }

/* ------------------------------------------------------------ empty/loading */
.er-empty { display: flex; flex-direction: column; align-items: center; gap: var(--er-s-2); padding: 38px var(--er-s-5); text-align: center; }
.er-empty-icon {
  width: 54px; height: 54px; border-radius: var(--er-r-md); display: grid; place-items: center;
  background: linear-gradient(150deg, var(--er-violet-soft), color-mix(in srgb, var(--er-blue) 10%, var(--er-card)));
  border: 1px solid color-mix(in srgb, var(--er-violet) 18%, transparent);
}
.er-empty-icon svg { width: 26px; height: 26px; color: var(--er-violet); }
.er-empty h3 { margin: 0; font-size: 14px; font-weight: 650; }
.er-empty p { margin: 0; font-size: 11.5px; line-height: 18px; color: var(--er-ink-3); max-width: 340px; }
.er-skeleton {
  border-radius: var(--er-r-sm);
  background: linear-gradient(90deg, color-mix(in srgb, var(--er-ink-3) 11%, transparent), color-mix(in srgb, var(--er-ink-3) 3%, transparent), color-mix(in srgb, var(--er-ink-3) 11%, transparent));
  background-size: 200% 100%; animation: er-shimmer 1.5s ease-in-out infinite;
}
@keyframes er-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -20% 0; } }

.er-alert { display: flex; align-items: flex-start; gap: 7px; padding: 9px 11px; border-radius: var(--er-r-sm); font-size: 11.5px; line-height: 18px; }
.er-alert.error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--er-card)); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent); }
.er-alert.ok { color: var(--er-mint); background: var(--er-mint-soft); border: 1px solid color-mix(in srgb, var(--er-mint) 24%, transparent); }
.er-alert.warn { color: var(--er-amber); background: var(--er-amber-soft); border: 1px solid color-mix(in srgb, var(--er-amber) 26%, transparent); }
.er-alert svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }

/* -------------------------------------------------------------------- modal */
.er-scrim { position: fixed; inset: 0; z-index: 900; display: grid; place-items: center; padding: var(--er-s-6); background: var(--dsw-alias-bg-mask-1); backdrop-filter: blur(4px); }
.er-modal {
  width: min(520px, 100%); max-height: 84vh; overflow: auto; display: flex; flex-direction: column; gap: var(--er-s-4);
  padding: var(--er-s-5); border-radius: var(--er-r-xl);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--er-line); box-shadow: var(--er-lift-3);
}
.er-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-2); }
.er-modal-title { font-size: 14px; font-weight: 680; }
.er-modal-foot { display: flex; justify-content: flex-end; gap: var(--er-s-2); }
.er-toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 950; }

/* ----------------------------------------------------------- raw diagnostics */
.er-raw {
  max-height: 210px; overflow: auto; padding: 9px 11px; border-radius: var(--er-r-sm);
  background: var(--dsw-alias-markdown-code-block); border: 1px solid var(--er-line);
  font-family: var(--ds-font-family-code, monospace); font-size: 10.5px; line-height: 16px;
  color: var(--er-ink-2); white-space: pre-wrap; word-break: break-all;
}

/* ---------------------------------------------------------------- settings */
.er-set-row { display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-4); padding: 12px 0; border-bottom: 1px solid var(--er-line); }
.er-set-row:last-child { border-bottom: none; }
.er-set-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
/* A row whose control must span the full width stacks instead of competing for
   space: a 100%-wide control inside a flex row squeezes the label to nothing. */
.er-set-row--stack { flex-direction: column; align-items: stretch; gap: 6px; }
.er-set-row--stack > .er-set-row-text { flex: none; }
.er-set-row-title { font-size: 12.5px; font-weight: 550; }
.er-set-row-desc { font-size: 11px; line-height: 17px; color: var(--er-ink-3); }
.er-mono { font-family: var(--ds-font-family-code, inherit); font-size: 11px; color: var(--er-ink-2); word-break: break-all; }

/* Backup guidance: three paths, each with one line saying what it holds. */
.er-backup-list { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--er-r-sm); border: 1px solid var(--er-line); background: color-mix(in srgb, var(--er-ink-3) 5%, transparent); }
.er-backup-item { display: flex; flex-direction: column; gap: 1px; }
.er-backup-path { font-weight: 550; }

.er-stage-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.er-stage { display: flex; flex-direction: column; gap: 3px; padding: 8px 9px; border-radius: var(--er-r-sm); border: 1px solid var(--er-line); background: var(--er-card); font-size: 10.5px; }
.er-stage-name { font-weight: 650; font-size: 11px; }
/* A one-line subject so two stages showing the same number stay distinguishable. */
.er-stage-hint {
  font-size: 9.5px; line-height: 13px;
  color: var(--er-ink-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.er-stage-status { font-size: 10px; color: var(--er-ink-3); }
.er-stage[data-status="SUCCEEDED"] .er-stage-status { color: var(--er-mint); }
.er-stage[data-status="RUNNING"] .er-stage-status { color: var(--er-blue); }
.er-stage[data-status="FAILED"] .er-stage-status { color: var(--dsw-alias-state-error-primary); }
.er-stage[data-status="NEEDS_REVIEW"] .er-stage-status { color: var(--er-amber); }
.er-stage[data-status="INTERRUPTED"] .er-stage-status { color: var(--er-amber); }
.er-stage[data-status="INTERRUPTED"] { border-color: color-mix(in srgb, var(--er-amber) 38%, var(--er-line)); }

.er-recent-row { display: grid; grid-template-columns: minmax(0, 8fr) minmax(0, 4fr); gap: var(--er-s-3); align-items: stretch; }

/* A failed stage is clickable, so its whole surface is the hit target. */
.er-stage[data-inspectable="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, var(--er-line)); }
.er-stage[data-inspectable="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, var(--er-card)); }
.er-stage-hit {
  display: flex; flex-direction: column; gap: 3px; width: 100%;
  background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit;
  text-align: left; cursor: pointer;
}
.er-stage-hit--static { cursor: default; }
.er-stage-hit:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: var(--er-r-xs); }
.er-stage[data-inspectable="true"] .er-stage-name { display: flex; align-items: center; gap: 4px; }
.er-stage[data-inspectable="true"] .er-stage-name svg { width: 11px; height: 11px; opacity: .7; }
/* "8 句失败": the stage itself may not fail when only some sentences did.
   It sits inside the stage's hit target, so it inherits the browser's form
   font unless it is given the stage's own type scale. */
.er-stage .er-stage-failed-count { font-size: 10px; font-weight: 600; line-height: 13px; color: var(--dsw-alias-state-error-primary); }

/* Stage detail dialog: codes, the reason, and the failing sentences. */
.er-stage-detail { display: flex; flex-direction: column; gap: 12px; padding: 14px var(--er-s-5) 16px; }
.er-stage-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.er-stage-detail-codes { display: flex; flex-direction: column; gap: 8px; }
.er-stage-detail-code { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.er-stage-detail-meaning { font-size: 11.5px; color: var(--er-ink-2); }
.er-stage-detail-msg {
  font-size: 11.5px; line-height: 17px; color: var(--er-ink-2);
  padding: 8px 10px; border-radius: var(--er-r-sm);
  background: color-mix(in srgb, var(--er-ink-3) 8%, transparent);
  word-break: break-word;
}
.er-stage-detail-list { display: flex; flex-direction: column; gap: 6px; }
.er-stage-detail-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-radius: var(--er-r-sm); border: 1px solid var(--er-line);
  background: var(--er-card);
}
.er-stage-detail-text {
  flex: 1; min-width: 0; font-size: 11.5px; line-height: 17px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.er-stage-detail-raw {
  max-height: 160px; overflow: auto; font-size: 10.5px; line-height: 15px;
  padding: 8px 10px; border-radius: var(--er-r-sm);
  border: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-ink-3) 6%, transparent);
  white-space: pre-wrap; word-break: break-word; color: var(--er-ink-2);
}

/* ------------------------------------------------------------- responsive */
@media (max-width: 1180px) {
  .er-board { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .er-span-8 { grid-column: span 6; }
  .er-span-6 { grid-column: span 3; }
  .er-span-4 { grid-column: span 3; }
  .er-span-3 { grid-column: span 2; }
  .er-reader { grid-template-columns: minmax(0, 1fr); }
  .er-recent-row { grid-template-columns: minmax(0, 1fr); }
  .er-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .er-stage-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  .er-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .er-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .er-span-12, .er-span-8, .er-span-6, .er-span-4, .er-span-3 { grid-column: span 2; }
  .er-rail { width: 60px; padding: var(--er-s-3) var(--er-s-2); }
  .er-brand-name, .er-brand-sub, .er-nav-group, .er-nav-label { display: none; }
  .er-nav-item { justify-content: center; padding: 8px 0; }
  .er-scroll { padding: var(--er-s-4) var(--er-s-4) var(--er-gutter-bottom); }
}
@media (prefers-reduced-motion: reduce) {
  .er-root *, .er-root *::before, .er-root *::after { transition: none !important; animation: none !important; }
}
`;


// ---- src/30-icons.js ----
/** Inline icon set — stroke icons drawn in the plugin's own hand, no host imports. */

/**
 * One 24x24 stroke icon.
 * @param {object} props {path: JSX children, size}.
 * @returns {object} svg element.
 */
function Icon({ children, size = 16 }) {
  return React.createElement('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true,
  }, children);
}

const Icons = {
  home: () => React.createElement(Icon, null, React.createElement('path', { d: 'M4 11 12 4l8 7' }), React.createElement('path', { d: 'M6.5 10v9h11v-9' })),
  compass: () => React.createElement(Icon, null,
    React.createElement('circle', { cx: 12, cy: 12, r: 8.2 }),
    React.createElement('path', { d: 'M15.4 8.6 13.6 13.6 8.6 15.4l1.8-5z' })),
  book: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M5 5.6c0-1 .8-1.6 1.8-1.3L12 6v14l-5.2-1.2C5.8 18.5 5 17.9 5 16.9z' }),
    React.createElement('path', { d: 'M19 5.6c0-1-.8-1.6-1.8-1.3L12 6v14l5.2-1.2c1-.3 1.8-.9 1.8-1.9z' })),
  letters: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M4 17 7.6 7l3.6 10' }),
    React.createElement('path', { d: 'M5.6 13.4h4' }),
    React.createElement('path', { d: 'M14 17V7' }),
    React.createElement('path', { d: 'M14 11.4c1.6-1.6 3.6-1.6 5 0' })),
  link: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M10.5 13.5a3.4 3.4 0 0 0 4.8 0l2.2-2.2a3.4 3.4 0 0 0-4.8-4.8L11.4 7.8' }),
    React.createElement('path', { d: 'M13.5 10.5a3.4 3.4 0 0 0-4.8 0L6.5 12.7a3.4 3.4 0 0 0 4.8 4.8l1.3-1.3' })),
  puzzle: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M9 5.5a2 2 0 0 1 4 0v.8h2.3a1 1 0 0 1 1 1v2.4h.8a2 2 0 0 1 0 4h-.8v2.4a1 1 0 0 1-1 1h-2.6v-.8a2 2 0 0 0-4 0v.8H6.9a1 1 0 0 1-1-1v-2.6h.8a2 2 0 0 0 0-4H5.9v-2.4a1 1 0 0 1 1-1H9z' })),
  quote: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M9 7H6.4c-.8 0-1.4.6-1.4 1.4V12h3.2v5H4.5v-5' }),
    React.createElement('path', { d: 'M19 7h-2.6c-.8 0-1.4.6-1.4 1.4V12h3.2v5h-3.7v-5' })),
  layers: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 5 4.5 9 12 13l7.5-4z' }),
    React.createElement('path', { d: 'M4.5 13 12 17l7.5-4' })),
  refresh: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M19 8.5A8 8 0 0 0 5.4 7' }),
    React.createElement('path', { d: 'M5 12.2A8 8 0 0 0 18.6 17' }),
    React.createElement('path', { d: 'M4.4 6.6v4h4' }),
    React.createElement('path', { d: 'M19.6 17.4v-4h-4' })),
  settings: () => React.createElement(Icon, null,
    React.createElement('circle', { cx: 12, cy: 12, r: 3.2 }),
    React.createElement('path', { d: 'M12 4.4v2M12 17.6v2M4.4 12h2M17.6 12h2M6.6 6.6l1.4 1.4M16 16l1.4 1.4M17.4 6.6 16 8M8 16l-1.4 1.4' })),
  search: () => React.createElement(Icon, null,
    React.createElement('circle', { cx: 10.8, cy: 10.8, r: 6 }),
    React.createElement('path', { d: 'm15.2 15.2 4 4' })),
  star: ({ filled } = {}) => React.createElement(Icon, null,
    React.createElement('path', {
      d: 'm12 4.6 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 10.3l5.4-.8z',
      fill: filled ? 'currentColor' : 'none',
    })),
  speaker: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M5 10v4h2.4L12 18V6l-4.6 4z' }),
    React.createElement('path', { d: 'M15.4 9a4 4 0 0 1 0 6' }),
    React.createElement('path', { d: 'M17.8 6.8a7 7 0 0 1 0 10.4' })),
  arrowLeft: () => React.createElement(Icon, null, React.createElement('path', { d: 'M19 12H5.4' }), React.createElement('path', { d: 'm10 7-5 5 5 5' })),
  arrowRight: () => React.createElement(Icon, null, React.createElement('path', { d: 'M5 12h13.6' }), React.createElement('path', { d: 'm14 7 5 5-5 5' })),
  plus: () => React.createElement(Icon, null, React.createElement('path', { d: 'M12 5.6v12.8M5.6 12h12.8' })),
  check: () => React.createElement(Icon, null, React.createElement('path', { d: 'm4.8 12.6 4.6 4.6L19.2 7.4' })),
  close: () => React.createElement(Icon, null, React.createElement('path', { d: 'M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6' })),
  chevron: ({ dir = 'down' } = {}) => React.createElement(Icon, null,
    React.createElement('path', {
      d: dir === 'up' ? 'm7 14.4 5-5 5 5' : 'm7 9.6 5 5 5-5',
    })),
  clock: () => React.createElement(Icon, null, React.createElement('circle', { cx: 12, cy: 12, r: 7.8 }), React.createElement('path', { d: 'M12 7.6V12l3 2' })),
  flame: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 4.4c3.4 3 5.4 5.4 5.4 8.6a5.4 5.4 0 0 1-10.8 0c0-1.6.8-3 2-4.2.6 1 1 1.8 1.2 2.8 1-2.2 1.4-3.4 2.2-7.2z' })),
  bookOpen: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 6.4C10 5 7.4 4.6 5 5v12c2.4-.4 5 0 7 1.4' }),
    React.createElement('path', { d: 'M12 6.4C14 5 16.6 4.6 19 5v12c-2.4-.4-5 0-7 1.4' })),
  grid: () => React.createElement(Icon, null,
    React.createElement('rect', { x: 4.4, y: 4.4, width: 6.4, height: 6.4, rx: 1.6 }),
    React.createElement('rect', { x: 13.2, y: 4.4, width: 6.4, height: 6.4, rx: 1.6 }),
    React.createElement('rect', { x: 4.4, y: 13.2, width: 6.4, height: 6.4, rx: 1.6 }),
    React.createElement('rect', { x: 13.2, y: 13.2, width: 6.4, height: 6.4, rx: 1.6 })),
  target: () => React.createElement(Icon, null,
    React.createElement('circle', { cx: 12, cy: 12, r: 8 }),
    React.createElement('circle', { cx: 12, cy: 12, r: 4 }),
    React.createElement('circle', { cx: 12, cy: 12, r: 0.6, fill: 'currentColor' })),
  note: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M6 4.6h9l4 4V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1z' }),
    React.createElement('path', { d: 'M14.6 4.8v4.4h4' }),
    React.createElement('path', { d: 'M8 13.6h7M8 16.6h5' })),
  columns: () => React.createElement(Icon, null,
    React.createElement('rect', { x: 4.4, y: 5.2, width: 15.2, height: 13.6, rx: 1.8 }),
    React.createElement('path', { d: 'M12 5.2v13.6' })),
  trash: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M5.6 7.4h12.8' }),
    React.createElement('path', { d: 'M9.4 7.4V5.6a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.8' }),
    React.createElement('path', { d: 'M7.2 7.4l.8 11a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l.8-11' })),
  download: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 4.6v10.4' }),
    React.createElement('path', { d: 'm8 11 4 4 4-4' }),
    React.createElement('path', { d: 'M5.4 18.4h13.2' })),
  upload: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 18.4V8' }),
    React.createElement('path', { d: 'm8 11 4-4 4 4' }),
    React.createElement('path', { d: 'M5.4 4.6h13.2' })),
  sparkle: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 4.4l1.8 4.4 4.4 1.8-4.4 1.8L12 16.8l-1.8-4.4L5.8 10.6l4.4-1.8z' }),
    React.createElement('path', { d: 'M18.4 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' })),
  /** A brush: cleaning the body of a stored article. */
  broom: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M14.8 3.8 20.2 9.2l-2.4 2.4-5.4-5.4z' }),
    React.createElement('path', { d: 'M11.4 7.2 16.8 12.6l-4.2 6.2a2.4 2.4 0 0 1-3.4 0l-.2-.2a2.4 2.4 0 0 1 0-3.4z' }),
    React.createElement('path', { d: 'M5.4 19.4h13.2' })),
  warning: () => React.createElement(Icon, null,
    React.createElement('path', { d: 'M12 4.8 20 18.4H4z' }),
    React.createElement('path', { d: 'M12 9.6v3.6M12 15.8v.4' })),
  info: () => React.createElement(Icon, null,
    React.createElement('circle', { cx: 12, cy: 12, r: 8 }),
    React.createElement('path', { d: 'M12 11v5M12 8.2v.4' })),
  more: () => React.createElement(Icon, null,
    React.createElement('circle', { cx: 6.4, cy: 12, r: 1.2, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12, cy: 12, r: 1.2, fill: 'currentColor' }),
    React.createElement('circle', { cx: 17.6, cy: 12, r: 1.2, fill: 'currentColor' })),
  copy: () => React.createElement(Icon, null,
    React.createElement('rect', { x: 8.4, y: 8.4, width: 10, height: 10, rx: 1.6 }),
    React.createElement('path', { d: 'M15.6 8.4V6.4a1.6 1.6 0 0 0-1.6-1.6H6.4A1.6 1.6 0 0 0 4.8 6.4v7.6a1.6 1.6 0 0 0 1.6 1.6h2' })),
};


// ---- src/40-ui.js ----
/** Shared primitives: cards, badges, buttons, empty states, dialogs, flash messages. */

/** Create one element. */
const h = React.createElement;

/** Span class for one bento cell, per the design spec table. */
const SPANS = { 12: 'er-span-12', 8: 'er-span-8', 6: 'er-span-6', 4: 'er-span-4', 3: 'er-span-3' };

/**
 * The board: one CSS grid, twelve columns at desktop.
 * Children must carry an explicit `span` so composition stays declarative.
 * @param {object} props `{ children }`.
 */
function Board({ children }) {
  return h('div', { className: 'er-board' }, children);
}

/**
 * One bento cell.
 * @param {object} props
 * @param {number} span columns out of 12.
 * @param {'feature'|'compact'|undefined} size radius/padding class.
 * @param {boolean} tint adds the ≤12% emphasis gradient.
 * @param {boolean} flush removes padding (for lists that own their edges).
 * @param {string} eyebrow small uppercase subject line.
 */
function Cell({ span = 12, size, tint = false, flush = false, eyebrow, icon, title, actions, children, className = '' }) {
  const classes = ['er-cell', SPANS[span] ?? SPANS[12],
    size === 'feature' ? 'er-cell--feature' : '', size === 'compact' ? 'er-cell--compact' : '',
    tint ? 'er-cell--tint' : '', flush ? 'er-cell--flush' : '', className].filter(Boolean).join(' ');
  const head = (eyebrow || title) ? h('div', {
    className: eyebrow ? 'er-eyebrow' : 'er-card-title',
    style: { padding: flush ? undefined : undefined, marginBottom: 12 },
  }, icon ?? null, h('span', null, eyebrow ?? title), actions ? h('div', { className: 'er-topbar-spacer' }) : null, actions ?? null) : null;
  return h('section', { className: classes }, head, children);
}

/** Card surface with an optional titled header. */
function Card({ title, icon, sub, actions, children, pad = true, className = '' }) {
  return h('section', { className: `er-card ${className}` },
    (title || actions) && h('div', { className: 'er-card-head' },
      h('div', { className: 'er-card-title' }, icon, h('span', null, title), sub && h('span', { className: 'er-card-sub' }, sub)),
      h('div', { className: 'er-topbar-spacer' }),
      actions),
    pad ? h('div', { className: 'er-card-pad' }, children) : children);
}

/** Small status pill. */
function Badge({ tone = 'soft', children }) {
  return h('span', { className: `er-badge ${tone}` }, children);
}

/** Button with variants; `variant` ∈ primary|default|ghost. */
function Button({
  variant = 'default', size, icon, iconOnly, wide, onClick, disabled, children,
  type = 'button', title, ariaLabel, ariaExpanded, testId,
}) {
  const classes = ['er-btn', variant === 'primary' ? 'primary' : '', variant === 'ghost' ? 'ghost' : '',
    size === 'sm' ? 'sm' : '', iconOnly ? 'icon' : '', wide ? 'wide' : ''].filter(Boolean).join(' ');
  return h('button', {
    type,
    className: classes,
    onClick,
    disabled: disabled === true,
    // Explicit list, not a spread: a plugin-only prop (a stray `t`, a callback)
    // must never reach the DOM element as an invalid attribute.
    title,
    'aria-label': ariaLabel ?? (iconOnly && typeof children === 'string' ? children : undefined),
    'aria-expanded': ariaExpanded,
    'data-testid': testId,
  }, icon ?? null, iconOnly ? null : children);
}

/** Empty state with an icon, copy and one call to action. */
function Empty({ icon, title, description, action }) {
  return h('div', { className: 'er-empty' },
    h('div', { className: 'er-empty-icon' }, icon),
    h('h3', null, title),
    description && h('p', null, description),
    action);
}

/** Inline alert. */
function Alert({ tone = 'error', children }) {
  const icon = tone === 'ok' ? h(Icons.check, null) : tone === 'warn' ? h(Icons.warning, null) : h(Icons.warning, null);
  return h('div', { className: `er-alert ${tone}`, role: tone === 'error' ? 'alert' : 'status' }, icon, h('div', null, children));
}

/** Shimmer placeholder block. */
function Skeleton({ height = 16, width = '100%', radius = 10 }) {
  return h('div', { className: 'er-skeleton', style: { height, width, borderRadius: radius } });
}

/** A labelled form field wrapper. */
function Field({ label, children, className = '' }) {
  return h('div', { className: `er-field ${className}` }, h('label', null, label), children);
}

/** Segmented tab strip. */
function Tabs({ items, value, onChange, trailing, sticky = false }) {
  return h('div', { className: sticky ? 'er-tabs-bar er-tabs-sticky' : 'er-tabs-bar' },
    h('div', { className: 'er-tabs', role: 'tablist' },
      items.map((item) => h('button', {
        key: item.id, type: 'button', role: 'tab', className: 'er-tab',
        'aria-selected': value === item.id,
        onClick: () => onChange(item.id),
      }, item.label))),
    trailing);
}

/** Modal dialog with Escape handling and a scrim. */
function Dialog({ title, onClose, children, footer }) {
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return h('div', { className: 'er-scrim', onClick: onClose },
    h('div', {
      className: 'er-modal', role: 'dialog', 'aria-modal': true, 'aria-label': title,
      onClick: (event) => event.stopPropagation(),
    },
    h('div', { className: 'er-modal-head' },
      h('div', { className: 'er-modal-title' }, title),
      h(Button, { variant: 'ghost', iconOnly: true, onClick: onClose, children: 'Close' }, h(Icons.close, null))),
    children,
    footer && h('div', { className: 'er-modal-foot' }, footer)));
}

/** Article artwork block used by cards and rows. */
function Thumb({ id, className = '', style }) {
  return h('div', { className: `er-thumb ${className}`, style: { background: artGradient(id), ...style }, 'aria-hidden': true });
}

/** Five-dot mastery indicator. */
function Mastery({ level }) {
  return h('span', { className: 'er-dots', 'aria-label': `掌握程度 ${level}/4` },
    [0, 1, 2, 3].map((index) => h('span', { key: index, className: 'er-dot', 'data-on': index < level })));
}

/** Progress ring for reading completion. */
function ProgressRing({ ratio, label }) {
  const size = 92;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  return h('div', { className: 'er-ring' },
    h('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
      h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'var(--er-line)', strokeWidth: 8 }),
      h('circle', {
        cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'url(#er-ring-grad)', strokeWidth: 8,
        strokeDasharray: circumference, strokeDashoffset: offset, strokeLinecap: 'round',
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
      h('defs', null,
        h('linearGradient', { id: 'er-ring-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0', stopColor: 'var(--er-blue)' }),
          h('stop', { offset: '1', stopColor: 'var(--er-violet)' }))),
      ),
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
      h('div', { className: 'er-ring-value' }, `${Math.round(ratio * 100)}%`),
      label !== undefined && h('div', { className: 'er-ring-label' }, label)));
}

/** Horizontal progress bar. */
function Progress({ ratio }) {
  return h('div', { className: 'er-progress', role: 'progressbar', 'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('span', { style: { width: `${Math.max(1, Math.round(ratio * 100))}%` } }));
}


// ---- src/50-dashboard.js ----
/** Dashboard: study overview, recent reading, and the analysis queue. */

/** One statistic tile. */
function StatTile({ icon, value, unit, label, delta, tone }) {
  return h('div', { className: 'er-stat' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('div', { className: 'er-stat-icon', style: tone ? { color: tone } : undefined }, icon),
      h('div', { className: 'er-stat-label' }, label)),
    h('div', { className: 'er-stat-value' }, String(value), unit && h('small', null, unit)),
    delta && h('div', { className: 'er-stat-delta' }, delta));
}

/** Welcome cell: greeting, search and the study counters. */
function Welcome({ t, onSearch, stats }) {
  // The display name is cosmetic, so it loads on its own: a signed-out account
  // or a slow lookup must never delay the greeting or the counters.
  const account = useLoad(() => call('accountName').catch(() => null), []);
  const name = typeof account.data === 'string' && account.data.trim().length > 0
    ? account.data.trim()
    : null;
  return h(Cell, { span: 12, size: 'feature', tint: true, className: 'er-welcome' },
    h('div', { className: 'er-topbar' },
      h('div', null,
        h('div', { className: 'er-eyebrow' }, h(Icons.sparkle, null), t('home.overview')),
        // With a name: "你好，小明". Without: "你好" alone — no placeholder word.
        h('h1', null, name === null ? t('home.greetingPlain') : `${t('home.greetingPrefix')}${name}`),
        h('p', null, t('home.tagline'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('div', { style: { width: 224 } },
        h('div', { className: 'er-search' },
          h(Icons.search, null),
          h('input', {
            type: 'search', placeholder: t('home.searchPlaceholder'),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && event.currentTarget.value.trim().length > 0) {
                onSearch(event.currentTarget.value.trim());
              }
            },
          })))),
    // The greeting's own totals are the four tiles below, so no extra summary
    // line is repeated and no duplicate entry points are offered.
    h('div', { className: 'er-stats' },
      stats.map((stat) => h(StatTile, { key: stat.label, ...stat }))));
}

/** Recent reading cells: an 8-column list beside a 4-column progress ring. */
function RecentReading({ t, articles, onOpen, progress }) {
  const rows = articles.slice(0, 3);
  let rowNodes;
  if (rows.length === 0) {
    rowNodes = h('div', { style: { padding: '4px 0' } }, h('p', { className: 'er-card-sub' }, t('home.recentEmpty')));
  } else {
    rowNodes = rows.map((article) => h('button', {
      key: article.id,
      className: 'er-row',
      onClick: () => onOpen(article.id),
    },
    h(Thumb, { id: article.id }),
    h('div', { className: 'er-row-body' },
      h('div', { className: 'er-row-title' }, article.title),
      h('div', { className: 'er-row-meta' },
        h(Badge, { tone: cefrTone(article.cefrLevel) }, article.cefrLevel ?? '—'),
        h('span', null, article.topic ?? 'Reading'),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, `${article.readingMinutes} ${t('common.minutes')}`),
        h(Badge, {
          tone: article.readingStatus === 'completed' ? 'mint' : 'violet',
        }, READING_LABELS[article.readingStatus] ?? '未读')))));
  }

  return [
    h(Cell, {
      key: 'recent', span: 8, eyebrow: t('home.recent'), icon: h(Icons.star, { filled: true }),
    },
    h('div', { className: 'er-row-list er-cell-scroll', style: { '--er-cell-max': '232px' } }, rowNodes)),
    h(Cell, {
      key: 'progress', span: 4, eyebrow: t('home.overallLabel'), icon: h(Icons.target, null),
      className: 'er-progress-cell',
    },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 14,
        flex: 1, justifyContent: 'center', minHeight: 0,
      },
    },
    h(ProgressRing, { ratio: progress.ratio, label: t('home.overall') }),
    h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
      h(Progress, { ratio: progress.ratio }),
      h('span', { className: 'er-card-sub' }, t('home.overallHint'))))),
  ];
}

/**
 * Dashboard study block: the very same heatmap card the history page renders.
 *
 * No separate component and no compact variant — the dashboard simply loads the
 * activity and hands it to `StudyHeatmapCard`, adding only a link out.
 */
function StudyMini({ t, onNavigate }) {
  const data = useLoad(() => call('studyActivity', { days: 364 }), []);
  const activity = data.data;
  if (data.status === 'loading' && !activity) {
    return h(Cell, { span: 12, eyebrow: t('history.gridTitle'), icon: h(Icons.grid, null) },
      h(Skeleton, { height: 120, radius: 12 }));
  }
  if (data.status === 'error') {
    return h(Cell, { span: 12, eyebrow: t('history.gridTitle'), icon: h(Icons.grid, null) },
      h(Alert, null, data.error.message));
  }
  return h(StudyHeatmapCard, {
    t,
    activity,
    actions: h(Button, {
      size: 'sm', variant: 'ghost', onClick: () => onNavigate('history'),
    }, t('home.studyMore')),
  });
}

/** The whole dashboard page. */
function Dashboard({ t, onNavigate, onOpen }) {
  const data = useLoad(() => call('dashboard'), []);
  const progress = useLoad(async () => {
    const list = await call('listArticles', { limit: 200 });
    const ratios = list.items.map((item) => (item.readingStatus === 'completed' ? 1 : item.readingStatus === 'reading' ? 0.45 : 0));
    return { ratio: ratios.length === 0 ? 0 : ratios.reduce((sum, value) => sum + value, 0) / ratios.length };
  }, [data.data]);
  if (data.status === 'loading' && !data.data) {
    return h('div', { className: 'er-page' },
      h(Skeleton, { height: 176, radius: 20 }), h(Skeleton, { height: 128, radius: 18 }));
  }
  if (data.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, data.error.message),
      h('div', null, h(Button, { onClick: data.reload }, t('common.retry'))));
  }
  const stats = data.data;
  const tiles = [
    { icon: h(Icons.bookOpen, null), value: stats.articles, label: t('home.statArticles'), delta: t('home.statArticlesDelta') },
    { icon: h(Icons.star, null), value: stats.favoriteWords, label: t('home.statWords'), delta: t('home.statWordsDelta') },
    { icon: h(Icons.clock, null), value: Math.round((stats.readingMinutes / 60) * 10) / 10, unit: t('common.hours'), label: t('home.statTime'), delta: t('home.statTimeDelta') },
    { icon: h(Icons.flame, null), value: stats.streakDays, unit: t('common.days'), label: t('home.statStreak'), delta: t('home.statStreakDelta') },
  ];
  return h('div', { className: 'er-page' },
    h(Board, null,
      h(Welcome, { t, stats: tiles, onSearch: (value) => onNavigate('articles', { search: value }) }),
      ...RecentReading({ t, articles: stats.recent, onOpen, progress: progress.data ?? { ratio: 0 } }),
      h(StudyMini, { t, onNavigate })));
}


// ---- src/60-discover.js ----
/**
 * Collection profile form.
 *
 * Six controls, matching the product specification:
 * 1. CEFR range (A1–C2, multi-select, default B1–B2)
 * 2. Sources (multi-select from the registry, default all)
 * 3. Publication window (24h / 7d / 30d / custom, default 7d)
 * 4. Article types (multi-select, default all)
 * 5. Sensitive-content filter (single choice, default on)
 * 6. Word-count range (default 800–1500)
 *
 * The registry arrives from the Host (`settings.collection`), so this form never
 * hard-codes a publisher list that could drift from the strategy table.
 */

/** Toggle one value inside an array. */
function toggleValue(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** How many candidates one page holds. */
const PAGE_SIZE = 30;

/** A labelled block of checkable chips. */
function ChipGroup({ t, label, options, selected, onToggle, onAll, onNone, hint }) {
  return h('div', { className: 'er-field' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('label', { className: 'er-field-label' }, label),
      selected.length > 0 ? h('span', { className: 'er-card-sub' }, `${selected.length}/${options.length}`) : null,
      h('div', { className: 'er-topbar-spacer' }),
      h(Button, { size: 'sm', variant: 'ghost', onClick: onAll }, t('discover.selectAll')),
      h(Button, { size: 'sm', variant: 'ghost', onClick: onNone }, t('discover.selectNone')),
    ),
    hint ? h('div', { className: 'er-card-sub', style: { marginBottom: 2 } }, hint) : null,
    h('div', { className: 'er-chips' },
      options.map((option) => h('button', {
        key: option.id,
        type: 'button',
        className: 'er-chip',
        'aria-pressed': selected.includes(option.id),
        title: option.title ?? undefined,
        onClick: () => onToggle(option.id),
      }, option.label))));
}

/** Profile controls shared by the discovery form. */
function ProfileForm({ t, profile, collection, onChange }) {
  const update = (patch) => onChange({ ...profile, ...patch });
  const range = profile.levelRange ?? ['B1', 'B2'];
  const levels = collection?.cefrLevels ?? ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const sources = collection?.sources ?? [];
  const types = collection?.articleTypes ?? [];
  const windows = [
    { id: '24h', days: 1, label: t('discover.window24h') },
    { id: '7d', days: 7, label: t('discover.window7d') },
    { id: '30d', days: 30, label: t('discover.window30d') },
    { id: 'custom', days: null, label: t('discover.windowCustom') },
  ];
  const window = profile.publishedWindow ?? '7d';

  /**
   * Select a level: clicking outside the current range extends it, clicking a
   * boundary shrinks it. This keeps one inclusive A→B span rather than a
   * scattered set, which is what "CEFR A1–C2 多选" means in practice.
   */
  const pickLevel = (level) => {
    const index = levels.indexOf(level);
    const low = levels.indexOf(range[0]);
    const high = levels.indexOf(range[1]);
    if (index >= low && index <= high) {
      // Shrinking: move the nearer boundary inward.
      if (range[0] === range[1]) return;
      if (index === low) return update({ levelRange: [levels[index + 1], range[1]] });
      if (index === high) return update({ levelRange: [range[0], levels[index - 1]] });
      return update({ levelRange: [range[0], levels[Math.max(0, index - 1)]] });
    }
    if (index < low) return update({ levelRange: [level, range[1]] });
    if (index > high) return update({ levelRange: [range[0], level] });
    return undefined;
  };

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    // 1. How many articles this run should collect
    h('div', { className: 'er-field' },
      h('label', null, t('discover.articleCount')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('input', {
          className: 'er-input', type: 'number', min: 1, max: 20, step: 1, style: { width: 96 },
          value: profile.articleCount ?? 1,
          onChange: (event) => {
            const raw = Number(event.target.value);
            // Keep the field usable while typing: clamp only to a legal integer.
            update({ articleCount: Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.round(raw))) : 1 });
          },
        }),
        h('span', { className: 'er-card-sub' }, t('discover.articleCountUnit')),
        h('div', { className: 'er-chips', style: { marginLeft: 6 } },
          [1, 3, 5, 10].map((value) => h('button', {
            key: value, type: 'button', className: 'er-chip',
            'aria-pressed': (profile.articleCount ?? 1) === value,
            onClick: () => update({ articleCount: value }),
          }, String(value)))),
        h('div', { className: 'er-topbar-spacer' }),
      ),
      h('div', { className: 'er-card-sub' }, t('discover.articleCountHint'))),

    // 2. CEFR range
    h('div', { className: 'er-field' },
      h('label', null, t('discover.levelRange'), ' ', h('span', { className: 'er-card-sub' }, `${range[0]} – ${range[1]}`)),
      h('div', { className: 'er-chips' },
        levels.map((level) => {
          const inside = levels.indexOf(level) >= levels.indexOf(range[0])
            && levels.indexOf(level) <= levels.indexOf(range[1]);
          return h('button', {
            key: level, type: 'button', className: 'er-chip',
            'aria-pressed': inside,
            onClick: () => pickLevel(level),
          }, level);
        }))),

    // 2. Sources
    h(ChipGroup, {
      t, label: t('discover.sources'), hint: t('discover.sourcesHint'),
      options: sources.map((source) => ({
        id: source.id,
        // An unhealthy source stays selectable but says so up front.
        label: source.health && source.health.ok === false
          ? `${source.name} ⚠`
          : source.name,
        title: [
          source.name,
          source.paywalled ? '可能需订阅' : '',
          source.health && source.health.ok === false ? `上次失败：${source.health.code}` : '',
          source.note ?? '',
        ].filter(Boolean).join(' · '),
      })),
      selected: profile.sourceIds ?? [],
      onToggle: (id) => update({ sourceIds: toggleValue(profile.sourceIds ?? [], id) }),
      onAll: () => update({ sourceIds: sources.map((source) => source.id) }),
      onNone: () => update({ sourceIds: [] }),
    }),

    // 3. Publication window
    h('div', { className: 'er-field' },
      h('label', null, t('discover.window')),
      h('div', { className: 'er-chips' },
        windows.map((item) => h('button', {
          key: item.id, type: 'button', className: 'er-chip',
          'aria-pressed': window === item.id,
          onClick: () => update({
            publishedWindow: item.id,
            publishedWithinDays: item.days ?? profile.publishedWithinDays ?? 7,
          }),
        }, item.label)),
        window === 'custom' && h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 } },
          h('input', {
            className: 'er-input', type: 'number', min: 1, max: 3650, style: { width: 92 },
            value: profile.publishedWithinDays ?? 7,
            onChange: (event) => update({ publishedWithinDays: Math.max(1, Number(event.target.value) || 1) }),
          }),
          h('span', { className: 'er-card-sub' }, t('discover.days')))),
      h('div', { className: 'er-card-sub' }, t('discover.windowHint'))),

    // 4. Article types
    h(ChipGroup, {
      t, label: t('discover.types'),
      options: types.map((type) => ({ id: type, label: t(`type.${type}`, { fallback: type }) })),
      selected: profile.types ?? [],
      onToggle: (id) => update({ types: toggleValue(profile.types ?? [], id) }),
      onAll: () => update({ types: [...types] }),
      onNone: () => update({ types: [] }),
    }),

    // 5. Sensitive-content filter
    h('div', { className: 'er-field' },
      h('label', null, t('discover.sensitive')),
      h('div', { className: 'er-chips' },
        [{ value: true, label: t('discover.sensitiveOn') }, { value: false, label: t('discover.sensitiveOff') }]
          .map((option) => h('button', {
            key: String(option.value), type: 'button', className: 'er-chip',
            'aria-pressed': (profile.filterSensitive !== false) === option.value,
            onClick: () => update({ filterSensitive: option.value }),
          }, option.label))),
      h('div', { className: 'er-card-sub' }, t('discover.sensitiveHint'))),

    // 6. Word count: no limit by default, or an explicit range.
    h('div', { className: 'er-field' },
      h('label', { className: 'er-field-label' }, t('discover.wordRange')),
      h('div', { className: 'er-chips' },
        [{ value: 'unlimited', label: t('discover.wordUnlimited') },
          { value: 'range', label: t('discover.wordRangeOption') }]
          .map((option) => h('button', {
            key: option.value,
            type: 'button',
            className: 'er-chip',
            'aria-pressed': (profile.wordLimitMode === 'range') === (option.value === 'range'),
            onClick: () => {
              // Only act when the mode actually changes: re-clicking the active
              // option must not resurrect a switch the learner turned off.
              if ((profile.wordLimitMode === 'range') === (option.value === 'range')) return;
              update({
                wordLimitMode: option.value,
                // Entering a range turns truncation on (the friendly default);
                // leaving clears it so the profile never claims a behaviour that
                // cannot apply.
                truncate: option.value === 'range',
              });
            },
          }, option.label))),
      profile.wordLimitMode === 'range'
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              className: 'er-input', type: 'number', min: 50, max: 5000, style: { width: 100 },
              value: profile.minWords ?? 800,
              onChange: (event) => update({ minWords: Math.max(1, Number(event.target.value) || 1) }),
            }),
            h('span', { className: 'er-card-sub' }, '–'),
            h('input', {
              className: 'er-input', type: 'number', min: 100, max: 20000, style: { width: 110 },
              value: profile.maxWords ?? 1500,
              onChange: (event) => update({ maxWords: Math.max(1, Number(event.target.value) || 1) }),
            }),
            h('span', { className: 'er-card-sub' }, t('common.words')),
            // A single on/off switch beside the inputs; on by default so an
            // over-long article is cut rather than silently skipped.
            h('label', { className: 'er-check', style: { marginLeft: 6 } },
              h('input', {
                type: 'checkbox',
                checked: profile.truncate === true,
                onChange: (event) => update({ truncate: event.target.checked }),
              }),
              h('span', null, t('discover.truncateOn'))),
            h('span', { className: 'er-card-sub' }, t('discover.truncateHint'))))
        : h('div', { className: 'er-card-sub', style: { marginTop: 8 } }, t('discover.wordUnlimitedHint'))));
}

/** One candidate row with its explainable score. */
function CandidateRow({ t, candidate, selected, onToggle, failure }) {
  return h('div', { className: 'er-candidate', 'data-selected': selected === true, 'data-failed': failure !== undefined },
    h('label', { className: 'er-check', style: { flex: 'none' } },
      h('input', { type: 'checkbox', checked: selected === true, onChange: () => onToggle(candidate.id) })),
    h(Thumb, { id: candidate.id }),
    h('div', { className: 'er-row-body' },
      h('div', { className: 'er-row-title' }, candidate.title),
      h('div', { className: 'er-row-meta' },
        h(Badge, { tone: cefrTone(candidate.cefrLevel) }, candidate.cefrLevel ?? '—'),
        candidate.articleType ? h(Badge, { tone: 'soft' }, t(`type.${candidate.articleType}`, { fallback: candidate.articleType })) : null,
        h('span', null, candidate.sourceName),
        candidate.publishedAt ? h('span', null, shortDate(candidate.publishedAt)) : null,
        candidate.wordCount > 0 ? h('span', null, `~${candidate.wordCount} ${t('common.words')}`) : null),
      candidate.reasons.length > 0 && h('div', { className: 'er-reasons' },
        candidate.reasons.map((reason) => h(Badge, { key: reason, tone: 'violet' }, reason))),
      failure !== undefined && failure.length > 0
        ? h('div', { className: 'er-candidate-error' }, failure)
        : null),
    h('div', { className: 'er-row-side' },
      candidate.imported
        ? h(Badge, { tone: 'mint' }, t('discover.imported'))
        : h(Badge, { tone: 'blue' }, `${candidate.score}`)),
    h('a', {
      href: candidate.url, target: '_blank', rel: 'noreferrer noopener',
      className: 'er-btn ghost sm', style: { textDecoration: 'none' },
    }, t('common.source')));
}

/** Live progress panel for one discovery run: bar, per-source state, log. */
function RunProgress({ t, progress }) {
  if (progress === null) return null;
  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const ratio = total === 0 ? (progress.running ? 0.15 : 1) : done / total;
  const stateTone = (status) => (status === 'ok' ? 'mint'
    : status === 'failed' ? 'pink'
      : status === 'empty' ? 'amber'
        : status === 'fetching' ? 'violet' : 'soft');
  return h(Cell, {
    span: 12,
    eyebrow: progress.running ? t('discover.running') : t('discover.runDone'),
    icon: h(Icons.clock, null),
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h('div', { style: { flex: 1 } }, h(Progress, { ratio })),
      h('span', { className: 'er-card-sub' }, `${done} / ${total}`),
      h('span', { className: 'er-card-sub' }, `· ${t('discover.candidatesCount')} ${progress.candidates ?? 0}`)),
    progress.sources?.length > 0
      ? h('div', { className: 'er-chips' },
        progress.sources.map((source) => h(Badge, {
          key: source.sourceId, tone: stateTone(source.status),
        }, `${source.sourceName}${source.fetched > 0 ? ` ${source.fetched}` : ''}`)))
      : null,
    progress.log?.length > 0
      ? h('div', {
        className: 'er-raw',
        style: { maxHeight: 140, display: 'flex', flexDirection: 'column', gap: 2 },
      },
      // Newest first: the interesting line is the one that just happened.
      [...progress.log].reverse().map((line, index) => h('div', {
        key: `${line.at}-${index}`,
        style: { color: line.level === 'error' ? 'var(--dsw-alias-state-error-primary)' : undefined },
      }, `${line.at.slice(11, 19)}  ${line.message}`)))
      : null,
    progress.error ? h(Alert, null, progress.error) : null));
}

/**
 * The shared discovery state: the profile, the running sweep, and the
 * candidates it produced.
 *
 * The collection profile and the discovered content are two tabs of one
 * workflow, so they share this state: a run started on the profile tab fills
 * the candidates on the content tab.
 *
 * The candidate list is paginated: the content pane holds one screen and asks
 * for the next page as the reader scrolls, so a long tail of candidates never
 * makes the pane taller than the viewport.
 */
function useDiscoveryState(t, notify) {
  const profiles = useLoad(() => call('listProfiles'), []);
  const settings = useLoad(() => call('settings'), []);
  const [profile, setProfile] = React.useState(null);
  // Hydrated from `discovered_articles`, so switching pages and coming back
  // shows the same pending list instead of an empty pane.
  const pending = useLoad(() => call('pendingCandidates', { limit: PAGE_SIZE }), []);
  const [candidates, setCandidates] = React.useState(null);
  const [total, setTotal] = React.useState(0);
  // Whether the Host answers with real pages. A Host that predates pagination
  // sends the top rows as one array and ignores the offset, so the client cuts
  // the pages out of that array itself.
  const [paged, setPaged] = React.useState(true);
  const [hasMore, setHasMore] = React.useState(false);
  const [reports, setReports] = React.useState([]);
  const [selected, setSelected] = React.useState([]);
  // Why a candidate refused to import, keyed by its id.
  const [failures, setFailures] = React.useState(() => new Map());
  const [loadingMore, setLoadingMore] = React.useState(false);
  const action = useAction();
  React.useEffect(() => {
    if (profiles.data && profile === null) setProfile(profiles.data[0]);
  }, [profiles.data, profile]);
  // `null` means "not chosen yet", so a run's own results are never overwritten
  // by a late hydration.
  React.useEffect(() => {
    if (candidates !== null) return;
    const payload = pending.data;
    if (!payload) return;
    const legacy = Array.isArray(payload);
    setPaged(!legacy);
    const items = legacy ? payload : (payload.items ?? []);
    setCandidates(items);
    setTotal(legacy ? items.length : (payload.total ?? items.length));
    // A legacy Host returned as many rows as were asked for, so a full page
    // means there may be more behind it.
    setHasMore(legacy ? items.length >= PAGE_SIZE : items.length < (payload.total ?? 0));
  }, [pending.data, candidates]);
  const shown = candidates ?? [];

  // Live run state, polled while a sweep is in flight.
  const [progress, setProgress] = React.useState(null);
  const polling = React.useRef(null);
  const stopPolling = () => {
    if (polling.current !== null) {
      clearInterval(polling.current);
      polling.current = null;
    }
  };
  React.useEffect(() => stopPolling, []);
  const startPolling = () => {
    stopPolling();
    polling.current = setInterval(() => {
      call('discoverProgress')
        .then((value) => {
          if (value === null || value === undefined) return;
          setProgress(value);
          if (value.running !== true) stopPolling();
        })
        .catch(() => stopPolling());
    }, 600);
  };

  const search = async () => {
    setProgress({ running: true, total: 0, done: 0, sources: [], log: [] });
    startPolling();
    const result = await action.run(async () => {
      const current = await call('saveProfile', { profile });
      // The profile carries `articleCount`; passing no limit keeps that in charge.
      return call('discover', { profileId: current.id });
    });
    stopPolling();
    // Read the final state once the sweep settles, so the log is complete even
    // if the last poll landed mid-flight.
    await call('discoverProgress').then(setProgress).catch(() => undefined);
    if (result) {
      setCandidates(result.candidates ?? []);
      setTotal(result.candidates?.length ?? 0);
      setHasMore(false);
      setReports(result.sources ?? []);
      setSelected([]);
    }
  };
  const toggle = (id) => setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  /**
   * Import the selected candidates.
   *
   * Every candidate is reported separately, because one unreachable source
   * must not hide the ones that worked. A candidate that was imported leaves
   * the discovered list; one that failed stays, so the reader can retry it.
   */
  const importSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const results = await action.run(() => call('confirmImport', { candidateIds: ids }));
    if (!results) return;
    const imported = results.filter((item) => item.ok);
    const failed = results.filter((item) => !item.ok);
    // Imported candidates are no longer pending, so drop them from the list.
    const done = new Set(imported.map((item) => item.id));
    setCandidates((current) => (current ?? []).filter((item) => !done.has(item.id)));
    setTotal((count) => Math.max(0, count - done.size));
    setSelected([]);
    // A failed candidate stays in the list with its reason attached, so the
    // reader sees why it did not import and can retry it.
    const reasons = new Map(failed.map((item) => [item.id, item.error ?? '']));
    setFailures(reasons);
    if (imported.length > 0) pending.reload();
    if (failed.length === 0) {
      notify(t('discover.importDone', { count: imported.length }), 'ok');
    } else if (imported.length === 0) {
      // Nothing worked: the reason matters more than the count.
      notify(failed[0].error ?? t('discover.importNone'), 'error');
    } else {
      notify(t('discover.importPartial', { done: imported.length, failed: failed.length }), 'error');
    }
  };
  /**
   * Load the next page of candidates.
   *
   * Appended, never replaced: the reader has already scrolled past the rows
   * that are on screen, and replacing them would jump the list back to the top.
   */
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    const offset = shown.length;
    setLoadingMore(true);
    try {
      // A legacy Host ignores the offset, so it is asked for every row up to
      // the end of this page and the page is cut out of the answer.
      const limit = paged ? PAGE_SIZE : offset + PAGE_SIZE;
      const payload = await call('pendingCandidates', { limit, offset: paged ? offset : 0 });
      const legacy = Array.isArray(payload);
      const items = legacy ? payload.slice(offset) : (payload?.items ?? []);
      if (items.length === 0) {
        setHasMore(false);
        return;
      }
      setCandidates((current) => {
        const seen = new Set((current ?? []).map((row) => row.id));
        const fresh = items.filter((row) => !seen.has(row.id));
        return [...(current ?? []), ...fresh];
      });
      if (legacy) {
        setTotal(offset + items.length);
        setHasMore(payload.length >= limit);
      } else {
        const count = payload?.total ?? offset + items.length;
        setTotal(count);
        setHasMore(offset + items.length < count);
      }
    } catch {
      /* a failed page must not break the list already on screen */
    } finally {
      setLoadingMore(false);
    }
  };
  return {
    profiles, settings, profile, setProfile, pending, candidates, setCandidates,
    reports, selected, action, shown, total, paged, hasMore, progress, search,
    toggle, importSelected, loadMore, loadingMore, failures,
  };
}

/** The collection profile tab: what to collect, and the button that collects it. */
function DiscoveryTab({ t, notify, state }) {
  const {
    profiles, settings, profile, setProfile, action, progress, search,
  } = state;
  return h('div', { className: 'er-discover-spec' },
    h(Cell, { span: 12, size: 'feature', eyebrow: t('discover.specTitle'), icon: h(Icons.grid, null) },
      profiles.status === 'loading' ? h(Skeleton, { height: 120 }) : null,
      profile ? h(ProfileForm, {
        t, profile,
        collection: settings.data?.collection,
        onChange: setProfile,
      }) : null,
      h('div', {
        style: {
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          gap: 8, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--er-line)',
        },
      },
      h('span', { className: 'er-card-sub', style: { flex: 1, minWidth: 0 } },
        profile ? `${(profile.sourceIds ?? []).length} ${t('discover.sourcesSelected')}` : ''),
      h(Button, {
        onClick: () => action.run(() => call('saveProfile', { profile }), t('discover.profileSaved')),
        disabled: action.pending || profile === null,
      }, t('discover.saveProfile')),
      h(Button, {
        variant: 'primary',
        icon: h(Icons.sparkle, null),
        disabled: action.pending || profile === null,
        onClick: search,
      }, action.pending
        ? t('common.working')
        : `${t('discover.start')} · ${profile?.articleCount ?? 1}`)),
      action.error ? h('div', { style: { marginTop: 10 } }, h(Alert, null, action.error.message)) : null),
    h(RunProgress, { t, progress }));
}

/**
 * The discovered content tab: the candidates a run produced, and the report.
 *
 * The list is one screen tall and loads the next page when the reader reaches
 * the bottom, so the pane never grows past the viewport.
 */
function DiscoveredTab({ t, notify, state }) {
  const {
    shown, total, paged, hasMore, reports, selected, action, toggle,
    importSelected, progress, loadMore, loadingMore, failures,
  } = state;
  const failedSources = reports.filter((report) => report.ok === false);

  const reportRows = reports.map((report) => h('div', {
    key: report.sourceId,
    style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 },
  },
  h('span', { style: { minWidth: 170 } }, report.sourceName),
  report.ok ? h(Badge, { tone: 'mint' }, `${report.fetched}`) : h(Badge, { tone: 'pink' }, report.code ?? 'error'),
  h('span', { className: 'er-card-sub', style: { flex: 1, minWidth: 0 } },
    report.ok
      ? [report.filtered ? `${t('discover.filtered')} ${report.filtered}` : '', report.skipped ?? ''].filter(Boolean).join(' · ')
      : (report.error ?? ''))));

  // `resultsCard` decides its own span from this flag, so it must be known
  // before that cell is constructed.
  const hasReport = reports.length > 0;
  const reportCard = !hasReport ? null : h(Cell, {
    span: 4, eyebrow: `${t('discover.sourceReport')} · ${reports.length}`, icon: h(Icons.info, null),
  },
  h('div', { className: 'er-cell-scroll', style: { display: 'flex', flexDirection: 'column', gap: 6, '--er-cell-max': '360px' } }, reportRows),
  failedSources.length > 0 ? h(Alert, { tone: 'warn' }, `${failedSources.length} ${t('discover.sourcesFailed')}`) : null);

  const candidateRows = shown.map((candidate) => h(CandidateRow, {
    key: candidate.id, t, candidate, selected: selected.includes(candidate.id),
    onToggle: toggle, failure: failures.get(candidate.id),
  }));

  // The list scrolls inside its own border; when the reader reaches the
  // bottom, the next page is fetched and appended.
  const onScroll = React.useCallback((event) => {
    const box = event.target;
    const remaining = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (remaining < 160) loadMore();
  }, [loadMore]);
  const count = paged ? `${shown.length}/${total}` : `${shown.length}${hasMore ? '+' : ''}`;
  const resultsCard = h(Cell, {
    span: hasReport ? 8 : 12,
    eyebrow: `${t('discover.results')}${shown.length > 0 ? ` · ${count}` : ''}`,
    icon: h(Icons.compass, null),
    actions: selected.length > 0
      ? h(Button, { variant: 'primary', onClick: importSelected, disabled: action.pending }, `${t('discover.importSelected')} (${selected.length})`)
      : null,
  },
  shown.length === 0
    ? h(Empty, { icon: h(Icons.compass, null), title: t('discover.emptyTitle'), description: t('discover.emptyBody') })
    : h('div', { className: 'er-cell-scroll er-candidate-scroll', onScroll },
      candidateRows,
      hasMore
        ? h('div', { className: 'er-more' },
          h(Button, {
            variant: 'ghost', disabled: loadingMore, onClick: loadMore,
          }, loadingMore ? t('common.working') : t('discover.loadMore')))
        : h('div', { className: 'er-more er-more--end' }, t('discover.listEnd'))));

  return h('div', { className: 'er-discover-results' },
    progress?.running === true ? h(RunProgress, { t, progress }) : null,
    h(Board, null, resultsCard, reportCard));
}

/** URL import tab with a fetched preview. */
function UrlTab({ t, notify, onOpenArticle }) {
  const [url, setUrl] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const action = useAction();
  const fetchPreview = async () => {
    if (url.trim().length === 0) return;
    const result = await action.run(() => call('importUrl', { url: url.trim() }));
    if (result) setPreview(result);
  };
  const save = async () => {
    if (!preview) return;
    const created = await action.run(() => call('createArticle', {
      article: {
        title: preview.title, text: preview.text, sourceUrl: preview.url,
        sourceName: preview.sourceName, cefrLevel: preview.cefrLevel,
      },
    }), t('discover.saved'));
    if (created) {
      notify(`${t('discover.saved')} ${created.wordCount} ${t('common.words')}`, 'ok');
      setPreview(null);
      setUrl('');
      onOpenArticle(created.id);
    }
  };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    h(Card, { title: t('discover.urlTitle'), icon: h(Icons.link, null) },
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', {
          className: 'er-input', placeholder: 'https://www.bbc.com/news/articles/...', value: url,
          onChange: (event) => setUrl(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') fetchPreview();
          },
        }),
        h(Button, { variant: 'primary', onClick: fetchPreview, disabled: action.pending, icon: h(Icons.search, null) },
          action.pending ? t('common.fetching') : t('discover.fetch'))),
      h('p', { className: 'er-card-sub', style: { marginTop: 8 } }, t('discover.urlHint')),
      action.error && h('div', { style: { marginTop: 10 } }, h(Alert, null, action.error.message))),
    preview && h(Card, { title: t('discover.previewTitle'), icon: h(Icons.bookOpen, null) },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        preview.duplicateArticleId && h(Alert, { tone: 'warn' }, t('discover.duplicate')),
        h('div', { className: 'er-row-meta' },
          h(Badge, { tone: cefrTone(preview.cefrLevel) }, `${preview.cefrLevel} · AI 估计`),
          h('span', null, `${preview.wordCount} ${t('common.words')}`),
          h('span', { className: 'er-crumb-dot' }),
          h('span', null, `${preview.sentenceCount} ${t('common.sentences')}`),
          h('span', { className: 'er-crumb-dot' }),
          h('span', null, `${preview.paragraphCount} ${t('common.paragraphs')}`)),
        h('div', { className: 'er-prose', style: { maxHeight: 260, overflowY: 'auto', paddingRight: 6, fontSize: 13, lineHeight: 24 } },
          preview.text.split(/\n{2,}/).map((paragraph, index) => h('p', { key: index }, paragraph))),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(Button, { variant: 'ghost', onClick: () => setPreview(null) }, t('common.cancel')),
          h(Button, {
            variant: 'primary', disabled: action.pending || preview.duplicateArticleId !== null, onClick: save,
          }, preview.duplicateArticleId ? t('discover.alreadySaved') : t('discover.saveArticle'))))));
}

/** Manual paste tab. */
function PasteTab({ t, notify, onOpenArticle }) {
  const [title, setTitle] = React.useState('');
  const [source, setSource] = React.useState('');
  const [text, setText] = React.useState('');
  const action = useAction();
  const save = async () => {
    const created = await action.run(() => call('createArticle', {
      article: { title: title.trim() || undefined, text, sourceName: source.trim() || undefined },
    }), t('discover.saved'));
    if (created) {
      notify(t('discover.saved'), 'ok');
      setTitle('');
      setText('');
      setSource('');
      onOpenArticle(created.id);
    }
  };
  const words = text.trim().length === 0 ? 0 : (text.match(/[A-Za-z][A-Za-z'\-]*/g) ?? []).length;
  return h(Card, { title: t('discover.pasteTitle'), icon: h(Icons.note, null) },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h('div', { className: 'er-form-grid', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' } },
        h(Field, { label: t('discover.pasteTitleLabel') },
          h('input', { className: 'er-input', value: title, onChange: (event) => setTitle(event.target.value) })),
        h(Field, { label: t('discover.pasteSource') },
          h('input', { className: 'er-input', value: source, onChange: (event) => setSource(event.target.value) }))),
      h(Field, { label: t('discover.pasteBody') },
        h('textarea', {
          className: 'er-textarea', value: text, placeholder: t('discover.pastePlaceholder'),
          onChange: (event) => setText(event.target.value),
        })),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h('span', { className: 'er-card-sub' }, `${words} ${t('common.words')}`),
        h('div', { className: 'er-topbar-spacer' }),
        h(Button, { variant: 'primary', disabled: action.pending || words < 10, onClick: save }, t('discover.saveArticle'))),
      action.error && h(Alert, null, action.error.message)));
}

/**
 * The discover page.
 *
 * Two levels, never three at once: the outer tab strip switches between the
 * collection profile and the discovered content, and the profile tab carries
 * the three collection modes (auto / URL / paste) as its own inner strip. Each
 * pane fills the screen and scrolls inside its own border, so the page never
 * grows past one viewport.
 *
 * Both tab levels are controlled by the shell: the shell persists them, so
 * leaving the panel for another Session and coming back restores the exact
 * tab the user was on.
 */
function Discover({ t, notify, onOpenArticle, tab: tabProp, mode: modeProp, onTabChange, onModeChange }) {
  const [ownTab, setOwnTab] = React.useState('spec');
  const [ownMode, setOwnMode] = React.useState('auto');
  const controlled = typeof tabProp === 'string';
  const tab = controlled ? tabProp : ownTab;
  const mode = controlled ? (modeProp ?? 'auto') : ownMode;
  const setTab = (next) => {
    if (!controlled) setOwnTab(next);
    onTabChange?.(next);
  };
  const setMode = (next) => {
    if (!controlled) setOwnMode(next);
    onModeChange?.(next);
  };
  const state = useDiscoveryState(t, notify);
  return h('div', { className: 'er-page er-page--fill' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.discover'))),
      h('div', { className: 'er-topbar-spacer' }),
      h(Tabs, {
        items: [
          { id: 'spec', label: t('discover.tabSpec') },
          { id: 'results', label: t('discover.tabResults') },
        ],
        value: tab, onChange: setTab,
      })),
    tab === 'spec'
      ? h('div', { className: 'er-discover-pane' },
        h(Tabs, {
          items: [
            { id: 'auto', label: t('discover.tabAuto') },
            { id: 'url', label: t('discover.tabUrl') },
            { id: 'paste', label: t('discover.tabPaste') },
          ],
          value: mode, onChange: setMode,
        }),
        h('div', { className: 'er-discover-body' },
          mode === 'auto' && h(DiscoveryTab, { t, notify, state }),
          mode === 'url' && h(UrlTab, { t, notify, onOpenArticle }),
          mode === 'paste' && h(PasteTab, { t, notify, onOpenArticle })))
      : h('div', { className: 'er-discover-pane' },
        h('div', { className: 'er-discover-body er-discover-body--fixed' },
          h(DiscoveredTab, { t, notify, state }))));
}


// ---- src/70-articles.js ----
/** Article library: filters, rows, and the analysis entry points. */

/** One library row. */
function ArticleRow({ t, article, onOpen, onAnalyze, onDelete, pending }) {
  return h('div', { className: 'er-row', style: { cursor: 'default' } },
    h('div', {
      onClick: () => onOpen(article.id),
      style: { display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, cursor: 'pointer' },
    },
    h(Thumb, { id: article.id }),
    h('div', { className: 'er-row-body' },
      h('div', { className: 'er-row-title' }, article.title),
      h('div', { className: 'er-row-meta' },
        h(Badge, { tone: cefrTone(article.cefrLevel) }, article.cefrLevel ?? '—'),
        h('span', null, article.sourceName ?? 'Manual'),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, `${article.wordCount} ${t('common.words')}`),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, `${article.readingMinutes} ${t('common.minutes')}`),
        h('span', { className: 'er-crumb-dot' }),
        h(Badge, {
          tone: article.status === 'COMPLETED' ? 'mint' : article.status === 'PARTIAL_COMPLETED' ? 'amber' : 'soft',
        }, ARTICLE_STATUS_LABELS[article.status] ?? article.status)),
      article.snippet
        ? h('div', {
          className: 'er-row-meta',
          style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, article.snippet)
        : null)),
    h('div', { className: 'er-row-side' },
      article.demo ? h(Badge, { tone: 'plain' }, 'sample') : null,
      // Only when the article actually came from a URL; pasted text has none.
      article.sourceUrl
        ? h('a', {
          className: 'er-source-link',
          href: article.sourceUrl,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: article.sourceUrl,
          onClick: (event) => event.stopPropagation(),
        }, h(Icons.link, null), h('span', null, t('reader.openSource')))
        : null,
      h(Button, { size: 'sm', onClick: () => onOpen(article.id) }, t('common.read')),
      h(Button, {
        size: 'sm', variant: 'primary', disabled: pending, onClick: () => onAnalyze(article.id),
      }, article.status === 'COMPLETED' ? t('common.reanalyze') : t('articles.analyze')),
      h(Button, {
        size: 'sm', variant: 'ghost', iconOnly: true, children: t('common.delete'),
        onClick: () => onDelete(article.id),
      }, h(Icons.trash, null))));
}

/** Library page with filters and the sample-library controls. */
function Articles({ t, notify, onOpenArticle, initialSearch }) {
  const [search, setSearch] = React.useState(initialSearch ?? '');
  const [cefr, setCefr] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [source, setSource] = React.useState('');
  const list = useLoad(() => call('listArticles', { search, cefrLevel: cefr || undefined, analysisStatus: status || undefined, sourceName: source || undefined, limit: 60 }), [search, cefr, status, source]);
  const action = useAction();
  React.useEffect(() => {
    if (initialSearch) setSearch(initialSearch);
  }, [initialSearch]);
  const analyze = async (articleId) => {
    const started = await action.run(() => call('startAnalysis', { articleId }));
    if (started) {
      notify(t('articles.analysisStarted'), 'ok');
      onOpenArticle(articleId);
    }
  };
  const remove = async (articleId) => {
    const done = await action.run(() => call('deleteArticle', { articleId }), t('articles.deleted'));
    if (done) {
      notify(t('articles.deleted'), 'ok');
      list.reload();
    }
  };
  return h('div', { className: 'er-page er-page--fill' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.articles'))),
      h('div', { className: 'er-topbar-spacer' })),
    h(Cell, { span: 12, flush: true, className: 'er-articles-cell' },
      h('div', { style: { display: 'flex', gap: 8, padding: '16px 18px 4px', flexWrap: 'wrap' } },
        h('div', { className: 'er-search', style: { flex: '1 1 220px' } },
          h(Icons.search, null),
          h('input', { type: 'search', placeholder: t('articles.searchPlaceholder'), value: search, onChange: (event) => setSearch(event.target.value) })),
        h('select', { className: 'er-select', style: { width: 120 }, value: cefr, onChange: (event) => setCefr(event.target.value) },
          h('option', { value: '' }, t('articles.allLevels')),
          ['A2', 'B1', 'B2', 'C1', 'C2'].map((level) => h('option', { key: level, value: level }, level))),
        h('select', { className: 'er-select', style: { width: 140 }, value: status, onChange: (event) => setStatus(event.target.value) },
          h('option', { value: '' }, t('articles.allStatus')),
          ['FETCHED', 'ANALYZING', 'PARTIAL_COMPLETED', 'COMPLETED', 'ANALYSIS_FAILED'].map((value) => h('option', { key: value, value }, ARTICLE_STATUS_LABELS[value]))),
        h('select', { className: 'er-select', style: { width: 150 }, value: source, onChange: (event) => setSource(event.target.value) },
          h('option', { value: '' }, t('articles.allSources')),
          (list.data?.sources ?? []).map((name) => h('option', { key: name, value: name }, name))),
        h('div', { className: 'er-topbar-spacer' }),
        h('span', { className: 'er-card-sub', style: { alignSelf: 'center' } }, `${list.data?.total ?? 0} ${t('articles.count')}`)),
      list.status === 'loading' && !list.data && h('div', { style: { padding: 20, display: 'flex', flexDirection: 'column', gap: 10 } },
        [0, 1, 2].map((index) => h(Skeleton, { key: index, height: 56, radius: 12 }))),
      list.status === 'error' && h('div', { style: { padding: 20 } }, h(Alert, null, list.error.message)),
      list.data && list.data.items.length === 0 && h(Empty, {
        icon: h(Icons.bookOpen, null),
        title: t('articles.emptyTitle'),
        description: t('articles.emptyBody'),
      }),
      list.data && list.data.items.length > 0 && h('div', {
        className: 'er-row-list er-articles-list',
      },
        list.data.items.map((article) => h(ArticleRow, {
          key: article.id, t, article,
          onOpen: onOpenArticle, onAnalyze: analyze, onDelete: remove, pending: action.pending,
        })))),
    action.error && h(Alert, null, action.error.message));
}


// ---- src/80-reader.js ----
/** Reader: continuous reading and dual-column intensive reading share one article body. */

/** Group analysed sentences into paragraph blocks, preserving order. */
function paragraphBlocks(detail) {
  const groups = [];
  for (const sentence of detail.sentences) {
    const last = groups[groups.length - 1];
    if (last && last.paragraphIndex === sentence.paragraphIndex) last.items.push(sentence);
    else groups.push({ paragraphIndex: sentence.paragraphIndex, items: [sentence] });
  }
  return groups;
}

/** Index analysed vocabulary by lower-cased surface form. */
function wordIndex(detail) {
  const map = new Map();
  for (const word of detail.words) {
    map.set(word.lemma.toLowerCase(), word);
    for (const evidence of word.evidence ?? []) {
      const tokens = String(evidence.exactText ?? '').toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
      for (const token of tokens) {
        if (token.startsWith(word.lemma.toLowerCase().slice(0, Math.min(5, word.lemma.length))) && map.get(token) === undefined) {
          map.set(token, word);
        }
      }
    }
  }
  return map;
}

/** Render one sentence with clickable analysed words inside it. */
function SentenceText({ text, words, onWord, active, onSelect }) {
  const parts = React.useMemo(() => {
    const out = [];
    const pattern = /[A-Za-z][A-Za-z'’\-]*/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) out.push({ kind: 'text', value: text.slice(cursor, match.index) });
      const surface = match[0];
      const word = words.get(surface.toLowerCase().replace(/['’]s$/, ''));
      out.push({ kind: word ? 'word' : 'text', value: surface, word });
      cursor = match.index + surface.length;
    }
    if (cursor < text.length) out.push({ kind: 'text', value: text.slice(cursor) });
    return out;
  }, [text, words]);
  return h('span', {
    className: 'er-sentence',
    'data-active': active === true,
    onClick: onSelect,
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect();
      }
    },
  }, parts.map((part, index) => (part.kind === 'word'
    ? h('span', {
      key: index,
      className: 'er-word',
      'data-known': part.word.masteryLevel >= 3,
      title: part.word.meanings?.[0]?.contextMeaning ?? part.word.meanings?.[0]?.meaning ?? '',
      onClick: (event) => {
        event.stopPropagation();
        onWord(part.word);
      },
    }, part.value)
    : h('span', { key: index }, part.value))));
}

/** Speaker control with a pending/error state, over the Edge-TTS bridge. */
function SpeakButton({ t, text, sentence, size = 'sm', variant = 'ghost', label, onResult }) {
  const [state, setState] = React.useState({ pending: false, playing: false, error: null });
  const run = async (event) => {
    event?.stopPropagation?.();
    if (state.pending) return;
    setState({ pending: true, playing: false, error: null });
    const result = sentence
      ? await speakSentence(sentence.articleId, sentence.sentenceIndex)
      : await speakText(text);
    setState({ pending: false, playing: result.played === true, error: result.played ? null : (result.message ?? '朗读失败') });
    onResult?.(result);
  };
  const icon = state.playing ? Icons.speaker : state.error ? Icons.warning : Icons.speaker;
  // The label doubles as the accessible name: icon-only buttons would otherwise
  // be announced as "button" to a screen reader.
  return h('button', {
    type: 'button',
    className: ['er-btn', variant, size, label === undefined ? 'icon' : ''].filter(Boolean).join(' '),
    disabled: state.pending === true,
    'aria-label': label ?? t('common.pronounce'),
    title: state.error ?? t('common.pronounce'),
    onClick: run,
    style: label === undefined ? undefined : { gap: 6 },
  },
  state.pending ? h('span', { style: { fontSize: 11 } }, '…') : h(icon, null),
  label === undefined ? null : h('span', null, state.playing ? t('common.playing') : label));
}

/** Why one sentence could not be analysed: code, reason, raw excerpt, retry. */
function SentenceFailure({ t, error, sentence }) {
  const [expanded, setExpanded] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const code = error?.code ?? 'LLM_UNAVAILABLE';
  const explain = t(`error.${code}`, { fallback: t('error.unknown') });
  const retry = async () => {
    setRetrying(true);
    try {
      await call('retrySentence', { articleId: sentence.articleId, sentenceIndex: sentence.sentenceIndex });
    } finally {
      setRetrying(false);
    }
  };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', {
      className: 'er-alert error',
      style: { alignItems: 'flex-start', flexDirection: 'column', gap: 6 },
    },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
      h(Icons.warning, null),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600 } }, t('reader.sentenceFailed')),
        h('div', { style: { marginTop: 2, opacity: 0.85 } }, explain)),
      h(Badge, { tone: 'plain' }, code)),
    h('div', { className: 'er-meaning-ctx', style: { color: 'inherit', opacity: 0.8 } },
      error?.message ?? t('error.noDetail')),
    error?.attempts > 1 ? h('div', { className: 'er-meaning-ctx', style: { color: 'inherit', opacity: 0.7 } }, `${t('reader.attempts')} ${error.attempts}`) : null),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h(Button, { size: 'sm', onClick: retry, disabled: retrying }, retrying ? t('common.working') : t('reader.retrySentence')),
      error?.raw ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => setExpanded(!expanded) },
        expanded ? t('reader.hideRaw') : t('reader.showRaw')) : null,
      h('div', { className: 'er-topbar-spacer' }),
      h(SpeakButton, { t, text: sentenceTextOf(sentence), label: t('common.pronounce') }),
      ),
    expanded && error?.raw
      ? h('pre', {
        className: 'er-raw', style: { margin: 0 },
        children: error.raw,
      })
      : null);
}

function sentenceTextOf(sentence) {
  return sentence?.text ?? '';
}

/** Dictionary card for one word, shared by the reader drawer and knowledge. */
function WordCard({ t, word, onFavorite, onMastery, onNote }) {
  // `favorite` doubles as "is in the library": a user_knowledge row is only
  // created when the learner adds the word, so this is the opt-in flag.
  const inLibrary = word.favorite === true;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { className: 'er-dict-head' },
      h('div', { className: 'er-dict-word' }, word.lemma),
      word.phonetic && h('span', { className: 'er-phonetic' }, word.phonetic),
      h(SpeakButton, { t, text: word.lemma, size: 'sm', variant: 'ghost' }),
      h('div', { className: 'er-topbar-spacer' }),
      h(Button, {
        size: 'sm',
        variant: inLibrary ? 'ghost' : 'primary',
        onClick: () => onFavorite(word.id, !inLibrary),
      }, inLibrary
        ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
          h(Icons.check, null), t('reader.inLibrary'))
        : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
          h(Icons.plus, null), t('reader.addToLibrary'))),
      h(Button, {
        size: 'sm', variant: 'ghost', iconOnly: true, children: t('word.addPlan'),
        onClick: () => onMastery(word.id, Math.min(4, (word.masteryLevel ?? 0) + 1)),
      }, h(Icons.target, null))),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
      (word.partOfSpeech ?? []).map((pos) => h(Badge, { key: pos, tone: 'soft' }, pos)),
      word.cefrLevel && h(Badge, { tone: cefrTone(word.cefrLevel) }, word.cefrLevel),
      h(Mastery, { level: word.masteryLevel ?? 0 })),
    (word.meanings ?? []).map((meaning, index) => h('div', { key: index, className: 'er-meaning' },
      h('div', { className: 'er-meaning-cn' }, meaning.meaning),
      meaning.contextMeaning && h('div', { className: 'er-meaning-ctx' }, `${t('word.inArticle')}${meaning.contextMeaning}`))),
    word.wordFormation && (word.wordFormation.components ?? []).length > 0 && h('div', { className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('word.formation')),
      h('div', { className: 'er-kv-value' },
        h('span', { className: 'er-en' }, word.wordFormation.components.join(' + ')),
        ` → ${word.wordFormation.explanation}`)),
    (word.evidence ?? []).length > 0 && h('div', { className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('word.evidence')),
      (word.evidence ?? []).map((item, index) => h('div', { key: index, className: 'er-example' }, item.exactText))),
    (word.synonyms ?? []).length > 0 && h('div', { className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('word.synonyms')),
      h('div', { className: 'er-kv-value', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        word.synonyms.map((value) => h('span', { key: value, className: 'er-token' }, value))),
    ));
}

/**
 * Right column: the selected sentence's analysis.
 * `onAddToLibrary(sentence, next)` writes the knowledge row; without a click the
 * sentence stays a candidate and never appears in the library.
 */
function SentencePane({ t, sentence, sentenceText, onAddToLibrary }) {
  if (!sentence) {
    return {
      head: null,
      body: h(Empty, { icon: h(Icons.target, null), title: t('reader.pickSentence'), description: t('reader.pickSentenceBody') }),
    };
  }
  const analysis = sentence.analysis;
  const inLibrary = sentence.inLibrary === true;
  /** Add/added toggle; disabled until the sentence has an id to store. */
  const libraryButton = sentence.id
    ? h(Button, {
      size: 'sm',
      variant: inLibrary ? 'ghost' : 'primary',
      onClick: () => onAddToLibrary?.(sentence, !inLibrary),
    }, inLibrary
      ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        h(Icons.check, null), t('reader.inLibrary'))
      : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        h(Icons.plus, null), t('reader.addToLibrary')))
    : null;
  // The sentence and its controls are the reference for everything below, so the
  // caller keeps them out of the scroller entirely.
  const head = h('div', { className: 'er-sentence-head' },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
      h('div', { style: { flex: 1, minWidth: 0 } }, sentenceText),
      h(SpeakButton, {
        t,
        text: sentenceText,
        sentence: { articleId: sentence.articleId, sentenceIndex: sentence.sentenceIndex },
      })),
    libraryButton ? h('div', { style: { marginTop: 8 } }, libraryButton) : null);
  if (!analysis) {
    // A sentence is listenable before analysis finishes: pronunciation does
    // not depend on the model's output.
    const failed = sentence.analysisStatus === 'failed';
    return {
      head,
      body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        failed
          ? h(SentenceFailure, { t, error: sentence.error, analysisStatus: sentence.analysisStatus, sentence })
          : h(Alert, { tone: 'warn' }, t('reader.noAnalysis'))),
    };
  }
  const parts = [];
  parts.push(h('div', { key: 'literal', className: 'er-kv' },
    h('div', { className: 'er-kv-label' }, t('reader.literal')),
    h('div', { className: 'er-kv-value' }, analysis.translation?.literal ?? '')));
  parts.push(h('div', { key: 'natural', className: 'er-kv' },
    h('div', { className: 'er-kv-label' }, t('reader.natural')),
    h('div', { className: 'er-kv-value' }, analysis.translation?.natural ?? '')));
  if (analysis.structure?.mainClause) {
    parts.push(h('div', { key: 'main', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.mainClause')),
      h('div', { className: 'er-kv-value er-en' }, analysis.structure.mainClause)));
  }
  const components = analysis.structure?.components ?? [];
  if (components.length > 0) {
    parts.push(h('div', { key: 'structure', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.structure')),
      h('div', { className: 'er-struct' }, components.map((part, index) => h('div', {
        key: index, className: 'er-struct-item',
      },
      h('span', { className: 'er-struct-type' }, part.type),
      h('div', { className: 'er-struct-text' }, part.text),
      part.explanation ? h('div', { className: 'er-meaning-ctx' }, part.explanation) : null)))));
  }
  const grammar = analysis.grammarPoints ?? [];
  if (grammar.length > 0) {
    parts.push(h('div', { key: 'grammar', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.grammar')),
      grammar.map((point, index) => h('div', { key: index, style: { marginBottom: 8 } },
        h('div', { className: 'er-kv-value', style: { fontWeight: 600 } }, point.title),
        h('div', { className: 'er-kv-value' }, point.explanation),
        point.evidence ? h('div', { className: 'er-example', style: { marginTop: 5 } }, point.evidence) : null))));
  }
  const expressions = analysis.keyExpressions ?? [];
  if (expressions.length > 0) {
    parts.push(h('div', { key: 'expressions', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.expressions')),
      expressions.map((item, index) => h('div', { key: index, style: { marginBottom: 6 } },
        h('span', { className: 'er-token', style: { marginRight: 6 } }, item.expression),
        h('span', { className: 'er-kv-value' }, item.meaning)))));
  }
  const uncertain = analysis.uncertaintyNotes ?? [];
  if (uncertain.length > 0) parts.push(h(Alert, { key: 'uncertain', tone: 'warn' }, uncertain.join('；')));
  if (sentence.analysisStatus === 'needs_review') {
    parts.push(h('div', { key: 'review-flag', className: 'er-meaning-ctx' }, t('reader.needsReview')));
  }
  const notes = analysis.difficultyNotes ?? [];
  if (notes.length > 0) {
    parts.push(h('div', { key: 'notes', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.notes')),
      h('div', { className: 'er-kv-value' }, notes.join('；'))));
  }
  return {
    head,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, parts),
  };
}

/** Article body renderer used by both reading modes. */
function ArticleBody({ detail, words, activeIndex, onSelect, onWord }) {
  const blocks = React.useMemo(() => paragraphBlocks(detail), [detail]);
  const paragraphs = blocks.map((block) => {
    // Segmentation trims every sentence, so concatenating spans would lose the
    // space after the full stop ("changes.A new study"). A literal space between
    // sentences keeps the text identical to the stored body.
    const children = [];
    block.items.forEach((sentence, index) => {
      if (index > 0) children.push(' ');
      children.push(h(SentenceText, {
        key: sentence.sentenceIndex,
        text: sentence.text,
        words,
        active: sentence.sentenceIndex === activeIndex,
        onSelect: () => onSelect(sentence.sentenceIndex),
        onWord,
      }));
    });
    return h('p', { key: block.paragraphIndex }, children);
  });
  return h('div', { className: 'er-prose' }, paragraphs);
}

/** Compact add/added control used by every candidate list. */
function LibraryToggle({ t, inLibrary, onToggle }) {
  return h(Button, {
    size: 'sm',
    variant: inLibrary ? 'ghost' : 'primary',
    onClick: (event) => {
      event.stopPropagation();
      onToggle();
    },
  }, inLibrary
    ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
      h(Icons.check, null), t('reader.inLibrary'))
    : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
      h(Icons.plus, null), t('reader.addToLibrary')));
}

/** Section heading inside the insights cell: no border, no nested card. */
function InsightSection({ t, icon, title, sub, children }) {
  return h('div', { className: 'er-insight-section' },
    h('div', { className: 'er-insight-head' },
      h('div', { className: 'er-insight-title' }, icon, h('span', null, title),
        sub === undefined || sub === null || sub === '' ? null : h('span', { className: 'er-card-sub' }, String(sub))),
      h('div', { className: 'er-topbar-spacer' })),
    children);
}

/** Tabs body for the article: overview / vocab / phrases / review. */
function ArticleInsights({ t, detail, tab, onTab, onWord, onAnalysis, onAddToLibrary }) {
  const overview = detail.overview;
  const difficulty = detail.difficulty;
  const review = detail.review;
  return h('div', {
    className: 'er-cell er-insights',
    style: { display: 'flex', flexDirection: 'column', gap: 0 },
  },
  // The strip is part of the frame, not a scrolled child: it must never move.
  h('div', { style: { paddingBottom: 12 } },
    h(Tabs, {
      items: [
        { id: 'guide', label: t('reader.tabGuide') },
        { id: 'words', label: t('reader.tabWords') },
        { id: 'phrases', label: t('reader.tabPhrases') },
        { id: 'review', label: t('reader.tabReview') },
      ],
      value: tab, onChange: onTab,
    })),
  h('div', { className: 'er-insights-body', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    tab === 'guide' && h(InsightSection, { t, title: t('reader.guideTitle'), icon: h(Icons.bookOpen, null) },
      !overview && h(Empty, {
        icon: h(Icons.sparkle, null), title: t('reader.notAnalysed'), description: t('reader.notAnalysedBody'),
        action: h(Button, { variant: 'primary', onClick: onAnalysis }, t('articles.analyze')),
      }),
      overview && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-label' }, t('reader.background')), h('div', { className: 'er-kv-value' }, overview.background)),
        h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-label' }, t('reader.mainIdea')), h('div', { className: 'er-kv-value' }, overview.mainIdea)),
        overview.keyPoints?.length > 0 && h('div', { className: 'er-kv' },
          h('div', { className: 'er-kv-label' }, t('reader.keyPoints')),
          overview.keyPoints.map((point, index) => h('div', { key: index, className: 'er-kv-value' }, `• ${point}`))),
        overview.readingFocus?.length > 0 && h('div', { className: 'er-kv' },
          h('div', { className: 'er-kv-label' }, t('reader.readingFocus')),
          overview.readingFocus.map((point, index) => h('div', { key: index, className: 'er-kv-value' }, `• ${point}`))),
        difficulty && h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(Badge, { tone: cefrTone(difficulty.cefrLevel) }, `${difficulty.cefrLevel} · AI`),
          h('span', { className: 'er-card-sub' }, `${t('reader.readingMinutes')} ${overview.estimatedReadingMinutes ?? detail.article.readingMinutes}`)))),
    tab === 'words' && h(InsightSection, { t, title: t('reader.wordsTitle'), icon: h(Icons.letters, null), sub: detail.words.length },
      detail.words.length === 0
        ? h(Empty, { icon: h(Icons.letters, null), title: t('reader.noWords'), description: t('reader.noWordsBody') })
        : h('div', { className: 'er-kgrid' },
          // A button cannot contain another button, so the card is a div with
          // role=button; the add control stops propagation.
          detail.words.map((word) => h('div', {
            key: word.id,
            className: 'er-kcard',
            role: 'button',
            tabIndex: 0,
            onClick: () => onWord(word),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') onWord(word);
            },
          },
          h('div', { className: 'er-kcard-top' },
            h('span', { className: 'er-kcard-word' }, word.lemma),
            word.phonetic && h('span', { className: 'er-phonetic' }, word.phonetic),
            h('div', { className: 'er-topbar-spacer' }),
            h(LibraryToggle, {
              t, inLibrary: word.favorite === true,
              onToggle: () => onAddToLibrary?.('word', word.id, !word.favorite),
            })),
          h('div', { className: 'er-kcard-meaning' }, word.meanings?.[0]?.contextMeaning ?? word.meanings?.[0]?.meaning ?? ''),
          h('div', { className: 'er-kcard-foot' },
            h(Badge, { tone: cefrTone(word.cefrLevel) }, word.cefrLevel ?? '—'),
            h('span', null, `${word.occurrences}×`),
            h(Mastery, { level: word.masteryLevel ?? 0 })))),
        ),
      ),
    tab === 'phrases' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h(InsightSection, { t, title: t('reader.phrasesTitle'), icon: h(Icons.link, null), sub: detail.phrases.length },
        detail.phrases.length === 0
          ? h(Empty, { icon: h(Icons.link, null), title: t('reader.noPhrases'), description: t('reader.noPhrasesBody') })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            detail.phrases.map((phrase) => h('div', { key: phrase.id, className: 'er-struct-item' },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { className: 'er-en', style: { fontWeight: 600 } }, phrase.expression),
                phrase.phraseType && h(Badge, { tone: 'violet' }, phrase.phraseType),
                h('div', { className: 'er-topbar-spacer' }),
                h(LibraryToggle, {
                  t, inLibrary: phrase.favorite === true,
                  onToggle: () => onAddToLibrary?.('phrase', phrase.id, !phrase.favorite),
                })),
              phrase.meaning && h('div', { className: 'er-kv-value' }, phrase.meaning),
              phrase.explanation && h('div', { className: 'er-meaning-ctx' }, phrase.explanation)))),
        ),
      h(InsightSection, { t, title: t('reader.collocationsTitle'), icon: h(Icons.layers, null), sub: detail.collocations.length },
        detail.collocations.length === 0
          ? h(Empty, { icon: h(Icons.layers, null), title: t('reader.noCollocations'), description: t('reader.noCollocationsBody') })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            detail.collocations.map((item) => h('div', { key: item.id, className: 'er-struct-item' },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { className: 'er-en', style: { fontWeight: 600 } }, item.expression),
                item.pattern && h(Badge, { tone: 'blue' }, item.pattern),
                h('div', { className: 'er-topbar-spacer' }),
                h(LibraryToggle, {
                  t, inLibrary: item.favorite === true,
                  onToggle: () => onAddToLibrary?.('collocation', item.id, !item.favorite),
                })),
              item.meaning && h('div', { className: 'er-kv-value' }, item.meaning),
              item.explanation && h('div', { className: 'er-meaning-ctx' }, item.explanation)))),
        ),
      ),
    tab === 'review' && h(InsightSection, { t, title: t('reader.reviewTitle'), icon: h(Icons.target, null) },
      !review
        ? h(Empty, { icon: h(Icons.target, null), title: t('reader.noReview'), description: t('reader.noReviewBody') })
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-label' }, t('reader.summary')), h('div', { className: 'er-kv-value' }, review.summary)),
          (review.logicalStructure ?? []).length > 0 && h('div', { className: 'er-kv' },
            h('div', { className: 'er-kv-label' }, t('reader.logicalStructure')),
            (review.logicalStructure ?? []).map((step, index) => h('div', { key: index, className: 'er-struct-item', style: { marginBottom: 6 } },
              h('span', { className: 'er-struct-type' }, `${step.step ?? index + 1} · ${step.title}`),
              h('div', { className: 'er-struct-text' }, step.description)))),
          (review.keyTakeaways ?? []).length > 0 && h('div', { className: 'er-kv' },
            h('div', { className: 'er-kv-label' }, t('reader.takeaways')),
            (review.keyTakeaways ?? []).map((item, index) => h('div', { key: index, className: 'er-kv-value' }, `• ${item}`))),
          (review.questions ?? []).length > 0 && h('div', { className: 'er-kv' },
            h('div', { className: 'er-kv-label' }, t('reader.questions')),
            (review.questions ?? []).map((question, index) => h(QuestionItem, { key: index, t, question, index }))))
      ))
  );
}

/** One comprehension question with a reveal toggle. */
function QuestionItem({ t, question, index }) {
  const [revealed, setRevealed] = React.useState(false);
  return h('div', { className: 'er-struct-item', style: { marginBottom: 8 } },
    h('div', { className: 'er-struct-text', style: { fontWeight: 600 } }, `${index + 1}. ${question.question}`),
    question.type === 'choice' && h('div', { className: 'er-kv-value' },
      (question.options ?? []).map((option, at) => h('div', { key: at }, option))),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
      h(Button, { size: 'sm', onClick: () => setRevealed(!revealed) }, revealed ? t('reader.hideAnswer') : t('reader.showAnswer')),
      revealed && h(Badge, { tone: 'mint' }, question.answer)),
    revealed && h('div', { className: 'er-meaning-ctx', style: { marginTop: 6 } }, question.explanation || ''));
}


// ---- src/90-detail.js ----
/** Article detail: the reading surface (continuous mode + dual-column mode). */

/**
 * Stage order, label key and the one-line subject each stage produces.
 * The hint exists because "切分" and "逐句" both show a sentence count: without
 * it, 15/15 next to 15/15 reads like the same measurement twice.
 */
const STAGES_ORDER = [
  { id: 'OVERVIEW', labelKey: 'stage.OVERVIEW', hintKey: 'stageHint.OVERVIEW' },
  { id: 'DIFFICULTY', labelKey: 'stage.DIFFICULTY', hintKey: 'stageHint.DIFFICULTY' },
  { id: 'VOCABULARY', labelKey: 'stage.VOCABULARY', hintKey: 'stageHint.VOCABULARY' },
  { id: 'PHRASES', labelKey: 'stage.PHRASES', hintKey: 'stageHint.PHRASES' },
  { id: 'COLLOCATIONS', labelKey: 'stage.COLLOCATIONS', hintKey: 'stageHint.COLLOCATIONS' },
  { id: 'SEGMENTATION', labelKey: 'stage.SEGMENTATION', hintKey: 'stageHint.SEGMENTATION' },
  { id: 'SENTENCE_ANALYSIS', labelKey: 'stage.SENTENCE_ANALYSIS', hintKey: 'stageHint.SENTENCE_ANALYSIS' },
  { id: 'REVIEW', labelKey: 'stage.REVIEW', hintKey: 'stageHint.REVIEW' },
];

/**
 * Per-stage counter text.
 *
 * A count must describe work actually finished, so each stage reads its own
 * progress payload:
 * - SEGMENTATION reports how many sentences were cut.
 * - SENTENCE_ANALYSIS reports analysed/total, never the success-only count.
 * Other stages have no countable unit and show none.
 * @returns {string} suffix such as ` 4/15`, or an empty string.
 */
function stageCounter(stageId, progress) {
  if (!progress) return '';
  if (stageId === 'SEGMENTATION') {
    // A single, finished action: report the sentence total, not a ratio that
    // looks like progress.
    const total = Number(progress.sentences);
    return Number.isFinite(total) && total > 0 ? ` ${total}` : '';
  }
  if (stageId === 'SENTENCE_ANALYSIS') {
    const total = Number(progress.sentences);
    if (!Number.isFinite(total) || total <= 0) return '';
    const analysed = Number.isFinite(progress.analysed)
      ? progress.analysed
      : (Number(progress.done) || 0) + (Number(progress.needsReview) || 0);
    return ` ${analysed}/${total}`;
  }
  return '';
}

/**
 * Stage progress strip.
 *
 * A failed stage is a button, not a banner: its detail — the error code, the
 * model's raw output and every failed sentence — belongs in a dialog the
 * learner opens on demand, not in a red panel that takes a whole column away
 * from the article they are reading. A stage that did not fail stays plain
 * text, so nothing suggests it is clickable.
 * @param {object} props
 * @param {(stageId: string) => void} props.onInspect opens the stage's detail.
 */
function AnalysisProgress({ t, tasks, onRetry, pending, onInspect, failedCount }) {
  const cells = STAGES_ORDER.map((stage) => {
    const task = tasks.find((item) => item.stage === stage.id);
    const status = task?.status ?? 'PENDING';
    const counter = stageCounter(stage.id, task?.progress);
    const review = stage.id === 'SENTENCE_ANALYSIS' && (task?.progress?.needsReview ?? 0) > 0
      ? ` · ${t('reader.needsReviewCount')} ${task.progress.needsReview}`
      : '';
    // The sentence stage fails per sentence, not as a stage: a run that stopped
    // early leaves the task at PENDING while individual sentences are marked
    // failed. Its detail is worth opening whenever either says so.
    const sentenceFailures = stage.id === 'SENTENCE_ANALYSIS' && failedCount > 0;
    // A run that stopped part-way leaves the stage PENDING so it stays
    // retryable, but it did start: its partial results are already on screen.
    // Calling that "待执行" is wrong, and it hides the retry button.
    const started = Number(task?.progress?.done ?? 0) > 0 || Number(task?.progress?.failed ?? 0) > 0;
    const interrupted = status === 'PENDING' && started;
    const shownStatus = interrupted ? 'INTERRUPTED' : status;
    const inspectable = status === 'FAILED' || status === 'NEEDS_REVIEW' || interrupted || sentenceFailures;
    // A stage that has detail but did not itself fail still needs to say how
    // many sentences went wrong, or the card looks successful.
    const failedBadge = sentenceFailures
      ? h('span', { className: 'er-stage-failed-count' }, `${failedCount} ${t('reader.sentencesFailed')}`)
      : null;
    const body = h(React.Fragment, null,
      h('div', { className: 'er-stage-name' }, t(stage.labelKey, { fallback: stage.id }),
        inspectable ? h(Icons.chevron, { dir: 'right' }) : null),
      h('div', { className: 'er-stage-hint' }, t(stage.hintKey, { fallback: '' }),
        // The status line is where the count lives, so it stays last.
      ),
      h('div', { className: 'er-stage-status' }, `${STATUS_LABELS[shownStatus] ?? shownStatus}${counter}${review}`),
      failedBadge);
    return h('div', { key: stage.id, className: 'er-stage', 'data-status': shownStatus, 'data-inspectable': inspectable },
      inspectable
        ? h('button', {
          type: 'button',
          className: 'er-stage-hit',
          'aria-label': `${t(stage.labelKey, { fallback: stage.id })} · ${t('reader.inspectStage')}`,
          onClick: () => onInspect(stage.id),
        }, body)
        : h('div', { className: 'er-stage-hit er-stage-hit--static' }, body),
      status === 'FAILED' || interrupted
        ? h(Button, { size: 'sm', variant: 'ghost', disabled: pending, onClick: () => onRetry(stage.id) }, t('common.retry'))
        : null);
  });
  return h('div', { className: 'er-stage-list' }, cells);
}

/**
 * Reader progress band.
 *
 * Collapses to a single progress line unless something needs attention (a failed
 * stage, a review flag, or a run in flight). The stage grid is tall; when every
 * stage succeeded it only repeats "done" eight times and steals height from the
 * article. `open` lets the learner override either way.
 * @param {object} props
 * @param {boolean|null} props.open null = follow the automatic rule.
 */
function Band({ t, ratio, position, tasks, running, onRetry, pending, open, onToggle, onInspect, failedCount }) {
  const needsAttention = running || failedCount > 0 || tasks.some((task) => (
    task.status === 'FAILED' || task.status === 'NEEDS_REVIEW'
  ));
  const expanded = open === null ? needsAttention : open;

  const attentionCount = tasks.filter((task) => task.status === 'FAILED' || task.status === 'NEEDS_REVIEW').length;
  const label = task => STATUS_LABELS[task.status] ?? task.status;

  const bar = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
    h('span', { className: 'er-card-sub', style: { flex: 'none' } }, t('reader.progress')),
    h('div', { style: { flex: 1, minWidth: 80 } }, h(Progress, { ratio })),
    h('span', { className: 'er-card-sub', style: { flex: 'none' } }, `${Math.round(ratio * 100)}%`),
    h('span', { className: 'er-card-sub', style: { flex: 'none' } }, position),
    needsAttention && !expanded
      ? h(Badge, { tone: 'pink' }, `${attentionCount} ${t('reader.needsAttention')}`)
      : null,
    // `onToggle` receives the *next* state. Passing the current one made the
    // parent store the value it already had, so the button looked dead.
    h(Button, {
      size: 'sm',
      variant: 'ghost',
      icon: h(Icons.chevron, { dir: expanded ? 'up' : 'down' }),
      iconOnly: true,
      ariaExpanded: expanded,
      ariaLabel: expanded ? t('reader.collapseBand') : t('reader.expandBand'),
      title: expanded ? t('reader.collapseBand') : t('reader.expandBand'),
      onClick: () => onToggle(!expanded),
    }));

  return h(Cell, {
    span: 12,
    size: 'compact',
    // Collapsed: no bottom padding, so the reader starts right beneath the bar.
    className: expanded ? 'er-reader-band' : 'er-reader-band er-reader-band--collapsed',
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: expanded ? 10 : 0 } },
    bar,
    expanded
      ? h(React.Fragment, null,
        h(AnalysisProgress, { t, tasks, onRetry, pending, onInspect, failedCount }),
        running ? h(Alert, { tone: 'warn' }, t('reader.analysisRunning')) : null)
      : null));
}

/**
 * Detail dialog for one stage.
 *
 * Opened when the learner clicks a failed (or review-flagged) stage card. It
 * lists the error codes with their meanings, the model's raw output when there
 * is one, and — for the sentence stage — every failed sentence with a jump
 * button, so the reader can go straight to it and retry.
 *
 * The page itself stays clean: a red summary panel used to sit in the aside
 * and push the article aside even when the learner only wanted to read.
 */
function StageDetailDialog({ t, stageId, tasks, sentences, onClose, onJump, onRetry }) {
  const stage = STAGES_ORDER.find((item) => item.id === stageId);
  const task = tasks.find((item) => item.stage === stageId);
  const status = task?.status ?? 'PENDING';
  const stageName = stage ? t(stage.labelKey, { fallback: stageId }) : stageId;

  // Only the sentence stage fails per item; the others fail as a whole stage.
  const failed = stageId === 'SENTENCE_ANALYSIS'
    ? sentences.filter((item) => item.analysisStatus === 'failed')
    : [];
  const codes = new Map();
  if (failed.length > 0) {
    for (const item of failed) {
      const code = item.error?.code ?? 'LLM_UNAVAILABLE';
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  } else if (task?.errorCode) {
    codes.set(task.errorCode, 1);
  }
  const counter = stageCounter(stageId, task?.progress);
  const review = stageId === 'SENTENCE_ANALYSIS' && (task?.progress?.needsReview ?? 0) > 0
    ? ` · ${t('reader.needsReviewCount')} ${task.progress.needsReview}`
    : '';

  const rawOutput = failed.find((item) => typeof item.error?.raw === 'string' && item.error.raw.length > 0)?.error.raw ?? null;

  const body = h('div', { className: 'er-stage-detail' },
    h('div', { className: 'er-stage-detail-head' },
      h(Badge, { tone: status === 'FAILED' ? 'pink' : 'amber' }, `${STATUS_LABELS[status] ?? status}${counter}${review}`),
      h('div', { className: 'er-stage-hint' }, t(stage?.hintKey ?? '', { fallback: '' }))),
    codes.size > 0
      ? h('div', { className: 'er-stage-detail-codes' },
        [...codes.entries()].map(([code, count]) => h('div', { key: code, className: 'er-stage-detail-code' },
          h(Badge, { tone: 'pink' }, `${code} × ${count}`),
          h('div', { className: 'er-stage-detail-meaning' }, t(`error.${code}`, { fallback: t('error.unknown') })))))
      : null,
    task?.errorMessage
      ? h('div', { className: 'er-stage-detail-msg' }, task.errorMessage)
      : null,
    // A per-sentence failure usually says the same thing as the stage; only
    // show it when it adds a specific reason.
    failed.length > 0
      ? h('div', { className: 'er-stage-detail-list' },
        failed.map((item) => h('div', { key: item.sentenceIndex, className: 'er-stage-detail-row' },
          h('span', { className: 'er-badge plain' }, `#${item.sentenceIndex + 1}`),
          h('span', { className: 'er-stage-detail-text' }, item.text),
          item.error?.message ? h('span', { className: 'er-meaning-ctx' }, item.error.message) : null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => onJump(item.sentenceIndex) }, t('reader.jumpToSentence')))))
      : null,
    // The model's raw output is the fastest way to tell a truncation from a
    // refusal; it is stored per sentence, so show the first one there is.
    rawOutput
      ? h('div', { className: 'er-stage-detail-raw er-mono' }, rawOutput)
      : null);

  return h(Dialog, {
    title: `${stageName} · ${t('reader.stageDetail')}`,
    onClose,
    footer: status === 'FAILED'
      ? h(Button, { disabled: false, onClick: () => { onRetry(stageId); onClose(); } }, t('common.retry'))
      : null,
  }, body);
}

/** Note list for the article, above the reader. */
function NoteList({ t, notes }) {
  if (notes.length === 0) return null;
  return h(Cell, { span: 12, eyebrow: `${t('reader.notes')} · ${notes.length}`, icon: h(Icons.note, null) },
    notes.map((note) => h('div', { key: note.id, className: 'er-struct-item', style: { marginBottom: 8 } },
      h('div', { className: 'er-struct-text' }, note.body),
      h('div', { className: 'er-meaning-ctx' },
        note.sentenceIndex !== null && note.sentenceIndex !== undefined
          ? `${t('reader.sentence')} #${note.sentenceIndex + 1}`
          : t('reader.articleNote'),
        ' · ', relativeDate(note.createdAt)))));
}

/** The reading page. */
function ArticleDetail({ t, articleId, notify, onBack, onNavigateKnowledge }) {
  const detail = useLoad(() => call('getArticle', { articleId }), [articleId]);
  const [mode, setMode] = React.useState('split');
  const [active, setActive] = React.useState(-1);
  const [drawerWord, setDrawerWord] = React.useState(null);
  const [insightTab, setInsightTab] = React.useState('guide');
  // The stage strip only earns its space when something needs attention; a fully
  // successful analysis collapses to a single progress line, and the reader gets
  // the height back. The learner can always open it to inspect the detail.
  const [bandOpen, setBandOpen] = React.useState(null);
  // Which stage's detail dialog is open, or null when none is.
  const [inspectStage, setInspectStage] = React.useState(null);
  const [noteDraft, setNoteDraft] = React.useState('');
  const action = useAction();
  const words = React.useMemo(() => (detail.data ? wordIndex(detail.data) : new Map()), [detail.data]);
  const sentences = detail.data?.sentences ?? [];
  const activeSentence = sentences.find((sentence) => sentence.sentenceIndex === active) ?? null;

  React.useEffect(() => {
    if (detail.data && active < 0) setActive(detail.data.progress?.sentenceIndex ?? 0);
  }, [detail.data, active]);

  // Reading time is measured, not estimated: accumulate wall-clock time only
  // while this pane is visible, and attribute it to the article on the next save.
  const readMs = React.useRef(0);
  const visibleSince = React.useRef(null);
  React.useEffect(() => {
    const markVisible = () => {
      if (visibleSince.current === null) visibleSince.current = Date.now();
    };
    // Without a DOM there is no visibility signal; count elapsed time only.
    if (typeof document === 'undefined') return undefined;
    const flush = () => {
      if (visibleSince.current !== null) {
        readMs.current += Date.now() - visibleSince.current;
        visibleSince.current = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markVisible();
      else flush();
    };
    markVisible();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [articleId]);

  // Reading position is saved once the selection settles, so dragging through
  // sentences does not write a row per click. The save carries the seconds read
  // since the previous save, so the study log reflects real attention.
  React.useEffect(() => {
    if (detail.data === undefined || active < 0) return undefined;
    const total = Math.max(1, sentences.length - 1);
    const ratio = Math.min(1, Math.max(0, active) / total);
    const timer = setTimeout(() => {
      // Fold the currently-visible span in before reporting.
      if (visibleSince.current !== null) {
        readMs.current += Date.now() - visibleSince.current;
        visibleSince.current = Date.now();
      }
      const seconds = Math.round(readMs.current / 1000);
      readMs.current = 0;
      call('saveProgress', { articleId, sentenceIndex: active, ratio, seconds }).catch(() => undefined);
    }, 900);
    return () => clearTimeout(timer);
  }, [active, articleId, detail.data, sentences.length]);

  const updateWord = async (wordId, patch) => {
    const value = await action.run(() => call('updateKnowledge', { entityType: 'word', entityId: wordId, ...patch }));
    if (value) detail.reload();
  };
  /**
   * Add or remove one entity from the knowledge library.
   * Nothing is stored until this runs, which is what keeps parsing from
   * silently filling the library.
   */
  const setInLibrary = async (kind, entityId, next) => {
    const value = await action.run(() => call('updateKnowledge', {
      entityType: kind, entityId, favorite: next,
    }));
    if (value) {
      notify(next ? t('reader.addedToLibrary') : t('reader.removedFromLibrary'), 'ok');
      detail.reload();
    }
  };
  const startAnalysis = async () => {
    const started = await action.run(() => call('startAnalysis', { articleId }));
    if (started) {
      notify(t('articles.analysisStarted'), 'ok');
      detail.reload();
    }
  };
  const retry = async (stage) => {
    const state = await action.run(() => call('retryStage', { articleId, stage }));
    if (state) {
      notify(t('articles.retryDone'), 'ok');
      detail.reload();
    }
  };
  const addNote = async () => {
    if (noteDraft.trim().length === 0) return;
    const saved = await action.run(() => call('saveNote', {
      articleId, body: noteDraft, sentenceIndex: active >= 0 ? active : undefined,
    }));
    if (saved) {
      setNoteDraft('');
      detail.reload();
    }
  };
  /**
   * Re-fetch the source page, keep only the prose and re-segment the article.
   *
   * An article imported before the cleaner existed still carries the page's
   * chrome in its body. Cleaning it changes every sentence offset, so the
   * analysis is dropped and the reader is told to run it again.
   */
  const cleanBody = async () => {
    const result = await action.run(() => call('cleanArticle', { articleId }));
    if (!result) return;
    notify(t('reader.cleaned', {
      before: result.wordsBefore,
      after: result.wordsAfter,
    }), 'ok');
    detail.reload();
  };
  const removeArticle = async () => {
    const removed = await action.run(() => call('deleteArticle', { articleId }));
    if (removed) onBack();
  };

  if (detail.status === 'loading' && !detail.data) {
    return h('div', { className: 'er-page' },
      h(Skeleton, { height: 44, radius: 14 }), h(Skeleton, { height: 320, radius: 20 }));
  }
  if (detail.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, detail.error.message),
      h('div', null, h(Button, { onClick: detail.reload }, t('common.retry'))));
  }

  const data = detail.data;
  const article = data.article;
  const total = Math.max(1, sentences.length);
  const ratio = sentences.length > 1 ? Math.min(1, Math.max(0, active) / (sentences.length - 1)) : 0;
  const running = data.analysis?.status === 'RUNNING' || data.tasks.some((task) => task.status === 'RUNNING');

  const jumpToSentence = (index) => {
    setActive(index);
    setMode('split');
  };

  const pane = SentencePane({
    t,
    sentence: activeSentence ? { ...activeSentence, articleId } : null,
    sentenceText: activeSentence?.text ?? '',
    onAddToLibrary: (sentence, next) => setInLibrary('sentence', sentence.id, next),
  });
  const sentencePanel = h('section', { className: 'er-cell er-side-card' },
    h('div', { className: 'er-side-head' },
      h('div', { className: 'er-side-title' }, h(Icons.target, null), h('span', null, t('reader.sentenceTab'))),
      h('div', { style: { display: 'flex', gap: 4 } },
        h(Button, {
          size: 'sm', variant: 'ghost', disabled: active <= 0,
          onClick: () => setActive(Math.max(0, active - 1)),
        }, '‹'),
        h(Button, {
          size: 'sm', variant: 'ghost', disabled: active >= sentences.length - 1,
          onClick: () => setActive(Math.min(sentences.length - 1, active + 1)),
        }, '›'))),
    // Header (title + sentence + add button) is part of the fixed frame; only
    // the analysis below it scrolls.
    pane.head,
    // The note composer travels with the analysis instead of pinning itself to
    // the panel bottom: a fixed footer reserved height for a field the reader
    // may never use, and the analysis had to shrink to fit around it. It now
    // arrives at the end of the scroll, where a note naturally belongs.
    h('div', { className: 'er-side-scroll', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      pane.body,
      activeSentence
        ? h('div', { className: 'er-note-compose' },
          h('div', { className: 'er-kv-label', style: { marginBottom: 6 } }, t('reader.noteForSentence')),
          h('textarea', {
            className: 'er-textarea', style: { minHeight: 74, fontSize: 12 },
            value: noteDraft, placeholder: t('reader.notePlaceholder'),
            onChange: (event) => setNoteDraft(event.target.value),
          }),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
            h(Button, {
              size: 'sm', disabled: action.pending || noteDraft.trim().length === 0, onClick: addNote,
            }, t('reader.saveNote'))))
        : null));

  const insightPanel = h(ArticleInsights, {
    onAddToLibrary: (kind, id, next) => setInLibrary(kind, id, next),
    t, detail: data, tab: insightTab, onTab: setInsightTab, onWord: setDrawerWord,
    onAnalysis: startAnalysis,
  });

  return h('div', { className: 'er-page er-page--fill' },
    h('div', { className: 'er-topbar' },
      h(Button, { variant: 'ghost', icon: h(Icons.arrowLeft, null), onClick: onBack }, t('common.back')),
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, article.title)),
      h('div', { className: 'er-topbar-spacer' }),
      h(Tabs, {
        items: [
          { id: 'split', label: t('reader.modeSplit') },
          { id: 'continuous', label: t('reader.modeContinuous') },
        ],
        value: mode, onChange: setMode,
      }),
      h(Button, {
        variant: 'ghost', icon: h(Icons.broom, null), disabled: action.pending || running, onClick: cleanBody,
        title: t('reader.cleanHint'),
      }, t('reader.clean')),
      h(Button, {
        variant: 'primary', icon: h(Icons.sparkle, null), disabled: action.pending || running, onClick: startAnalysis,
      }, running ? t('reader.analyzing') : data.analysis ? t('common.reanalyze') : t('articles.analyze'))),

    h(Band, {
      t,
      ratio,
      position: `${Math.max(1, active + 1)} / ${total}`,
      tasks: data.tasks,
      running,
      onRetry: retry,
      pending: action.pending,
      open: bandOpen,
      onToggle: setBandOpen,
      onInspect: setInspectStage,
      failedCount: sentences.filter((item) => item.analysisStatus === 'failed').length,
    }),

    h('div', { className: 'er-reader er-reader--fill' },
      h('section', { className: 'er-cell er-article-card' },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
          h(Thumb, { id: article.id, style: { width: 76, height: 56, flex: 'none' } }),
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('h2', { className: 'er-article-title' }, article.title),
            h('div', { className: 'er-article-meta' },
              h(Badge, { tone: cefrTone(article.cefrLevel) }, `${article.cefrLevel ?? '—'} · AI 估计`),
              h(Badge, { tone: 'soft' }, article.sourceName ?? 'Manual'),
              h('span', null, `${data.wordCount} ${t('common.words')}`),
              h('span', { className: 'er-crumb-dot' }),
              h('span', null, `${article.readingMinutes} ${t('common.minutes')}`),
              article.publishedAt ? h('span', null, shortDate(article.publishedAt)) : null,
              article.sourceUrl
                ? h('a', {
                  className: 'er-source-link',
                  href: article.sourceUrl,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: article.sourceUrl,
                }, h(Icons.link, null), h('span', null, t('reader.openSource')))
                : null)),
          h(Button, {
            variant: 'ghost', iconOnly: true, children: t('common.delete'), onClick: removeArticle,
          }, h(Icons.trash, null))),
        h('div', { className: 'er-pane-scroll' },
          sentences.length === 0
            ? h(Empty, { icon: h(Icons.bookOpen, null), title: t('reader.emptyBody'), description: t('reader.emptyBodyHint') })
            : h(ArticleBody, {
              detail: data, words, activeIndex: active, onSelect: setActive, onWord: setDrawerWord,
            }))),
      mode === 'split'
        ? h('aside', { className: 'er-side' },
          // Both children render their own cell, or nothing at all.
          sentencePanel,
          h(NoteList, { t, notes: data.notes }))
        : h('aside', { className: 'er-side' },
          insightPanel,
          h(NoteList, { t, notes: data.notes }))),


    inspectStage
      ? h(StageDetailDialog, {
        t,
        stageId: inspectStage,
        tasks: data.tasks,
        sentences,
        onClose: () => setInspectStage(null),
        onJump: (index) => {
          setInspectStage(null);
          jumpToSentence(index);
        },
        onRetry: retry,
      })
      : null,

    drawerWord
      ? h(Dialog, {
        title: t('reader.wordDetail'), onClose: () => setDrawerWord(null),
        footer: h(Button, {
          onClick: () => {
            const wordId = drawerWord.id;
            setDrawerWord(null);
            onNavigateKnowledge('word', wordId);
          },
        }, t('reader.openInKnowledge')),
      },
      h(WordCard, {
        t, word: drawerWord,
        onFavorite: (id, value) => updateWord(id, { favorite: value }),
        onMastery: (id, value) => updateWord(id, { masteryLevel: value }),
      }))
      : null,

    action.error ? h(Alert, null, action.error.message) : null);
}


// ---- src/100-knowledge.js ----
/** Knowledge base pages, review centre and settings, all over the same facade. */

const KIND_LABELS = { word: '单词', phrase: '短语', collocation: '搭配', sentence: '句子' };
const MASTERY_LABELS = ['未学习', '初次接触', '认识', '基本掌握', '熟练掌握'];

/** One knowledge card in the library grid. */
function KnowledgeCard({ t, item, onOpen, onFavorite }) {
  const detailText = Array.isArray(item.detail)
    ? item.detail.map((entry) => entry.contextMeaning ?? entry.meaning ?? '').filter(Boolean).join('；')
    : (typeof item.detail === 'string' ? item.detail : '') || (item.meaning ?? '');
  return h('div', {
    className: 'er-kcard', role: 'button', tabIndex: 0,
    onClick: () => onOpen(item.id),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen(item.id);
      }
    },
  },
  h('div', { className: 'er-kcard-top' },
    h('span', { className: 'er-kcard-word' }, item.expression),
    item.phonetic ? h('span', { className: 'er-phonetic' }, item.phonetic) : null,
    h('div', { className: 'er-topbar-spacer' }),
    h('button', {
      type: 'button', className: 'er-btn ghost icon sm', 'aria-label': t('common.favorite'),
      style: { color: item.favorite ? 'var(--er-amber)' : undefined },
      onClick: (event) => {
        event.stopPropagation();
        onFavorite(item.id, !item.favorite);
      },
    }, h(Icons.star, { filled: item.favorite }))),
  h('div', { className: 'er-kcard-meaning' }, detailText || '—'),
  h('div', { className: 'er-kcard-foot' },
    item.cefrLevel ? h(Badge, { tone: cefrTone(item.cefrLevel) }, item.cefrLevel) : null,
    h(Mastery, { level: item.masteryLevel }),
    h('div', { className: 'er-topbar-spacer' }),
    h('span', null, `${item.sourceCount} ${t('knowledge.sources')}`)));
}

/** Entity detail: meanings, mastery selector, editable note, every context. */
function KnowledgeDetail({ t, kind, entityId, onBack, notify }) {
  const detail = useLoad(() => call('knowledgeDetail', { kind, entityId }), [kind, entityId]);
  const action = useAction();
  const [noteDraft, setNoteDraft] = React.useState(null);
  const data = detail.data;

  React.useEffect(() => {
    if (data && noteDraft === null) setNoteDraft(data.notes ?? '');
  }, [data, noteDraft]);

  const update = async (patch) => {
    const value = await action.run(() => call('updateKnowledge', { entityType: kind, entityId, ...patch }));
    if (value) {
      detail.reload();
      notify(t('knowledge.updated'), 'ok');
    }
  };

  if (detail.status === 'loading' && !data) {
    return h('div', { className: 'er-page' }, h(Skeleton, { height: 220, radius: 20 }));
  }
  if (detail.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, detail.error.message),
      h('div', null, h(Button, { onClick: onBack }, t('common.back'))));
  }

  const contexts = data.contexts ?? [];
  const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
    h('div', { className: 'er-dict-head', style: { flex: 1 } },
      h('div', { className: 'er-dict-word', style: { fontSize: 22 } }, data.expression),
      h(SpeakButton, { t, text: data.expression, size: 'sm', variant: 'ghost' }),
      data.phonetic ? h('span', { className: 'er-phonetic' }, data.phonetic) : null,
      kind === 'word' && data.cefrLevel ? h(Badge, { tone: cefrTone(data.cefrLevel) }, data.cefrLevel) : null),
    h(Button, {
      size: 'sm', variant: 'ghost', iconOnly: true, children: t('common.favorite'),
      onClick: () => update({ favorite: !data.favorite }),
    }, h('span', { style: { color: data.favorite ? 'var(--er-amber)' : undefined, display: 'grid' } }, h(Icons.star, { filled: data.favorite }))));

  const meanings = kind === 'word' ? (data.meanings ?? []) : [];
  const meaningBlock = kind === 'word'
    ? meanings.map((meaning, index) => h('div', { key: index, className: 'er-meaning' },
      h('div', { className: 'er-meaning-cn' }, meaning.meaning),
      meaning.contextMeaning ? h('div', { className: 'er-meaning-ctx' }, meaning.contextMeaning) : null))
    : [h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      data.meaning ? h('div', { className: 'er-kv-value' }, data.meaning) : null,
      data.explanation ? h('div', { className: 'er-meaning-ctx' }, data.explanation) : null,
      data.pattern ? h(Badge, { tone: 'blue' }, data.pattern) : null)];
  const synonyms = kind === 'word' && (data.synonyms ?? []).length > 0
    ? h('div', { className: 'er-kv', style: { marginTop: 10 } },
      h('div', { className: 'er-kv-label' }, t('word.synonyms')),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        data.synonyms.map((value) => h('span', { key: value, className: 'er-token' }, value))))
    : null;
  const masteryRow = h('div', { className: 'er-chips' },
    [0, 1, 2, 3, 4].map((level) => h('button', {
      key: level, type: 'button', className: 'er-chip',
      'aria-pressed': data.masteryLevel === level,
      onClick: () => update({ masteryLevel: level }),
    }, `${level} · ${MASTERY_LABELS[level]}`)));
  const noteBlock = h('div', { style: { marginTop: 14 } },
    h('div', { className: 'er-kv-label', style: { marginBottom: 6 } }, t('knowledge.notes')),
    h('textarea', {
      className: 'er-textarea', style: { minHeight: 82 },
      value: noteDraft ?? '',
      onChange: (event) => setNoteDraft(event.target.value),
    }),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
      h(Button, { size: 'sm', disabled: action.pending, onClick: () => update({ notes: noteDraft ?? '' }) }, t('knowledge.saveNote'))));
  const contextList = contexts.length === 0
    ? h(Empty, { icon: h(Icons.bookOpen, null), title: t('knowledge.noContext'), description: '' })
    : h('div', { className: 'er-cell-scroll', style: { display: 'flex', flexDirection: 'column', gap: 8, '--er-cell-max': '460px' } },
      contexts.map((context, index) => h('div', { key: index, className: 'er-struct-item' },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { className: 'er-struct-type', style: { alignSelf: 'flex-start' } }, context.title ?? ''),
          context.cefrLevel ? h(Badge, { tone: cefrTone(context.cefrLevel) }, context.cefrLevel) : null,
          context.sourceName ? h(Badge, { tone: 'soft' }, context.sourceName) : null),
        context.contextMeaning ? h('div', { className: 'er-struct-text' }, context.contextMeaning) : null,
        (context.evidence ?? []).map((item, at) => h('div', {
          key: at, className: 'er-example', style: { marginTop: 4 },
        }, item.exactText)),
        context.analysis?.translation?.natural
          ? h('div', { className: 'er-meaning-ctx', style: { marginTop: 4 } }, context.analysis.translation.natural)
          : null)));
  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h(Button, { variant: 'ghost', icon: h(Icons.arrowLeft, null), onClick: onBack }, t('common.back')),
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }),
        h('span', null, KIND_LABELS[kind]), h('span', { className: 'er-crumb-dot' }),
        h('span', null, data.expression))),
    h(Board, null,
      h(Cell, { span: 8, size: 'feature', eyebrow: t('knowledge.detail') }, header,
        h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } }, meaningBlock), synonyms,
        h('div', { style: { marginTop: 16 } }, masteryRow)),
      h(Cell, { span: 4, eyebrow: t('knowledge.myNote') }, noteBlock),
      h(Cell, { span: 12, eyebrow: `${t('knowledge.contexts')} · ${contexts.length}`, icon: h(Icons.bookOpen, null) }, contextList)),
    action.error ? h(Alert, null, action.error.message) : null);
}

/** Icon that matches one knowledge kind. */
const KIND_ICONS = {
  word: 'letters',
  phrase: 'link',
  collocation: 'layers',
  sentence: 'quote',
};

/** One knowledge library page. */
function KnowledgePage({ t, kind, notify }) {
  const [search, setSearch] = React.useState('');
  // Everything listed is already in the library, so "only favourites" would be a
  // no-op; the useful filter is what still needs learning.
  const [unmasteredOnly, setUnmasteredOnly] = React.useState(false);
  const [openId, setOpenId] = React.useState(null);
  const list = useLoad(() => call('searchKnowledge', {
    kind, search, maxMastery: unmasteredOnly ? 2 : undefined,
    limit: 60,
  }), [kind, search, unmasteredOnly]);
  const action = useAction();
  const favorite = async (id, value) => {
    const updated = await action.run(() => call('updateKnowledge', { entityType: kind, entityId: id, favorite: value }));
    if (updated) list.reload();
  };
  if (openId !== null) {
    return h(KnowledgeDetail, { t, kind, entityId: openId, onBack: () => setOpenId(null), notify });
  }
  const body = list.status === 'loading' && !list.data
    ? h('div', { className: 'er-kgrid' }, [0, 1, 2, 3].map((index) => h(Skeleton, { key: index, height: 112, radius: 15 })))
    : list.status === 'error'
      ? h(Alert, null, list.error.message)
      : list.data.length === 0
        // Each tab explains its own emptiness: words existing says nothing
        // about phrases, and a shared "library is empty" message was simply
        // wrong for the three other tabs.
        ? h(Empty, {
          icon: h(Icons[KIND_ICONS[kind] ?? 'letters'], null),
          title: t(`knowledge.empty.${kind}.title`, { fallback: t('knowledge.emptyTitle') }),
          description: t(`knowledge.empty.${kind}.body`, { fallback: t('knowledge.emptyBody') }),
        })
        : h('div', { className: 'er-kgrid' }, list.data.map((item) => h(KnowledgeCard, {
          key: item.id, t, item, onOpen: setOpenId, onFavorite: favorite,
        })));
  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, KIND_LABELS[kind])),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `${list.data?.length ?? 0} ${t('knowledge.count')}`)),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      h('div', { className: 'er-search', style: { flex: '1 1 240px' } },
        h(Icons.search, null),
        h('input', {
          type: 'search', placeholder: t('knowledge.searchPlaceholder'), value: search,
          onChange: (event) => setSearch(event.target.value),
        })),
      h(Button, {
        icon: h(Icons.target, null),
        variant: unmasteredOnly ? 'primary' : undefined,
        onClick: () => setUnmasteredOnly(!unmasteredOnly),
      }, t('knowledge.notMastered'))),
    body,
    action.error ? h(Alert, null, action.error.message) : null);
}

/** Flashcards over the not-yet-mastered vocabulary. */
function ReviewPage({ t, notify }) {
  const queue = useLoad(() => call('reviewQueue', { limit: 20 }), []);
  const [index, setIndex] = React.useState(0);
  const [revealed, setRevealed] = React.useState(false);
  const action = useAction();
  const items = queue.data?.items ?? [];
  const current = items[Math.min(index, Math.max(0, items.length - 1))];

  const score = async (level) => {
    if (!current) return;
    const updated = await action.run(() => call('updateKnowledge', {
      entityType: 'word', entityId: current.id, masteryLevel: level,
    }));
    if (updated) {
      setRevealed(false);
      setIndex((value) => value + 1);
      queue.reload();
      notify(t('review.next'), 'ok');
    }
  };

  if (queue.status === 'loading' && !queue.data) {
    return h('div', { className: 'er-page' }, h(Skeleton, { height: 240, radius: 20 }));
  }
  if (queue.status === 'error') {
    return h('div', { className: 'er-page' }, h(Alert, null, queue.error.message));
  }

  const reviewed = queue.data.reviewedToday;
  const target = queue.data.target;

  const flashCell = h(Cell, { span: 8, size: 'feature', tint: true },
    h('div', { className: 'er-flash-words', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 } },
      current
        ? h(React.Fragment, null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { className: 'er-flash-word' }, current.expression),
            h(SpeakButton, { t, text: current.expression, size: 'sm', variant: 'ghost' })),
          current.phonetic ? h('span', { className: 'er-phonetic' }, current.phonetic) : null,
          revealed
            ? h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 } },
              (current.meanings ?? []).map((meaning, index2) => h('div', { key: index2, className: 'er-meaning-cn' }, meaning.meaning)),
              h('span', { className: 'er-card-sub' }, MASTERY_LABELS[current.masteryLevel]))
            : h(Button, { variant: 'ghost', onClick: () => setRevealed(true) }, t('review.reveal')),
          revealed
            ? h('div', { className: 'er-flash-answers' },
              h(Button, { variant: 'primary', onClick: () => score(4) }, t('review.mastered')),
              h(Button, { onClick: () => score(2) }, t('review.again')),
              h(Button, { variant: 'ghost', onClick: () => score(0) }, t('review.unsure')))
            : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', marginTop: 4 } },
            h('span', { className: 'er-card-sub' }, `${Math.min(index + 1, items.length)} / ${items.length}`),
            h('div', { style: { flex: 1 } }, h(Progress, { ratio: items.length === 0 ? 0 : (index + 1) / items.length }))))
        : h(Empty, { icon: h(Icons.check, null), title: t('review.emptyTitle'), description: t('review.emptyBody') })));

  const counterCell = h(Cell, { span: 4, eyebrow: t('review.today'), icon: h(Icons.target, null) },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h(StatTile, { icon: h(Icons.star, null), value: queue.data.total, label: t('review.totalWords') }),
      h(StatTile, { icon: h(Icons.target, null), value: queue.data.mastered, label: t('review.masteredCount') }),
      h(StatTile, { icon: h(Icons.clock, null), value: reviewed, label: t('review.todayReviewed') }),
      h(StatTile, { icon: h(Icons.flame, null), value: queue.data.items.length, label: t('review.remaining') })));

  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.review'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `${t('review.today')} ${reviewed} / ${target}`)),
    h(Board, null, flashCell, counterCell));
}

/**
 * Group a flat provider/model list into provider groups.
 *
 * The fallback for a shell whose model catalog is not reachable: the Host
 * route carries every model, but without the provider display names.
 * @param {object[]} rows flat model rows.
 * @returns {object[]} provider groups.
 */
function groupFlatModels(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.provider)) groups.set(row.provider, { provider: row.provider, name: row.provider, models: [] });
    groups.get(row.provider).models.push({ model: row.model, label: row.label ?? row.model });
  }
  return [...groups.values()];
}

/** Settings: model status, parser knobs, data facts, backup guidance, demo data. */
function SettingsPage({ t, notify }) {
  const data = useLoad(() => call('settings'), []);
  const action = useAction();
  const [trial, setTrial] = React.useState('Small habits can lead to big changes.');
  const [voicePref, setVoicePref] = React.useState(() => speechPrefs());
  // The model the conversation is actually running on. The Host only knows the
  // deployment default, so this is read from the current Session in the browser.
  const sessionModel = useSessionModel();
  // The Harness model catalog: the same provider-grouped roster the shell's own
  // model picker shows. The browser half owns it; the Host route carries the
  // same models as a flat list, which is the fallback when the catalog is not
  // reachable (an older shell, or a session without a model yet).
  const catalog = useModelCatalog();
  const modelGroups = catalog?.groups
    ? catalog.groups.map((group) => ({
      provider: group.id ?? group.provider,
      name: group.name ?? group.provider ?? group.id,
      models: (group.models ?? []).map((model) => ({
        model: model.id ?? model.model,
        label: model.name ?? model.label ?? model.id ?? model.model,
      })),
    }))
    : groupFlatModels(data.data?.availableModels ?? []);
  // Name the session's model the way the picker names it: the friendly label
  // when the roster knows it, the raw model id otherwise.
  const sessionLabel = sessionModel === null
    ? ''
    : (modelGroups.flatMap((group) => group.models
      .filter((row) => row.model === sessionModel.model)
      .map((row) => row.label))[0] ?? sessionModel.model);
  // Draft for the editable model/tuning. Derived from the payload on first
  // render and then owned by the controls, so a save never fights a re-render.
  const [draftState, setDraft] = React.useState(null);
  const draft = data.data ? (draftState ?? {
    modelOverride: data.data.modelOverride ?? null,
    sentenceConcurrency: data.data.tuning?.sentenceConcurrency ?? 2,
    retryLimit: data.data.tuning?.retryLimit ?? 2,
  }) : null;
  /**
   * Apply an edit and persist it immediately: these are preferences, so a save
   * button would only add a step that can be forgotten. The control updates
   * optimistically, and a rejected save is reported and rolled back.
   */
  const applyDraft = async (patch) => {
    const next = { ...draft, ...patch };
    const previous = draft;
    setDraft(next);
    try {
      const result = await call('savePluginSettings', {
        tuning: {
          sentenceConcurrency: next.sentenceConcurrency,
          retryLimit: next.retryLimit,
        },
        modelOverride: next.modelOverride,
      });
      if (result?.saved === false) {
        // The chosen model disappeared from the Harness: keep the old value.
        setDraft(previous);
        notify(t('settings.modelUnknown'), 'error');
      }
    } catch (error) {
      setDraft(previous);
      notify(error.message, 'error');
    }
  };
  if (data.status === 'loading' && !data.data) {
    return h('div', { className: 'er-page' }, h(Skeleton, { height: 220, radius: 20 }));
  }
  // Without this branch a failed RPC rendered `vundefined` everywhere.
  if (data.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, data.error.message),
      h('div', { style: { marginTop: 10 } }, h(Button, { onClick: data.reload }, t('common.retry'))));
  }
  const settings = data.data ?? {};
  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.settings'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `v${settings.version} · schema ${settings.schemaVersion}`)),
    h(Board, null,
      h(Cell, { span: 6, eyebrow: t('settings.model'), icon: h(Icons.sparkle, null) },
        h('div', { className: 'er-set-row er-set-row--stack' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.modelRoute')),
            h('div', { className: 'er-set-row-desc' },
              sessionModel === null
                ? t('settings.modelHint')
                : t('settings.modelSessionNow', { model: sessionLabel }))),
          h('select', {
            className: 'er-select', style: { width: '100%' },
            value: draft.modelOverride ? `${draft.modelOverride.provider}:${draft.modelOverride.model}` : '',
            onChange: (event) => {
              const next = event.target.value;
              if (next === '') { applyDraft({ modelOverride: null }); return; }
              const at = next.indexOf(':');
              applyDraft({ modelOverride: { provider: next.slice(0, at), model: next.slice(at + 1) } });
            },
          },
          h('option', { value: '' },
            sessionModel === null
              ? t('settings.modelFollowSession')
              : t('settings.modelFollowSessionNamed', { model: sessionLabel })),
          modelGroups.map((group) => h('optgroup', {
            key: group.provider,
            label: group.name ?? group.provider,
          }, group.models.map((row) => h('option', {
            key: `${group.provider}:${row.model}`,
            value: `${group.provider}:${row.model}`,
          }, row.label)))))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.sentenceConcurrency')),
            h('div', { className: 'er-set-row-desc' }, t('settings.sentenceConcurrencyHint'))),
          h('input', {
            className: 'er-input', type: 'number', min: 1, max: 5, style: { width: 70 },
            value: draft.sentenceConcurrency,
            onChange: (event) => applyDraft({ sentenceConcurrency: Math.max(1, Math.min(5, Number(event.target.value) || 1)) }),
          })),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.retryLimit')),
            h('div', { className: 'er-set-row-desc' }, t('settings.retryLimitHint'))),
          h('input', {
            className: 'er-input', type: 'number', min: 1, max: 5, style: { width: 70 },
            value: draft.retryLimit,
            onChange: (event) => applyDraft({ retryLimit: Math.max(1, Math.min(5, Number(event.target.value) || 1)) }),
          })),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.llmService')),
            h('div', { className: 'er-set-row-desc' }, t('settings.llmServiceHint'))),
          h(Badge, { tone: settings.llmAvailable ? 'mint' : 'pink' }, settings.llmAvailable ? t('settings.ready') : t('settings.unavailable'))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.searchService')),
            h('div', { className: 'er-set-row-desc' }, t('settings.searchServiceHint'))),
          h(Badge, { tone: settings.searchAvailable ? 'mint' : 'amber' }, settings.searchAvailable ? t('settings.ready') : t('settings.unavailable')))),
      h(Cell, { span: 6, eyebrow: t('settings.speech'), icon: h(Icons.speaker, null) },
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechEngine')),
            h('div', { className: 'er-set-row-desc' }, t('settings.speechEngineHint'))),
          h(Badge, { tone: settings.speech?.available ? 'mint' : 'pink' },
            settings.speech?.available ? 'edge-tts' : t('settings.unavailable'))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechCache')),
            h('div', { className: 'er-set-row-desc' }, `${settings.speech?.cachedFiles ?? 0} · ${bytes(settings.speech?.cachedBytes ?? 0)}`)),
          h(Button, {
            disabled: action.pending, onClick: async () => {
              const result = await action.run(() => call('clearSpeechCache'));
              if (result) {
                notify(`${t('settings.speechCleared')} ${result.removed}`, 'ok');
                data.reload();
              }
            },
          }, t('settings.speechClear'))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14 } },
          h('div', { className: 'er-set-row-title' }, t('settings.speechTrial')),
          h('div', { className: 'er-set-row-desc' }, t('settings.speechTrialHint')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('input', {
              className: 'er-input', style: { flex: '1 1 220px' }, value: trial, placeholder: 'Small habits can lead to big changes.',
              onChange: (event) => setTrial(event.target.value),
            }),
            h(SpeakButton, {
              t, text: trial || 'Small habits can lead to big changes.',
              label: t('settings.speechPlay'), variant: 'primary', size: 'sm',
              sentence: undefined,
            }))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechVoice')),
            h('div', { className: 'er-set-row-desc' }, t('settings.speechVoiceHint'))),
          h('select', {
            className: 'er-select', style: { width: 210 }, value: voicePref.voice,
            onChange: (event) => {
              const next = { ...voicePref, voice: event.target.value };
              setVoicePref(next);
              saveSpeechPrefs(next);
            },
          }, (Array.isArray(settings.speech?.voices) ? settings.speech.voices : []).map((voice) => h('option', { key: voice.id, value: voice.id }, voice.label)))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechRate')),
            h('div', { className: 'er-set-row-desc' }, `${voicePref.rate}%`)),
          h('input', {
            type: 'range', min: -40, max: 50, step: 5, value: voicePref.rate,
            onChange: (event) => {
              const next = { ...voicePref, rate: Number(event.target.value) };
              setVoicePref(next);
              saveSpeechPrefs(next);
            },
          }))),
      h(Cell, { span: 12, eyebrow: t('settings.data'), icon: h(Icons.layers, null) },
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.dataDir')),
            h('div', { className: 'er-set-row-desc er-mono' }, settings.dataDir ?? '')),
          h(Badge, { tone: 'soft' }, bytes(settings.bytes))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.counts')),
            h('div', { className: 'er-set-row-desc' },
              Object.entries(settings.counts ?? {}).map(([key, value]) => `${key}: ${value}`).join(' · '))),
          null),
        h('div', { className: 'er-set-row er-set-row--stack' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.backup')),
            h('div', { className: 'er-set-row-desc' }, t('settings.backupHint'))),
          h('div', { className: 'er-backup-list' },
            h('div', { className: 'er-backup-item' },
              h('div', { className: 'er-backup-path er-mono' }, `${settings.dataDir ?? ''}/database`),
              h('div', { className: 'er-set-row-desc' }, t('settings.backupDatabase'))),
            h('div', { className: 'er-backup-item' },
              h('div', { className: 'er-backup-path er-mono' }, `${settings.dataDir ?? ''}/articles`),
              h('div', { className: 'er-set-row-desc' }, t('settings.backupArticles'))),
            h('div', { className: 'er-backup-item' },
              h('div', { className: 'er-backup-path er-mono' }, `${settings.dataDir ?? ''}/cache`),
              h('div', { className: 'er-set-row-desc' }, t('settings.backupCache')))),
          h('div', { className: 'er-set-row-desc' }, t('settings.backupRestore'))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.knowledge')),
            h('div', { className: 'er-set-row-desc' }, t('settings.knowledgeHint'))),
          h(Button, { variant: 'ghost', onClick: async () => {
            const result = await action.run(() => call('clearKnowledge'));
            if (result) {
              notify(t('settings.knowledgeCleared', { count: result.cleared }), 'ok');
              data.reload();
            }
          } }, t('settings.knowledgeClear')))),
      h(Cell, { span: 12, eyebrow: t('settings.about'), icon: h(Icons.info, null) },
        h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-value' }, t('settings.aboutBody'))),
        h('div', { className: 'er-kv', style: { marginTop: 8 } },
          h('div', { className: 'er-kv-label' }, t('settings.database')),
          h('div', { className: 'er-kv-value er-mono' }, settings.databasePath ?? '')))),
    action.error ? h(Alert, null, action.error.message) : null);
}


// ---- src/105-history.js ----
/**
 * Study history: a contribution grid plus a day-by-day activity feed.
 *
 * Both are built from `study_events`, whose `seconds` are measured while the
 * reader pane is visible. Nothing here estimates time from word counts.
 */

/** Weekday initials, Monday first, matching the grid's row order. */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Local YYYY-MM-DD for a Date, matching the host's day boundary. */
function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parse a YYYY-MM-DD key into a local Date at midnight. */
function parseDay(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Human duration: seconds become "2 小时 15 分" or "8 分钟". */
function duration(t, seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes <= 0) return `0 ${t('common.minutes')}`;
  if (minutes < 60) return `${minutes} ${t('common.minutes')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours} ${t('common.hours')}`
    : `${hours} ${t('common.hours')} ${rest} ${t('common.minutes')}`;
}

/**
 * Build the grid as columns of seven days, newest week last.
 *
 * Levels scale to the learner's own busiest day; a fixed minute scale would make
 * a light user's whole grid level 1 and a heavy user's all level 4.
 */
function buildWeeks(days, peakSeconds, weeks, endDay) {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // A custom range may end in the past, so the last column follows the requested
  // end day rather than always the current week.
  const anchor = endDay ? parseDay(endDay) : today;
  const end = new Date(anchor);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

  const columns = [];
  for (let week = weeks - 1; week >= 0; week -= 1) {
    const column = [];
    for (let row = 0; row < 7; row += 1) {
      const date = new Date(end);
      date.setDate(end.getDate() - week * 7 - (6 - row));
      const key = dayKey(date);
      const entry = byDay.get(key);
      const seconds = entry?.seconds ?? 0;
      let level = 0;
      if (seconds > 0) {
        if (peakSeconds <= 0) level = 1;
        else {
          const ratio = seconds / peakSeconds;
          level = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
        }
      }
      column.push({
        day: key,
        date,
        future: date > today,
        seconds,
        minutes: Math.round(seconds / 60),
        events: entry?.events ?? 0,
        kinds: entry?.kinds ?? [],
        level,
      });
    }
    columns.push(column);
  }
  return columns;
}

/** One-line summary of a day, used as the cell tooltip. */
function daySummary(t, cell) {
  if (cell.future) return cell.day;
  if (cell.events === 0) return `${cell.day} · ${t('history.nothing')}`;
  return `${cell.day} · ${cell.events} ${t('history.events')} · ${duration(t, cell.seconds)}`;
}

/** Month labels positioned over the column where the month changes. */
function monthLabels(columns) {
  const labels = [];
  let previous = -1;
  columns.forEach((column, index) => {
    const first = column[0]?.date;
    if (first && first.getMonth() !== previous) {
      previous = first.getMonth();
      labels.push({ index, text: String(first.getMonth() + 1) });
    }
  });
  return labels;
}

/** The contribution grid. */
function ActivityGrid({ t, days, peakSeconds, weeks, endDay }) {
  const columns = React.useMemo(
    () => buildWeeks(days, peakSeconds, weeks, endDay),
    [days, peakSeconds, weeks, endDay],
  );
  const labels = monthLabels(columns);
  return h('div', { className: 'er-heat' },
    h('div', { className: 'er-heat-rows' },
      h('div', { className: 'er-heat-months', style: { gridTemplateColumns: `repeat(${weeks}, 1fr)` } },
        labels.map((label) => h('span', { key: label.index, style: { gridColumnStart: label.index + 1 } }, label.text))),
      h('div', { className: 'er-heat-body' },
        h('div', { className: 'er-heat-weekdays' },
          WEEKDAY_KEYS.map((key, index) => h('span', {
            key,
            // Labelling all seven rows would crowd a 20px gutter.
            style: { visibility: index % 2 === 0 ? 'visible' : 'hidden' },
          }, t(`history.weekday.${key}`)))),
        h('div', { className: 'er-heat-grid', style: { gridTemplateColumns: `repeat(${weeks}, 1fr)` } },
          columns.map((column) => h('div', { key: column[0]?.day, className: 'er-heat-week' },
            column.map((cell) => h('div', {
              key: cell.day,
              className: 'er-heat-cell',
              'data-level': cell.level,
              'data-future': cell.future === true ? 'true' : undefined,
              title: daySummary(t, cell),
            }))))))),
    h('div', { className: 'er-heat-legend' },
      h('span', { className: 'er-card-sub' }, t('history.less')),
      [0, 1, 2, 3, 4].map((level) => h('span', { key: level, className: 'er-heat-cell', 'data-level': level })),
      h('span', { className: 'er-card-sub' }, t('history.more'))));
}

/**
 * Activity feed: one section per active day, newest first.
 *
 * Each day lists the articles actually read that day with the measured time, so
 * the log answers "where did the time go", not just "did I show up".
 */
function ActivityFeed({ t, activity }) {
  const byDay = new Map();
  for (const event of activity.events ?? []) {
    if (!byDay.has(event.day)) byDay.set(event.day, []);
    byDay.get(event.day).push(event);
  }
  // Group per day, then per article inside the day.
  const sections = [...byDay.entries()]
    .sort((left, right) => (left[0] < right[0] ? 1 : -1))
    .map(([day, events]) => {
      const perArticle = new Map();
      let seconds = 0;
      for (const event of events) {
        seconds += event.seconds;
        const key = event.articleId ?? '_none';
        if (!perArticle.has(key)) {
          perArticle.set(key, {
            articleId: event.articleId,
            title: event.title ?? t('history.unknownArticle'),
            cefrLevel: event.cefrLevel ?? null,
            kinds: new Set(),
            seconds: 0,
            events: 0,
          });
        }
        const entry = perArticle.get(key);
        entry.seconds += event.seconds;
        entry.events += 1;
        if (event.kind) entry.kinds.add(event.kind);
      }
      return { day, seconds, articles: [...perArticle.values()].sort((a, b) => b.seconds - a.seconds) };
    });

  if (sections.length === 0) {
    return h(Empty, {
      icon: h(Icons.clock, null),
      title: t('history.emptyTitle'),
      description: t('history.emptyBody'),
    });
  }

  const dayNodes = sections.map((section) => h('section', {
    key: section.day,
    className: 'er-feed-day',
  },
  h('div', { className: 'er-feed-dayhead' },
    h('span', { className: 'er-feed-date' }, section.day),
    h('span', { className: 'er-card-sub' }, `${section.articles.length} ${t('history.articles')}`),
    h('div', { className: 'er-topbar-spacer' }),
    h(Badge, { tone: section.seconds >= 600 ? 'mint' : 'soft' }, duration(t, section.seconds))),
  section.articles.map((article) => h('div', {
    key: `${section.day}-${article.articleId ?? 'none'}`,
    className: 'er-feed-row',
  },
  h('div', { className: 'er-feed-icon' }, h(Icons.bookOpen, null)),
  h('div', { className: 'er-feed-body' },
    h('div', { className: 'er-feed-title' }, article.title),
    h('div', { className: 'er-feed-meta' },
      article.cefrLevel ? h(Badge, { tone: cefrTone(article.cefrLevel) }, article.cefrLevel) : null,
      [...article.kinds].map((kind) => h('span', { key: kind },
        t(`history.kind.${kind}`, { fallback: kind }))),
      h('span', { className: 'er-crumb-dot' }),
      h('span', null, `${article.events} ${t('history.events')}`))),
  h('div', { className: 'er-feed-time' }, duration(t, article.seconds))))));

  return h('div', { className: 'er-feed' }, dayNodes);
}

/** The log always covers one year: 53 week columns. */
const HISTORY_WEEKS = 53;



/**
 * The study heatmap block: totals, the year grid and the empty hint.
 *
 * Extracted so the dashboard renders exactly this, not a look-alike. `actions`
 * lets a host add a link without duplicating the body.
 */
function StudyHeatmapCard({ t, activity, actions }) {
  const totals = activity.totals;
  return h(Cell, {
    span: 12,
    eyebrow: t('history.gridTitle'),
    icon: h(Icons.grid, null),
    actions,
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
      h('span', { className: 'er-card-sub' },
        `${t('history.currentStreak')} ${totals.currentStreak} ${t('common.days')}`),
      h('span', { className: 'er-card-sub' },
        `${totals.activeDays} ${t('history.activeDays')}`),
      h('span', { className: 'er-card-sub' }, duration(t, totals.seconds))),
    h(ActivityGrid, {
      t,
      days: activity.days,
      peakSeconds: activity.peakSeconds,
      weeks: HISTORY_WEEKS,
      endDay: activity.endDay,
    }),
    activity.days.length === 0 ? h(Alert, { tone: 'warn' }, t('history.emptyHint')) : null));
}

/** Study history page: totals, the grid, and the day-by-day feed. */
function StudyHistoryPage({ t, notify }) {
  const data = useLoad(
    () => call('studyActivity', { days: HISTORY_WEEKS * 7, includeEvents: true }),
    [],
  );
  if (data.status === 'loading' && !data.data) {
    return h('div', { className: 'er-page' },
      h(Skeleton, { height: 150, radius: 18 }), h(Skeleton, { height: 180, radius: 18 }));
  }
  if (data.status === 'error') {
    return h('div', { className: 'er-page' }, h(Alert, null, data.error.message));
  }
  const activity = data.data;
  const totals = activity.totals;

  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, t('nav.history'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `${activity.startDay} → ${activity.endDay ?? activity.today}`)),

    // Headline sentence, mirroring "2,533 contributions in the last year".
    h(Cell, { span: 12, size: 'feature', tint: true },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('h2', { className: 'er-feed-headline' },
          t('history.headline', {
            time: duration(t, totals.seconds),
            days: totals.activeDays,
            fallback: t('history.headlineFallback'),
          })),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
          h('span', { className: 'er-card-sub' },
            `${t('history.currentStreak')} ${totals.currentStreak} ${t('common.days')}`),
          h('span', { className: 'er-card-sub' },
            `${t('history.longestStreak')} ${totals.longestStreak} ${t('common.days')}`),
          h('span', { className: 'er-card-sub' },
            `${t('history.byKind')} · ${(activity.byArticle ?? []).length} ${t('history.articles')}`)))),

    h(StudyHeatmapCard, { t, activity }),

    h(Cell, { span: 12, eyebrow: t('history.feedTitle'), icon: h(Icons.clock, null) },
      h(ActivityFeed, { t, activity })));
}


// ---- src/110-locale.js ----
/** Dictionaries for the Reader's own surfaces. Host chrome stays in its locale. */

const ZH = {
  'panel': 'English Reader',
  'nav.home': '首页',
  'nav.discover': '采集文章',
  'nav.articles': '我的文章',
  'nav.words': '单词库',
  'nav.phrases': '短语库',
  'nav.collocations': '搭配库',
  'nav.sentences': '句子库',
  'nav.review': '复习中心',
  'nav.settings': '设置',
  'nav.knowledge': '知识库',
  'nav.group.knowledge': '知识库',
  'nav.group.practice': '练习与进度',

  'common.words': '词',
  'common.minutes': '分钟',
  'common.hours': '小时',
  'common.days': '天',
  'common.sentences': '句',
  'common.paragraphs': '段',
  'common.read': '阅读',
  'common.retry': '重试',
  'common.back': '返回',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.favorite': '收藏',
  'common.pronounce': '发音',
  'common.working': '处理中…',
  'common.fetching': '抓取中…',
  'common.analyze': '开始解析',
  'common.reanalyze': '重新解析',
  'common.source': '原文',
  'common.export': '导出',

  'home.overview': '学习概览',
  'home.greeting': '你好，学习者！',
  'home.greetingPlain': '你好',
  'home.greetingPrefix': '你好，',
  'home.tagline': '每天阅读一点英文，遇见更大的世界',
  'home.searchPlaceholder': '搜索单词、短语或文章…',
  'home.statArticles': '已读文章',
  'home.statArticlesDelta': '持续积累中',
  'home.statWords': '已学单词',
  'home.statWordsDelta': '收藏即掌握起点',
  'home.statTime': '学习时长',
  'home.statTimeDelta': '按文章估算',
  'home.statStreak': '连续学习',
  'home.statStreakDelta': '近 7 天',
  'home.recent': '最近阅读',
  'home.recentEmpty': '还没有文章，去「采集文章」发现第一篇吧。',
  'home.overall': '阅读完成率',
  'home.overallLabel': '整体进度',
  'home.overallHint': '按最近阅读位置估算',
  'home.articles': '篇文章',
  'home.knowledge': '个知识点',

  'discover.tabAuto': '自动发现',
  'discover.tabUrl': 'URL 导入',
  'discover.tabPaste': '手动粘贴',
  'discover.tabSpec': '采集规格',
  'discover.tabResults': '发现内容',
  'discover.running': '正在采集',
  'discover.runDone': '采集完成',
  'discover.candidatesCount': '候选',
  'discover.specTitle': '采集规格',
  'discover.articleCount': '采集文章数量',
  'discover.articleCountUnit': '篇',
  'discover.articleCountHint': '本次采集最终保留的候选数量；来源较多时会按匹配度取前 N 篇。',
  'discover.levelRange': '难度（CEFR）',
  'discover.sources': '来源',
  'discover.sourcesHint': '每个来源用各自的抓取策略；带订阅墙的来源只能抓公开部分。',
  'discover.sourcesSelected': '个来源已选',
  'discover.sourceReport': '来源采集结果',
  'discover.sourcesFailed': '个来源抓取失败',
  'discover.filtered': '已过滤敏感内容',
  'discover.selectAll': '全选',
  'discover.selectNone': '全不选',
  'discover.window': '文章发布时间',
  'discover.window24h': '最近 24 小时',
  'discover.window7d': '最近 7 天',
  'discover.window30d': '最近 30 天',
  'discover.windowCustom': '自定义',
  'discover.windowHint': '按来源的发布日期过滤；无日期的书籍与目录不参与时间筛选。',
  'discover.days': '天',
  'discover.types': '文章类型',
  'discover.sensitive': '过滤敏感内容',
  'discover.sensitiveOn': '开启',
  'discover.sensitiveOff': '关闭',
  'discover.sensitiveHint': '按标题与摘要的关键词预筛，可能误伤；被过滤数量会显示在来源结果里。',
  'discover.wordUnlimited': '不限制',
  'discover.wordRangeOption': '可选范围',
  'discover.wordUnlimitedHint': '不按长度筛选，任何篇幅的文章都会保留。',
  'discover.truncateOn': '允许截断文章',
  'discover.truncateOff': '不截断（跳过超长）',
  'discover.truncateHint': '截断只在句子边界切分，不会把句子切断。',
  'discover.wordRange': '词数范围',
  'type.news': '新闻',
  'type.analysis': '分析',
  'type.explainer': '解释性报道',
  'type.research_news': '科研新闻',
  'type.opinion': '评论',
  'type.criticism': '文艺批评',
  'type.essay': '随笔/长文',
  'type.feature': '特写',
  'type.literature': '文学作品',
  'type.graded_news': '分级新闻',
  'type.tutorial': '教学材料',
  'type.reference': '参考资料',
  'discover.profileName': '规格名称',
  'discover.cefr': '英语难度',
  'discover.topic': '文章主题',
  'discover.source': '来源域名',
  'discover.minWords': '最少词数',
  'discover.maxWords': '最多词数',
  'discover.vocabTarget': '重点词汇数',
  'discover.keywords': '关键词',
  'discover.preferRecent': '优先近期文章',
  'discover.avoidTechnical': '避免过于专业',
  'discover.preferStory': '优先故事性内容',
  'discover.saveProfile': '保存规格',
  'discover.profileSaved': '规格已保存',
  'discover.start': '开始发现',
  'discover.results': '发现结果',
  'discover.loadMore': '加载更多',
  'discover.listEnd': '已经到底了',
  'discover.emptyTitle': '还没有候选文章',
  'discover.emptyBody': '调整左侧采集规格后点击「开始发现」，候选会带上可解释的匹配理由。',
  'discover.importSelected': '导入所选',
  'discover.importDone': '已导入 {count} 篇文章，已移到「我的文章」',
  'discover.importPartial': '已导入 {done} 篇，{failed} 篇失败',
  'discover.importNone': '没有可导入的候选',
  'discover.imported': '已导入',
  'discover.urlTitle': '导入 URL',
  'discover.urlHint': '只抓取公开可访问的正文；受登录、付费墙或域名限制的页面会被拒绝。',
  'discover.fetch': '抓取',
  'discover.previewTitle': '抓取预览',
  'discover.duplicate': '这篇文章已在库中，可直接打开。',
  'discover.alreadySaved': '已在库中',
  'discover.saveArticle': '保存文章',
  'discover.saved': '文章已保存',
  'discover.pasteTitle': '粘贴文章',
  'discover.pasteTitleLabel': '标题',
  'discover.pasteSource': '来源（可选）',
  'discover.pasteBody': '正文',
  'discover.pastePlaceholder': '把英文原文粘贴到这里，保留段落空行，切句会更准确…',

  'articles.emptyTitle': '文章库还是空的',
  'articles.emptyBody': '从「采集文章」自动发现，或用 URL / 粘贴导入你的第一篇英文文章。',
  'articles.searchPlaceholder': '搜索标题、来源、摘要…',
  'articles.allLevels': '全部难度',
  'articles.allStatus': '全部状态',
  'articles.allSources': '全部来源',
  'articles.count': '篇',
  'articles.analyze': '解析',
  'articles.analysisStarted': '解析已开始，可在阅读页查看进度',
  'articles.deleted': '文章已删除',
  'articles.retryDone': '该阶段已重试',

  'nav.history': '学习记录',
  'history.range.1w': '一周',
  'history.range.1m': '一个月',
  'history.range.3m': '三个月',
  'history.range.6m': '半年',
  'history.range.1y': '一年',
  'history.range.custom': '自定义',
  'home.studyTitle': '学习记录',
  'home.studyEmpty': '读一篇文章后，这里会出现你的学习热力图。',
  'home.studyMore': '查看全部',
  'history.headline': '过去一年学习 {time}，共 {days} 天',
  'history.headlineFallback': '还没有学习记录',
  'history.feedTitle': '学习明细',
  'history.articles': '篇文章',
  'history.unknownArticle': '未关联文章',
  'history.gridTitle': '学习热力图',
  'history.currentStreak': '当前连续',
  'history.longestStreak': '最长连续',
  'history.totalTime': '累计时长',
  'history.activeDays': '学习天数',
  'history.byKind': '时间分布',
  'history.recentDays': '最近学习',
  'history.events': '次记录',
  'history.nothing': '无学习记录',
  'history.less': '少',
  'history.more': '多',
  'history.emptyTitle': '还没有学习记录',
  'history.emptyBody': '开始阅读或复习后，这里会按天记录你的学习情况。',
  'history.emptyHint': '阅读、复习、收藏单词都会记入学习记录；仅打开页面不算。',
  'history.weekday.mon': '一',
  'history.weekday.tue': '二',
  'history.weekday.wed': '三',
  'history.weekday.thu': '四',
  'history.weekday.fri': '五',
  'history.weekday.sat': '六',
  'history.weekday.sun': '日',
  'history.kind.read': '阅读',
  'history.kind.vocabulary': '单词',
  'history.kind.phrase': '短语',
  'history.kind.collocation': '搭配',
  'history.kind.sentence': '句子',
  'stage.OVERVIEW': '导读',
  'stage.DIFFICULTY': '难度',
  'stage.VOCABULARY': '单词',
  'stage.PHRASES': '短语',
  'stage.COLLOCATIONS': '搭配',
  'stage.SEGMENTATION': '切分',
  'stage.SENTENCE_ANALYSIS': '逐句',
  'stage.REVIEW': '复盘',
  'stageHint.OVERVIEW': '全文背景与主旨',
  'stageHint.DIFFICULTY': 'CEFR 难度估计',
  'stageHint.VOCABULARY': '生词及释义',
  'stageHint.PHRASES': '短语及用法',
  'stageHint.COLLOCATIONS': '常见搭配',
  'stageHint.SEGMENTATION': '切成几句',
  'stageHint.SENTENCE_ANALYSIS': '每句精读',
  'stageHint.REVIEW': '理解题',
  'reader.modeSplit': '双栏精读',
  'reader.modeContinuous': '连续阅读',
  'reader.progress': '阅读进度',
  'reader.analyzing': '解析中…',
  'reader.clean': '清理正文',
  'reader.stageDetail': '阶段详情',
  'reader.inspectStage': '查看详情',
  'reader.sentencesFailed': '句失败',
  'reader.cleanHint': '重新抓取原文，只保留正文段落，并重建句子。',
  'reader.cleaned': '正文已清理：{before} 词 → {after} 词，请重新解析。',
  'reader.analysisRunning': '解析正在后台运行，完成前部分内容可能为空；可离开本页稍后回来。',
  'reader.tabGuide': '导读',
  'reader.tabWords': '重点单词',
  'reader.tabPhrases': '短语搭配',
  'reader.tabReview': '复盘',
  'reader.guideTitle': '文章导读',
  'reader.background': '背景',
  'reader.mainIdea': '核心观点',
  'reader.keyPoints': '关键信息',
  'reader.readingFocus': '阅读重点',
  'reader.readingMinutes': '建议阅读',
  'reader.notAnalysed': '尚未解析',
  'reader.notAnalysedBody': '点击「开始解析」生成导读、词汇、逐句分析与复盘题。',
  'reader.wordsTitle': '重点单词',
  'reader.noWords': '还没有重点单词',
  'reader.noWordsBody': '解析完成后，这里会列出按理解价值挑选的词汇。',
  'reader.phrasesTitle': '重点短语',
  'reader.noPhrases': '还没有短语',
  'reader.noPhrasesBody': '解析完成后会区分动词短语、介词短语与习惯表达。',
  'reader.collocationsTitle': '固定搭配',
  'reader.noCollocations': '还没有搭配',
  'reader.noCollocationsBody': '解析完成后会列出可以整体记忆的搭配模式。',
  'reader.reviewTitle': '文章复盘',
  'reader.noReview': '还没有复盘',
  'reader.noReviewBody': '解析完成后会生成逻辑结构、要点和理解题。',
  'reader.summary': '总结',
  'reader.logicalStructure': '逻辑结构',
  'reader.takeaways': '关键要点',
  'reader.questions': '理解题',
  'reader.showAnswer': '查看答案',
  'reader.hideAnswer': '收起答案',
  'reader.pickSentence': '选择句子开始精读',
  'reader.pickSentenceBody': '在左侧点击任意句子，这里会显示结构、直译意译、语法点与表达。',
  'reader.noAnalysis': '这句话还没有解析结果。若解析已完成，可尝试重试「逐句解析」阶段。',
  'reader.sentenceFailed': '这句解析失败',
  'reader.needsReview': '此句结构校验通过，但部分引用需人工复核。',
  'reader.retrySentence': '重试这一句',
  'reader.showRaw': '查看模型原始输出',
  'reader.hideRaw': '收起原始输出',
  'reader.attempts': '已尝试次数',
  'reader.failureSummary': '失败原因汇总',
  'reader.needsReviewCount': '待复核',
  'reader.failedSentences': '解析失败的句子',
  'reader.jumpToSentence': '定位',
  'error.LLM_INVALID_JSON': '模型没有返回合法 JSON：多半是回答被截断，或在 JSON 前后夹带了说明文字。',
  'error.LLM_TRUNCATED': '模型输出达到长度上限被截断，JSON 没有写完。可以调高 maxTokens，或把文章切成更小的任务。',
  'error.LLM_UNAVAILABLE': '模型调用失败：当前模型服务不可用或返回了错误。',
  'error.LLM_TIMEOUT': '模型调用超时或被取消。',
  'error.SCHEMA_VALIDATION_FAILED': '模型返回的结构不符合该阶段要求的字段。',
  'error.EVIDENCE_NOT_FOUND': '模型引用的原文片段在文章里找不到，疑似编造引用。',
  'error.NO_RECORD': '这句是旧版本解析时失败的，当时没有记录原因。',
  'error.unknown': '出现未知错误，可展开原始输出排查。',
  'error.noDetail': '没有记录更详细的原因。',
  'reader.literal': '直译',
  'reader.natural': '意译',
  'reader.mainClause': '主干',
  'reader.structure': '结构分析',
  'reader.grammar': '语法点',
  'reader.expressions': '重点表达',
  'reader.notes': '难度提示',
  'reader.sentenceTab': '句子解析',
  'reader.openSource': '原文链接',
  'reader.expandBand': '展开解析进度',
  'reader.collapseBand': '收起解析进度',
  'reader.needsAttention': '项待处理',
  'reader.addToLibrary': '加入知识库',
  'reader.inLibrary': '已在知识库',
  'reader.addedToLibrary': '已加入知识库',
  'reader.removedFromLibrary': '已移出知识库',
  'knowledge.optInHint': '解析结果不会自动进入知识库，需在阅读页手动加入。',
  'knowledge.notMastered': '仅未掌握',
  'reader.noteForSentence': '为这句添加笔记',
  'reader.notePlaceholder': '记录你的理解、疑问或例句…',
  'reader.saveNote': '保存笔记',
  'reader.notes': '阅读笔记',
  'reader.sentence': '句子',
  'reader.articleNote': '文章笔记',
  'reader.wordDetail': '单词详情',
  'reader.openInKnowledge': '在知识库打开',
  'reader.emptyBody': '正文为空',
  'reader.emptyBodyHint': '这篇正文没有可读文本，请重新导入。',

  'word.inArticle': '文中含义：',
  'word.formation': '构词分析',
  'word.evidence': '原文语境',
  'word.synonyms': '近义词',
  'word.addPlan': '加入复习计划',

  'knowledge.sources': '来源',
  'knowledge.count': '条',
  'knowledge.searchPlaceholder': '搜索词条…',
  'knowledge.onlyFavorite': '只看收藏',
  'knowledge.empty.word.title': '还没有单词',
  'knowledge.empty.word.body': '在阅读页点击单词旁的「加入知识库」，单词就会出现在这里。',
  'knowledge.empty.phrase.title': '还没有短语',
  'knowledge.empty.phrase.body': '解析文章后，在「短语搭配」里点击短语旁的「加入知识库」。',
  'knowledge.empty.collocation.title': '还没有搭配',
  'knowledge.empty.collocation.body': '解析文章后，在「短语搭配」里点击搭配旁的「加入知识库」。',
  'knowledge.empty.sentence.title': '还没有句子',
  'knowledge.empty.sentence.body': '在阅读页选中句子，点「加入知识库」收藏整句。',
  'knowledge.emptyTitle': '知识库还是空的',
  'knowledge.emptyBody': '导入并解析文章后，单词、短语、搭配和句子会沉淀到这里，并跨文章复用。',
  'knowledge.updated': '已更新',
  'knowledge.mastery': '掌握程度',
  'knowledge.notes': '我的笔记',
  'knowledge.saveNote': '保存笔记',
  'knowledge.contexts': '原文语境',
  'knowledge.noContext': '暂无来源语境',

  'review.today': '今日已完成',
  'review.reveal': '看答案',
  'review.mastered': '我认识了',
  'review.again': '再看看',
  'review.unsure': '不太确定',
  'review.next': '已记录，下一张',
  'review.emptyTitle': '今天复习完成',
  'review.emptyBody': '解析文章后，未掌握到「基本掌握」的单词会进入复习队列。',
  'review.totalWords': '入库单词',
  'review.masteredCount': '已掌握',
  'review.todayReviewed': '今日复习',
  'review.remaining': '待复习',

  'settings.model': '模型与解析',
  'settings.modelHint': '默认跟随当前会话的模型；选择后解析将使用所选模型。',
  'settings.modelFollowSession': '跟随会话模型（默认）',
  'settings.modelFollowSessionNamed': '跟随会话模型：{model}',
  'settings.modelSessionNow': '当前会话使用 {model}；默认跟随它，选择后解析改用所选模型。',
  'settings.modelUnknown': '所选模型不可用，已保留原设置。',
  'settings.modelHint': 'Follows the session model by default; pick one to override it for analysis.',
  'settings.modelFollowSession': 'Follow session model (default)',
  'settings.modelFollowSessionNamed': 'Follow session model: {model}',
  'settings.modelSessionNow': 'This session runs {model}; analysis follows it until you pick another one.',
  'settings.modelUnknown': 'That model is not available; the previous setting was kept.',
  'settings.modelRoute': '当前模型',
  'settings.modelMissing': 'Harness 尚未配置默认模型；解析会提示不可用。',
  'settings.llmService': '模型服务',
  'settings.llmServiceHint': '插件通过 Harness 的模型运行时调用，不读取任何密钥。',
  'settings.searchService': '搜索服务',
  'settings.searchServiceHint': '自动发现需要 Harness 已注册的搜索 Provider。',
  'settings.sentenceConcurrency': '逐句并发',
  'settings.sentenceConcurrencyHint': '同时解析的句子数，配置项 sentenceConcurrency。',
  'settings.retryLimit': '失败重试',
  'settings.retryLimitHint': '单个阶段的最大尝试次数。',
  'settings.wordsTarget': '重点词汇数',
  'settings.wordsTargetHint': '每篇文章提取的目标词数。',
  'settings.ready': '可用',
  'settings.unavailable': '未配置',
  'settings.speech': '发音（Edge TTS）',
  'settings.speechEngine': '语音引擎',
  'settings.speechEngineHint': '使用微软 Edge 神经语音（与 edge-tts 同一协议），无需安装 Python 包或密钥。',
  'settings.speechCache': '音频缓存',
  'settings.speechClear': '清空缓存',
  'settings.speechCleared': '音频缓存已清空',
  'settings.speechTrial': '试听',
  'settings.speechTrialHint': '输入任意英文，用当前音色朗读。',
  'settings.speechPlay': '朗读',
  'settings.speechVoice': '默认音色',
  'settings.speechVoiceHint': '单词与句子的朗读都使用这个音色。',
  'settings.speechRate': '语速',
  'settings.data': '数据目录与备份',
  'settings.dataDir': '数据目录',
  'settings.counts': '内容统计',
  'settings.backup': '备份与恢复',
  'settings.backupHint': '数据分散在数据库、正文文件和音频缓存里，直接复制整个数据目录即可完成备份。',
  'settings.backupDatabase': 'SQLite 数据库：文章元数据、解析结果、词汇与笔记、进度与设置。',
  'settings.backupArticles': '文章正文 Markdown（若存在还包括原始 HTML），数据库里只有指向它的路径。',
  'settings.backupCache': '朗读音频缓存，可整目录删除，删后重新朗读会自动重建。',
  'settings.backupRestore': '恢复：关闭 Harness，把这些目录放回同一路径（默认 ~/.dsh/english-reader），再启动即可。',
  'settings.knowledge': '单词库数据',
  'settings.knowledgeHint': '清空单词、短语、搭配、句子四个库（只删「已加入知识库」的条目，文章与解析结果保留）。',
  'settings.knowledgeClear': '清空单词库',
  'settings.knowledgeCleared': '已清空 {count} 条知识库记录。',
  'settings.about': '关于',
  'settings.aboutBody': 'English Reader：文章是学习入口，知识实体是长期资产。解析结论均标注为 AI 估计，并保留原文证据。',
  'settings.database': '数据库',
};

const EN = {
  'panel': 'English Reader',
  'nav.home': 'Home',
  'nav.discover': 'Discover',
  'nav.articles': 'My Articles',
  'nav.words': 'Vocabulary',
  'nav.phrases': 'Phrases',
  'nav.collocations': 'Collocations',
  'nav.sentences': 'Sentences',
  'nav.review': 'Review',
  'nav.settings': 'Settings',
  'nav.knowledge': 'Knowledge',
  'nav.group.knowledge': 'Knowledge',
  'nav.group.practice': 'Practice & progress',

  'common.words': 'words',
  'common.minutes': 'min',
  'common.hours': 'h',
  'common.days': 'days',
  'common.sentences': 'sentences',
  'common.paragraphs': 'paragraphs',
  'common.read': 'Read',
  'common.retry': 'Retry',
  'common.back': 'Back',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.favorite': 'Favorite',
  'common.pronounce': 'Pronounce',
  'common.working': 'Working…',
  'common.fetching': 'Fetching…',
  'common.analyze': 'Analyze',
  'common.reanalyze': 'Re-analyze',
  'common.source': 'Source',
  'common.export': 'Export',

  'home.overview': 'Overview',
  'home.greeting': 'Hello, learner!',
  'home.greetingPlain': 'Hello',
  'home.greetingPrefix': 'Hello, ',
  'home.tagline': 'A little English every day opens a bigger world',
  'home.searchPlaceholder': 'Search words, phrases or articles…',
  'home.statArticles': 'Articles',
  'home.statArticlesDelta': 'keep collecting',
  'home.statWords': 'Saved words',
  'home.statWordsDelta': 'saving is the first step',
  'home.statTime': 'Study time',
  'home.statTimeDelta': 'estimated',
  'home.statStreak': 'Streak',
  'home.statStreakDelta': 'last 7 days',
  'home.recent': 'Recently read',
  'home.recentEmpty': 'No articles yet — start with Discover.',
  'home.overall': 'Completion',
  'home.overallLabel': 'Overall progress',
  'home.overallHint': 'Estimated from reading positions',
  'home.articles': 'articles',
  'home.knowledge': 'knowledge items',

  'discover.tabAuto': 'Auto discover',
  'discover.tabUrl': 'Import URL',
  'discover.tabPaste': 'Paste article',
  'discover.tabSpec': 'Collection profile',
  'discover.tabResults': 'Discovered content',
  'discover.running': 'Collecting',
  'discover.runDone': 'Run finished',
  'discover.candidatesCount': 'candidates',
  'discover.specTitle': 'Collection profile',
  'discover.articleCount': 'Articles per run',
  'discover.articleCountUnit': 'articles',
  'discover.articleCountHint': 'How many candidates the run keeps; with many sources the top N by match score survive.',
  'discover.levelRange': 'CEFR level',
  'discover.sources': 'Sources',
  'discover.sourcesHint': 'Each source has its own fetch strategy; paywalled sources yield public excerpts only.',
  'discover.sourcesSelected': 'sources selected',
  'discover.sourceReport': 'Per-source results',
  'discover.sourcesFailed': 'source(s) failed',
  'discover.filtered': 'filtered',
  'discover.selectAll': 'All',
  'discover.selectNone': 'None',
  'discover.window': 'Published within',
  'discover.window24h': 'Last 24 hours',
  'discover.window7d': 'Last 7 days',
  'discover.window30d': 'Last 30 days',
  'discover.windowCustom': 'Custom',
  'discover.windowHint': 'Filters by the publisher date; undated books and catalogs skip the time filter.',
  'discover.days': 'days',
  'discover.types': 'Article types',
  'discover.sensitive': 'Sensitive content',
  'discover.sensitiveOn': 'Filter on',
  'discover.sensitiveOff': 'Off',
  'discover.sensitiveHint': 'Keyword pre-screen over titles and summaries; it can over-filter. Counts appear in the source report.',
  'discover.wordUnlimited': 'No limit',
  'discover.wordRangeOption': 'Set a range',
  'discover.wordUnlimitedHint': 'Length is ignored; articles of any size are kept.',
  'discover.truncateOn': 'Truncate long articles',
  'discover.truncateOff': 'Skip long articles',
  'discover.truncateHint': 'Truncation cuts on sentence boundaries, never mid-sentence.',
  'discover.wordRange': 'Word count',
  'type.news': 'News',
  'type.analysis': 'Analysis',
  'type.explainer': 'Explainer',
  'type.research_news': 'Research news',
  'type.opinion': 'Opinion',
  'type.criticism': 'Criticism',
  'type.essay': 'Essay',
  'type.feature': 'Feature',
  'type.literature': 'Literature',
  'type.graded_news': 'Graded news',
  'type.tutorial': 'Tutorial',
  'type.reference': 'Reference',
  'discover.profileName': 'Profile name',
  'discover.cefr': 'CEFR level',
  'discover.topic': 'Topics',
  'discover.source': 'Source domains',
  'discover.minWords': 'Min words',
  'discover.maxWords': 'Max words',
  'discover.vocabTarget': 'Key words',
  'discover.keywords': 'Keywords',
  'discover.preferRecent': 'Prefer recent',
  'discover.avoidTechnical': 'Avoid highly technical',
  'discover.preferStory': 'Prefer storytelling',
  'discover.saveProfile': 'Save profile',
  'discover.profileSaved': 'Profile saved',
  'discover.start': 'Start discovery',
  'discover.results': 'Candidates',
  'discover.loadMore': 'Load more',
  'discover.listEnd': 'That is everything',
  'discover.emptyTitle': 'No candidates yet',
  'discover.emptyBody': 'Adjust the profile, then run discovery. Each candidate carries explainable match reasons.',
  'discover.importSelected': 'Import selected',
  'discover.importDone': 'Imported {count} articles into My Articles',
  'discover.importPartial': 'Imported {done}, {failed} failed',
  'discover.importNone': 'Nothing could be imported',
  'discover.imported': 'Imported',
  'discover.urlTitle': 'Import from URL',
  'discover.urlHint': 'Only publicly readable bodies are fetched; login walls and blocked domains are refused.',
  'discover.fetch': 'Fetch',
  'discover.previewTitle': 'Preview',
  'discover.duplicate': 'This article is already in the library.',
  'discover.alreadySaved': 'Already saved',
  'discover.saveArticle': 'Save article',
  'discover.saved': 'Article saved',
  'discover.pasteTitle': 'Paste an article',
  'discover.pasteTitleLabel': 'Title',
  'discover.pasteSource': 'Source (optional)',
  'discover.pasteBody': 'Body',
  'discover.pastePlaceholder': 'Paste the English text here, keeping blank lines between paragraphs…',

  'articles.emptyTitle': 'The library is empty',
  'articles.emptyBody': 'Discover articles, import a URL, or paste your first English text.',
  'articles.searchPlaceholder': 'Search title, source, snippet…',
  'articles.allLevels': 'All levels',
  'articles.allStatus': 'All statuses',
  'articles.allSources': 'All sources',
  'articles.count': 'articles',
  'articles.analyze': 'Analyze',
  'articles.analysisStarted': 'Analysis started — watch progress on the reading page',
  'articles.deleted': 'Article deleted',
  'articles.retryDone': 'Stage retried',

  'nav.history': 'Study log',
  'history.range.1w': '1 week',
  'history.range.1m': '1 month',
  'history.range.3m': '3 months',
  'history.range.6m': '6 months',
  'history.range.1y': '1 year',
  'history.range.custom': 'Custom',
  'home.studyTitle': 'Study log',
  'home.studyEmpty': 'Read an article and your heatmap will appear here.',
  'home.studyMore': 'See all',
  'history.headline': '{time} studied across {days} days in the past year',
  'history.headlineFallback': 'No study history yet',
  'history.feedTitle': 'Study detail',
  'history.articles': 'articles',
  'history.unknownArticle': 'Unlinked article',
  'history.gridTitle': 'Study heatmap',
  'history.currentStreak': 'Current streak',
  'history.longestStreak': 'Longest streak',
  'history.totalTime': 'Total time',
  'history.activeDays': 'Active days',
  'history.byKind': 'Where the time went',
  'history.recentDays': 'Recent days',
  'history.events': 'events',
  'history.nothing': 'no activity',
  'history.less': 'Less',
  'history.more': 'More',
  'history.emptyTitle': 'No study history yet',
  'history.emptyBody': 'Read an article or review a word and your days will appear here.',
  'history.emptyHint': 'Reading, reviewing and adding words are recorded; merely opening a page is not.',
  'history.weekday.mon': 'Mon',
  'history.weekday.tue': 'Tue',
  'history.weekday.wed': 'Wed',
  'history.weekday.thu': 'Thu',
  'history.weekday.fri': 'Fri',
  'history.weekday.sat': 'Sat',
  'history.weekday.sun': 'Sun',
  'history.kind.read': 'Reading',
  'history.kind.vocabulary': 'Vocabulary',
  'history.kind.phrase': 'Phrases',
  'history.kind.collocation': 'Collocations',
  'history.kind.sentence': 'Sentences',
  'stage.OVERVIEW': 'Overview',
  'stage.DIFFICULTY': 'Difficulty',
  'stage.VOCABULARY': 'Words',
  'stage.PHRASES': 'Phrases',
  'stage.COLLOCATIONS': 'Collocations',
  'stage.SEGMENTATION': 'Segments',
  'stage.SENTENCE_ANALYSIS': 'Sentences',
  'stage.REVIEW': 'Review',
  'stageHint.OVERVIEW': 'Background and main idea',
  'stageHint.DIFFICULTY': 'CEFR estimate',
  'stageHint.VOCABULARY': 'Words and meanings',
  'stageHint.PHRASES': 'Phrases in use',
  'stageHint.COLLOCATIONS': 'Common pairings',
  'stageHint.SEGMENTATION': 'How many sentences',
  'stageHint.SENTENCE_ANALYSIS': 'Per-sentence detail',
  'stageHint.REVIEW': 'Comprehension checks',
  'reader.modeSplit': 'Dual column',
  'reader.modeContinuous': 'Continuous',
  'reader.progress': 'Progress',
  'reader.analyzing': 'Analyzing…',
  'reader.clean': 'Clean body',
  'reader.stageDetail': 'Stage detail',
  'reader.inspectStage': 'View detail',
  'reader.sentencesFailed': 'failed',
  'reader.cleanHint': 'Fetch the source again, keep only the article paragraphs and rebuild the sentences.',
  'reader.cleaned': 'Body cleaned: {before} → {after} words. Analyze it again.',
  'reader.analysisRunning': 'Analysis runs in the background; some sections stay empty until it finishes.',
  'reader.tabGuide': 'Guide',
  'reader.tabWords': 'Vocabulary',
  'reader.tabPhrases': 'Phrases',
  'reader.tabReview': 'Review',
  'reader.guideTitle': 'Reading guide',
  'reader.background': 'Background',
  'reader.mainIdea': 'Main idea',
  'reader.keyPoints': 'Key points',
  'reader.readingFocus': 'Watch for',
  'reader.readingMinutes': 'Suggested reading',
  'reader.notAnalysed': 'Not analyzed yet',
  'reader.notAnalysedBody': 'Start the analysis to get the guide, vocabulary, sentence breakdown and questions.',
  'reader.wordsTitle': 'Key vocabulary',
  'reader.noWords': 'No key words yet',
  'reader.noWordsBody': 'Words chosen for their reading value appear here after analysis.',
  'reader.phrasesTitle': 'Key phrases',
  'reader.noPhrases': 'No phrases yet',
  'reader.noPhrasesBody': 'Verb, prepositional and idiomatic phrases appear here after analysis.',
  'reader.collocationsTitle': 'Collocations',
  'reader.noCollocations': 'No collocations yet',
  'reader.noCollocationsBody': 'Reusable patterns worth learning as whole units appear here after analysis.',
  'reader.reviewTitle': 'Article review',
  'reader.noReview': 'No review yet',
  'reader.noReviewBody': 'Logical structure, takeaways and comprehension questions appear after analysis.',
  'reader.summary': 'Summary',
  'reader.logicalStructure': 'Logical structure',
  'reader.takeaways': 'Takeaways',
  'reader.questions': 'Questions',
  'reader.showAnswer': 'Show answer',
  'reader.hideAnswer': 'Hide answer',
  'reader.pickSentence': 'Pick a sentence',
  'reader.pickSentenceBody': 'Click any sentence on the left to see its structure, translations, grammar and expressions.',
  'reader.noAnalysis': 'This sentence has no analysis yet. If the run finished, try retrying the sentence stage.',
  'reader.sentenceFailed': 'This sentence failed',
  'reader.needsReview': 'Structure checked out, but some quoted evidence needs a human review.',
  'reader.retrySentence': 'Retry this sentence',
  'reader.showRaw': 'Show raw model output',
  'reader.hideRaw': 'Hide raw output',
  'reader.attempts': 'Attempts',
  'reader.failureSummary': 'Failure summary',
  'reader.needsReviewCount': 'review',
  'reader.failedSentences': 'Failed sentences',
  'reader.jumpToSentence': 'Jump',
  'error.LLM_INVALID_JSON': 'The model did not return valid JSON — usually a truncated answer, or prose wrapped around the object.',
  'error.LLM_TRUNCATED': 'The model hit its output limit mid-JSON. Raise maxTokens or split the task into smaller pieces.',
  'error.LLM_UNAVAILABLE': 'The model call failed: the provider is unreachable or returned an error.',
  'error.LLM_TIMEOUT': 'The model call timed out or was cancelled.',
  'error.SCHEMA_VALIDATION_FAILED': 'The model answer did not match the fields this stage requires.',
  'error.EVIDENCE_NOT_FOUND': 'A quoted passage does not appear in the article — it looks invented.',
  'error.NO_RECORD': 'This sentence failed under an earlier version that did not record a reason.',
  'error.unknown': 'An unknown error occurred; expand the raw output to inspect it.',
  'error.noDetail': 'No further detail was recorded.',
  'reader.literal': 'Literal',
  'reader.natural': 'Natural',
  'reader.mainClause': 'Main clause',
  'reader.structure': 'Structure',
  'reader.grammar': 'Grammar',
  'reader.expressions': 'Key expressions',
  'reader.notes': 'Notes',
  'reader.sentenceTab': 'Sentence',
  'reader.openSource': 'Original',
  'reader.expandBand': 'Show analysis stages',
  'reader.collapseBand': 'Hide analysis stages',
  'reader.needsAttention': 'to check',
  'reader.addToLibrary': 'Add to library',
  'reader.inLibrary': 'In library',
  'reader.addedToLibrary': 'Added to library',
  'reader.removedFromLibrary': 'Removed from library',
  'knowledge.optInHint': 'Parsed results stay out of the library until you add them in the reader.',
  'knowledge.notMastered': 'Not mastered',
  'reader.noteForSentence': 'Note on this sentence',
  'reader.notePlaceholder': 'Your understanding, a question, or an example…',
  'reader.saveNote': 'Save note',
  'reader.notes': 'Reading notes',
  'reader.sentence': 'Sentence',
  'reader.articleNote': 'Article note',
  'reader.wordDetail': 'Word detail',
  'reader.openInKnowledge': 'Open in knowledge base',
  'reader.emptyBody': 'Empty article',
  'reader.emptyBodyHint': 'This body has no readable text; import it again.',

  'word.inArticle': 'In this article: ',
  'word.formation': 'Word formation',
  'word.evidence': 'Evidence',
  'word.synonyms': 'Synonyms',
  'word.addPlan': 'Add to review',

  'knowledge.sources': 'sources',
  'knowledge.count': 'items',
  'knowledge.searchPlaceholder': 'Search entries…',
  'knowledge.onlyFavorite': 'Favorites only',
  'knowledge.empty.word.title': 'No words yet',
  'knowledge.empty.word.body': 'Open a word in the reader and press "Add to library".',
  'knowledge.empty.phrase.title': 'No phrases yet',
  'knowledge.empty.phrase.body': 'Analyze an article, then press "Add to library" beside a phrase.',
  'knowledge.empty.collocation.title': 'No collocations yet',
  'knowledge.empty.collocation.body': 'Analyze an article, then press "Add to library" beside a collocation.',
  'knowledge.empty.sentence.title': 'No sentences yet',
  'knowledge.empty.sentence.body': 'Select a sentence in the reader and press "Add to library".',
  'knowledge.emptyTitle': 'Nothing collected yet',
  'knowledge.emptyBody': 'Words, phrases, collocations and sentences accumulate here as you analyze articles, reusable across articles.',
  'knowledge.updated': 'Updated',
  'knowledge.mastery': 'Mastery',
  'knowledge.notes': 'My notes',
  'knowledge.saveNote': 'Save note',
  'knowledge.contexts': 'Source contexts',
  'knowledge.noContext': 'No source context yet',

  'review.today': 'Done today',
  'review.reveal': 'Show answer',
  'review.mastered': 'I know it',
  'review.again': 'Review again',
  'review.unsure': 'Not sure',
  'review.next': 'Saved — next card',
  'review.emptyTitle': 'Review finished for now',
  'review.emptyBody': 'Words below master level enter the review queue after you analyze articles.',
  'review.totalWords': 'Words collected',
  'review.masteredCount': 'Mastered',
  'review.todayReviewed': 'Reviewed today',
  'review.remaining': 'Remaining',

  'settings.model': 'Model and analysis',
  'settings.modelRoute': 'Current model',
  'settings.modelMissing': 'The Harness has no default model configured; analysis will report unavailable.',
  'settings.modelFollowSessionNamed': 'Follow session model: {model}',
  'settings.modelSessionNow': 'This session runs {model}; analysis follows it until you pick another one.',
  'settings.llmService': 'Model runtime',
  'settings.llmServiceHint': 'Calls go through the Harness model runtime; no API key is read.',
  'settings.searchService': 'Search runtime',
  'settings.searchServiceHint': 'Discovery needs a registered search provider.',
  'settings.sentenceConcurrency': 'Sentence concurrency',
  'settings.sentenceConcurrencyHint': 'Sentences analysed at once (sentenceConcurrency).',
  'settings.retryLimit': 'Stage retries',
  'settings.retryLimitHint': 'Maximum attempts per stage.',
  'settings.wordsTarget': 'Key words per article',
  'settings.wordsTargetHint': 'Target vocabulary count for each article.',
  'settings.ready': 'ready',
  'settings.unavailable': 'not configured',
  'settings.speech': 'Pronunciation (Edge TTS)',
  'settings.speechEngine': 'Speech engine',
  'settings.speechEngineHint': 'Microsoft Edge neural voices over the same protocol edge-tts uses — no Python package or key needed.',
  'settings.speechCache': 'Audio cache',
  'settings.speechClear': 'Clear cache',
  'settings.speechCleared': 'Audio cache cleared',
  'settings.speechTrial': 'Try it',
  'settings.speechTrialHint': 'Type any English text and hear it in the selected voice.',
  'settings.speechPlay': 'Speak',
  'settings.speechVoice': 'Default voice',
  'settings.speechVoiceHint': 'Used for both word and sentence playback.',
  'settings.speechRate': 'Rate',
  'settings.data': 'Data and backup',
  'settings.dataDir': 'Data directory',
  'settings.counts': 'Contents',
  'settings.backup': 'Backup and restore',
  'settings.backupHint': 'Data spans the database, article files and the audio cache; copying the whole data directory backs all of it up.',
  'settings.backupDatabase': 'SQLite database: article metadata, analyses, vocabulary and notes, progress and settings.',
  'settings.backupArticles': 'Article body Markdown (plus source HTML when present); the database only stores a path to it.',
  'settings.backupCache': 'Spoken-audio cache. Safe to delete as a whole; it is rebuilt the next time something is read aloud.',
  'settings.backupRestore': 'Restore: stop the Harness, put these directories back at the same path (default ~/.dsh/english-reader), then start it again.',
  'settings.knowledge': 'Knowledge base',
  'settings.knowledgeHint': 'Empty the word, phrase, collocation and sentence libraries. Only library membership is removed; articles and their analyses are kept.',
  'settings.knowledgeClear': 'Clear knowledge base',
  'settings.knowledgeCleared': 'Cleared {count} library entries.',
  'settings.about': 'About',
  'settings.aboutBody': 'English Reader: articles are the entry point, knowledge entities are the lasting asset. Every level is an AI estimate and every conclusion keeps its source evidence.',
  'settings.database': 'Database',
};


// ---- src/120-app.js ----
/** Application shell: rail navigation, page routing, and the panel registration. */

/** Rail navigation entries; `nav.*` labels come from the plugin locale. */
const NAV_GROUPS = [
  {
    id: 'main',
    items: [
      { id: 'home', icon: 'home' },
      { id: 'discover', icon: 'compass' },
      { id: 'articles', icon: 'book' },
    ],
  },
  {
    id: 'knowledge',
    items: [
      { id: 'words', icon: 'letters' },
      { id: 'phrases', icon: 'link' },
      { id: 'collocations', icon: 'layers' },
      { id: 'sentences', icon: 'quote' },
    ],
  },
  {
    // Practice and progress: these act on the library but are not part of it.
    id: 'practice',
    items: [
      { id: 'review', icon: 'refresh' },
      { id: 'history', icon: 'grid' },
    ],
  },
];

const PANEL_ID = 'english-reader';

/** Brand mark, drawn locally so the rail never depends on host artwork. */
function BrandMark({ size = 30 }) {
  return h('svg', { viewBox: '0 0 64 64', width: size, height: size, role: 'img', 'aria-label': 'English Reader' },
    h('path', {
      d: 'M14 18c0-2 1.6-3.2 3.6-2.6L32 18v30l-14.4-3.2C15.6 44.4 14 43 14 41V18Z',
      fill: '#fff', stroke: '#c9bfff', strokeWidth: 2,
    }),
    h('path', {
      d: 'M50 18c0-2-1.6-3.2-3.6-2.6L32 18v30l14.4-3.2c2-.6 3.6-1.4 3.6-3.4V18Z',
      fill: '#fff', stroke: '#c9bfff', strokeWidth: 2,
    }),
    h('path', { d: 'M32 18v30', stroke: '#c9bfff', strokeWidth: 2 }),
    h('rect', { x: 18, y: 25, width: 9, height: 2.4, rx: 1.2, fill: '#b9aef5' }),
    h('rect', { x: 18, y: 31, width: 7, height: 2.4, rx: 1.2, fill: '#d3cbfa' }),
    h('rect', { x: 36, y: 27, width: 9, height: 2.4, rx: 1.2, fill: '#8b7bf7' }),
    h('circle', { cx: 45, cy: 43, r: 10, fill: '#8b7bf7' }),
    h('path', { d: 'M40.5 43l3 3 5.5-6', fill: 'none', stroke: '#fff', strokeWidth: 2.6, strokeLinecap: 'round' }));
}

/** Rail item with an icon and a localized label. */
function NavItem({ t, id, icon, active, onSelect }) {
  return h('button', {
    type: 'button', className: 'er-nav-item', 'aria-current': active ? 'true' : undefined,
    onClick: () => onSelect(id),
  },
  h('span', { className: 'er-nav-icon' }, h(Icons[icon] ?? Icons.book, null)),
  h('span', { className: 'er-nav-label' }, t(`nav.${id}`)));
}

/**
 * Where the user was.
 *
 * The Harness unmounts the plugin panel when the user leaves for another
 * Session, so the route has to outlive the component: without this, coming
 * back lands on the home page instead of the page the user left.
 */
const ROUTE_KEY = 'english-reader:route';

/** The route the user last looked at. */
function readSavedRoute() {
  try {
    const raw = window.localStorage.getItem(ROUTE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.page !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remember the route so leaving the panel does not lose the place. */
function saveRoute(route) {
  try {
    window.localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  } catch {
    /* storage unavailable */
  }
}

/** The whole plugin surface, mounted into the `main` panel. */
function EnglishReaderApp({ t }) {
  const [route, setRoute] = React.useState(() => readSavedRoute() ?? {
    page: 'home', articleId: null, kind: 'words', detailId: null, search: undefined,
    discoverTab: 'spec', discoverMode: 'auto',
  });
  const [toast, setToast] = React.useState(null);
  const notify = React.useCallback((message, tone = 'ok') => {
    setToast({ message, tone, at: Date.now() });
  }, []);
  React.useEffect(() => {
    if (toast === null) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const go = (page, extra) => setRoute((current) => ({ ...current, page, ...extra }));
  // Persist on every change: the panel is unmounted when the user leaves for
  // another Session, and the route has to survive that.
  React.useEffect(() => {
    saveRoute(route);
  }, [route]);
  const openArticle = (articleId) => setRoute({ page: 'article', articleId, kind: 'words', detailId: null });
  const openKnowledge = (kind, detailId) => setRoute({
    page: 'knowledge',
    kind: kind === 'word' ? 'words' : `${kind}s`,
    detailId,
    articleId: null,
  });
  const navigateByNav = (id) => {
    if (id === 'home') go('home');
    else if (id === 'discover') go('discover');
    else if (id === 'articles') go('articles');
    else if (id === 'review') go('review');
    else if (id === 'history') go('history');
    else if (id === 'settings') go('settings');
    else go('knowledge', { kind: id, detailId: null });
  };
  const activeNav = route.page === 'knowledge'
    ? route.kind
    : route.page === 'article' ? 'articles' : route.page;

  const kinds = { words: 'word', phrases: 'phrase', collocations: 'collocation', sentences: 'sentence' };
  let page = null;
  if (route.page === 'home') {
    page = h(Dashboard, { t, onNavigate: go, onOpen: openArticle });
  } else if (route.page === 'discover') {
    page = h(Discover, {
      t, notify, onOpenArticle: openArticle,
      tab: route.discoverTab, mode: route.discoverMode,
      onTabChange: (next) => go('discover', { discoverTab: next }),
      onModeChange: (next) => go('discover', { discoverMode: next }),
    });
  } else if (route.page === 'articles') {
    page = h(Articles, {
      t, notify, onOpenArticle: openArticle, initialSearch: route.search,
    });
  } else if (route.page === 'article') {
    page = route.articleId === null
      ? h(Empty, { icon: h(Icons.bookOpen, null), title: t('articles.emptyTitle'), description: t('articles.emptyBody') })
      : h(ArticleDetail, {
        t, articleId: route.articleId, notify,
        onBack: () => go('articles'),
        onNavigateKnowledge: openKnowledge,
      });
  } else if (route.page === 'review') {
    page = h(ReviewPage, { t, notify });
  } else if (route.page === 'history') {
    page = h(StudyHistoryPage, { t, notify });
  } else if (route.page === 'settings') {
    page = h(SettingsPage, { t, notify });
  } else if (route.page === 'knowledge') {
    const kind = kinds[route.kind] ?? 'word';
    page = route.detailId
      ? h(KnowledgeDetail, {
        t, kind, entityId: route.detailId, notify,
        onBack: () => go('knowledge', { detailId: null }),
      })
      : h(KnowledgePage, { t, kind, notify });
  }

  const groups = NAV_GROUPS.map((group, groupIndex) => h('div', { key: group.id },
    groupIndex > 0 ? h('div', { className: 'er-nav-group' }, t(`nav.group.${group.id}`)) : null,
    group.items.map((item) => h(NavItem, {
      key: item.id, t, id: item.id, icon: item.icon,
      active: activeNav === item.id, onSelect: navigateByNav,
    }))));

  return h('div', { className: 'er-root' },
    h('nav', { className: 'er-rail', 'aria-label': 'English Reader' },
      h('div', { className: 'er-brand' },
        h('div', { className: 'er-brand-mark' }, h(BrandMark, null)),
        // One line: the rail is 188px wide, so the two words fit together.
        h('div', { className: 'er-brand-name' }, 'English Reader')),
      groups,
      h('div', { className: 'er-rail-foot' },
        h(NavItem, {
          t, id: 'settings', icon: 'settings',
          active: activeNav === 'settings', onSelect: navigateByNav,
        }))),
    h('div', { className: 'er-main' },
      h('div', {
        // A fill-mode page owns its own scrolling, so the shell must not
        // scroll it as well: the page would grow past the viewport instead.
        className: route.page === 'article' || route.page === 'discover' || route.page === 'articles'
          ? 'er-scroll er-scroll--fill'
          : 'er-scroll',
      }, page)),
    toast !== null
      ? h('div', { className: 'er-toast' },
        h('div', {
          className: `er-alert ${toast.tone === 'error' ? 'error' : 'ok'}`,
          role: 'status', style: { boxShadow: 'var(--er-float-lg)' },
        },
        toast.tone === 'error' ? h(Icons.warning, null) : h(Icons.check, null),
        h('div', null, toast.message)))
      : null);
}


// ---- src/125-bridge.js ----
/**
 * Bridge to the Harness client services.
 *
 * The plugin's own data lives behind the Host route, but the model the CURRENT
 * session runs on lives in the Session's `modelSelection` projection, which
 * only the browser half can read: the Host only knows the deployment default.
 * The panel registration installs the client context here, so the settings page
 * can name the model the conversation is actually using instead of saying
 * "the same as the session".
 */

/** The client context, installed once by the panel registration. */
let CLIENT_CTX = null;

/** Remember the client context. */
function setClientContext(ctx) {
  CLIENT_CTX = ctx;
}

/** The client Session service, or null when the shell has none yet. */
function clientSessions() {
  try {
    return CLIENT_CTX?.get?.('sessions') ?? null;
  } catch {
    return null;
  }
}

/** The Session the shell is currently showing, or null. */
function currentSessionId() {
  const sessions = clientSessions();
  if (!sessions) return null;
  try {
    const byId = sessions.list.getSnapshot().byId;
    return Object.values(byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The model the current session is using.
 * @returns {{provider: string, model: string}|null} the live selection.
 */
function readSessionModel() {
  const sessions = clientSessions();
  const id = currentSessionId();
  if (!sessions || !id) return null;
  try {
    const view = sessions.binding(id)?.session?.projections?.faceOf('modelSelection')?.getSnapshot();
    const selection = view?.next ?? view?.lastUsed;
    return selection?.provider ? { provider: selection.provider, model: selection.model } : null;
  } catch {
    return null;
  }
}

/**
 * Watch the current session's model selection.
 *
 * The projection face exists only once the session is bound, so the listener
 * re-reads the binding on every notification: a session that binds later still
 * reports its model.
 * @param {Function} listener called on every change.
 * @returns {Function} unsubscribe.
 */
function subscribeSessionModel(listener) {
  const sessions = clientSessions();
  const disposers = [];
  const update = () => {
    try {
      listener(readSessionModel());
    } catch {
      /* a stale binding must not break the page */
    }
  };
  try {
    if (sessions?.list?.subscribe) disposers.push(sessions.list.subscribe(update));
    const id = currentSessionId();
    const face = sessions?.binding?.(id)?.session?.projections?.faceOf('modelSelection');
    if (face?.subscribe) disposers.push(face.subscribe(update));
  } catch {
    /* no session yet */
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * The current session's model, kept live.
 * @returns {{provider: string, model: string}|null} selection.
 */
function useSessionModel() {
  const [model, setModel] = React.useState(null);
  React.useEffect(() => {
    setModel(readSessionModel());
    return subscribeSessionModel(setModel);
  }, []);
  return model;
}

/**
 * The Harness model catalog: providers with their display names and models.
 *
 * This is the same grouped roster the Harness model picker renders, so the
 * settings page names providers and models exactly like the shell does. The
 * Host route cannot supply it: only the browser half holds the model catalog
 * the picker reads.
 *
 * @returns {Promise<{groups: object[], default: object|null}|null>} catalog.
 */
async function readModelCatalog() {
  try {
    const remote = CLIENT_CTX?.get?.('remote');
    const session = remote?.session;
    if (!session || typeof session.modelCatalog !== 'function') return null;
    const response = await session.modelCatalog();
    if (!response || response.ok !== true || !response.value) return null;
    return response.value;
  } catch {
    return null;
  }
}

/**
 * The model catalog, kept live.
 * @returns {{groups: object[], default: object|null}|null} catalog.
 */
function useModelCatalog() {
  const [catalog, setCatalog] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    readModelCatalog().then((value) => {
      if (alive) setCatalog(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return catalog;
}


// ------------------------------------------------------------------ panel
const NS = 'englishReader';

/** Sidebar glyph: the reader's own mark, sized by the owner. */
function EnglishReaderPanelIcon({ size }) {
  return h('span', {
    style: { display: 'grid', placeItems: 'center', width: size, height: size },
  }, h(BrandMark, { size }));
}

/**
 * Main-panel entry. The owner passes the locale-bound translate function as props.t.
 */
function EnglishReaderPanel(props) {
  return h('div', { style: { height: '100%', minHeight: 0 } },
    h('style', null, CSS),
    h(EnglishReaderApp, { t: props.t }));
}

const plugin = {
  // 'remote.session' carries the model catalog the Harness picker reads, and
  // 'sessions' the live Session projection with the current model choice.
  inject: ['slots', 'locale', 'remote.session', 'sessions'],
  apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'english-reader: dictionaries');
    // The settings page names the model the current session runs on; that value
    // only exists in the browser's Session projection, so the context is kept.
    setClientContext(ctx);
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => ctx.locale.bind(NS)('panel'),
      locale: NS,
    }, EnglishReaderPanelIcon));
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
    }, EnglishReaderPanel));
  },
};



return plugin;

  },
});
