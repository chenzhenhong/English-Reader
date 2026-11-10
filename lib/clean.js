/**
 * Article cleaner: HTML → the paragraphs a reader would call "the article".
 *
 * A publisher page is mostly chrome: skip links, bylines, share buttons,
 * copyright notes, sponsor blocks, related-story teasers. Stripping tags alone
 * keeps all of it, so the stored body — and every analysis built on it — starts
 * with noise the learner must read past.
 *
 * The cleaner works in three steps:
 *
 * 1. **Structural normalization.** A browser closes a `<p>` when the next one
 *    opens; many publishers emit unclosed `<p>` tags, so the markup is
 *    normalized before anything is read.
 * 2. **Paragraph selection.** Only paragraph-level elements are candidates —
 *    a headline or a menu item is not prose. Candidates are then scored: a
 *    paragraph reads like body copy when it is long enough, has several words,
 *    and ends like a sentence.
 * 3. **Boilerplate removal.** Lines that are certainly page furniture (a
 *    byline, a "Listen" button, a copyright notice) are dropped, and a
 *    paragraph repeated twice in a row is kept once.
 *
 * Everything here is deterministic and publisher-agnostic: no per-site
 * selector table to maintain, and a page that changes its markup still
 * cleans up, just less precisely.
 */

/** Lines that are page furniture rather than prose. */
const BOILERPLATE = [
  /^accessibility links?$/i,
  /^skip to\b/i,
  /^keyboard shortcuts/i,
  /^toggle (nav|menu)/i,
  /^search\b/i,
  /^sign (in|up|out)$/i,
  /^subscribe\b/i,
  /^newsletter\b/i,
  /^follow us\b/i,
  /^advertisement$/i,
  /^sponsored( content)?$/i,
  /^sponsor message$/i,
  /^become an? .* sponsor$/i,
  /^become a .* member$/i,
  /^listen$/i,
  /^listen ·?.*$/i,
  /^download$/i,
  /^embed$/i,
  /^transcript$/i,
  /^share$/i,
  /^comments?$/i,
  /^by$/i,
  /^hear on\b/i,
  /^published\b/i,
  /^updated\b/i,
  /^copyright\b/i,
  /^all rights reserved/i,
  /^terms of use/i,
  /^privacy policy/i,
  /^cookie policy/i,
  /^accuracy and availability/i,
  /^\w[\w .'-]{0,40} does not (offer|accept)/i,
  /^\w[\w .'-]{0,40} platforms? and products/i,
  /^anyone who makes such an offer/i,
  /^more from\b/i,
  /^related (stories|articles|news)$/i,
  /^read more$/i,
  /^see more$/i,
  /^continue reading$/i,
  /^top stories$/i,
  /^most (read|popular)$/i,
  /^latest\b/i,
  /^next (up|article)$/i,
  /^previous\b/i,
  /^image:.*$/i,
  /^photo(graph)?:.*$/i,
  /^credit:.*$/i,
  /^illustration:.*$/i,
  /^advertisement ·.*$/i,
  // A photo caption: the picture description, its credit and the "hide caption"
  // toggle are printed as one paragraph on many publishers, so the credit or the
  // toggle label is the signal. A caption is page furniture, not article prose.
  /hide caption/i,
  /toggle caption/i,
  /\b[A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){0,3}\s*\/\s*(?:AP|Reuters|Getty Images?|AFP|Bloomberg|Polaris|Shutterstock)\b/i,
];

/**
 * A speaker turn: "SCHMITZ: What great timing…" — prose even when short.
 *
 * The label is shouted (`ROB SCHMITZ, HOST:`), so it is matched in capitals;
 * a name with an initial only (`Schmitz:`) is not a label.
 */
const SPEAKER_TURN = /^[A-Z][A-Z .,'’\-]{2,30}:\s+\S/;

/**
 * A speaker label on its own: "ROB SCHMITZ, HOST:".
 *
 * A transcript prints the speaker and the speech as two elements, so the label
 * has to be rejoined with the words that follow it.
 */
const SPEAKER_LABEL = /^[A-Z][A-Z .,'’\-]{2,30}:$/;

/** A caption or a stage direction: "(SOUNDBITE OF ARCHIVED RECORDING)". */
const STAGE_DIRECTION = /^\([^)]{3,80}\)$/;

/** Decode the handful of HTML entities article text actually uses. */
function decode(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body.startsWith('#')) {
      const value = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“',
      rdquo: '”', hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·',
    };
    const value = named[body.toLowerCase()];
    return value === undefined ? match : value;
  });
}

