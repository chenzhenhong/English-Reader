/**
 * Source strategies.
 *
 * Every publisher differs in three places: where articles can be listed, what
 * the article page looks like, and what level signal the site itself exposes.
 * One `SourceStrategy` shape describes all three, so adding a source is a
 * registry entry rather than a change to the discovery pipeline.
 *
 * `Kind` names the discovery mechanism, not the publisher:
 * - `feed`    — an RSS/Atom feed lists recent items.
 * - `html`    — a listing page is scraped for links.
 * - `catalog` — a browsable catalog (Project Gutenberg) rather than dated news.
 *
 * Strategies return *candidates*; fetching the body stays with the shared
 * fetcher, which keeps SSRF, size and timeout rules in one place.
 */

/** Article types the collection profile can request. */
export const ARTICLE_TYPES = Object.freeze([
  'news', 'analysis', 'explainer', 'research_news', 'opinion', 'criticism',
  'essay', 'feature', 'literature', 'graded_news', 'tutorial', 'reference',
]);

/** CEFR levels in order, used by range checks and defaults. */
export const CEFR_LEVELS = Object.freeze(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

/** Publication windows offered by the profile form. */
export const PUBLISHED_WINDOWS = Object.freeze([
  { id: '24h', days: 1 },
  { id: '7d', days: 7 },
  { id: '30d', days: 30 },
  { id: 'custom', days: null },
]);

/**
 * The 21 sources the collection profile offers, with the level and type each
 * publisher is known for.
 *
 * `levelHint` is the publisher's own difficulty signal: graded-news sites
 * publish explicit levels, general outlets do not. It seeds the estimate and
 * is never presented as a verified level.
 */
export const SOURCE_REGISTRY = Object.freeze([
  {
    id: 'news-in-levels', name: 'News in Levels', domains: ['newsinlevels.com'],
    kind: 'feed', feedUrl: 'https://www.newsinlevels.com/feed/',
    levelHint: { scheme: 'nil', min: 'A2', max: 'B1' },
    articleTypes: ['graded_news', 'news'], languages: ['en'], paywalled: false,
    note: 'Three graded levels; the page states the level and repeats the story at each.',
  },
  {
    id: 'breaking-news-english', name: 'Breaking News English', domains: ['breakingnewsenglish.com'],
    kind: 'feed', feedUrl: 'https://breakingnewsenglish.com/rss.xml',
    levelHint: { scheme: 'bne', min: 'A2', max: 'B1' },
    articleTypes: ['graded_news', 'news', 'tutorial'], languages: ['en'], paywalled: false,
    note: 'Lesson pages carry several graded versions of one story.',
  },
  {
    id: 'english-newsroom', name: 'English Newsroom', domains: ['englishnewsroom.com'],
    kind: 'feed', feedUrl: 'https://englishnewsroom.com/rss.xml',
    levelHint: { scheme: 'graded', min: 'A2', max: 'B1' },
    articleTypes: ['graded_news', 'news'], languages: ['en'], paywalled: false,
  },
  {
    id: 'news-for-kids', name: 'NewsForKids.net', domains: ['newsforkids.net'],
    kind: 'feed', feedUrl: 'https://newsforkids.net/feed/',
    levelHint: { scheme: 'kids', min: 'A2', max: 'B1' },
    articleTypes: ['graded_news', 'news', 'explainer'], languages: ['en'], paywalled: false,
  },
  {
    id: 'engoo-daily-news', name: 'Engoo Daily News', domains: ['engoo.com'],
    kind: 'html', feedUrl: null, listingUrl: 'https://engoo.com/app/daily-news',
    levelHint: { scheme: 'graded', min: 'A2', max: 'C1' },
    articleTypes: ['graded_news', 'news', 'tutorial'], languages: ['en'], paywalled: true,
    note: 'Requires an account for full lessons; only public previews are fetchable.',
  },
  {
    id: 'bbc-learning-english', name: 'BBC Learning English', domains: ['bbc.co.uk', 'bbc.com'],
    kind: 'html', feedUrl: null,
    listingUrl: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english',
    levelHint: { scheme: 'graded', min: 'B1', max: 'B2' },
    articleTypes: ['graded_news', 'tutorial', 'explainer'], languages: ['en'], paywalled: false,
  },
  {
    id: 'cnn-10', name: 'CNN 10', domains: ['cnn.com'],
    kind: 'html', feedUrl: null, listingUrl: 'https://www.cnn.com/cnn10',
    levelHint: { scheme: 'graded', min: 'B1', max: 'B2' },
    articleTypes: ['graded_news', 'news', 'explainer'], languages: ['en'], paywalled: false,
  },
  {
    id: 'ap-news', name: 'AP News', domains: ['apnews.com'],
    kind: 'feed', feedUrl: 'https://apnews.com/hub/ap-top-news',
    levelHint: { scheme: 'news', min: 'B2', max: 'C1' },
    articleTypes: ['news', 'explainer'], languages: ['en'], paywalled: false,
  },
  {
    id: 'bbc-news', name: 'BBC News', domains: ['bbc.com', 'bbc.co.uk'],
    kind: 'feed', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml',
    levelHint: { scheme: 'news', min: 'B2', max: 'C1' },
    articleTypes: ['news', 'analysis', 'explainer', 'feature'], languages: ['en'], paywalled: false,
  },
  {
    id: 'the-guardian', name: 'The Guardian', domains: ['theguardian.com'],
    kind: 'feed', feedUrl: 'https://www.theguardian.com/international/rss',
    levelHint: { scheme: 'news', min: 'B2', max: 'C1' },
    articleTypes: ['news', 'analysis', 'opinion', 'feature', 'criticism'], languages: ['en'], paywalled: false,
  },
  {
    id: 'npr', name: 'NPR', domains: ['npr.org'],
    kind: 'feed', feedUrl: 'https://feeds.npr.org/1001/rss.xml',
    levelHint: { scheme: 'news', min: 'B2', max: 'C1' },
    articleTypes: ['news', 'analysis', 'feature'], languages: ['en'], paywalled: false,
  },
  {
    id: 'new-scientist', name: 'New Scientist', domains: ['newscientist.com'],
    kind: 'feed', feedUrl: 'https://www.newscientist.com/feed/home/',
    levelHint: { scheme: 'science', min: 'C1', max: 'C2' },
    articleTypes: ['news', 'feature', 'explainer', 'research_news'], languages: ['en'], paywalled: true,
  },
  {
    id: 'science-alert', name: 'ScienceAlert', domains: ['sciencealert.com'],
    kind: 'feed', feedUrl: 'https://www.sciencealert.com/rss',
    levelHint: { scheme: 'science', min: 'B2', max: 'C1' },
    articleTypes: ['explainer', 'research_news', 'feature'], languages: ['en'], paywalled: false,
  },
  {
    id: 'the-conversation', name: 'The Conversation', domains: ['theconversation.com'],
    kind: 'feed', feedUrl: 'https://theconversation.com/us/articles.atom',
    levelHint: { scheme: 'analysis', min: 'C1', max: 'C2' },
    articleTypes: ['analysis', 'explainer', 'opinion'], languages: ['en'], paywalled: false,
  },
  {
    id: 'longreads', name: 'Longreads', domains: ['longreads.com'],
    kind: 'feed', feedUrl: 'https://longreads.com/feed/',
    levelHint: { scheme: 'essay', min: 'C1', max: 'C2' },
    articleTypes: ['feature', 'essay', 'criticism'], languages: ['en'], paywalled: false,
  },
  {
    id: 'aeon', name: 'Aeon Essays', domains: ['aeon.co'],
    kind: 'feed', feedUrl: 'https://aeon.co/feed.rss',
    levelHint: { scheme: 'essay', min: 'C1', max: 'C2' },
    articleTypes: ['essay', 'analysis', 'opinion'], languages: ['en'], paywalled: false,
  },
  {
    id: 'arts-letters-daily', name: 'Arts & Letters Daily', domains: ['artsandlettersdaily.com', 'aldaily.com'],
    kind: 'html', feedUrl: null, listingUrl: 'https://www.artsandlettersdaily.com/',
    levelHint: { scheme: 'essay', min: 'C1', max: 'C2' },
    articleTypes: ['essay', 'criticism', 'reference'], languages: ['en'], paywalled: false,
    note: 'A curated index: links point at other publications, so the origin is followed.',
  },
  {
    id: 'project-gutenberg', name: 'Project Gutenberg', domains: ['gutenberg.org'],
    kind: 'catalog', feedUrl: null, listingUrl: 'https://www.gutenberg.org/ebooks/search/?sort_order=downloads',
    levelHint: { scheme: 'literature', min: 'C1', max: 'C2' },
    articleTypes: ['literature', 'reference'], languages: ['en'], paywalled: false,
    note: 'Public-domain books, not dated news; date filters do not apply.',
  },
  {
    id: 'science-daily', name: 'ScienceDaily', domains: ['sciencedaily.com'],
    kind: 'feed', feedUrl: 'https://www.sciencedaily.com/rss/all.xml',
    levelHint: { scheme: 'science', min: 'B2', max: 'C1' },
    articleTypes: ['research_news', 'explainer', 'news'], languages: ['en'], paywalled: false,
  },
  {
    id: 'nature-news', name: 'Nature News', domains: ['nature.com'],
    kind: 'feed', feedUrl: 'https://www.nature.com/nature.rss',
    levelHint: { scheme: 'science', min: 'C1', max: 'C2' },
    articleTypes: ['research_news', 'news', 'analysis'], languages: ['en'], paywalled: true,
  },
  {
    id: 'mit-technology-review', name: 'MIT Technology Review', domains: ['technologyreview.com'],
    kind: 'feed', feedUrl: 'https://www.technologyreview.com/feed/',
    levelHint: { scheme: 'science', min: 'C1', max: 'C2' },
    articleTypes: ['analysis', 'feature', 'explainer', 'research_news'], languages: ['en'], paywalled: true,
  },
]);

/** Choose one CEFR level a publisher's band maps to for a requested range. */
function bandFor(band, requested) {
  if (band === undefined || band === null) return null;
  const lowIndex = CEFR_LEVELS.indexOf(band.min);
  const highIndex = CEFR_LEVELS.indexOf(band.max);
  if (Array.isArray(requested) && requested.length === 2) {
    const wantedLow = CEFR_LEVELS.indexOf(requested[0]);
    const wantedHigh = CEFR_LEVELS.indexOf(requested[1]);
    const overlapLow = Math.max(wantedLow, lowIndex < 0 ? 0 : lowIndex);
    const overlapHigh = Math.min(wantedHigh, highIndex < 0 ? CEFR_LEVELS.length - 1 : highIndex);
    if (overlapLow <= overlapHigh) return CEFR_LEVELS[overlapLow] ?? null;
  }
  if (lowIndex < 0) return band.max ?? null;
  if (highIndex < 0) return band.min ?? null;
  return CEFR_LEVELS[Math.round((lowIndex + highIndex) / 2)] ?? null;
}

/** Lookup by registry id. */
export function findSource(id) {
  return SOURCE_REGISTRY.find((source) => source.id === id);
}

/** Resolve the registry entry that owns a URL, by hostname. */
export function sourceForUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
  return SOURCE_REGISTRY.find((source) => source.domains.some((domain) => (
    host === domain || host.endsWith(`.${domain}`)
  )));
}

