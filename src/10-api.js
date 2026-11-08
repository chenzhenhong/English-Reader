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

/** Human label for an analysis stage. */
const STAGE_LABELS = {
  OVERVIEW: '文章导读',
  DIFFICULTY: '难度评估',
  VOCABULARY: '重点单词',
  PHRASES: '重点短语',
  COLLOCATIONS: '固定搭配',
  SEGMENTATION: '句子切分',
  SENTENCE_ANALYSIS: '逐句解析',
  REVIEW: '文章复盘',
};

/** Human label for a stage status. */
const STATUS_LABELS = {
  PENDING: '待执行',
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
