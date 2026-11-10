/**
 * Dictionary lookup over the free web versions of Youdao and Bing.
 *
 * Both providers are reached by scraping the page a human sees at
 * `dict.youdao.com/w/<word>` and `cn.bing.com/dict/clientsearch?q=<word>`. That
 * is deliberate: neither exposes a free, stable, key-less JSON API, and the
 * extension-style scraping Saladict uses carries the same trade-off — it works
 * today and a markup change breaks it. The parsers therefore extract by class
 * name and report `DICTIONARY_NOT_FOUND` rather than inventing a result.
 *
 * Parsing runs without a DOM library (the profile bundle ships no
 * dependencies): `extractElements` walks the markup and balances tags, so a
 * block that contains its own nested elements is still captured whole.
 */
import { ReaderError, ERROR_CODES } from './net.js';

/** Providers and the endpoint each one is fetched from. */
export const DICTIONARY_PROVIDERS = Object.freeze({
  youdao: {
    id: 'youdao',
    url: (word) => `https://dict.youdao.com/w/${encodeURIComponent(word)}`,
  },
  bing: {
    id: 'bing',
    url: (word) => `https://cn.bing.com/dict/clientsearch?mkt=zh-CN&setLang=zh`
      + `&form=BDVEHC&ClientVer=BDDTV3.5.1.4320&q=${encodeURIComponent(word)}`,
  },
});

/** Every provider id, in settings-select order. */
export const DICTIONARY_IDS = Object.freeze(['youdao', 'bing']);

/** The default provider, used until the learner picks one. */
export const DEFAULT_DICTIONARY = 'youdao';

/** Limit a lookup to one token; anything longer is a phrase, not a lookup. */
const WORD_PATTERN = /^[A-Za-z][A-Za-z'’\-]*$/;

/**
 * Reject anything that cannot be a single English word.
 * @param {string} word the raw query.
 * @returns {string} the trimmed, validated word.
 */
export function normalizeWord(word) {
  const trimmed = String(word ?? '').trim();
  if (trimmed.length === 0 || trimmed.length > 40) {
    throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'Enter one English word to look up.');
  }
  if (!WORD_PATTERN.test(trimmed)) {
    throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'Only single English words can be looked up.');
  }
  return trimmed;
}

/** Drop comments and the chrome that never carries a definition. */
function stripScripts(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ');
}

/** Decode the entities dictionary pages actually emit, including numeric ones. */
function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
    mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
    copy: '©', reg: '®', trade: '™', middot: '·', deg: '°', plusmn: '±',
    times: '×', divide: '÷', laquo: '«', raquo: '»', sect: '§', para: '¶',
    micro: 'µ', larr: '←', rarr: '→', middot: '·',
  };
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[body.toLowerCase()] ?? match;
  });
}

/** Plain text of a markup fragment: tags out, entities resolved. */
function plainText(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    // A tag between a word and its punctuation must not become a space.
    .replace(/\s+([.,;:!?)\]}])/g, '$1')
    .trim();
}

/**
 * Collect every element of one tag whose attributes pass a predicate, with its
 * balanced inner markup.
 *
 * The predicate receives the opening tag's raw attributes and its class list,
 * which is what both providers key their definitions off. Balancing tags (not
 * matching to the first close) is what lets a block containing its own nested
 * elements stay intact.
 * @param {string} html markup to scan.
 * @param {string} tag element name.
 * @param {(attrs: string, classes: string[]) => boolean} [predicate]
 * @returns {Array<{attrs: string, classes: string[], inner: string}>}
 */
function extractElements(html, tag, predicate) {
  const out = [];
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let match;
  while ((match = openRe.exec(html)) !== null) {
    const attrs = match[0];
    const classMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
    const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    if (predicate && !predicate(attrs, classes)) continue;
    const start = match.index + attrs.length;
    let depth = 1;
    const scan = new RegExp(`<(\\/?)${tag}\\b[^>]*>`, 'gi');
    scan.lastIndex = start;
    let step;
    while ((step = scan.exec(html)) !== null) {
      if (step[1] === '/') {
        depth -= 1;
        if (depth === 0) {
          out.push({ attrs, classes, inner: html.slice(start, step.index) });
          break;
        }
      } else {
        depth += 1;
      }
    }
  }
  return out;
}