/**
 * A strategy is data plus three optional behaviours. Defaults keep a simple
 * feed-only source to a registry entry alone.
 *
 * Behaviours, all optional:
 * - `list(context)`   → extra candidate items, or a replacement listing.
 * - `extract(html, url, context)` → `{ title, text, cefrLevel }` overrides.
 * - `classify(item)`  → `{ articleType, level }` hints for one candidate.
 * - `accepts(item, profile)` → false to drop a candidate before scoring.
 */

/** Publisher-specific extraction for pages whose boilerplate is known. */
const EXTRACTORS = {
  /** News in Levels repeats a story at three levels; keep the requested one. */
  'news-in-levels': (html, url, context) => {
    const levelFromUrl = url.match(/level-(\d)/i)?.[1];
    const wanted = Array.isArray(context?.levels) && context.levels.length > 0
      ? context.levels[0]
      : (levelFromUrl === '1' ? 'A2' : levelFromUrl === '2' ? 'B1' : 'B2');
    return { levelHint: wanted };
  },
  /** Project Gutenberg wraps the book in license boilerplate. */
  'project-gutenberg': (html) => ({
    // The plain-text editions carry the boilerplate markers; the HTML reader
    // view does not, so only trim when the markers exist.
    trimStart: /START OF (THE|THIS) PROJECT GUTENBERG EBOOK/i,
    trimEnd: /END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i,
  }),
  /** The Conversation marks its articles with a level-free but clean body. */
  'the-conversation': () => ({ stripSelectors: ['.article-top-tags', '.read-more'] }),
};

