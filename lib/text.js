/**
 * Deterministic text pipeline: HTML → cleaned text → paragraphs → sentences with
 * character offsets, plus word counting and lightweight difficulty heuristics.
 *
 * The model never rewrites the article: segmentation happens here so offsets
 * always address the stored body.
 */

/** Named entities worth decoding in article prose. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', rsquo2: '’', copy: '©', reg: '®',
  trade: '™', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ouml: 'ö', uuml: 'ü',
  auml: 'ä', szlig: 'ß', frac12: '½', times: '×', euro: '€', pound: '£', yen: '¥',
};

const BLOCK_TAGS = /<\/?(p|div|section|article|header|footer|main|aside|h[1-6]|ul|ol|li|blockquote|pre|figure|figcaption|table|tr|td|th|br|hr|nav|form|noscript|iframe|script|style|svg|head)\b[^>]*>/gi;

/** Decode the handful of HTML entities article text actually uses. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const value = ENTITIES[body.toLowerCase()];
    return value === undefined ? match : value;
  });
}

/** Collapse whitespace but keep paragraph breaks intact. */
function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract readable article text from an HTML document.
 * Nav, script, style, form and footer content is dropped before block splitting.
 *
 * The document may be cut short — the Harness caps a fetched body — and the cut
 * often lands inside a `<style>` block. An unterminated style block would then
 * leak its CSS into the text, so a trailing `<style`/`</style` is closed
 * before the content is stripped.
 * @param {string} html raw document.
 * @returns {{text: string, title: string, description: string}} cleaned body.
 */
export function extractReadable(html) {
  if (typeof html !== 'string' || html.length === 0) return { text: '', title: '', description: '' };
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside|form|button)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // A cut that lands inside a style or script block leaves it unterminated;
    // closing it keeps its content out of the article text.
    .replace(/<(style|script)\b[^>]*>(?:(?!<\/\1>)[\s\S])*$/i, ' ')
    .replace(/<\/(style|script)\b[^>]*>[\s\S]*$/i, ' ');
  const metaDescription = clean.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const body = clean.replace(BLOCK_TAGS, (tag) => (tag.startsWith('</') ? '\n\n' : '\n\n'));
  const text = tidy(decodeEntities(body.replace(/<[^>]+>/g, ' ')));
  return {
    text,
    title: titleMatch ? tidy(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ''))) : '',
    description: metaDescription ? tidy(decodeEntities(metaDescription[1])) : '',
  };
}

/** Split cleaned text into paragraphs, preserving blank-line separation. */
export function toParagraphs(text) {
  return tidy(text)
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, ' ').trim())
    .filter((block) => block.length > 0);
}

/**
 * Deterministic sentence segmentation over one paragraph.
 * Handles abbreviation and decimal points so offsets stay correct.
 */
export function splitSentences(paragraph) {
  const out = [];
  let start = 0;
  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
    'u.s', 'u.k', 'no', 'a.m', 'p.m', 'inc', 'ltd', 'co', 'jan', 'feb', 'mar', 'apr',
    'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  ]);
  for (let i = 0; i < paragraph.length; i += 1) {
    const ch = paragraph[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let j = i + 1;
    while (j < paragraph.length && (paragraph[j] === '"' || paragraph[j] === "'" || paragraph[j] === '”' || paragraph[j] === '’' || paragraph[j] === ')')) j += 1;
    const next = paragraph[j];
    if (next === undefined || !/\s/.test(next)) continue;
    if (ch === '.') {
      const before = paragraph.slice(Math.max(0, i - 8), i).toLowerCase();
      const word = before.match(/([a-z.]*)$/)?.[1] ?? '';
      if (ABBREVIATIONS.has(word)) continue;
      if (/\d$/.test(paragraph[i - 1] ?? '') && /\s/.test(next) && /\d/.test(paragraph[j + 1] ?? '')) continue;
    }
    // Offsets point at the trimmed extent, so slicing the stored body with
    // them reproduces the sentence exactly.
    const raw = paragraph.slice(start, j);
    const leading = raw.length - raw.trimStart().length;
    const sentence = raw.trim();
    if (sentence.length > 0) out.push({ text: sentence, start: start + leading, end: start + leading + sentence.length });
    start = j;
    i = j - 1;
  }
  const rawTail = paragraph.slice(start);
  const tailLeading = rawTail.length - rawTail.trimStart().length;
  const tail = rawTail.trim();
  if (tail.length > 0) out.push({ text: tail, start: start + tailLeading, end: start + tailLeading + tail.length });
  return out;
}

/**
 * Segment a body into paragraphs and sentences with stable offsets.
 * Offsets address the normalized body string, so the reader highlights exactly
 * the stored characters.
 * @param {string} text cleaned body.
 * @returns {{text: string, paragraphs: Array<object>, sentences: Array<object>, wordCount: number}} segmentation.
 */
export function segmentArticle(text) {
  const paragraphs = toParagraphs(text);
  const normalized = paragraphs.join('\n\n');
  const sentences = [];
  let cursor = 0;
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const local = splitSentences(paragraph);
    for (const item of local) {
      sentences.push({
        paragraphIndex,
        sentenceIndex: sentences.length,
        text: item.text,
        startOffset: cursor + item.start,
        endOffset: cursor + item.end,
      });
    }
    cursor += paragraph.length + 2;
  });
  return {
    text: normalized,
    paragraphs: paragraphs.map((body, index) => ({ index, body })),
    sentences,
    wordCount: countWords(normalized),
  };
}