/** Read one attribute from an opening tag. */
function attr(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match === null ? '' : decodeEntities(match[1]).trim();
}

/** Join a possibly relative URL onto its host. */
function joinUrl(base, path) {
  if (!path) return '';
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}

/** Text of the first element matching a predicate. */
function firstText(root, tag, predicate) {
  const element = extractElements(root, tag, predicate)[0];
  return element === undefined ? '' : plainText(element.inner);
}

/** Text of the first element with a class, trying the common container tags. */
function firstTextByClass(root, className) {
  for (const tag of ['div', 'span', 'p', 'li']) {
    const text = firstText(root, tag, (classes) => classes.includes(className));
    if (text.length > 0) return text;
  }
  return '';
}

/** Split a definition's leading part of speech from its body. */
function splitPos(text) {
  const match = text.match(/^([a-z]{1,4}\.)\s*(.*)$/i);
  return match === null ? { pos: '', text } : { pos: match[1], text: match[2].trim() };
}

/**
 * Close the gaps Bing leaves between CJK characters.
 *
 * Its example sentences split the Chinese translation into per-character
 * anchors, so every character comes back separated by a space. English spacing
 * is left alone: the anchors there carry the real word boundaries.
 */
function joinCjk(text) {
  return text.replace(/([一-鿿])\s+(?=[一-鿿，。！？；：、（）])/g, '$1');
}

/** Parse `dict.youdao.com/w/<word>` into the common shape. */
function parseYoudao(html) {
  const doc = stripScripts(html);
  const keyword = firstText(doc, 'span', (classes) => classes.includes('keyword'));
  const phonetics = [];
  for (const element of extractElements(doc, 'span', (classes) => classes.includes('pronounce'))) {
    const phonetic = extractElements(element.inner, 'span', (classes) => classes.includes('phonetic'))[0];
    const cut = element.inner.search(/<span\b/i);
    const label = plainText(cut >= 0 ? element.inner.slice(0, cut) : element.inner);
    const voice = extractElements(element.inner, 'a', (classes) => classes.includes('dictvoice'))[0];
    const rel = voice === undefined ? '' : attr(voice.attrs, 'data-rel');
    phonetics.push({
      label,
      text: phonetic === undefined ? '' : plainText(phonetic.inner),
      // `data-rel` is already "word&type=N"; the endpoint wants it as the
      // `audio` query parameter, not as a bare query string.
      audio: rel.length > 0 ? `https://dict.youdao.com/dictvoice?audio=${rel}` : '',
    });
  }
  const definitions = [];
  // The basic sense block is the first `trans-container` that actually lists
  // senses; later ones belong to the web-translation tab.
  const basic = extractElements(doc, 'div', (classes) => classes.includes('trans-container'))
    .find((element) => /<li\b/i.test(element.inner));
  if (basic !== undefined) {
    for (const item of extractElements(basic.inner, 'li', () => true)) {
      const text = plainText(item.inner);
      if (text.length > 0) definitions.push(splitPos(text));
    }
  }
  const forms = firstText(doc, 'p', (classes) => classes.includes('additional'));
  const collins = [];
  const collinsRoot = extractElements(doc, 'div', (attrs) => /id\s*=\s*"collinsResult"/i.test(attrs))[0];
  if (collinsRoot !== undefined) {
    for (const element of extractElements(collinsRoot.inner, 'div', (classes) => classes.includes('wt-container'))) {
      const title = firstTextByClass(element.inner, 'wt-title');
      const text = plainText(element.inner);
      if (title.length > 0 || text.length > 0) collins.push({ title, text });
    }
  }
  return { word: keyword, phonetics, definitions, forms, collins, examples: [], translation: '' };
}