/**
 * Build the strategy table at runtime.
 *
 * Each entry wraps the registry row and adds the behaviours above, so adding a
 * source means appending to `SOURCE_REGISTRY` (and optionally an extractor),
 * never editing the discovery pipeline.
 * @param {object} deps shared services the strategies may call.
 * @returns {Map<string, object>} id → strategy.
 */
export function buildStrategies(deps) {
  const strategies = new Map();
  for (const source of SOURCE_REGISTRY) {
    const extractor = EXTRACTORS[source.id];
    strategies.set(source.id, {
      ...source,
      /**
       * Enumerate candidates for this source.
       * Feed sources parse the feed; HTML sources scrape links; catalogs read
       * the listing page.
       */
      async list(context) {
        if (source.kind === 'feed' && source.feedUrl) {
          const body = await deps.fetchText(source.feedUrl, context.signal);
          const items = deps.parseFeed(body);
          return items.map((item) => ({ ...item, sourceId: source.id, sourceName: source.name }));
        }
        const page = await deps.fetchText(source.listingUrl, context.signal);
        const minTitle = source.kind === 'catalog' ? 20 : 30;
        return deps.scrapeLinks(page, source.listingUrl, minTitle)
          .slice(0, (context.limit ?? 10) * 2)
          .map((item) => ({ ...item, sourceId: source.id, sourceName: source.name }));
      },
      /** Publisher-specific post-processing after the shared extractor. */
      extract(html, url, context) {
        return extractor ? extractor(html, url, context) : {};
      },
      /** Default classification: the publisher's own level band and types. */
      classify(item, profile) {
        const type = source.articleTypes[0] ?? 'news';
        // `cefrLevel` is one level from the publisher's band, chosen against
        // the requested range; the band itself travels as `levelBand`. Binding
        // the band object into a column would fail in SQLite.
        return {
          articleType: type,
          cefrLevel: bandFor(source.levelHint, profile?.levelRange),
          levelBand: source.levelHint ?? null,
        };
      },
      /** Reject candidates the profile cannot use. */
      accepts(item, profile) {
        if (profile.types?.length > 0 && !source.articleTypes.some((type) => profile.types.includes(type))) {
          // A source whose declared types are all deselected contributes nothing.
          return false;
        }
        if (profile.levelRange && source.levelHint) {
          const min = CEFR_LEVELS.indexOf(profile.levelRange[0]);
          const max = CEFR_LEVELS.indexOf(profile.levelRange[1]);
          const low = CEFR_LEVELS.indexOf(source.levelHint.min);
          const high = CEFR_LEVELS.indexOf(source.levelHint.max);
          // Overlap test: a band entirely outside the wanted range is dropped.
          if (high < min || low > max) return false;
        }
        return true;
      },
    });
  }
  return strategies;
}
