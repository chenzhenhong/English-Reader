/**
 * Domain repositories and the application facade.
 *
 * The facade is the one boundary the UI (through the Host RPC) and the agent
 * tools both call, so view interactions and tool actions never fork business
 * logic. Every method returns JSON-safe data and throws `ReaderError` with a
 * stable code on failure.
 */
import {
  openStore, now, sha256, normalizeKey, newId, readArticleBody, writeArticleBody,
  removeArticleBody, diskUsage, ARTICLE_STATUS, STAGES,
} from './store.js';
import {
  extractReadable, segmentArticle, countWords, readingMinutes, rankCandidates,
  heuristicLevel, tokenize, truncateToWords,
} from './text.js';
import { ReaderError, ERROR_CODES, canonicalUrl, fetchArticle, fetchText, searchWeb } from './net.js';
import { parseFeed, scrapeLinks, stripHtml } from './feed.js';
import { cleanArticle } from './clean.js';
import { SOURCE_REGISTRY, ARTICLE_TYPES, CEFR_LEVELS, PUBLISHED_WINDOWS, buildStrategies, findSource, sourceForUrl } from './sources.js';
import { analyzeStage, analyzeSentence, findQuote } from './llm.js';
import { createSpeech, SpeechError, VOICES } from './speech.js';

/** Default collection profile, ready on first run. */
/**
 * The collection profile the design specifies.
 *
 * Sources are stored by registry id so renaming a publisher or adding a mirror
 * domain never invalidates saved profiles. `levelRange` is the inclusive CEFR
 * band; `publishedWithinDays` maps onto the 24h/7d/30d/custom control;
 * `filterSensitive` is the single-choice content filter (on by default).
 */
const DEFAULT_PROFILE = {
  name: 'B1–B2 分级阅读',
  levelRange: ['B1', 'B2'],
  sourceIds: SOURCE_REGISTRY.map((source) => source.id),
  publishedWithinDays: 7,
  publishedWindow: '7d',
  types: [...ARTICLE_TYPES],
  filterSensitive: true,
  // How many articles one discovery run keeps. Default 1: the user asked to
  // collect one article, not to browse a feed.
  articleCount: 1,
  // `unlimited` (default) ignores length entirely. `range` enforces min/max, and
  // only then does `truncate` decide whether long articles are cut or skipped.
  wordLimitMode: 'unlimited',
  minWords: 800,
  maxWords: 1500,
  // On by default: inside a range, cutting an over-long article is friendlier
  // than silently skipping it.
  truncate: true,
  targetVocabularyCount: 15,
  keywords: [],
  excludedKeywords: [],
  topics: [],
  preferRecent: true,
  avoidHighlyTechnical: true,
};

/** Normalize a saved profile: tolerate the pre-registry shape too. */
function normalizeProfile(profile) {
  const sourceIds = Array.isArray(profile?.sourceIds)
    ? profile.sourceIds.filter((id) => findSource(id) !== undefined)
    : SOURCE_REGISTRY
      .filter((source) => (profile?.sources ?? []).some((item) => item.enabled !== false && (
        source.domains.includes(String(item.domain ?? '').replace(/^www\./, ''))
        || source.name === item.name
      )))
      .map((source) => source.id);
  const levelRange = Array.isArray(profile?.levelRange) && profile.levelRange.length === 2
    ? profile.levelRange
    : [profile?.cefrLevels?.[0] ?? 'B1', profile?.cefrLevels?.slice(-1)[0] ?? 'B2'];
  const ordered = [...levelRange].sort((a, b) => CEFR_LEVELS.indexOf(a) - CEFR_LEVELS.indexOf(b));
  return {
    ...profile,
    levelRange: [ordered[0] ?? 'B1', ordered[1] ?? 'B2'],
    sourceIds: sourceIds.length > 0 ? sourceIds : SOURCE_REGISTRY.map((source) => source.id),
    types: Array.isArray(profile?.types) && profile.types.length > 0 ? profile.types : [...ARTICLE_TYPES],
    filterSensitive: profile?.filterSensitive !== false,
    publishedWithinDays: Number(profile?.publishedWithinDays) > 0 ? Number(profile.publishedWithinDays) : 7,
    // Keep the window id consistent with the days it came from.
    publishedWindow: ['24h', '7d', '30d', 'custom'].includes(profile?.publishedWindow)
      ? profile.publishedWindow
      : (Number(profile?.publishedWithinDays) === 1 ? '24h'
        : Number(profile?.publishedWithinDays) === 30 ? '30d'
          : '7d'),
    wordLimitMode: profile?.wordLimitMode === 'range' ? 'range' : 'unlimited',
    minWords: Number(profile?.minWords) > 0 ? Number(profile.minWords) : 800,
    maxWords: Number(profile?.maxWords) > 0 ? Number(profile.maxWords) : 1500,
    // Truncation is only meaningful inside a range, and defaults to on there.
    truncate: profile?.wordLimitMode === 'range'
      ? (profile?.truncate === undefined || profile?.truncate === null ? true : profile.truncate === true)
      : false,
    // `Number(null)` and `Number('')` are both 0, so an absent field must be
    // tested for presence before any numeric coercion.
    articleCount: (() => {
      const raw = profile?.articleCount;
      if (raw === undefined || raw === null || raw === '') return 1;
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? Math.max(1, Math.min(20, Math.round(numeric))) : 1;
    })(),
  };
}

/** Parse a JSON column tolerantly. */
function json(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Run a synchronous DB write inside one transaction. */
function transact(db, fn) {
  db.exec('BEGIN');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction already ended */
    }
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(ERROR_CODES.DATABASE_ERROR, `Database write failed: ${error.message}`);
  }
}