/** Void elements never go on the open-element stack. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose text is article prose. */
const PROSE_TAGS = new Set([
  'p', 'li', 'blockquote', 'pre', 'td', 'th', 'dd', 'dt',
]);

/**
 * Start tags that close an open `<p>`, the way a browser's parser does.
 *
 * A publisher may print `<p><p>` for every line — NPR's transcript does — so
 * without this rule every line nests into a single paragraph.
 */
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/**
 * Containers whose text is page furniture, not prose.
 *
 * A figure caption, a menu item in an `<aside>` or `<nav>`, or the contents of
 * a `<form>` is never the article. Recognizing the container is more reliable
 * than pattern-matching the words inside it, which is why the scorer still
 * exists for the containers that are not marked up at all.
 */
const CHROME_TAGS = new Set([
  'aside', 'button', 'dialog', 'figcaption', 'figure', 'form', 'head',
  'iframe', 'menu', 'nav', 'noscript', 'script', 'style', 'svg', 'template',
]);

/**
 * Collapse the whitespace of one fragment, decode its entities and strip any
 * markup a malformed tag left behind.
 *
 * The tokenizer skips properly matched tags, but a tag inside an attribute
 * value (NPR prints the embed snippet inside `<input value="<iframe …>">`) can
 * survive into the buffer. Stripping it here is the safety net that keeps such
 * leakage out of the stored body.
 */