/** Parse `cn.bing.com/dict/clientsearch` into the common shape. */
function parseBing(html) {
  const doc = stripScripts(html);
  const word = firstText(doc, 'div', (classes) => classes.includes('client_def_hd_hd'));
  const phonetics = [];
  for (const list of extractElements(doc, 'div', (classes) => classes.includes('client_def_hd_pn_list'))) {
    const head = extractElements(list.inner, 'div', (classes) => classes.includes('client_def_hd_pn'))[0];
    if (head === undefined) continue;
    const raw = plainText(head.inner);
    const at = raw.search(/[:：]/);
    const label = at >= 0 ? raw.slice(0, at).trim() : '';
    const text = at >= 0 ? raw.slice(at + 1).trim() : raw;
    const audio = extractElements(list.inner, 'div', (classes) => classes.includes('client_aud_o'))[0];
    const rel = audio === undefined ? '' : attr(audio.attrs, 'data-pronunciation');
    phonetics.push({
      label,
      text,
      audio: rel.length > 0 ? joinUrl('https://cn.bing.com', rel) : '',
    });
  }
  const definitions = [];
  // The basic senses live inside `client_def_container`; the same class names
  // also appear in the detailed and English-English sections further down, so
  // scoping there keeps the popup to the section a learner reads first.
  const defContainer = extractElements(doc, 'div', (attrs) => /id\s*=\s*"client_def_container"/i.test(attrs))[0];
  const defScope = defContainer === undefined ? doc : defContainer.inner;
  for (const bar of extractElements(defScope, 'div', (classes) => classes.includes('client_def_bar'))) {
    const pos = firstTextByClass(bar.inner, 'client_def_title_bar');
    const text = firstTextByClass(bar.inner, 'client_def_list');
    if (pos.length > 0 || text.length > 0) definitions.push({ pos, text });
  }
  const examples = [];
  // Example sentences sit in `sentenceSeg`, one row per sentence.
  const sentenceRoot = extractElements(doc, 'div', (attrs) => /id\s*=\s*"sentenceSeg"/i.test(attrs))[0];
  if (sentenceRoot !== undefined) {
    for (const row of extractElements(sentenceRoot.inner, 'div', (classes) => classes.includes('client_sentence_list1'))) {
      const english = firstTextByClass(row.inner, 'client_sen_en');
      const chinese = firstTextByClass(row.inner, 'client_sen_cn');
      if (english.length > 0) examples.push({ en: english, zh: joinCjk(chinese) });
      if (examples.length >= 5) break;
    }
  }
  const translation = extractElements(doc, 'div', (classes) => classes.includes('client_trans_head'))
    .map((element) => firstTextByClass(element.inner, 'client_sen_cn'))
    .find((value) => value.length > 0) ?? '';
  return { word, phonetics, definitions, forms: '', collins: [], examples, translation };
}

/** Turn a provider-specific parse into the shape the UI renders. */
function normalize(parsed, provider, requested) {
  const phonetics = (parsed.phonetics ?? []).filter((item) => item.text.length > 0 || item.audio.length > 0);
  const definitions = (parsed.definitions ?? []).filter((item) => item.text.length > 0);
  const collins = (parsed.collins ?? []).filter((item) => item.text.length > 0);
  const examples = (parsed.examples ?? []).filter((item) => item.en.length > 0);
  const hasLexicon = provider === 'youdao'
    ? parsed.word.length > 0 && (definitions.length > 0 || phonetics.length > 0 || collins.length > 0)
    : parsed.word.length > 0 && (definitions.length > 0 || phonetics.length > 0);
  if (!hasLexicon && parsed.translation.length === 0) return null;
  return {
    word: parsed.word.length > 0 ? parsed.word : requested,
    provider,
    phonetics,
    definitions,
    examples,
    forms: parsed.forms ?? '',
    collins,
    translation: parsed.translation ?? '',
  };
}

/**
 * Look one word up on a provider's web dictionary.
 * @param {string} word the word to look up.
 * @param {'youdao'|'bing'} provider the provider id.
 * @param {{fetchText: Function, signal?: AbortSignal, web?: object}} deps
 *   the shared fetcher and its options, so the caller keeps one network path.
 * @returns {Promise<object>} the normalised entry.
 */
export async function lookupDictionary(word, provider, deps) {
  const entry = DICTIONARY_PROVIDERS[provider];
  if (entry === undefined) {
    throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'Unknown dictionary provider.');
  }
  const html = await deps.fetchText(entry.url(word), deps.signal, 6 * 1024 * 1024, deps.web);
  let parsed;
  try {
    parsed = provider === 'youdao' ? parseYoudao(html) : parseBing(html);
  } catch {
    throw new ReaderError(ERROR_CODES.DICTIONARY_PARSE_FAILED, 'The dictionary page could not be read.');
  }
  const result = normalize(parsed, provider, word);
  if (result === null) {
    throw new ReaderError(ERROR_CODES.DICTIONARY_NOT_FOUND, `No dictionary entry for "${word}".`);
  }
  return result;
}