/** Map an article row to its API shape. */
function articleRow(row, extra = {}) {
  return {
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    author: row.author,
    publishedAt: row.published_at,
    topic: row.topic,
    cefrLevel: row.cefr_level,
    wordCount: row.word_count,
    readingMinutes: row.reading_minutes,
    status: row.status,
    readingStatus: row.reading_status,
    demo: row.demo === 1,
    thumbnail: row.thumbnail,
    snippet: row.snippet,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

/**
 * Build the English Reader facade over an opened store.
 * @param {object} options {dataDir, llm, defaultModel, web, config, logger}.
 * @returns {object} the facade consumed by RPC handlers and agent tools.
 */
export function createFacade(options) {
  const { db, dirs } = openStore(options.dataDir);
  const config = {
    sentenceConcurrency: 2,
    retryLimit: 2,
    wordsPerArticle: 15,
    ...(options.config ?? {}),
  };
  const logger = options.logger ?? { warn() {}, info() {} };
  const speech = createSpeech(dirs.root);
  /** Abort controllers for in-flight analysis runs, keyed by analysis id. */
  const running = new Map();
  /** Serialized analysis queue so two runs never fight over one article. */
  const queue = new Map();

  // ---------------------------------------------------------------- articles

  /** Look up one article row or throw a coded error. */
  function requireArticle(articleId) {
    const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
    if (row === undefined) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'That article no longer exists.');
    return row;
  }

  /** Find an existing article by URL or content hash. */
  function findDuplicate(url, hash) {
    if (url) {
      const byUrl = db.prepare('SELECT article_id AS id FROM article_sources WHERE source_url = ?').get(canonicalUrl(url));
      if (byUrl !== undefined) return byUrl.id;
    }
    if (hash) {
      const byHash = db.prepare('SELECT id FROM articles WHERE content_hash = ?').get(hash);
      if (byHash !== undefined) return byHash.id;
    }
    return undefined;
  }

  /** Insert one article body and metadata row inside one transaction. */
  function insertArticle(input) {
    return transact(db, () => {
      const id = newId('art');
      const hash = sha256(input.text);
      const contentPath = writeArticleBody(dirs, id, input.text, input.rawHtml);
      const words = input.wordCount ?? countWords(input.text);
      db.prepare(`INSERT INTO articles (id, title, source_name, author, source_url, published_at, language, topic,
        cefr_level, word_count, reading_minutes, content_hash, content_path, thumbnail, snippet, status, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'en', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.title, input.sourceName ?? null, input.author ?? null, input.sourceUrl ?? null,
        input.publishedAt ?? null, input.topic ?? null, input.cefrLevel ?? null, words,
        readingMinutes(words), hash, contentPath, input.thumbnail ?? null,
        input.snippet ?? input.text.slice(0, 180), input.status ?? ARTICLE_STATUS.FETCHED, input.demo ? 1 : 0,
        now(), now(),
      );
      if (input.sourceUrl) {
        db.prepare('INSERT OR IGNORE INTO article_sources (id, article_id, source_url, source_name, fetched_at) VALUES (?, ?, ?, ?, ?)').run(
          newId('src'), id, canonicalUrl(input.sourceUrl), input.sourceName ?? null, now(),
        );
      }
      return { id, hash, words, title: input.title };
    });
  }

  /** List articles with filters, newest first. */
  function listArticles(query = {}) {
    const clauses = [];
    const params = [];
    if (query.demoOnly) clauses.push('demo = 1');
    if (query.search) {
      clauses.push('(title LIKE ? OR snippet LIKE ? OR source_name LIKE ?)');
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }
    if (query.cefrLevel) {
      clauses.push('cefr_level = ?');
      params.push(query.cefrLevel);
    }
    if (query.sourceName) {
      clauses.push('source_name = ?');
      params.push(query.sourceName);
    }
    if (query.readingStatus) {
      clauses.push('reading_status = ?');
      params.push(query.readingStatus);
    }
    if (query.analysisStatus) {
      clauses.push('status = ?');
      params.push(query.analysisStatus);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM articles ${where}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM articles ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const sources = db.prepare('SELECT DISTINCT source_name FROM articles WHERE source_name IS NOT NULL').all().map((row) => row.source_name);
    return { items: rows.map((row) => articleRow(row)), total, sources };
  }

  /** Full article detail consumed by every reading surface. */
  // ------------------------------------------------------- plugin settings

  /** Read one plugin setting from `app_settings`. */
  function pluginSetting(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`plugin.${key}`);
    return row === undefined ? undefined : json(row.value, undefined);
  }

  /** Write one plugin setting. */
  function setPluginSetting(key, value) {
    transact(db, () => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
      .run(`plugin.${key}`, JSON.stringify(value)));
  }

  /**
   * Save the user's model override and tuning.
   *
   * `modelOverride: null` means "follow the session default". The model pair is
   * validated against the Harness model list so a stale pick cannot be stored.
   */
  async function savePluginSettings(input) {
    const tuning = input.tuning ?? {};
    setPluginSetting('tuning', {
      sentenceConcurrency: tuning.sentenceConcurrency,
      retryLimit: tuning.retryLimit,
    });
    let override = null;
    if (input.modelOverride && input.modelOverride.provider && input.modelOverride.model) {
      const wanted = `${input.modelOverride.provider}:${input.modelOverride.model}`;
      const known = (await availableModelList()).some((row) => `${row.provider}:${row.model}` === wanted);
      override = known ? { provider: input.modelOverride.provider, model: input.modelOverride.model } : null;
      if (!known) return { saved: false, reason: 'unknown-model' };
    }
    setPluginSetting('modelOverride', override);
    return { saved: true, modelOverride: override, tuning: effectiveTuning() };
  }

  /**
   * Every provider/model pair the Harness currently exposes.
   *
   * The settings page groups these by provider itself: the browser half reads
   * the Harness model catalog — the same roster the shell's own model picker
   * shows — so this flat list is only the fallback for a shell without one.
   */
  async function availableModelList() {
    try {
      const providers = options.llm?.listProviders?.() ?? [];
      const rows = [];
      for (const provider of providers) {
        const id = provider.id ?? provider;
        const models = await options.llm.listModels?.(id) ?? [];
        for (const model of models) rows.push({ provider: id, model: model.id, label: model.name ?? model.id });
      }
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * The model the user picked in settings, or null to follow the session.
   * Stored as {provider, model}; validated on read so a stale provider cannot
   * be used after the model disappears from the Harness.
   */
  function modelOverride() {
    const stored = pluginSetting('modelOverride');
    if (stored === undefined || stored === null) return null;
    const provider = typeof stored.provider === 'string' ? stored.provider : '';
    const model = typeof stored.model === 'string' ? stored.model : '';
    return provider.length > 0 && model.length > 0 ? { provider, model } : null;
  }

  /** Effective concurrency / retry: user setting first, bundle config second. */
  function effectiveTuning() {
    const stored = pluginSetting('tuning') ?? {};
    const pick = (key, fallback, min, max) => {
      const raw = Number(stored[key] ?? fallback);
      return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.round(raw))) : fallback;
    };
    return {
      sentenceConcurrency: pick('sentenceConcurrency', config.sentenceConcurrency, 1, 5),
      retryLimit: pick('retryLimit', config.retryLimit, 1, 5),
    };
  }

  // ---------------------------------------------------------- study activity

  /**
   * Local calendar day for a Date, as YYYY-MM-DD.
   * The grid must match the learner's own days, so this uses local time rather
   * than UTC: at 07:00 in UTC+8 the UTC date is still yesterday.
   * @param {Date} [date] defaults to now.
   */
  function localDay(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Record one study interaction.
   * Silent on failure: a study log must never break reading.
   * @param {{kind: string, articleId?: string, entityType?: string, entityId?: string, seconds?: number}} event
   */
  function recordStudy(event) {
    try {
      const seconds = Math.max(0, Math.min(6 * 3600, Math.round(Number(event.seconds) || 0)));
      transact(db, () => {
        db.prepare(`INSERT INTO study_events (id, day, kind, article_id, entity_type, entity_id, seconds, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          newId('evt'), localDay(), event.kind,
          event.articleId ?? null, event.entityType ?? null, event.entityId ?? null,
          seconds, now(),
        );
      });
    } catch (error) {
      logger?.warn?.('study event not recorded', error?.message);
    }
  }

  /**
   * Study activity for the contribution grid.
   *
   * Returns one entry per day that has activity, plus the aggregates the header
   * needs. Days with no activity are omitted; the grid fills gaps itself so the
   * payload stays small.
   * @param {{days?: number}} [query] trailing window, default 364.
   */
  function studyActivity(query = {}) {
    const today = new Date();
    // An explicit range wins over a trailing window: the learner may want a
    // specific past interval, which "last N days" cannot express.
    const hasRange = typeof query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.from)
      && typeof query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.to);
    let startDay;
    let endDay;
    let window;
    if (hasRange && query.from <= query.to) {
      startDay = query.from;
      endDay = query.to;
      window = Math.round((new Date(`${endDay}T00:00:00`) - new Date(`${startDay}T00:00:00`)) / 86400000) + 1;
    } else {
      window = Math.max(7, Math.min(730, Number(query.days) || 364));
      const start = new Date(today);
      start.setDate(start.getDate() - (window - 1));
      startDay = localDay(start);
      endDay = localDay(today);
    }

    const rows = db.prepare(`SELECT day,
      COUNT(*) AS events,
      SUM(seconds) AS seconds,
      GROUP_CONCAT(DISTINCT kind) AS kinds
      FROM study_events WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(startDay, endDay);

    // Level buckets: quartiles of this learner's own busiest day, so the grid
    // stays readable whether they study 5 minutes or 5 hours a day.
    const peak = rows.reduce((max, row) => Math.max(max, Number(row.seconds) || 0), 0);
    const days = rows.map((row) => ({
      day: row.day,
      events: Number(row.events) || 0,
      seconds: Number(row.seconds) || 0,
      minutes: Math.round((Number(row.seconds) || 0) / 60),
      kinds: (row.kinds ?? '').split(',').filter(Boolean),
    }));

    const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
    const totalEvents = days.reduce((sum, day) => sum + day.events, 0);

    // Streaks are computed over the returned window, walking backwards from the
    // most recent active day (today or yesterday still counts as "current").
    const activeDays = new Set(days.map((day) => day.day));
    let current = 0;
    const cursor = new Date(today);
    if (!activeDays.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (activeDays.has(localDay(cursor))) {
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    let longest = 0;
    let run = 0;
    let previous = null;
    for (const day of days) {
      const date = new Date(`${day.day}T00:00:00`);
      if (previous !== null) {
        const gap = Math.round((date - previous) / 86400000);
        run = gap === 1 ? run + 1 : 1;
      } else {
        run = 1;
      }
      previous = date;
      longest = Math.max(longest, run);
    }

    // Per-article totals: the question the log must answer is not only "when did
    // I study" but "how long did each article take me".
    const byArticle = db.prepare(`SELECT e.article_id AS id, SUM(e.seconds) AS seconds,
      COUNT(*) AS events, MAX(e.day) AS lastDay, a.title, a.cefr_level AS cefrLevel
      FROM study_events e LEFT JOIN articles a ON a.id = e.article_id
      WHERE e.day >= ? AND e.article_id IS NOT NULL
      GROUP BY e.article_id ORDER BY seconds DESC`).all(startDay).map((row) => ({
      articleId: row.id,
      title: row.title ?? '(deleted article)',
      cefrLevel: row.cefrLevel ?? null,
      seconds: Number(row.seconds) || 0,
      minutes: Math.round((Number(row.seconds) || 0) / 60),
      events: Number(row.events) || 0,
      lastDay: row.lastDay,
    }));

    // Per-kind totals tell the learner what the time was spent on.
    const byKind = {};
    for (const row of db.prepare(`SELECT kind, COUNT(*) AS events, SUM(seconds) AS seconds
      FROM study_events WHERE day >= ? AND day <= ? GROUP BY kind ORDER BY seconds DESC`).all(startDay, endDay)) {
      byKind[row.kind] = { events: Number(row.events) || 0, seconds: Number(row.seconds) || 0 };
    }

    // The activity feed needs the raw rows (with article titles), but the grid
    // does not; keep the payload small unless the caller asks.
    //
    // `day` narrows the feed to one day (the heatmap click), and
    // `eventsLimit`/`eventsOffset` page it: the feed scrolls inside a fixed
    // height, so the next chunk is fetched as the reader reaches the bottom.
    const feedDay = typeof query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : null;
    const feedWhere = feedDay === null
      ? 'WHERE e.day >= ? AND e.day <= ?'
      : 'WHERE e.day = ?';
    const feedParams = feedDay === null ? [startDay, endDay] : [feedDay];
    const feedRows = query.includeEvents === true
      ? db.prepare(`SELECT e.day, e.kind, e.seconds, e.article_id AS articleId,
        COALESCE(a.title, '(deleted article)') AS title, a.cefr_level AS cefrLevel
        FROM study_events e LEFT JOIN articles a ON a.id = e.article_id
        ${feedWhere} ORDER BY e.day DESC, e.created_at DESC`).all(...feedParams)
      : [];
    const eventsLimit = Math.min(Math.max(Number(query.eventsLimit) || 40, 1), 200);
    const eventsOffset = Math.max(Number(query.eventsOffset) || 0, 0);
    const events = query.includeEvents === true
      ? feedRows.slice(eventsOffset, eventsOffset + eventsLimit).map((row) => ({
        day: row.day,
        kind: row.kind,
        seconds: Number(row.seconds) || 0,
        articleId: row.articleId,
        title: row.title,
        cefrLevel: row.cefrLevel,
      }))
      : undefined;
    const hasMore = query.includeEvents === true && eventsOffset + eventsLimit < feedRows.length;

    return {
      window,
      today: localDay(),
      startDay,
      endDay,
      peakSeconds: peak,
      ...(events === undefined ? {} : { events }),
      ...(events === undefined ? {} : { eventsHasMore: hasMore }),
      days,
      totals: {
        seconds: totalSeconds,
        minutes: Math.round(totalSeconds / 60),
        events: totalEvents,
        activeDays: days.length,
        currentStreak: current,
        longestStreak: longest,
      },
      byKind,
      byArticle,
    };
  }

  function getArticle(articleId) {
    const row = requireArticle(articleId);
    const body = readArticleBody(dirs, row);
    const segment = segmentArticle(body);
    const analysis = db.prepare('SELECT * FROM article_analyses WHERE article_id = ? ORDER BY version DESC LIMIT 1').get(articleId);
    const tasks = analysis
      ? db.prepare('SELECT * FROM analysis_tasks WHERE analysis_id = ?').all(analysis.id).map((task) => ({
        stage: task.stage, status: task.status, errorCode: task.error_code,
        errorMessage: task.error_message, retryCount: task.retry_count, updatedAt: task.updated_at,
        progress: json(task.output_json, null),
      }))
      : [];
    const sentences = db.prepare(`SELECT s.*, t.id AS sentence_id, t.content,
      k.favorite AS saved_favorite, k.mastery_level AS saved_mastery
      FROM article_sentences s
      JOIN sentences t ON t.id = s.sentence_id
      LEFT JOIN user_knowledge k ON k.entity_type = 'sentence' AND k.entity_id = t.id
      WHERE s.article_id = ? ORDER BY s.sentence_index`).all(articleId).map((item) => ({
      paragraphIndex: item.paragraph_index,
      sentenceIndex: item.sentence_index,
      // The knowledge row id, and whether the learner added it.
      id: item.sentence_id,
      inLibrary: item.saved_favorite !== null || item.saved_mastery !== null,
      startOffset: item.start_offset,
      endOffset: item.end_offset,
      text: item.content,
      analysis: json(item.analysis_json, null),
      analysisStatus: item.analysis_status,
      // Present only when the sentence failed, so the reader can explain it.
      error: item.analysis_status === 'failed'
        ? (item.error_code === null || item.error_code === undefined
          // Failures recorded before per-sentence diagnostics existed have no
          // code; say so rather than inventing a reason.
          ? {
            code: 'NO_RECORD',
            message: '这句在更早的版本中失败，没有记录原因。重试这一句可得到新的诊断。',
            raw: null,
            attempts: item.attempts ?? 1,
            legacy: true,
          }
          : {
            code: item.error_code,
            message: item.error_message ?? '没有记录更详细的原因。',
            raw: item.raw_output ? item.raw_output.slice(0, 900) : null,
            attempts: item.attempts ?? 1,
            legacy: false,
          })
        : null,
    }));
    const words = db.prepare(`SELECT v.*, w.context_meaning, w.occurrences, w.evidence_json,
      k.favorite, k.mastery_level, k.notes
      FROM article_words w JOIN vocabulary v ON v.id = w.vocabulary_id
      LEFT JOIN user_knowledge k ON k.entity_type = 'word' AND k.entity_id = v.id
      WHERE w.article_id = ? ORDER BY v.lemma COLLATE NOCASE`).all(articleId).map((item) => ({
      id: item.id,
      lemma: item.lemma,
      phonetic: item.phonetic,
      partOfSpeech: json(item.part_of_speech_json, []),
      meanings: json(item.meanings_json, []),
      contextMeaning: item.context_meaning,
      occurrences: item.occurrences,
      evidence: json(item.evidence_json, []),
      cefrLevel: item.cefr_level,
      wordFormation: json(item.word_formation_json, null),
      synonyms: json(item.synonyms_json, []),
      antonyms: json(item.antonyms_json, []),
      favorite: item.favorite === 1,
      masteryLevel: item.mastery_level ?? 0,
      notes: item.notes ?? '',
    }));
    const phrases = db.prepare(`SELECT p.*, l.evidence_json, k.favorite, k.mastery_level
      FROM article_phrases l JOIN phrases p ON p.id = l.phrase_id
      LEFT JOIN user_knowledge k ON k.entity_type = 'phrase' AND k.entity_id = p.id
      WHERE l.article_id = ?`).all(articleId).map((item) => ({
      id: item.id, expression: item.expression, phraseType: item.phrase_type, meaning: item.meaning,
      explanation: item.explanation, evidence: json(item.evidence_json, []),
      favorite: item.favorite === 1, masteryLevel: item.mastery_level ?? 0,
    }));
    const collocations = db.prepare(`SELECT c.*, l.evidence_json, k.favorite, k.mastery_level
      FROM article_collocations l JOIN collocations c ON c.id = l.collocation_id
      LEFT JOIN user_knowledge k ON k.entity_type = 'collocation' AND k.entity_id = c.id
      WHERE l.article_id = ?`).all(articleId).map((item) => ({
      id: item.id, expression: item.expression, pattern: item.pattern, meaning: item.meaning,
      explanation: item.explanation, evidence: json(item.evidence_json, []),
      favorite: item.favorite === 1, masteryLevel: item.mastery_level ?? 0,
    }));
    const progress = db.prepare('SELECT * FROM reading_progress WHERE article_id = ?').get(articleId);
    const notes = db.prepare('SELECT * FROM reading_notes WHERE article_id = ? ORDER BY created_at DESC').all(articleId)
      .map((item) => ({ id: item.id, sentenceIndex: item.sentence_index, body: item.body, createdAt: item.created_at }));
    return {
      article: articleRow(row),
      body: segment.text,
      paragraphs: segment.paragraphs,
      overview: json(analysis?.overview_json, null),
      difficulty: json(analysis?.difficulty_json, null),
      review: json(analysis?.review_json, null),
      analysis: analysis === undefined ? null : {
        id: analysis.id, version: analysis.version, status: analysis.status,
        model: analysis.model, createdAt: analysis.created_at,
      },
      tasks,
      sentences: sentences.length > 0
        ? sentences
        : segment.sentences.map((item) => ({ ...item, analysis: null, analysisStatus: 'pending' })),
      words,
      phrases,
      collocations,
      progress: progress === undefined
        ? { sentenceIndex: 0, ratio: 0 }
        : { sentenceIndex: progress.current_sentence_index, ratio: progress.progress_ratio, updatedAt: progress.updated_at },
      notes,
      wordCount: segment.wordCount,
    };
  }

  /** Dashboard statistics plus recent activity. */
  function dashboard() {
    const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM articles) AS articles,
      (SELECT COUNT(*) FROM user_knowledge WHERE entity_type = 'word' AND favorite = 1) AS words,
      (SELECT COUNT(*) FROM user_knowledge) AS knowledge,
      (SELECT COALESCE(SUM(reading_minutes), 0) FROM articles) AS minutes`).get();
    const knowledge = db.prepare(`SELECT entity_type AS kind, COUNT(*) AS n,
      SUM(CASE WHEN mastery_level >= 3 THEN 1 ELSE 0 END) AS mastered FROM user_knowledge GROUP BY entity_type`).all();
    const recent = db.prepare('SELECT * FROM articles ORDER BY updated_at DESC LIMIT 4').all().map((row) => articleRow(row));
    const tasks = db.prepare(`SELECT t.stage, t.status, t.error_message, n.article_id AS article_id, a.title AS article_title
      FROM analysis_tasks t JOIN article_analyses n ON n.id = t.analysis_id JOIN articles a ON a.id = n.article_id
      WHERE t.status IN ('RUNNING', 'FAILED', 'PENDING') ORDER BY t.updated_at DESC LIMIT 6`).all()
      .map((row) => ({ stage: row.stage, status: row.status, articleId: row.article_id, articleTitle: row.article_title, error: row.error_message }));
    const streak = db.prepare('SELECT COUNT(DISTINCT substr(updated_at, 1, 10)) AS days FROM reading_progress WHERE updated_at > ?')
      .get(new Date(Date.now() - 7 * 86400_000).toISOString());
    return {
      articles: totals.articles,
      favoriteWords: totals.words,
      knowledgeItems: totals.knowledge,
      readingMinutes: totals.minutes,
      streakDays: streak.days,
      knowledge,
      recent,
      tasks,
    };
  }

  /** Delete an article and its files. Global knowledge entities survive. */
  function deleteArticle(articleId) {
    const row = requireArticle(articleId);
    transact(db, () => db.prepare('DELETE FROM articles WHERE id = ?').run(articleId));
    removeArticleBody(dirs, row.id);
    return { deleted: true };
  }

  // ------------------------------------------------------------ collection

  /** List saved collection profiles, seeding the default on first use. */
  function listProfiles() {
    let rows = db.prepare('SELECT * FROM collection_profiles ORDER BY created_at').all();
    if (rows.length === 0) {
      transact(db, () => {
        db.prepare('INSERT INTO collection_profiles (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
          newId('prf'), DEFAULT_PROFILE.name, JSON.stringify(DEFAULT_PROFILE), now(), now(),
        );
      });
      rows = db.prepare('SELECT * FROM collection_profiles ORDER BY created_at').all();
    }
    // Saved profiles may predate the registry; normalize on read so every
    // caller sees the current shape (`sourceIds`, `levelRange`, `types`, …).
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      ...normalizeProfile({ name: row.name, ...json(row.config_json, {}) }),
    }));
  }

  /** Create or update one collection profile. */
  function saveProfile(input) {
    const { id, ...rest } = input;
    if (typeof rest.name !== 'string' || rest.name.trim().length === 0) {
      throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'A collection profile needs a name.');
    }
    return transact(db, () => {
      if (id) {
        const existing = db.prepare('SELECT id FROM collection_profiles WHERE id = ?').get(id);
        if (existing === undefined) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'That collection profile no longer exists.');
        db.prepare('UPDATE collection_profiles SET name = ?, config_json = ?, updated_at = ? WHERE id = ?').run(
          rest.name.trim(), JSON.stringify(rest), now(), id,
        );
        return { id };
      }
      const created = newId('prf');
      db.prepare('INSERT INTO collection_profiles (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        created, rest.name.trim(), JSON.stringify(rest), now(), now(),
      );
      return { id: created };
    });
  }

  /** Delete a collection profile. */
  function deleteProfile(profileId) {
    const result = db.prepare('DELETE FROM collection_profiles WHERE id = ?').run(profileId);
    if (result.changes === 0) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'That collection profile no longer exists.');
    return { deleted: true };
  }

    /** Strategies over the shared services, built once per facade. */
  const strategies = buildStrategies({
    // The Harness web service reaches the deployment's own network path, so it
    // is tried first: behind a fake-IP proxy the plugin's own resolver sees a
    // synthetic address and would refuse the page.
    fetchText: (url, signal) => fetchText(url, signal, 6 * 1024 * 1024, options.web),
    parseFeed,
    scrapeLinks,
  });

  /** Candidate's published date within the profile window? */
  function withinWindow(profile, publishedAt) {
    const days = Number(profile.publishedWithinDays) || 7;
    if (typeof publishedAt !== 'string' || publishedAt.length === 0) {
      // A catalog entry (a book, an undated page) has no publish date; only the
      // dated windows reject undated items.
      return profile.publishedWindow === 'custom' ? true : true;
    }
    const age = (Date.now() - new Date(publishedAt).getTime()) / 86400_000;
    return Number.isFinite(age) && age <= days;
  }

  /**
   * Content filter. This is a heuristic pre-screen, not a classifier: it drops
   * candidates whose title or summary carries clearly unsuitable vocabulary,
   * and reports every drop so the user can see what was excluded.
   */
  const SENSITIVE_TERMS = [
    'nsfw', 'porn', 'sex tape', 'explicit', 'gore', 'beheading', 'massacre',
    'suicide', 'self-harm', 'rape', 'drug overdose', 'graphic violence',
  ];
  function looksSensitive(item) {
    const haystack = `${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
    return SENSITIVE_TERMS.find((term) => haystack.includes(term));
  }

  /**
   * Fetch every enabled source's candidates, then filter, score and dedupe.
   *
   * Sources are independent, so one publisher being down or bot-walled must
   * not fail the whole run: per-source outcomes are reported alongside the
   * candidates.
   */
  async function discover(profileId, limit, signal) {
    try {
      return await runDiscovery(profileId, limit, signal);
    } catch (error) {
      if (discoverRun !== null) {
        discoverRun.running = false;
        discoverRun.finishedAt = new Date().toISOString();
        discoverRun.error = error?.message ?? String(error);
        logRun('error', `采集中断：${discoverRun.error}`);
      }
      throw error;
    }
  }

  /** The actual sweep, wrapped by `discover` so progress always closes. */
  async function runDiscovery(profileId, limit, signal) {
    const profiles = listProfiles();
    const profile = normalizeProfile(profiles.find((item) => item.id === profileId) ?? profiles[0]);
    if (profile === undefined) throw new ReaderError(ERROR_CODES.SEARCH_PROVIDER_ERROR, 'No collection profile exists yet.');
    // The requested article count comes from the profile; a caller that passes
    // an explicit limit (agent tools, tests) overrides it for that run only.
    const wanted = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.max(1, Math.min(50, Math.round(Number(limit))))
      : profile.articleCount;
    // `signal` cancels the whole discovery sweep (feeds + listing fetches).
    const selected = profile.sourceIds.map((id) => strategies.get(id)).filter(Boolean);
    const perSource = Math.max(3, Math.ceil(wanted / Math.max(1, selected.length)) + 2);

    const report = [];
    const collected = [];
    // Publish progress so the UI can show what is happening: a sweep over 21
    // sources takes seconds and would otherwise look frozen.
    discoverRun = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      candidates: 0,
      error: null,
      sources: selected.map((strategy) => ({
        sourceId: strategy.id, sourceName: strategy.name, status: 'pending', fetched: 0,
      })),
      log: [],
    };
    logRun('info', `开始采集：${selected.length} 个来源，目标 ${wanted} 篇`);

    const outcomes = await Promise.all(selected.map(async (strategy) => {
      const slot = discoverRun?.sources.find((item) => item.sourceId === strategy.id);
      if (slot) slot.status = 'fetching';
      try {
        const items = await strategy.list({ signal, limit: perSource, levels: profile.levelRange });
        if (slot) {
          slot.status = items.length > 0 ? 'ok' : 'empty';
          slot.fetched = items.length;
        }
        logRun('info', `${strategy.name}：取到 ${items.length} 条`);
        return { strategy, items, ok: true };
      } catch (error) {
        const message = error instanceof ReaderError ? error.message : String(error?.message ?? error);
        const code = error instanceof ReaderError ? error.code : ERROR_CODES.SEARCH_PROVIDER_ERROR;
        if (slot) {
          slot.status = 'failed';
          slot.code = code;
          slot.error = message;
        }
        logRun('error', `${strategy.name} 失败（${code}）：${message}`);
        return { strategy, items: [], ok: false, error: message, code };
      }
    }));

    for (const outcome of outcomes) {
      const { strategy } = outcome;
      report.push({
        sourceId: strategy.id, sourceName: strategy.name, kind: strategy.kind,
        ok: outcome.ok && outcome.items.length > 0,
        fetched: outcome.items.length,
        // A reachable page with no usable links is its own outcome: reporting
        // "ok 0" would imply the publisher simply had no articles.
        error: outcome.ok
          ? (outcome.items.length === 0 ? '页面可访问，但没有提取到文章链接（站点结构或脚本渲染所致）' : null)
          : outcome.error,
        code: outcome.ok ? (outcome.items.length === 0 ? 'NO_LINKS_FOUND' : null) : outcome.code,
      });
      if (!strategy.accepts({}, profile)) {
        report.at(-1).skipped = '类型或难度不在采集规格内';
        continue;
      }
      for (const item of outcome.items) {
        if (!withinWindow(profile, item.publishedAt)) continue;
        if (profile.filterSensitive) {
          const term = looksSensitive(item);
          if (term !== undefined) {
            report.at(-1).filtered = (report.at(-1).filtered ?? 0) + 1;
            continue;
          }
        }
        const classified = strategy.classify(item, profile) ?? {};
        const words = countWords(`${item.title} ${item.summary}`);
        collected.push({
          ...item, ...classified,
          wordEstimate: words,
          levelBand: strategy.levelHint ?? null,
        });
      }
    }

    const rows = [];
    transact(db, () => {
      for (const item of collected) {
        if (!item.url) continue;
        const scored = scoreCandidate(profile, item);
        if (scored.rejected) continue;
        const url = canonicalUrl(item.url);
        if (db.prepare('SELECT id FROM discovered_articles WHERE url = ?').get(url) !== undefined) continue;
        const id = newId('dsc');
        db.prepare(`INSERT INTO discovered_articles (id, profile_id, title, url, source_name, published_at, word_count, cefr_level, snippet, score, reasons_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`).run(
          id, profile.id, item.title ?? item.url, url, item.sourceName ?? scored.sourceName,
          // Every bindable value is normalized to null-or-a-value: SQLite
          // rejects undefined, and optional level metadata is often absent.
          item.publishedAt ?? null,
          Number.isFinite(item.wordEstimate) ? item.wordEstimate : 0,
          item.cefrLevel ?? scored.cefrLevel ?? null,
          String(item.summary ?? '').slice(0, 200),
          Number.isFinite(scored.score) ? scored.score : 0,
          JSON.stringify(scored.reasons ?? []),
          now(),
        );
        rows.push({
          id,
          title: item.title ?? item.url,
          url,
          sourceName: item.sourceName ?? scored.sourceName,
          sourceId: item.sourceId ?? null,
          publishedAt: item.publishedAt ?? null,
          wordCount: item.wordEstimate ?? 0,
          cefrLevel: item.cefrLevel ?? scored.cefrLevel,
          levelBand: item.levelBand ?? null,
          articleType: item.articleType ?? null,
          snippet: (item.summary ?? '').slice(0, 200),
          score: scored.score,
          reasons: scored.reasons,
          imported: false,
        });
      }
    });
    recordSourceHealth(report);
    rows.sort((left, right) => right.score - left.score);
    if (discoverRun !== null) {
      const failed = report.filter((item) => item.ok === false).length;
      logRun('info', `筛选后候选 ${rows.length} 条，保留 ${Math.min(rows.length, wanted)} 条`);
      if (failed > 0) logRun('warn', `${failed} 个来源没有取到内容`);
    }
    const imported = new Set(db.prepare('SELECT source_url FROM article_sources').all().map((row) => row.source_url));
    for (const row of rows) row.imported = imported.has(row.url);
    const kept = rows.slice(0, wanted);
    if (discoverRun !== null) {
      discoverRun.running = false;
      discoverRun.finishedAt = new Date().toISOString();
      discoverRun.candidates = kept.length;
      logRun('info', '采集完成');
    }
    return {
      profileId: profile.id,
      candidates: kept,
      total: rows.length,
      wanted,
      sources: report,
      profile,
    };
  }

  /**
   * Score one candidate against the profile.
   *
   * Kept explainable: each contribution is a named reason, and a candidate
   * outside the requested band is rejected rather than silently ranked low.
   */
  function scoreCandidate(profile, item) {
    const title = item.title ?? '';
    const summary = item.summary ?? '';
    const haystack = `${title} ${summary}`.toLowerCase();
    const reasons = [];
    let score = 0;

    const [minLevel, maxLevel] = profile.levelRange;
    const band = item.cefrLevel ? CEFR_LEVELS.indexOf(item.cefrLevel) : -1;
    const lowIndex = CEFR_LEVELS.indexOf(minLevel);
    const highIndex = CEFR_LEVELS.indexOf(maxLevel);
    if (band >= 0) {
      if (band < lowIndex) {
        return { rejected: true, reasons: ['低于目标难度'], score: 0, cefrLevel: item.cefrLevel, sourceName: item.sourceName };
      }
      if (band > highIndex) {
        return { rejected: true, reasons: ['高于目标难度'], score: 0, cefrLevel: item.cefrLevel, sourceName: item.sourceName };
      }
      score += 2;
      reasons.push(`难度匹配 ${item.cefrLevel}`);
    } else if (item.levelBand) {
      score += 1;
      reasons.push(`来源难度带 ${item.levelBand.min}–${item.levelBand.max}`);
    }

    if (item.articleType) {
      if (profile.types?.includes(item.articleType)) {
        score += 1.5;
        reasons.push(`类型匹配 ${item.articleType}`);
      } else {
        return { rejected: true, reasons: ['类型不在所选范围'], score: 0, cefrLevel: item.cefrLevel, sourceName: item.sourceName };
      }
    }

    const topicHit = (profile.topics ?? []).filter((topic) => haystack.includes(String(topic).toLowerCase()));
    if (topicHit.length > 0) {
      score += 2;
      reasons.push(`主题匹配 ${topicHit.join('、')}`);
    }
    const keywordHit = (profile.keywords ?? []).filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
    if (keywordHit.length > 0) {
      score += 1.5;
      reasons.push(`关键词 ${keywordHit.join('、')}`);
    }
    const excluded = (profile.excludedKeywords ?? []).filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
    if (excluded.length > 0) {
      score -= 3;
      reasons.push(`含排除词 ${excluded.join('、')}`);
    }

    // Length: a summary is always shorter than the article, so this only
    // rejects nothing and gently prefers sources whose typical length matches.
    const contentWords = countWords(`${title} ${summary}`);
    if (contentWords < 20) {
      reasons.push('标题较短，正文长度待抓取确认');
    } else if (contentWords >= 40) {
      score += 0.5;
      reasons.push('摘要较充实');
    }

    if (item.publishedAt) {
      const age = (Date.now() - new Date(item.publishedAt).getTime()) / 86400_000;
      if (Number.isFinite(age) && age <= 1) {
        score += 1.5;
        reasons.push('24 小时内发布');
      } else if (Number.isFinite(age) && age <= 7) {
        score += 1;
        reasons.push('一周内发布');
      }
    }

    return {
      score: Math.round(score * 100) / 100,
      reasons,
      cefrLevel: item.cefrLevel ?? null,
      rejected: false,
      sourceName: item.sourceName ?? '',
    };
  }

  /**
   * Per-source health from the most recent discovery run.
   * The strategy table itself is static; the health of each remote source is
   * not, so this is recorded rather than declared.
   */
  function sourceHealth() {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'source_health'").get();
    return json(row?.value, {});
  }

  /** Persist the outcome list of one discovery sweep. */
  function recordSourceHealth(reports) {
    const previous = sourceHealth();
    const next = { ...previous };
    for (const report of reports ?? []) {
      next[report.sourceId] = {
        ok: report.ok === true,
        code: report.code ?? null,
        error: report.error ?? null,
        at: now(),
      };
    }
    try {
      transact(db, () => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('source_health', ?)").run(JSON.stringify(next)));
    } catch {
      /* health is advisory; never fail a run over it */
    }
    return next;
  }

  /** Fetch and preview a URL without saving it. */
  async function importUrl(url) {
    const fetched = await fetchArticle(url, undefined, options.web);
    const readable = extractReadable(fetched.html);
    // The page is mostly chrome; the cleaner keeps only the paragraphs a
    // reader would call "the article".
    const cleaned = cleanArticle(fetched.html, { title: readable.title });
    const text = cleaned.paragraphs.length > 0 ? cleaned.text : readable.text;
    if (countWords(text) < 40) {
      throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'Readable article text could not be extracted from that page.');
    }
    const segment = segmentArticle(text);
    const duplicateId = findDuplicate(fetched.url, sha256(segment.text));
    return {
      url: fetched.url,
      title: readable.title || new URL(fetched.url).hostname.replace(/^www\./, ''),
      sourceName: new URL(fetched.url).hostname.replace(/^www\./, ''),
      description: readable.description,
      text: segment.text,
      wordCount: segment.wordCount,
      readingMinutes: readingMinutes(segment.wordCount),
      paragraphCount: segment.paragraphs.length,
      sentenceCount: segment.sentences.length,
      cefrLevel: heuristicLevel(segment.text),
      duplicateArticleId: duplicateId ?? null,
    };
  }

  /**
   * Apply the profile's length rule to a fetched body.
   *
   * `unlimited` keeps everything. Inside a range, an over-long article is either
   * truncated on a sentence boundary (`truncate`) or rejected outright, so the
   * learner never gets a silently shortened text they did not ask for.
   * @returns {{ok: boolean, text: string, truncated: boolean, words: number, reason?: string}}
   */
  function applyWordLimit(text, profile) {
    const words = countWords(text);
    if (profile.wordLimitMode !== 'range') {
      return { ok: true, text, truncated: false, words };
    }
    const max = Number(profile.maxWords) || 0;
    const min = Number(profile.minWords) || 0;
    if (words < min) {
      return { ok: false, text, truncated: false, words, reason: 'tooShort' };
    }
    if (words <= max) {
      return { ok: true, text, truncated: false, words };
    }
    if (profile.truncate !== true) {
      return { ok: false, text, truncated: false, words, reason: 'tooLong' };
    }
    const cut = truncateToWords(text, max);
    // A cut that leaves less than the minimum is not a usable article.
    if (cut.words < min) {
      return { ok: false, text, truncated: false, words, reason: 'tooShortAfterTruncate' };
    }
    return { ok: true, text: cut.text, truncated: true, words: cut.words };
  }

  // -------------------------------------------------- discovery run progress

  /**
   * In-memory progress for the current discovery run.
   *
   * The Host RPC is request/response: a long sweep cannot push updates, so the
   * run publishes its progress here and the UI polls `discoverProgress`. This is
   * deliberately not persisted — progress is only meaningful while a run lives.
   */
  let discoverRun = null;

  /** Public snapshot of the current (or last) discovery run. */
  function discoverProgress() {
    if (discoverRun === null) return { running: false, sources: [], log: [] };
    const done = discoverRun.sources.filter((item) => item.status !== 'pending').length;
    return {
      running: discoverRun.running,
      startedAt: discoverRun.startedAt,
      finishedAt: discoverRun.finishedAt,
      total: discoverRun.sources.length,
      done,
      // The newest log line first: it is what the UI shows while scrolling is
      // not an option.
      log: [...discoverRun.log],
      sources: discoverRun.sources.map((item) => ({ ...item })),
      candidates: discoverRun.candidates,
      error: discoverRun.error ?? null,
    };
  }

  /** Append one line to the run log, keeping the buffer bounded. */
  function logRun(level, message) {
    if (discoverRun === null) return;
    discoverRun.log.push({ at: new Date().toISOString(), level, message });
    if (discoverRun.log.length > 200) discoverRun.log.shift();
  }

  /**
   * Pending candidates from previous discovery runs.
   *
   * Discovery writes every candidate to `discovered_articles`, so the list must
   * survive a page switch. Only rows still marked `candidate` are returned:
   * imported ones are already articles and would confuse the selection.
   *
   * The read is paginated so the content pane can hold one screen and load
   * more as the reader scrolls, instead of pulling the whole table at once.
   * @param {{limit?: number, offset?: number}} [query]
   * @returns {{items: object[], total: number, limit: number, offset: number}} one page.
   */
  function pendingCandidates(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const total = db.prepare("SELECT COUNT(*) AS n FROM discovered_articles WHERE status = 'candidate'").get().n;
    const rows = db.prepare(`SELECT * FROM discovered_articles
      WHERE status = 'candidate' ORDER BY score DESC, created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        url: row.url,
        sourceName: row.source_name,
        publishedAt: row.published_at,
        wordCount: row.word_count,
        cefrLevel: row.cefr_level,
        snippet: row.snippet,
        score: row.score,
        reasons: json(row.reasons_json, []),
        imported: false,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Re-clean a stored article and re-segment it.
   *
   * An article imported before the cleaner existed kept the page's chrome in
   * its body. This fetches the page again, keeps only the prose, stores it and
   * rebuilds the sentence rows — the analysis is invalidated, because every
   * offset into the old body is meaningless now.
   * @param {string} articleId article to clean.
   * @returns {object} what changed and what the caller must redo.
   */
  async function cleanStoredArticle(articleId) {
    const article = requireArticle(articleId);
    // The raw row names the column; the shaped row would be `sourceUrl`.
    const sourceUrl = article.source_url;
    if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) {
      throw new ReaderError(ERROR_CODES.INVALID_URL, 'This article has no source page to clean from.');
    }
    const fetched = await fetchArticle(sourceUrl, undefined, options.web);
    const readable = extractReadable(fetched.html);
    const cleaned = cleanArticle(fetched.html, { title: readable.title });
    if (cleaned.paragraphs.length === 0) {
      throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'No article text could be recovered from that page.');
    }
    const segment = segmentArticle(cleaned.text);
    const before = countWords(readArticleBody(dirs, article));
    // The title may carry the publisher's display suffix ("… : NPR"); the page
    // names the article itself, so the stored title is refreshed too.
    const title = readable.title.length > 0 ? readable.title : article.title;
    const titleChanged = title !== article.title;
    // The snippet was cut from the old body, which began with the page chrome.
    const snippet = cleaned.text.slice(0, 180);
    transact(db, () => {
      writeArticleBody(dirs, articleId, cleaned.text, fetched.html);
      db.prepare('UPDATE articles SET title = ?, snippet = ?, content_hash = ?, word_count = ?, reading_minutes = ?, updated_at = ? WHERE id = ?')
        .run(title, snippet, sha256(cleaned.text), segment.wordCount, readingMinutes(segment.wordCount), now(), articleId);
      // The sentences are rebuilt from the cleaned body: the old rows point at
      // offsets in a body that no longer exists.
      db.prepare('DELETE FROM article_sentences WHERE article_id = ?').run(articleId);
      for (const sentence of segment.sentences) {
        const hash = sha256(normalizeKey(sentence.text));
        let sentenceId = db.prepare('SELECT id FROM sentences WHERE normalized_hash = ?').get(hash)?.id;
        if (sentenceId === undefined) {
          sentenceId = newId('snt');
          db.prepare('INSERT INTO sentences (id, normalized_hash, content, created_at) VALUES (?, ?, ?, ?)').run(
            sentenceId, hash, sentence.text, now(),
          );
        }
        db.prepare(`INSERT INTO article_sentences (id, article_id, sentence_id, paragraph_index, sentence_index, start_offset, end_offset, analysis_json, analysis_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending')`).run(
          newId('as'), articleId, sentenceId, sentence.paragraphIndex, sentence.sentenceIndex, sentence.startOffset, sentence.endOffset,
        );
      }
      // The analyses described the old body, so they are dropped rather than
      // left to point at sentences that no longer exist.
      db.prepare('DELETE FROM article_analyses WHERE article_id = ?').run(articleId);
      db.prepare('UPDATE articles SET status = ? WHERE id = ?').run(ARTICLE_STATUS.FETCHED, articleId);
    });
    return {
      articleId,
      wordsBefore: before,
      wordsAfter: segment.wordCount,
      sentences: segment.sentences.length,
      dropped: cleaned.dropped,
      title,
      titleChanged,
      reanalyze: true,
    };
  }

  /** Save a fetched preview (or a manual paste) as an article. */
  function createArticle(input) {
    const text = String(input.text ?? '').trim();
    if (text.length === 0) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'The article body is empty.');
    const duplicateId = findDuplicate(input.sourceUrl, sha256(segmentArticle(text).text));
    if (duplicateId !== undefined) {
      throw new ReaderError(ERROR_CODES.DUPLICATE_ARTICLE, 'This article is already in your library.', { articleId: duplicateId });
    }
    const created = insertArticle({
      title: String(input.title ?? '').trim() || 'Untitled article',
      text,
      sourceName: input.sourceName ?? null,
      sourceUrl: input.sourceUrl ?? null,
      author: input.author ?? null,
      publishedAt: input.publishedAt ?? null,
      topic: input.topic ?? null,
      cefrLevel: input.cefrLevel ?? heuristicLevel(text),
      thumbnail: input.thumbnail ?? null,
      status: ARTICLE_STATUS.FETCHED,
    });
    return { id: created.id, wordCount: created.words, readingMinutes: readingMinutes(created.words) };
  }

  /** Import every selected discovered candidate; each result is reported separately. */
  async function confirmImport(candidateIds) {
    const results = [];
    // Length is a profile setting, so the same candidate set can behave
    // differently per profile; read it once per run.
    const profiles = listProfiles();
    const profile = normalizeProfile(profiles[0]);
    for (const candidateId of candidateIds) {
      const row = db.prepare('SELECT * FROM discovered_articles WHERE id = ?').get(candidateId);
      if (row === undefined) {
        results.push({ id: candidateId, ok: false, error: 'That candidate is no longer available.' });
        continue;
      }
      try {
        const preview = await importUrl(row.url);
        const limited = applyWordLimit(preview.text, profile);
        if (!limited.ok) {
          // Report why, rather than importing a text the learner excluded.
          results.push({
            id: candidateId, ok: false,
            error: limited.reason === 'tooShort' || limited.reason === 'tooShortAfterTruncate'
              ? `Article is shorter than ${profile.minWords} words.`
              : `Article is longer than ${profile.maxWords} words and truncation is off.`,
            reason: limited.reason, words: limited.words,
          });
          continue;
        }
        const created = createArticle({
          title: preview.title, text: limited.text, sourceUrl: preview.url,
          sourceName: preview.sourceName, cefrLevel: preview.cefrLevel,
        });
        db.prepare("UPDATE discovered_articles SET status = 'imported' WHERE id = ?").run(candidateId);
        results.push({
          id: candidateId, ok: true, articleId: created.id,
          truncated: limited.truncated, words: limited.words,
        });
      } catch (error) {
        results.push({ id: candidateId, ok: false, error: error instanceof ReaderError ? error.message : String(error) });
      }
    }
    return results;
  }

  /**
   * Set candidates aside.
   *
   * A candidate is kept as a row only until the learner decides what to do
   * with it, so "not importing this one" is a decision worth recording: the
   * status moves to `discarded` and the row leaves the candidate list without
   * being deleted, which keeps the discovery counts honest.
   *
   * @param {string[]} candidateIds candidates to set aside.
   * @returns {{removed: number, skipped: number}} what changed.
   */
  function discardCandidates(candidateIds) {
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) return { removed: 0, skipped: 0 };
    let removed = 0;
    let skipped = 0;
    transact(db, () => {
      for (const candidateId of candidateIds) {
        const row = db.prepare("SELECT status FROM discovered_articles WHERE id = ?").get(candidateId);
        if (row === undefined || row.status !== 'candidate') {
          skipped += 1;
          continue;
        }
        db.prepare("UPDATE discovered_articles SET status = 'discarded' WHERE id = ?").run(candidateId);
        removed += 1;
      }
    });
    return { removed, skipped };
  }

  // -------------------------------------------------------------- analysis

  /** Load an analysis plus its ordered stage list. */
  function analysisState(articleId) {
    const analysis = db.prepare('SELECT * FROM article_analyses WHERE article_id = ? ORDER BY version DESC LIMIT 1').get(articleId);
    if (analysis === undefined) return null;
    const tasks = db.prepare('SELECT * FROM analysis_tasks WHERE analysis_id = ?').all(analysis.id)
      .map((task) => ({
        stage: task.stage, status: task.status, errorCode: task.error_code,
        errorMessage: task.error_message, retryCount: task.retry_count,
        progress: json(task.output_json, null),
      }));
    const stageStatus = {};
    for (const task of tasks) stageStatus[task.stage] = task.status;
    const done = STAGES.filter((stage) => stageStatus[stage.name] === 'SUCCEEDED').length;
    return {
      id: analysis.id,
      articleId,
      version: analysis.version,
      status: analysis.status,
      model: analysis.model,
      stages: STAGES.map((stage) => ({
        stage: stage.name,
        status: stageStatus[stage.name] ?? 'PENDING',
        error: tasks.find((task) => task.stage === stage.name)?.errorMessage ?? null,
        progress: tasks.find((task) => task.stage === stage.name)?.progress ?? null,
      })),
      completed: done,
      total: STAGES.length,
      running: running.has(analysis.id),
    };
  }

  /** Record one LLM call for observability (never the full body). */
  function logCall(entry) {
    try {
      db.prepare(`INSERT INTO llm_call_logs (id, job, article_id, analysis_id, stage, model, prompt_version, latency_ms, input_tokens, output_tokens, error_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('log'), entry.job ?? null, entry.articleId ?? null, entry.analysisId ?? null, entry.stage ?? null,
        entry.model ?? null, entry.promptVersion ?? null, entry.latencyMs ?? null,
        entry.inputTokens ?? null, entry.outputTokens ?? null, entry.errorCode ?? null, now(),
      );
    } catch (error) {
      logger.warn(`english-reader: could not record an LLM call (${error.message})`);
    }
  }

  /** Mark one stage's status. */
  function setStage(analysisId, stage, status, extra = {}) {
    db.prepare(`UPDATE analysis_tasks SET status = ?, output_json = ?, error_code = ?, error_message = ?, raw_output = ?, retry_count = COALESCE(?, retry_count), started_at = COALESCE(?, started_at), updated_at = ?, completed_at = ? WHERE analysis_id = ? AND stage = ?`).run(
      status,
      extra.output === undefined ? null : JSON.stringify(extra.output),
      extra.errorCode ?? null, extra.errorMessage ?? null, extra.rawOutput ?? null, extra.retryCount ?? null,
      extra.startedAt ?? null, now(), status === 'SUCCEEDED' || status === 'FAILED' || status === 'SKIPPED' ? now() : null,
      analysisId, stage,
    );
  }

  /** Resolve (or create) a vocabulary entity and link it to one article. */
  function upsertVocabulary(item, articleId) {
    const key = normalizeKey(item.lemma ?? '');
    if (key.length === 0) return undefined;
    const existing = db.prepare('SELECT id FROM vocabulary WHERE normalized_key = ?').get(key);
    const id = existing?.id ?? newId('voc');
    if (existing === undefined) {
      db.prepare(`INSERT INTO vocabulary (id, lemma, normalized_key, phonetic, part_of_speech_json, meanings_json,
        word_formation_json, cefr_level, synonyms_json, antonyms_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, item.lemma, key, item.phonetic ?? null,
        JSON.stringify(item.partOfSpeech ?? []), JSON.stringify(item.meanings ?? []),
        JSON.stringify(item.wordFormation ?? null), item.cefrLevel ?? null,
        JSON.stringify(item.synonyms ?? []), JSON.stringify(item.antonyms ?? []), now(), now(),
      );
    }
    const link = db.prepare('SELECT id FROM article_words WHERE article_id = ? AND vocabulary_id = ?').get(articleId, id);
    const occurrences = Math.max(1, Number(item.occurrences) || 1);
    const contextMeaning = item.meanings?.[0]?.contextMeaning ?? null;
    const evidence = JSON.stringify(item.evidence ?? []);
    if (link === undefined) {
      db.prepare(`INSERT INTO article_words (id, article_id, vocabulary_id, context_meaning, occurrences, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(newId('aw'), articleId, id, contextMeaning, occurrences, evidence);
    } else {
      db.prepare('UPDATE article_words SET context_meaning = ?, occurrences = ?, evidence_json = ? WHERE id = ?').run(
        contextMeaning, occurrences, evidence, link.id,
      );
    }
    return id;
  }

  /** Insert or reuse a phrase/collocation entity plus its article link. */
  function upsertExpression(kind, item, articleId) {
    const table = kind === 'phrase' ? 'phrases' : 'collocations';
    const linkTable = kind === 'phrase' ? 'article_phrases' : 'article_collocations';
    const linkColumn = kind === 'phrase' ? 'phrase_id' : 'collocation_id';
    const key = normalizeKey(item.expression ?? '');
    if (key.length === 0) return undefined;
    const existing = db.prepare(`SELECT id FROM ${table} WHERE normalized_key = ?`).get(key);
    const id = existing?.id ?? newId(kind === 'phrase' ? 'phr' : 'col');
    if (existing === undefined) {
      if (kind === 'phrase') {
        db.prepare(`INSERT INTO phrases (id, normalized_key, expression, phrase_type, meaning, explanation, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, key, item.expression, item.phraseType ?? null, item.meaning ?? null, item.explanation ?? null, now(), now(),
        );
      } else {
        db.prepare(`INSERT INTO collocations (id, normalized_key, expression, pattern, meaning, explanation, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, key, item.expression, item.pattern ?? null, item.meaning ?? null, item.explanation ?? null, now(), now(),
        );
      }
    }
    const link = db.prepare(`SELECT id FROM ${linkTable} WHERE article_id = ? AND ${linkColumn} = ?`).get(articleId, id);
    if (link === undefined) {
      db.prepare(`INSERT INTO ${linkTable} (id, article_id, ${linkColumn}, evidence_json) VALUES (?, ?, ?, ?)`).run(
        newId('lnk'), articleId, id, JSON.stringify(item.evidence ?? []),
      );
    }
    return id;
  }

  /** Persist one successful stage's outputs into the domain tables. */
  function commitStage(articleId, analysisId, stage, data) {
    transact(db, () => {
      if (stage === 'OVERVIEW') {
        db.prepare('UPDATE article_analyses SET overview_json = ? WHERE id = ?').run(JSON.stringify(data), analysisId);
      }
      if (stage === 'DIFFICULTY') {
        db.prepare('UPDATE article_analyses SET difficulty_json = ? WHERE id = ?').run(JSON.stringify(data), analysisId);
        db.prepare('UPDATE articles SET cefr_level = ?, reading_minutes = COALESCE(?, reading_minutes), updated_at = ? WHERE id = ?').run(
          data.cefrLevel, null, now(), articleId,
        );
      }
      if (stage === 'REVIEW') {
        db.prepare('UPDATE article_analyses SET review_json = ? WHERE id = ?').run(JSON.stringify(data), analysisId);
      }
      if (stage === 'SEGMENTATION') {
        const body = readArticleBody(dirs, requireArticle(articleId));
        const segment = segmentArticle(body);
        db.prepare('DELETE FROM article_sentences WHERE article_id = ?').run(articleId);
        for (const sentence of segment.sentences) {
          const hash = sha256(normalizeKey(sentence.text));
          let sentenceId = db.prepare('SELECT id FROM sentences WHERE normalized_hash = ?').get(hash)?.id;
          if (sentenceId === undefined) {
            sentenceId = newId('snt');
            db.prepare('INSERT INTO sentences (id, normalized_hash, content, created_at) VALUES (?, ?, ?, ?)').run(
              sentenceId, hash, sentence.text, now(),
            );
          }
          db.prepare(`INSERT INTO article_sentences (id, article_id, sentence_id, paragraph_index, sentence_index, start_offset, end_offset, analysis_json, analysis_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending')`).run(
            newId('as'), articleId, sentenceId, sentence.paragraphIndex, sentence.sentenceIndex, sentence.startOffset, sentence.endOffset,
          );
        }
        db.prepare('UPDATE articles SET word_count = ?, updated_at = ? WHERE id = ?').run(segment.wordCount, now(), articleId);
      }
      if (stage === 'VOCABULARY') {
        for (const item of data.items ?? []) upsertVocabulary(item, articleId);
      }
      if (stage === 'PHRASES') {
        for (const item of data.items ?? []) upsertExpression('phrase', item, articleId);
      }
      if (stage === 'COLLOCATIONS') {
        for (const item of data.items ?? []) upsertExpression('collocation', item, articleId);
      }
    });
  }

  /** Resolve one article's body and neighbouring context for a sentence. */
  function sentenceContext(articleId, sentenceIndex) {
    const detail = db.prepare(`SELECT s.sentence_index, s.paragraph_index, t.content FROM article_sentences s
      JOIN sentences t ON t.id = s.sentence_id WHERE s.article_id = ? AND s.sentence_index = ?`).get(articleId, sentenceIndex);
    if (detail === undefined) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'That sentence is not part of this article.');
    const neighbours = db.prepare(`SELECT s.sentence_index, t.content FROM article_sentences s JOIN sentences t ON t.id = s.sentence_id
      WHERE s.article_id = ? AND s.sentence_index BETWEEN ? AND ? ORDER BY s.sentence_index`).all(articleId, sentenceIndex - 1, sentenceIndex + 1);
    return { sentence: detail.content, context: neighbours.map((item) => item.content).join(' ') };
  }

  /** Run one stage, retrying the stage alone on failure. */
  async function runStage(articleId, analysisId, stage, signal) {
    const article = requireArticle(articleId);
    const body = readArticleBody(dirs, article);
    const payload = { text: body, title: article.title, count: config.wordsPerArticle };
    const attemptLimit = effectiveTuning().retryLimit;
    setStage(analysisId, stage, 'RUNNING', { startedAt: now() });
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      try {
        const result = await analyzeStage(
            { llm: options.llm, defaultModel: options.defaultModel, modelOverride: modelOverride() },
          stage, payload, signal,
        );
        commitStage(articleId, analysisId, stage, result.data);
        setStage(analysisId, stage, result.needsReview ? 'NEEDS_REVIEW' : 'SUCCEEDED', { output: { evidence: result.evidence, needsReview: result.needsReview } });
        db.prepare('UPDATE article_analyses SET model = ?, prompt_bundle_version = ? WHERE id = ?').run(result.model, result.promptVersion, analysisId);
        logCall({ job: 'analysis', articleId, analysisId, stage, model: result.model, promptVersion: result.promptVersion, latencyMs: result.latencyMs, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
        return { ok: true, needsReview: result.needsReview };
      } catch (error) {
        const coded = error instanceof ReaderError ? error : new ReaderError(ERROR_CODES.LLM_UNAVAILABLE, String(error?.message ?? error));
        logCall({ job: 'analysis', articleId, analysisId, stage, errorCode: coded.code, latencyMs: 0 });
        if (attempt === attemptLimit - 1) {
          // Keep what the model returned. A stage failure that has no raw
          // output leaves the learner to retry blind.
          setStage(analysisId, stage, 'FAILED', {
            errorCode: coded.code, errorMessage: coded.message,
            rawOutput: typeof coded.rawOutput === 'string' ? coded.rawOutput : null,
          });
          return { ok: false, code: coded.code, message: coded.message };
        }
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    return { ok: false, code: ERROR_CODES.LLM_UNAVAILABLE, message: 'The stage could not complete.' };
  }

  /** Run sentence analysis for every pending sentence with bounded concurrency. */
  async function runSentenceAnalysis(articleId, analysisId, signal) {
    const pending = db.prepare(`SELECT s.sentence_index FROM article_sentences s LEFT JOIN sentences t ON t.id = s.sentence_id
      WHERE s.article_id = ? AND s.analysis_status IN ('pending', 'failed') ORDER BY s.sentence_index`).all(articleId);
    if (pending.length === 0) {
      setStage(analysisId, 'SENTENCE_ANALYSIS', 'SKIPPED', { output: { sentences: 0 } });
      return { ok: true, done: 0, failed: 0 };
    }
    let cursor = 0;
    let done = 0;
    let failed = 0;
    setStage(analysisId, 'SENTENCE_ANALYSIS', 'RUNNING', {
      startedAt: now(),
      output: { sentences: pending.length, done: 0, failed: 0 },
    });
    const workers = effectiveTuning().sentenceConcurrency;
    const tick = async () => {
      while (cursor < pending.length) {
        if (signal?.aborted) throw new ReaderError(ERROR_CODES.LLM_TIMEOUT, 'The analysis was cancelled.');
        const item = pending[cursor];
        cursor += 1;
        const context = sentenceContext(articleId, item.sentence_index);
        try {
          const result = await analyzeSentence(
              { llm: options.llm, defaultModel: options.defaultModel, modelOverride: modelOverride() },
            { ...context, title: requireArticle(articleId).title },
            signal,
          );
          transact(db, () => {
            const hash = sha256(normalizeKey(context.sentence));
            let sentenceId = db.prepare('SELECT id FROM sentences WHERE normalized_hash = ?').get(hash)?.id;
            if (sentenceId === undefined) {
              sentenceId = newId('snt');
              db.prepare('INSERT INTO sentences (id, normalized_hash, content, created_at) VALUES (?, ?, ?, ?)').run(sentenceId, hash, context.sentence, now());
            }
            db.prepare('UPDATE article_sentences SET analysis_json = ?, analysis_status = ? WHERE article_id = ? AND sentence_index = ?').run(
              JSON.stringify(result.data), result.needsReview ? 'needs_review' : 'done', articleId, item.sentence_index,
            );
          });
          logCall({ job: 'sentence', articleId, analysisId, stage: 'SENTENCE_ANALYSIS', model: result.model, promptVersion: result.promptVersion, latencyMs: result.latencyMs, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
          done += 1;
          // Progress is reported per completed sentence so the reader can show
          // "12 / 40 sentences" instead of an opaque bar.
          db.prepare('UPDATE analysis_tasks SET output_json = ?, updated_at = ? WHERE analysis_id = ? AND stage = ?').run(
            JSON.stringify({ sentences: pending.length, done, failed }), now(), analysisId, 'SENTENCE_ANALYSIS',
          );
        } catch (error) {
          failed += 1;
          const coded = error instanceof ReaderError ? error : new ReaderError(ERROR_CODES.LLM_UNAVAILABLE, String(error?.message ?? error));
          logCall({ job: 'sentence', articleId, analysisId, stage: 'SENTENCE_ANALYSIS', errorCode: coded.code });
          // The reason is stored, not just counted: a reader who sees a failed
          // sentence must be able to find out why without reading the Host log.
          const raw = typeof coded.rawOutput === 'string' ? coded.rawOutput : null;
          const nextAttempts = db.prepare('SELECT attempts FROM article_sentences WHERE article_id = ? AND sentence_index = ?')
            .get(articleId, item.sentence_index)?.attempts ?? 0;
          db.prepare(`UPDATE article_sentences SET analysis_status = 'failed', error_code = ?,
            error_message = ?, raw_output = ?, attempts = ? WHERE article_id = ? AND sentence_index = ?`).run(
            coded.code, coded.message, raw, nextAttempts + 1, articleId, item.sentence_index,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, tick));
    refreshSentenceStage(articleId, analysisId);
    return { ok: failed === 0, done, failed };
  }

  /** Retry exactly one failed sentence, keeping every other result intact. */
  async function retrySentence(articleId, sentenceIndex, signal) {
    const article = requireArticle(articleId);
    const analysis = db.prepare('SELECT * FROM article_analyses WHERE article_id = ? ORDER BY version DESC LIMIT 1').get(articleId);
    if (analysis === undefined) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'This article has no analysis yet.');
    const row = db.prepare(`SELECT s.sentence_index, s.attempts, t.content FROM article_sentences s
      JOIN sentences t ON t.id = s.sentence_id WHERE s.article_id = ? AND s.sentence_index = ?`).get(articleId, Number(sentenceIndex));
    if (row === undefined) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'That sentence is not part of this article.');
    const context = sentenceContext(articleId, row.sentence_index);
    try {
      const result = await analyzeSentence(
        { llm: options.llm, defaultModel: options.defaultModel, modelOverride: modelOverride() },
        { ...context, title: article.title }, signal,
      );
      transact(db, () => {
        db.prepare(`UPDATE article_sentences SET analysis_json = ?, analysis_status = ?, error_code = NULL,
          error_message = NULL, raw_output = NULL, attempts = attempts + 1
          WHERE article_id = ? AND sentence_index = ?`).run(
          JSON.stringify(result.data), result.needsReview ? 'needs_review' : 'done',
          articleId, row.sentence_index,
        );
      });
      logCall({ job: 'sentence', articleId, analysisId: analysis.id, stage: 'SENTENCE_ANALYSIS', model: result.model, promptVersion: result.promptVersion, latencyMs: result.latencyMs, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
      refreshSentenceStage(articleId, analysis.id);
      return { ok: true, sentenceIndex: row.sentence_index, needsReview: result.needsReview };
    } catch (error) {
      const coded = error instanceof ReaderError ? error : new ReaderError(ERROR_CODES.LLM_UNAVAILABLE, String(error?.message ?? error));
      logCall({ job: 'sentence', articleId, analysisId: analysis.id, stage: 'SENTENCE_ANALYSIS', errorCode: coded.code });
      transact(db, () => {
        db.prepare(`UPDATE article_sentences SET analysis_status = 'failed', error_code = ?, error_message = ?,
          raw_output = ?, attempts = attempts + 1 WHERE article_id = ? AND sentence_index = ?`).run(
          coded.code, coded.message, typeof coded.rawOutput === 'string' ? coded.rawOutput : null,
          articleId, row.sentence_index,
        );
      });
      refreshSentenceStage(articleId, analysis.id);
      throw coded;
    }
  }

  /**
   * Recompute the SENTENCE_ANALYSIS stage row from the sentence rows.
   * Retrying one sentence, or finishing a pass, must leave the stage summary
   * consistent with what is actually stored.
   */
  function refreshSentenceStage(articleId, analysisId) {
    const counts = db.prepare(`SELECT analysis_status AS status, COUNT(*) AS n FROM article_sentences
      WHERE article_id = ? GROUP BY analysis_status`).all(articleId);
    const total = counts.reduce((sum, row) => sum + row.n, 0);
    const failed = counts.filter((row) => row.status === 'failed').reduce((sum, row) => sum + row.n, 0);
    const done = counts.filter((row) => row.status === 'done').reduce((sum, row) => sum + row.n, 0);
    const review = counts.filter((row) => row.status === 'needs_review').reduce((sum, row) => sum + row.n, 0);
    const pending = total - failed - done - review;
    const failures = db.prepare(`SELECT error_code AS code, COUNT(*) AS n FROM article_sentences
      WHERE article_id = ? AND analysis_status = 'failed' GROUP BY error_code ORDER BY n DESC`).all(articleId)
      .map((row) => ({ code: row.code ?? 'UNKNOWN', n: row.n }));
    const status = failed > 0 ? 'FAILED' : pending > 0 ? 'RUNNING' : 'SUCCEEDED';
    setStage(analysisId, 'SENTENCE_ANALYSIS', status, {
      output: {
        sentences: total, analysed: done + review, done, failed, needsReview: review, pending,
        failureCodes: Object.fromEntries(failures.map((item) => [item.code, item.n]),
        ),
      },
      errorCode: failures[0]?.code ?? null,
      errorMessage: failed > 0 ? `${failed} of ${total} sentences could not be analysed.` : null,
    });
    return { total, done, failed, review, pending };
  }

  /**
   * Re-check every analysed sentence's quoted evidence against the stored body.
   *
   * This is how historical rows recorded under the old rule get a fair verdict:
   * each stored analysis is re-examined, rather than assuming that a
   * `needs_review` row must have failed. It is idempotent and reports what it
   * changed, so a caller can run it once after an upgrade.
   * @param {string} articleId article to revalidate.
   * @returns {object} counts of checked, cleared and still-flagged sentences.
   */
  function revalidateSentences(articleId) {
    const article = requireArticle(articleId);
    const body = readArticleBody(dirs, article);
    const rows = db.prepare(`SELECT s.id, s.sentence_index, s.analysis_status, s.analysis_json, t.content
      FROM article_sentences s JOIN sentences t ON t.id = s.sentence_id
      WHERE s.article_id = ? AND s.analysis_json IS NOT NULL`).all(articleId);
    let checked = 0;
    let cleared = 0;
    let flagged = 0;
    for (const row of rows) {
      const parsed = json(row.analysis_json, null);
      if (parsed === null) continue;
      checked += 1;
      // Only sentence-level quotes are meaningful here; the article-level
      // evidence check already ran per stage.
      const quotes = [];
      for (const point of parsed.grammarPoints ?? []) quotes.push(point.evidence);
      for (const part of parsed.structure?.components ?? []) quotes.push(part.text);
      for (const item of parsed.keyExpressions ?? []) quotes.push(item.expression);
      const missing = quotes.filter((quote) => typeof quote === 'string' && quote.length > 0 && !findQuote(body, quote));
      const notes = (parsed.uncertaintyNotes ?? []).length;
      const status = missing.length > 0 ? 'needs_review' : 'done';
      if (row.analysis_status !== status) {
        transact(db, () => db.prepare('UPDATE article_sentences SET analysis_status = ?, uncertainty_notes = ? WHERE id = ?')
          .run(status, String(notes), row.id));
        if (status === 'done') cleared += 1;
        else flagged += 1;
      } else {
        transact(db, () => db.prepare('UPDATE article_sentences SET uncertainty_notes = ? WHERE id = ?').run(String(notes), row.id));
      }
    }
    const analysis = db.prepare('SELECT id FROM article_analyses WHERE article_id = ? ORDER BY version DESC LIMIT 1').get(articleId);
    if (analysis !== undefined) refreshSentenceStage(articleId, analysis.id);
    return { checked, cleared, flagged, notes: rows.length };
  }

  /** Number of segmented sentences stored for one article. */
  function countSentences(articleId) {
    return db.prepare('SELECT COUNT(*) AS n FROM article_sentences WHERE article_id = ?').get(articleId).n;
  }

  /** Execute the whole stage graph for one analysis, then settle its status. */
  async function runAnalysis(articleId, analysisId, onlyStages, signal) {
    const article = requireArticle(articleId);
    db.prepare('UPDATE articles SET status = ?, updated_at = ? WHERE id = ?').run(ARTICLE_STATUS.ANALYZING, now(), articleId);
    db.prepare("UPDATE article_analyses SET status = 'RUNNING' WHERE id = ?").run(analysisId);
    let failures = 0;
    for (const stage of STAGES) {
      if (signal?.aborted) break;
      const current = db.prepare('SELECT status FROM analysis_tasks WHERE analysis_id = ? AND stage = ?').get(analysisId, stage.name);
      if (onlyStages !== undefined && !onlyStages.includes(stage.name)) continue;
      if (onlyStages === undefined && current?.status === 'SUCCEEDED') continue;
      if (stage.name === 'SENTENCE_ANALYSIS') {
        const result = await runSentenceAnalysis(articleId, analysisId, signal);
        if (!result.ok) failures += 1;
        continue;
      }
      if (stage.name === 'SEGMENTATION') {
        // Segmentation is deterministic local work, never a model call:
        // offsets must always address the stored body.
        try {
          commitStage(articleId, analysisId, 'SEGMENTATION', {});
          setStage(analysisId, 'SEGMENTATION', 'SUCCEEDED', { output: { sentences: countSentences(articleId) } });
        } catch (error) {
          const coded = error instanceof ReaderError ? error : new ReaderError(ERROR_CODES.DATABASE_ERROR, error.message);
          setStage(analysisId, 'SEGMENTATION', 'FAILED', { errorCode: coded.code, errorMessage: coded.message });
          failures += 1;
        }
        continue;
      }
      const result = await runStage(articleId, analysisId, stage.name, signal);
      if (!result.ok) failures += 1;
    }
    const aborted = signal?.aborted === true;
    const finalStatus = aborted ? 'FAILED' : failures === 0 ? 'COMPLETED' : 'PARTIAL_COMPLETED';
    const articleStatus = aborted ? ARTICLE_STATUS.ANALYSIS_FAILED : failures === 0 ? ARTICLE_STATUS.COMPLETED : ARTICLE_STATUS.PARTIAL_COMPLETED;
    db.prepare('UPDATE article_analyses SET status = ? WHERE id = ?').run(finalStatus, analysisId);
    db.prepare('UPDATE articles SET status = ?, updated_at = ? WHERE id = ?').run(articleStatus, now(), articleId);
    running.delete(analysisId);
    logger.info(`english-reader: analysis ${analysisId} settled as ${finalStatus}`);
    return finalStatus;
  }

  /** Start a fresh analysis version for one article. */
  function startAnalysis(articleId) {
    const article = requireArticle(articleId);
    const latest = db.prepare('SELECT MAX(version) AS v FROM article_analyses WHERE article_id = ?').get(articleId);
    const version = (latest?.v ?? 0) + 1;
    const analysisId = newId('ana');
    transact(db, () => {
      db.prepare('INSERT INTO article_analyses (id, article_id, version, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
        analysisId, articleId, version, 'RUNNING', now(),
      );
      for (const stage of STAGES) {
        db.prepare('INSERT INTO analysis_tasks (id, analysis_id, stage, status, updated_at) VALUES (?, ?, ?, ?, ?)').run(
          newId('tsk'), analysisId, stage.name, 'PENDING', now(),
        );
      }
    });
    const controller = new AbortController();
    running.set(analysisId, controller);
    const task = runAnalysis(articleId, analysisId, undefined, controller.signal)
      .catch((error) => logger.warn(`english-reader: analysis ${analysisId} failed: ${error.message}`))
      .finally(() => running.delete(analysisId));
    queue.set(analysisId, task);
    return { analysisId, articleId: article.id, version };
  }

  /** Retry one failed stage, keeping successful stages untouched. */
  async function retryStage(articleId, stage) {
    const analysis = db.prepare('SELECT * FROM article_analyses WHERE article_id = ? ORDER BY version DESC LIMIT 1').get(articleId);
    if (analysis === undefined) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'This article has no analysis yet.');
    const task = db.prepare('SELECT * FROM analysis_tasks WHERE analysis_id = ? AND stage = ?').get(analysis.id, stage);
    if (task === undefined) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, `Unknown stage ${stage}.`);
    const controller = new AbortController();
    running.set(analysis.id, controller);
    const job = runAnalysis(articleId, analysis.id, [stage], controller.signal)
      .catch((error) => logger.warn(`english-reader: retry of ${stage} failed: ${error.message}`))
      .finally(() => running.delete(analysis.id));
    queue.set(analysis.id, job);
    await job;
    return analysisState(articleId);
  }

  /** Cancel a running analysis. */
  function cancelAnalysis(articleId) {
    const analysis = db.prepare('SELECT * FROM article_analyses WHERE article_id = ? ORDER BY version DESC LIMIT 1').get(articleId);
    if (analysis === undefined) return { cancelled: false };
    const controller = running.get(analysis.id);
    if (controller === undefined) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  /**
   * Recover interrupted work on startup: anything left RUNNING or PENDING from
   * a previous process is marked retryable, and successful stages stay intact.
   */
  function resumeInterrupted() {
    const stale = db.prepare("SELECT * FROM article_analyses WHERE status = 'RUNNING'").all();
    let adopted = 0;
    for (const analysis of stale) {
      db.prepare("UPDATE analysis_tasks SET status = 'PENDING' WHERE analysis_id = ? AND status = 'RUNNING'").run(analysis.id);
      db.prepare("UPDATE article_analyses SET status = 'PARTIAL_COMPLETED' WHERE id = ?").run(analysis.id);
      db.prepare('UPDATE articles SET status = ? WHERE id = ?').run(ARTICLE_STATUS.PARTIAL_COMPLETED, analysis.article_id);
      adopted += 1;
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM analysis_tasks WHERE status = 'PENDING'").get().n;
    return { interrupted: adopted, pendingStages: pending, at: now() };
  }

  // -------------------------------------------------------------- knowledge

  /**
   * Search one knowledge kind across the entities the learner added.
   *
   * Parsing an article only produces *candidates* (the vocabulary/phrase/
   * collocation/sentence tables). The library is `user_knowledge`: a row exists
   * there only after the learner pressed "add to library" in the reader. A join
   * is therefore an inner join, not a left join.
   */
  function searchKnowledge(query = {}) {
    const kind = query.kind ?? 'word';
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 200);
    const search = query.search?.trim();
    const clauses = [];
    const params = [];
    if (search) {
      clauses.push('(e.expression LIKE ? OR e.lemma LIKE ? OR e.meaning LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (query.favoriteOnly) clauses.push('k.favorite = 1');
    if (query.minMastery !== undefined) {
      clauses.push('k.mastery_level >= ?');
      params.push(Number(query.minMastery));
    }
    if (query.maxMastery !== undefined) {
      clauses.push('k.mastery_level <= ?');
      params.push(Number(query.maxMastery));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    if (kind === 'word') {
      const rows = db.prepare(`SELECT v.id, v.lemma AS expression, v.phonetic, v.cefr_level, v.meanings_json AS detail,
        (SELECT COUNT(DISTINCT w.article_id) FROM article_words w WHERE w.vocabulary_id = v.id) AS sources,
        (SELECT a.id FROM article_words w JOIN articles a ON a.id = w.article_id WHERE w.vocabulary_id = v.id ORDER BY a.created_at DESC LIMIT 1) AS article_id,
        (SELECT a.title FROM article_words w JOIN articles a ON a.id = w.article_id WHERE w.vocabulary_id = v.id ORDER BY a.created_at DESC LIMIT 1) AS article_title,
        COALESCE(k.favorite, 0) AS favorite, COALESCE(k.mastery_level, 0) AS mastery
        FROM vocabulary v JOIN user_knowledge k ON k.entity_type = 'word' AND k.entity_id = v.id
        ${where} ORDER BY mastery DESC, v.lemma COLLATE NOCASE LIMIT ?`).all(...params, limit);
      return rows.map((row) => ({
        id: row.id, kind, expression: row.expression, phonetic: row.phonetic, detail: json(row.detail, []),
        cefrLevel: row.cefr_level, sourceCount: row.sources, articleId: row.article_id,
        articleTitle: row.article_title, favorite: row.favorite === 1, masteryLevel: row.mastery,
      }));
    }
    if (kind === 'sentence') {
      const rows = db.prepare(`SELECT s.id, s.content AS expression,
        (SELECT COUNT(DISTINCT a.article_id) FROM article_sentences a WHERE a.sentence_id = s.id) AS sources,
        (SELECT a.article_id FROM article_sentences a WHERE a.sentence_id = s.id ORDER BY a.rowid DESC LIMIT 1) AS article_id,
        (SELECT an.title FROM article_sentences a JOIN articles an ON an.id = a.article_id WHERE a.sentence_id = s.id LIMIT 1) AS article_title,
        COALESCE(k.favorite, 0) AS favorite, COALESCE(k.mastery_level, 0) AS mastery
        FROM sentences s JOIN user_knowledge k ON k.entity_type = 'sentence' AND k.entity_id = s.id
        ${where.replace(/e\.expression/g, 's.content').replace(/e\.lemma/g, 's.content').replace(/e\.meaning/g, 's.content')}
        ORDER BY mastery DESC, s.rowid DESC LIMIT ?`).all(...params, limit);
      return rows.map((row) => ({
        id: row.id, kind, expression: row.expression, detail: [], cefrLevel: null,
        sourceCount: row.sources, articleId: row.article_id, articleTitle: row.article_title,
        favorite: row.favorite === 1, masteryLevel: row.mastery,
      }));
    }
    const table = kind === 'phrase' ? 'phrases' : 'collocations';
    const detailColumn = kind === 'phrase' ? 'p.explanation' : 'p.pattern';
    const rows = db.prepare(`SELECT p.id, p.expression, p.meaning, ${detailColumn} AS detail,
      (SELECT COUNT(DISTINCT l.article_id) FROM article_${table} l WHERE l.${kind}_id = p.id) AS sources,
      (SELECT a.id FROM article_${table} l JOIN articles a ON a.id = l.article_id WHERE l.${kind}_id = p.id ORDER BY a.created_at DESC LIMIT 1) AS article_id,
      (SELECT a.title FROM article_${table} l JOIN articles a ON a.id = l.article_id WHERE l.${kind}_id = p.id ORDER BY a.created_at DESC LIMIT 1) AS article_title,
      COALESCE(k.favorite, 0) AS favorite, COALESCE(k.mastery_level, 0) AS mastery
      FROM ${table} p JOIN user_knowledge k ON k.entity_type = '${kind}' AND k.entity_id = p.id
      ${where} ORDER BY mastery DESC, p.expression COLLATE NOCASE LIMIT ?`).all(...params, limit);
    return rows.map((row) => ({
      id: row.id, kind, expression: row.expression, phonetic: null, detail: row.detail ?? '',
      meaning: row.meaning, cefrLevel: null, sourceCount: row.sources, articleId: row.article_id,
      articleTitle: row.article_title, favorite: row.favorite === 1, masteryLevel: row.mastery,
    }));
  }

  /** One knowledge entity with every context it appears in. */
  function knowledgeDetail(kind, entityId) {
    const knowledge = db.prepare('SELECT * FROM user_knowledge WHERE entity_type = ? AND entity_id = ?').get(kind, entityId);
    const base = knowledge === undefined
      ? { favorite: false, masteryLevel: 0, notes: '' }
      : { favorite: knowledge.favorite === 1, masteryLevel: knowledge.mastery_level, notes: knowledge.notes ?? '' };
    if (kind === 'word') {
      const row = db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(entityId);
      if (row === undefined) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'That word no longer exists.');
      const contexts = db.prepare(`SELECT a.id AS articleId, a.title, a.source_name AS sourceName, a.cefr_level AS cefrLevel,
        w.context_meaning AS contextMeaning, w.evidence_json
        FROM article_words w JOIN articles a ON a.id = w.article_id WHERE w.vocabulary_id = ? ORDER BY a.created_at DESC`).all(entityId)
        .map((item) => ({
          articleId: item.articleId, title: item.title, sourceName: item.sourceName,
          cefrLevel: item.cefrLevel, contextMeaning: item.contextMeaning,
          evidence: json(item.evidence_json, []),
        }));
      return {
        kind, id: entityId, expression: row.lemma, phonetic: row.phonetic,
        partOfSpeech: json(row.part_of_speech_json, []), meanings: json(row.meanings_json, []),
        wordFormation: json(row.word_formation_json, null), cefrLevel: row.cefr_level,
        synonyms: json(row.synonyms_json, []), antonyms: json(row.antonyms_json, []),
        contexts, ...base,
      };
    }
    if (kind === 'sentence') {
      const row = db.prepare('SELECT * FROM sentences WHERE id = ?').get(entityId);
      if (row === undefined) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'That sentence no longer exists.');
      const contexts = db.prepare(`SELECT a.id AS articleId, a.title, s.analysis_json, s.sentence_index AS sentenceIndex
        FROM article_sentences s JOIN articles a ON a.id = s.article_id WHERE s.sentence_id = ?`).all(entityId)
        .map((item) => ({ ...item, analysis: json(item.analysis_json, null) }));
      return { kind, id: entityId, expression: row.content, contexts, ...base };
    }
    const table = kind === 'phrase' ? 'phrases' : 'collocations';
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId);
    if (row === undefined) throw new ReaderError(ERROR_CODES.DATABASE_ERROR, 'That expression no longer exists.');
    const contexts = db.prepare(`SELECT a.id AS articleId, a.title, a.source_name AS sourceName, a.cefr_level AS cefrLevel,
      l.evidence_json
      FROM article_${table} l JOIN articles a ON a.id = l.article_id WHERE l.${kind}_id = ?`).all(entityId)
      .map((item) => ({
        articleId: item.articleId, title: item.title, sourceName: item.sourceName,
        cefrLevel: item.cefrLevel, evidence: json(item.evidence_json, []),
      }));
    return {
      kind, id: entityId, expression: row.expression, meaning: row.meaning,
      explanation: row.explanation, pattern: row.pattern ?? null, contexts, ...base,
    };
  }

  /** Update favorite/mastery/notes for any knowledge entity. */
  function updateKnowledge(input) {
    const kind = input.entityType;
    if (!['word', 'phrase', 'collocation', 'sentence'].includes(kind)) {
      throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, `Unknown knowledge kind "${kind}".`);
    }
    const mastery = input.masteryLevel === undefined ? undefined : Math.max(0, Math.min(4, Number(input.masteryLevel)));
    return transact(db, () => {
      const existing = db.prepare('SELECT * FROM user_knowledge WHERE entity_type = ? AND entity_id = ?').get(kind, input.entityId);
      const favorite = input.favorite === undefined ? (existing?.favorite ?? 0) : input.favorite ? 1 : 0;
      const level = mastery === undefined ? (existing?.mastery_level ?? 0) : mastery;
      const notes = input.notes === undefined ? (existing?.notes ?? null) : input.notes;
      // `inLibrary` is the membership flag. An explicit `false` removes the
      // entity: the row is the membership record, so it must be deleted rather
      // than kept with favorite = 0.
      const removeFromLibrary = input.favorite === false && (input.masteryLevel === undefined || level === 0);
      if (existing !== undefined && removeFromLibrary) {
        db.prepare('DELETE FROM user_knowledge WHERE id = ?').run(existing.id);
        return {
          entityType: kind, entityId: input.entityId, favorite: false,
          masteryLevel: 0, notes: '', inLibrary: false,
        };
      }
      if (existing === undefined) {
        db.prepare('INSERT INTO user_knowledge (id, entity_type, entity_id, favorite, mastery_level, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          newId('ukn'), kind, input.entityId, favorite, level, notes, now(),
        );
      } else {
        db.prepare('UPDATE user_knowledge SET favorite = ?, mastery_level = ?, notes = ?, updated_at = ? WHERE id = ?').run(
          favorite, level, notes, now(), existing.id,
        );
      }
      recordStudy({
        kind: kind === 'word' ? 'vocabulary' : kind,
        entityType: kind,
        entityId: input.entityId,
        seconds: Number(input.seconds) || 0,
      });
      return {
        entityType: kind, entityId: input.entityId, favorite: favorite === 1,
        masteryLevel: level, notes: notes ?? '', inLibrary: true,
      };
    });
  }

  /** Review queue: knowledge items the learner has not mastered yet. */
  function reviewQueue(limit = 20) {
    const rows = db.prepare(`SELECT v.id, v.lemma AS expression, v.phonetic, v.meanings_json, v.cefr_level,
      COALESCE(k.mastery_level, 0) AS mastery, COALESCE(k.favorite, 0) AS favorite
      FROM vocabulary v JOIN user_knowledge k ON k.entity_type = 'word' AND k.entity_id = v.id
      WHERE k.mastery_level < 3
      ORDER BY k.mastery_level ASC, v.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(100, limit))).map((row) => ({
      id: row.id, kind: 'word', expression: row.expression, phonetic: row.phonetic,
      meanings: json(row.meanings_json, []), cefrLevel: row.cefr_level,
      masteryLevel: row.mastery, favorite: row.favorite === 1,
    }));
    const totals = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN mastery_level >= 3 THEN 1 ELSE 0 END) AS mastered
      FROM user_knowledge WHERE entity_type = 'word'`).get();
    return {
      items: rows,
      reviewedToday: db.prepare("SELECT COUNT(*) AS n FROM user_knowledge WHERE entity_type = 'word' AND substr(updated_at, 1, 10) = ?").get(now().slice(0, 10)).n,
      target: 5,
      total: totals.total ?? 0,
      mastered: totals.mastered ?? 0,
    };
  }

  // ---------------------------------------------------------------- reading

  /** Save reading position. */
  function saveProgress(input) {
    const article = requireArticle(input.articleId);
    const ratio = Math.max(0, Math.min(1, Number(input.ratio) || 0));
    transact(db, () => {
      const existing = db.prepare('SELECT * FROM reading_progress WHERE article_id = ?').get(article.id);
      if (existing === undefined) {
        db.prepare('INSERT INTO reading_progress (article_id, current_sentence_index, progress_ratio, updated_at) VALUES (?, ?, ?, ?)').run(
          article.id, Math.max(0, Number(input.sentenceIndex) || 0), ratio, now(),
        );
      } else {
        db.prepare('UPDATE reading_progress SET current_sentence_index = ?, progress_ratio = ?, updated_at = ? WHERE article_id = ?').run(
          Math.max(0, Number(input.sentenceIndex) || 0), ratio, now(), article.id,
        );
      }
      db.prepare('UPDATE articles SET reading_status = ?, updated_at = ? WHERE id = ?').run(
        ratio >= 0.98 ? 'completed' : ratio > 0 ? 'reading' : 'unread', now(), article.id,
      );
    });
    // Only record time the client actually measured; a save with no elapsed
    // seconds still counts as an activity, with zero attributed time.
    recordStudy({
      kind: 'read',
      articleId: article.id,
      seconds: Number(input.seconds) || 0,
    });
    return { saved: true, ratio };
  }

  /** Add or remove a reading note. */
  function saveNote(input) {
    const article = requireArticle(input.articleId);
    if (input.remove) {
      db.prepare('DELETE FROM reading_notes WHERE id = ? AND article_id = ?').run(input.id, article.id);
      return { removed: true };
    }
    const body = String(input.body ?? '').trim();
    if (body.length === 0) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'A note needs some text.');
    const id = newId('nte');
    transact(db, () => db.prepare('INSERT INTO reading_notes (id, article_id, sentence_index, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id, article.id, input.sentenceIndex ?? null, body, now(),
    ));
    return { id, body };
  }

  // ----------------------------------------------------------------- speech

  /**
   * Synthesize one word, phrase or sentence.
   * Callers pass the text they are looking at, so a sentence never needs its
   * index resolved twice.
   * @param {object} input {text, voice, rate}.
   * @param {AbortSignal} [signal] cancellation from the request.
   * @returns {Promise<object>} audio payload metadata.
   */
  async function speak(input, signal) {
    try {
      const result = await speech.speak({
        text: input?.text,
        voice: input?.voice ?? 'en-US-AriaNeural',
        rate: input?.rate ?? 0,
      }, signal);
      return {
        audio: result.bytes.toString('base64'),
        mime: 'audio/mpeg',
        voice: result.voice,
        rate: result.rate,
        bytes: result.bytes.length,
        cached: result.cached,
      };
    } catch (error) {
      if (error instanceof SpeechError) throw new ReaderError(error.code, error.message);
      throw new ReaderError('SPEECH_FAILED', `Speech synthesis failed: ${error?.message ?? 'unknown error'}`);
    }
  }

  /**
   * Speak one sentence of an article by index, so the UI never resends text.
   * Analysis rows exist only after segmentation, so the deterministic
   * segmentation of the stored body is the fallback source — imports can be
   * listened to before analysis finishes.
   */
  async function speakSentence(articleId, sentenceIndex, voice, rate, signal) {
    const article = requireArticle(articleId);
    let text;
    const stored = db.prepare(`SELECT s.sentence_index, t.content FROM article_sentences s
      JOIN sentences t ON t.id = s.sentence_id WHERE s.article_id = ? AND s.sentence_index = ?`).get(articleId, sentenceIndex);
    if (stored !== undefined) {
      text = stored.content;
    } else {
      const segment = segmentArticle(readArticleBody(dirs, article));
      text = segment.sentences.find((item) => item.sentenceIndex === Number(sentenceIndex))?.text;
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'That sentence is not part of this article.');
    }
    return speak({ text, voice, rate }, signal);
  }

  /** Speech cache facts and cleanup. */
  function speechStats() {
    return { ...speech.stats(), available: typeof WebSocket === 'function' };
  }

  function clearSpeechCache() {
    return speech.clearCache();
  }

  // --------------------------------------------------------------- settings

  /** Settings snapshot for the settings page. */
  async function settings() {
    let route = null;
    try {
      route = options.defaultModel?.currentSelection?.() ?? null;
    } catch {
      route = null;
    }
    return {
      model: route === null ? null : { provider: route.provider, model: route.model },
      llmAvailable: options.llm !== undefined,
      searchAvailable: options.web !== undefined,
      dataDir: dirs.root,
      databasePath: `${dirs.database}/english-reader.sqlite`,
      bytes: diskUsage(dirs),
      schemaVersion: Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value ?? 0),
      // The model picker: every provider the Harness exposes, with its models.
      // One implementation only — an earlier inline copy passed the provider
      // OBJECT to `listModels`, so every provider listed the same models.
      availableModels: await availableModelList(),
      modelOverride: modelOverride(),
      tuning: effectiveTuning(),
      sentenceConcurrency: config.sentenceConcurrency,
      retryLimit: config.retryLimit,
      speech: {
        available: typeof WebSocket === 'function',
        engine: 'edge-tts',
        voices: VOICES,
        ...speech.stats(),
      },
      // Collection metadata lives beside the data settings so the form never
      // hard-codes a source list that could drift from the registry.
      collection: {
        sources: SOURCE_REGISTRY.map((source) => ({
          id: source.id, name: source.name, domains: source.domains, kind: source.kind,
          levelHint: source.levelHint, articleTypes: source.articleTypes,
          paywalled: source.paywalled, note: source.note ?? null,
          health: sourceHealth()[source.id] ?? null,
        })),
        articleTypes: [...ARTICLE_TYPES],
        cefrLevels: [...CEFR_LEVELS],
        windows: PUBLISHED_WINDOWS.map((window) => ({ id: window.id, days: window.days })),
      },
      counts: {
        articles: db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,
        words: db.prepare('SELECT COUNT(*) AS n FROM vocabulary').get().n,
        phrases: db.prepare('SELECT COUNT(*) AS n FROM phrases').get().n,
        collocations: db.prepare('SELECT COUNT(*) AS n FROM collocations').get().n,
        sentences: db.prepare('SELECT COUNT(*) AS n FROM sentences').get().n,
      },
      version: options.version ?? '1.0.0',
    };
  }

  /** Export the whole library as one JSON document. */
  function exportData() {
    const payload = {
      formatVersion: 1,
      exportedAt: now(),
      articles: db.prepare('SELECT * FROM articles').all().map((row) => ({
        ...articleRow(row),
        // `text` is the field the importer reads, so a round trip is lossless.
        text: readArticleBody(dirs, row),
      })),
      profiles: listProfiles(),
      knowledge: db.prepare('SELECT * FROM user_knowledge').all(),
      progress: db.prepare('SELECT * FROM reading_progress').all(),
      notes: db.prepare('SELECT * FROM reading_notes').all(),
      analyses: db.prepare('SELECT * FROM article_analyses').all(),
    };
    return payload;
  }

  /** Restore an export into this library, skipping duplicates. */
  function importData(payload) {
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.articles)) {
      throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'That file is not an English Reader export.');
    }
    let added = 0;
    let skipped = 0;
    for (const article of payload.articles) {
      if (typeof article.text !== 'string' || article.text.length === 0) {
        skipped += 1;
        continue;
      }
      if (findDuplicate(article.sourceUrl, sha256(segmentArticle(article.text).text)) !== undefined) {
        skipped += 1;
        continue;
      }
      insertArticle({
        title: article.title ?? 'Untitled',
        text: article.text,
        sourceName: article.sourceName ?? null,
        sourceUrl: article.sourceUrl ?? null,
        cefrLevel: article.cefrLevel ?? null,
        status: ARTICLE_STATUS.FETCHED,
        demo: false,
      });
      added += 1;
    }
    return { added, skipped };
  }

  // ------------------------------------------------------------ demo library

  /** Sample article bodies so the UI has something readable on first run. */
  const DEMO_ARTICLES = options.demo ?? [];

  /**
   * Seed the sample library once. Demo rows are tagged so they can be removed
   * with one action and never masquerade as the user's own imports.
   */
  function seedDemo() {
    const seeded = db.prepare("SELECT value FROM app_settings WHERE key = 'demo_seeded'").get();
    if (seeded !== undefined && seeded.value === '1') return { seeded: 0 };
    let count = 0;
    transact(db, () => {
      for (const demo of DEMO_ARTICLES) {
        if (findDuplicate(null, sha256(demo.text)) !== undefined) continue;
        const id = newId('art');
        const contentPath = writeArticleBody(dirs, id, demo.text);
        const words = countWords(demo.text);
        db.prepare(`INSERT INTO articles (id, title, source_name, author, source_url, published_at, topic, cefr_level, word_count, reading_minutes,
          content_hash, content_path, thumbnail, snippet, status, demo, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`).run(
          id, demo.title, demo.sourceName, demo.author ?? null, demo.publishedAt, demo.topic,
          demo.cefrLevel, words, readingMinutes(words), sha256(demo.text), contentPath,
          demo.snippet ?? demo.text.slice(0, 180), ARTICLE_STATUS.FETCHED, now(), now(),
        );
        count += 1;
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('demo_seeded', '1')").run();
    });
    return { seeded: count };
  }

  /**
   * Empty the knowledge base.
   *
   * The four libraries (words, phrases, collocations, sentences) are what the
   * learner keeps, and every one of them is reachable only through a knowledge
   * row: `searchKnowledge` joins on `user_knowledge`. Clearing that table
   * empties the libraries without touching the articles, which keeps their
   * bodies and analyses intact — an analysis simply stops being "in the
   * library" until the learner adds it again.
   *
   * The entities themselves are kept, because the articles still reference
   * them (`article_words`, `article_collocations`, `article_sentences`): the
   * reader still shows a word card with its meaning, it just no longer claims
   * the learner saved it.
   * @returns {{cleared: number, byKind: object}} how many rows went.
   */
  function clearKnowledge() {
    const before = db.prepare('SELECT entity_type, COUNT(*) AS n FROM user_knowledge GROUP BY entity_type').all();
    const byKind = {};
    let cleared = 0;
    for (const row of before) {
      byKind[row.entity_type] = row.n;
      cleared += row.n;
    }
    transact(db, () => db.prepare('DELETE FROM user_knowledge').run());
    // Sentence library entries are the same rows: a sentence is "kept" only
    // through its knowledge row, so the sentence table keeps the text and the
    // library shows nothing.
    return { cleared, byKind };
  }

  /** Remove every demo article. */
  function removeDemo() {
    const rows = db.prepare('SELECT id FROM articles WHERE demo = 1').all();
    for (const row of rows) removeArticleBody(dirs, row.id);
    db.prepare('DELETE FROM articles WHERE demo = 1').run();
    return { removed: rows.length };
  }

  // ---------------------------------------------------------------- startup

  const settingsRow = db.prepare('SELECT value FROM app_settings LIMIT 1').get();

  return {
    dirs,
    listArticles,
    getArticle,
    dashboard,
    deleteArticle,
    listProfiles,
    saveProfile,
    deleteProfile,
    discover,
    importUrl,
    createArticle,
    cleanStoredArticle,
    discardCandidates,
    confirmImport,
    startAnalysis,
    retryStage,
    retrySentence,
    revalidateSentences,
    cancelAnalysis,
    analysisState,
    resumeInterrupted,
    searchKnowledge,
    knowledgeDetail,
    updateKnowledge,
    reviewQueue,
    pendingCandidates,
    savePluginSettings,
    discoverProgress,
    saveProgress,
    studyActivity,
    saveNote,
    settings,
    sourceHealth,
    speak,
    speakSentence,
    speechStats,
    clearSpeechCache,
    exportData,
    importData,
    seedDemo,
    removeDemo,
    clearKnowledge,
    /** Await every in-flight analysis (used by graceful shutdown). */
    async drain() {
      await Promise.allSettled([...queue.values()]);
    },
  };
}