/**
 * Truncate a body to at most `maxWords`, cutting only on sentence boundaries.
 *
 * Truncating mid-sentence would leave a fragment that the analyser has to treat
 * as a complete sentence, so the cut lands after the last sentence that still
 * fits. A body already within budget is returned unchanged.
 * @param {string} text article body.
 * @param {number} maxWords inclusive word budget.
 * @returns {{text: string, truncated: boolean, words: number, droppedSentences: number}}
 */
export function truncateToWords(text, maxWords) {
  const budget = Math.max(1, Math.floor(Number(maxWords) || 0));
  const full = segmentArticle(text);
  if (full.wordCount <= budget) {
    return { text: full.text, truncated: false, words: full.wordCount, droppedSentences: 0 };
  }
  // Keep the longest run of whole sentences that fits the budget.
  let kept = 0;
  let words = 0;
  for (const sentence of full.sentences) {
    const next = words + countWords(sentence.text);
    if (next > budget && kept > 0) break;
    words = next;
    kept += 1;
  }
  const paragraphs = [];
  const seen = new Set();
  for (const sentence of full.sentences.slice(0, kept)) {
    if (!seen.has(sentence.paragraphIndex)) {
      seen.add(sentence.paragraphIndex);
      paragraphs.push([]);
    }
    paragraphs[paragraphs.length - 1].push(sentence.text);
  }
  const body = paragraphs.map((parts) => parts.join(' ')).join('\n\n');
  return {
    text: body,
    truncated: true,
    words: countWords(body),
    droppedSentences: full.sentences.length - kept,
  };
}

/** Count English words in a body. */
export function countWords(text) {
  const matches = String(text).match(/[A-Za-z][A-Za-z'’\-]*/g);
  return matches === null ? 0 : matches.length;
}

/** Reading minutes at ~150 wpm, minimum one. */
export function readingMinutes(words) {
  return Math.max(1, Math.round(words / 150));
}

/** Common function words that never deserve vocabulary treatment. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'them', 'his', 'her', 'their', 'our',
  'my', 'your', 'not', 'no', 'so', 'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'than', 'then', 'there', 'here', 'when',
  'where', 'which', 'who', 'whom', 'what', 'while', 'into', 'about', 'over', 'under', 'more',
  'most', 'some', 'any', 'all', 'each', 'every', 'also', 'just', 'very', 'too', 'only', 'such',
]);

/** Tokenize a body into normalized lowercase words. */
export function tokenize(text) {
  const matches = String(text).toLowerCase().match(/[a-z][a-z'\-]*/g);
  return matches === null ? [] : matches;
}

/** Rank candidate vocabulary by length, rarity and repetition inside the article. */
export function rankCandidates(text, limit) {
  const counts = new Map();
  for (const word of tokenize(text)) {
    const lemma = word.replace(/'s$/, '');
    if (lemma.length < 4 || STOP_WORDS.has(lemma)) continue;
    counts.set(lemma, (counts.get(lemma) ?? 0) + 1);
  }
  const scored = [...counts.entries()]
    .map(([lemma, times]) => ({ lemma, times, weight: lemma.length + Math.min(times, 3) * 1.5 }))
    .sort((left, right) => right.weight - left.weight || left.lemma.localeCompare(right.lemma));
  return scored.slice(0, Math.max(0, limit)).map((item) => item.lemma);
}

/**
 * Heuristic CEFR estimate used only when the model is unavailable or its
 * difficulty stage failed; the UI labels every level as an AI estimate.
 */
export function heuristicLevel(text) {
  const words = countWords(text);
  const sentences = Math.max(1, splitSentences(text).length);
  const average = words / sentences;
  const longWords = (text.match(/[A-Za-z]{9,}/g) ?? []).length;
  const ratio = words === 0 ? 0 : longWords / words;
  const score = average / 8 + ratio * 10;
  if (score < 1.2) return 'A2';
  if (score < 1.8) return 'B1';
  if (score < 2.6) return 'B2';
  if (score < 3.4) return 'C1';
  return 'C2';
}
