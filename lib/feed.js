/**
 * Feed parsing without dependencies.
 *
 * Two dialects cover every source in the registry: RSS 2.0 and Atom. The
 * parser is deliberately tolerant — feeds in the wild carry raw `&amp;`,
 * CDATA sections, and elements in any order — but it never invents items it
 * cannot resolve to a link.
 */

/** Decode the entities feeds actually use, including numeric forms. */
export function decodeXmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return named[body] ?? match;
  });
}

/** Read the text of the first matching element, unwrapping CDATA. */
function pick(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (match === null) return '';
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeXmlEntities(cdata ? cdata[1] : raw).trim();
}

/** Read an attribute from the first matching element. */
function pickAttr(block, tag, attribute) {
  const match = block.match(new RegExp(`<${tag}[^>]*\\b${attribute}=["']([^"']*)["'][^>]*>`, 'i'));
  return match === null ? '' : decodeXmlEntities(match[1]).trim();
}

/** Strip markup from a description so snippets are plain text. */
export function stripHtml(html) {
  return decodeXmlEntities(String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    // A tag between a word and its punctuation must not become a space.
    .replace(/\s+([.,;:!?)\]])/g, '$1')
    .replace(/([([\{])\s+/g, '$1'))
    .trim();
}

/** Normalize a date into an ISO string, or null. */
function normalizeDate(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Split a feed into its item blocks. */
function itemBlocks(xml, tag) {
  const out = [];
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match;
  while ((match = pattern.exec(xml)) !== null) out.push(match[1]);
  return out;
}

/**
 * Parse an RSS 2.0 or Atom document into candidate items.
 * @param {string} xml feed body.
 * @returns {Array<{title: string, url: string, publishedAt: string|null, summary: string, author: string}>} items.
 */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  if (text.length === 0) return [];
  const isAtom = /<feed[\s>]/i.test(text.slice(0, 2000)) && /<entry[\s>]/i.test(text);
  const blocks = itemBlocks(text, isAtom ? 'entry' : 'item');
  const items = [];
  for (const block of blocks) {
    const title = pick(block, 'title');
    let url = '';
    if (isAtom) {
      // Prefer the alternate link; fall back to the first href.
      const alternates = [...block.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
      const chosen = alternates.find((tag) => /rel=["']alternate["']/i.test(tag)) ?? alternates[0] ?? '';
      url = (chosen.match(/href=["']([^"']*)["']/i)?.[1] ?? '').trim();
      if (url.length === 0) url = pick(block, 'id');
    } else {
      url = pick(block, 'link');
      if (url.length === 0) url = pickAttr(block, 'guid', 'isPermaLink') ? pick(block, 'guid') : '';
    }
    if (url.length === 0) continue;
    const summary = stripHtml(pick(block, 'description') || pick(block, 'summary') || pick(block, 'content'));
    items.push({
      title: title || url,
      url: decodeXmlEntities(url),
      publishedAt: normalizeDate(pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated')),
      summary: summary.slice(0, 400),
      author: pick(block, 'dc:creator') || pick(block, 'author') || '',
    });
  }
  return items;
}

/**
 * Extract link candidates from a listing page for sources without a feed.
 *
 * Publishers differ, so the rule is deliberately generic: take anchors whose
 * text reads like a headline (8+ words-worth of characters, no navigation
 * words), resolve them against the listing, and drop same-site index pages.
 * A source needing more precision supplies its own strategy later.
 * @param {string} html listing page.
 * @param {string} baseUrl URL the links are relative to.
 * @returns {Array<{title: string, url: string, publishedAt: null, summary: string, author: ''}>} candidates.
 */
export function scrapeLinks(html, baseUrl, minTitle = 25) {
  const out = [];
  const seen = new Set();
  const NAVIGATION = /^(home|about|contact|login|sign ?in|subscribe|privacy|terms|menu|search|archive|more|next|previous)$/i;
  const anchors = String(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of anchors) {
    const href = match[1].trim();
    const label = stripHtml(match[2]);
    if (label.length < minTitle || label.length > 160 || NAVIGATION.test(label)) continue;
    // Navigation copy is a sentence fragment, not a headline: drop labels that
    // end like a menu item or read like a call to action.
    if (/^(read more|learn more|see all|view all|show more|more stories|all articles|next page)$/i.test(label)) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url)) continue;
    // Index, tag and author pages are never the article itself.
    if (/\/(tag|tags|category|categories|author|authors|page|search)\//i.test(url)) continue;
    const key = url.replace(/[#?].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: label, url, publishedAt: null, summary: '', author: '' });
  }
  return out;
}