function normalizeText(text) {
  return decode(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Close every `<p>` the way a browser does.
 *
 * A new paragraph ends the previous one, so an unclosed `<p>` would otherwise
 * swallow the rest of the document into one block.
 * @param {string} html raw markup.
 * @returns {string} markup with explicit paragraph closes.
 */
export function normalizeParagraphs(html) {
  let out = '';
  let lastEnd = 0;
  const open = /<p\b[^>]*>/gi;
  let match;
  while ((match = open.exec(html)) !== null) {
    out += `${html.slice(lastEnd, match.index)}</p>${match[0]}`;
    lastEnd = open.lastIndex;
  }
  return out + html.slice(lastEnd);
}

/**
 * Collect the prose blocks of a document.
 *
 * The markup arrives as a string, so the tags are walked with a quote-aware
 * scanner and a stack of open elements rather than a regex over raw markup.
 * Only text inside a prose element is collected — a `<p>`, a list item, a
 * block quote or a table cell — and a block is emitted when its element closes.
 * The chrome flag comes from the open-element stack, so a caption inside a
 * `<figure>` or a menu item inside an `<aside>` is dropped before it is scored.
 *
 * @param {string} html raw markup.
 * @returns {{text: string, start: number, end: number, chrome: boolean}[]} blocks in document order.
 */
export function collectBlocks(html) {
  const blocks = [];
  // Comments and declarations are text to a tag scanner; drop them first so a
  // truncated fetch's newsletter payload cannot become a paragraph.
  const source = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<![^>]*>/g, ' ');
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  const stack = [];
  let buffer = '';
  let bufferStart = 0;
  let lastIndex = 0;
  let proseDepth = 0;
  let chromeDepth = 0;
  let match;

  const flush = () => {
    const raw = buffer;
    const text = normalizeText(raw);
    if (text.length > 0) {
      const leading = raw.length - raw.trimStart().length;
      blocks.push({
        text,
        start: bufferStart + leading,
        end: bufferStart + leading + text.length,
        // True while any chrome container is open: the text may have come from
        // inside it even when a prose tag closed first.
        chrome: chromeDepth > 0,
      });
    }
    buffer = '';
  };

  while ((match = tagPattern.exec(source)) !== null) {
    const slice = source.slice(lastIndex, match.index);
    if (proseDepth > 0) {
      if (buffer.length === 0) bufferStart = lastIndex;
      buffer += slice;
    }
    const full = match[0];
    const closing = match[1] === '/';
    const name = match[2];
    const lower = name.toLowerCase();
    lastIndex = match.index + full.length;

    if (lower === 'br') {
      if (proseDepth > 0) buffer += ' ';
      continue;
    }
    if (closing) {
      // Find the matching open element; a browser drops any unclosed elements
      // above it when the parent closes. Those removed prose or chrome elements
      // end their text, so flush once before the depth counters move.
      let matchIndex = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].toLowerCase() === lower) {
          matchIndex = i;
          break;
        }
      }
      if (matchIndex >= 0) {
        const removed = stack.slice(matchIndex);
        if (removed.some((name) => PROSE_TAGS.has(name.toLowerCase()) || CHROME_TAGS.has(name.toLowerCase()))) {
          flush();
        }
        for (const name of removed) {
          const removedLower = name.toLowerCase();
          if (PROSE_TAGS.has(removedLower)) proseDepth = Math.max(0, proseDepth - 1);
          if (CHROME_TAGS.has(removedLower)) chromeDepth = Math.max(0, chromeDepth - 1);
        }
        stack.length = matchIndex;
      }
    } else {
      // A browser closes an open `<p>` when a block start tag arrives, and an
      // open `<li>` when another `<li>` starts. Real markup nests them
      // (`<p><p>`, `<li>a<li>b`), so without this the lines merge into one.
      if (P_CLOSERS.has(lower)) {
        while (stack.length > 0 && stack[stack.length - 1].toLowerCase() === 'p') {
          if (PROSE_TAGS.has('p')) { flush(); proseDepth = Math.max(0, proseDepth - 1); }
          stack.pop();
        }
      }
      if (lower === 'li' && stack.length > 0 && stack[stack.length - 1].toLowerCase() === 'li') {
        if (PROSE_TAGS.has('li')) { flush(); proseDepth = Math.max(0, proseDepth - 1); }
        stack.pop();
      }
      if (PROSE_TAGS.has(lower)) {
        if (proseDepth === 0) buffer = '';
        proseDepth += 1;
      }
      // A chrome element opening mid-block separates the prose before it from
      // the page furniture inside it; otherwise they would merge into one block.
      if (CHROME_TAGS.has(lower) && proseDepth > 0 && buffer.length > 0) flush();
      if (CHROME_TAGS.has(lower)) chromeDepth += 1;
      if (!VOID_TAGS.has(lower)) stack.push(name);
    }
  }
  // An unclosed prose element still holds its text.
  if (proseDepth > 0) {
    const tail = source.slice(lastIndex);
    if (buffer.length === 0) bufferStart = lastIndex;
    buffer += tail;
    flush();
  }
  return blocks;
}

/**
 * Score one block as body prose.
 *
 * Zero means "not prose": page furniture, a label, or a fragment too short to
 * be a paragraph of an article.
 * @param {string} text block text.
 * @returns {number} higher is more likely to be body copy.
 */
export function proseScore(text) {
  const value = text.trim();
  if (value.length === 0) return 0;
  // A block that still carries markup — a tag the scanner missed, or an entity
  // that decoded to one (NPR prints the embed snippet inside an audio tool) —
  // is page furniture, not prose. Real prose never contains a tag-like run.
  if (/<[a-zA-Z][^>]*>/i.test(value)) return 0;
  if (BOILERPLATE.some((pattern) => pattern.test(value))) return 0;
  if (STAGE_DIRECTION.test(value)) return 0;
  // A speaker turn is prose even when it is short.
  if (SPEAKER_TURN.test(value)) return 1;
  // A speaker label is kept so it can be rejoined with the speech below it.
  if (SPEAKER_LABEL.test(value)) return 1;
  if (value.length < 45) return 0;
  const words = value.split(/\s+/).length;
  if (words < 10) return 0;
  // A line of only punctuation and digits is a figure caption or a timestamp.
  if (/^[\d\s:·|.,'"/\\-–—()#]+$/.test(value)) return 0;
  let score = 1;
  if (/[.!?]["')\]]?$/.test(value)) score += 2;
  if (words >= 18) score += 1;
  if (value.length > 140) score += 1;
  return score;
}

/**
 * Drop a paragraph that repeats the one before it.
 *
 * A publisher often prints the standfirst and then opens the body with the
 * same sentence; the learner should read it once.
 * @param {{text: string}[]} blocks blocks in document order.
 * @returns {{text: string}[]} the blocks without the repeats.
 */
export function dedupeBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    const previous = out[out.length - 1];
    if (previous === undefined) {
      out.push(block);
      continue;
    }
    if (previous.text === block.text) continue;
    const head = block.text.slice(0, 60);
    if (head.length >= 40 && previous.text.startsWith(head)) continue;
    out.push(block);
  }
  return out;
}

/**
 * Rejoin a speaker label with the speech that follows it.
 *
 * A transcript prints "ROB SCHMITZ, HOST:" as its own element and the words
 * after it as another; read alone, the label is a fragment, so the two are
 * merged into one paragraph.
 * @param {string[]} paragraphs paragraphs in document order.
 * @returns {string[]} the paragraphs with the labels rejoined.
 */
export function joinSpeakerLabels(paragraphs) {
  const out = [];
  for (const paragraph of paragraphs) {
    const previous = out[out.length - 1];
    if (previous !== undefined && SPEAKER_LABEL.test(previous)) {
      out[out.length - 1] = `${previous} ${paragraph}`;
      continue;
    }
    out.push(paragraph);
  }
  return out;
}

/**
 * Clean one publisher page into the article body.
 *
 * @param {string} html raw document.
 * @param {{title?: string}} [options] the document title, when known.
 * @returns {{text: string, paragraphs: string[], dropped: number}} the body and
 *   how many blocks were discarded as furniture.
 */
export function cleanArticle(html, options = {}) {
  if (typeof html !== 'string' || html.length === 0) {
    return { text: '', paragraphs: [], dropped: 0 };
  }
  // Script, style and head content is never prose, and a `<style>` that a
  // truncated fetch cut in half would leak its CSS into the text.
  const withoutChrome = html
    .replace(/<(script|style|noscript|template|svg|iframe|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(style|script)\b[^>]*>(?:(?!<\/\1>)[\s\S])*$/i, ' ')
    .replace(/<\/(style|script)\b[^>]*>[\s\S]*$/i, ' ');
  const blocks = collectBlocks(withoutChrome);
  const title = typeof options.title === 'string' ? options.title.trim().toLowerCase() : '';
  const kept = [];
  for (const block of blocks) {
    // A block inside a chrome container (a figure caption, a menu, a form) is
    // page furniture by structure, so it is dropped before it can be scored.
    if (block.chrome) continue;
    if (proseScore(block.text) === 0) continue;
    // The headline repeated as the first paragraph is chrome too.
    if (title.length > 20 && block.text.toLowerCase().startsWith(title.slice(0, 40))) continue;
    kept.push(block);
  }
  const paragraphs = joinSpeakerLabels(dedupeBlocks(kept).map((block) => block.text));
  return {
    text: paragraphs.join('\n\n'),
    paragraphs,
    dropped: blocks.length - kept.length,
  };
}
