/**
 * English Reader — Host half.
 *
 * Owns the facade (SQLite + files), exposes it to the browser half over one
 * authenticated `/api/` POST route, and registers the agent tools that share
 * those same operations.
 *
 * `ctx.connection.fetch.register` puts the route inside the Harness
 * authentication fence, so only the authenticated browser Peer reaches it.
 * Only Node builtins are imported: a profile bundle must not depend on bare
 * `@deepseek-ai/*` specifiers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createFacade } from './facade.js';
import { ReaderError, ERROR_CODES, allowSyntheticRanges } from './net.js';

/** Route path the browser half calls. */
const ROUTE_PATH = '/api/english-reader';

/** Plugin display name. */
const name = 'english-reader';

/** Services this plugin needs; `llm`/`web` stay optional through ctx.get. */
const inject = ['connection', 'tools'];

/** Read the packaged demo library once. */
function loadDemo() {
  try {
    const url = new URL('./demo-library.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return [];
  }
}

/** Resolve the data directory, defaulting under the Harness home. */
function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'english-reader');
}

/** Normalize any thrown value into a coded error envelope. */
function toError(error) {
  if (error instanceof ReaderError) return { status: 400, body: { ok: false, error: error.toJSON() } };
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { ok: false, error: { code: ERROR_CODES.DATABASE_ERROR, message } } };
}

/**
 * Build the operation table shared by the RPC route and the agent tools.
 * @param {object} facade application facade.
 * @param {() => Promise<string|null>} accountName signed-in display name, or null.
 * @returns {Record<string, Function>} operation map.
 */
function operations(facade, accountName = async () => null) {
  return {
    dashboard: () => facade.dashboard(),
    listArticles: (args) => facade.listArticles(args ?? {}),
    getArticle: (args) => facade.getArticle(args.articleId),
    deleteArticle: (args) => facade.deleteArticle(args.articleId),
    listProfiles: () => facade.listProfiles(),
    saveProfile: (args) => facade.saveProfile(args.profile ?? args),
    deleteProfile: (args) => facade.deleteProfile(args.profileId),
    discover: (args) => facade.discover(args.profileId, args.limit),
    importUrl: (args) => facade.importUrl(args.url),
    createArticle: (args) => facade.createArticle(args.article ?? args),
    cleanArticle: (args) => facade.cleanStoredArticle(args.articleId),
    confirmImport: (args) => facade.confirmImport(args.candidateIds ?? []),
    pendingCandidates: (args) => facade.pendingCandidates(args),
    savePluginSettings: (args) => facade.savePluginSettings(args ?? {}),
    discoverProgress: () => facade.discoverProgress(),
    startAnalysis: (args) => facade.startAnalysis(args.articleId),
    retryStage: (args) => facade.retryStage(args.articleId, args.stage),
    retrySentence: (args) => facade.retrySentence(args.articleId, args.sentenceIndex),
    revalidateSentences: (args) => facade.revalidateSentences(args.articleId),
    cancelAnalysis: (args) => facade.cancelAnalysis(args.articleId),
    analysisState: (args) => facade.analysisState(args.articleId),
    searchKnowledge: (args) => facade.searchKnowledge(args ?? {}),
    knowledgeDetail: (args) => facade.knowledgeDetail(args.kind, args.entityId),
    updateKnowledge: (args) => facade.updateKnowledge(args),
    reviewQueue: (args) => facade.reviewQueue(args?.limit ?? 20),
    saveProgress: (args) => facade.saveProgress(args),
    saveNote: (args) => facade.saveNote(args),
    settings: () => facade.settings(),
    collectionMeta: () => facade.settings().collection,
    sourceHealth: () => facade.sourceHealth(),
    studyActivity: (args) => facade.studyActivity(args),
    // Cosmetic: the greeting falls back to a plain hello when this is null.
    accountName: () => accountName(),
    speak: (args) => facade.speak(args),
    speakSentence: (args) => facade.speakSentence(args.articleId, args.sentenceIndex, args.voice, args.rate),
    speechStats: () => facade.speechStats(),
    clearSpeechCache: () => facade.clearSpeechCache(),
    exportData: () => facade.exportData(),
    importData: (args) => facade.importData(args.payload),
    seedDemo: () => facade.seedDemo(),
    removeDemo: () => facade.removeDemo(),
    resumeInterrupted: () => facade.resumeInterrupted(),
  };
}

/** Read a bounded JSON body from a WHATWG Request. */
async function readJson(request, limit = 3 * 1024 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'That request body is too large.');
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'The request body was not valid JSON.');
  }
}

/** Content block helpers for tool rendering. */
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

/**
 * Register the Host RPC route and the agent tools.
 * @param {object} ctx plugin context.
 * @param {object} config deployment configuration (raw row config).
 */
export function apply(ctx, config) {
  // A fake-IP proxy resolves real hostnames into synthetic ranges. The profile's
  // `web-fetch-lan` row declares those ranges, so the SSRF guard learns them
  // once: real private literals stay refused, synthetic ones become fetchable.
  //
  // The values usually live in a profile PATCH layer, not on the loader entry
  // itself, so `entry.options.config` is empty. `configuration()` is the API
  // that returns the composed inherited + override values.
  const isLanEntry = (entry) => entry?.options?.id === 'web-fetch-lan'
    || entry?.options?.name === '@deepseek-ai/dsh-web-fetch-lan';
  const collectRanges = (raw) => ({
    v4: Array.isArray(raw?.fakeIpRanges) ? raw.fakeIpRanges : [],
    v6: Array.isArray(raw?.fakeIpRanges6) ? raw.fakeIpRanges6 : [],
  });
  try {
    const editor = ctx.get('configEditor');
    let ranges = { v4: [], v6: [] };

    // 1. Composed profile layers (the normal case).
    if (typeof editor?.configuration === 'function') {
      const row = editor.configuration().find((item) => isLanEntry(item.entry));
      if (row !== undefined) {
        ranges = collectRanges({ ...(row.inherited ?? {}), ...(row.override ?? {}) });
      }
    }
    // 2. Inline config on the loader entry.
    if (ranges.v4.length === 0 && ranges.v6.length === 0) {
      const entry = editor?.entries?.().find(isLanEntry);
      ranges = collectRanges(entry?.options?.config);
    }
    // 3. An explicit list on this plugin's own config wins over discovery.
    const own = collectRanges(config);
    if (own.v4.length > 0 || own.v6.length > 0) ranges = own;

    if (ranges.v4.length > 0 || ranges.v6.length > 0) {
      allowSyntheticRanges(ranges);
      ctx.logger?.info?.(`english-reader: synthetic DNS ranges allowed (v4=${ranges.v4.length}, v6=${ranges.v6.length})`);
    } else {
      ctx.logger?.warn?.('english-reader: no fake-IP ranges declared; synthetic DNS stays refused');
    }
  } catch (error) {
    ctx.logger?.warn?.(`english-reader: could not read proxy ranges (${error.message}); synthetic DNS stays refused`);
  }
  const dataDir = resolveDataDir(config?.dataDir);
  const facade = createFacade({
    dataDir,
    config: {
      sentenceConcurrency: Number(config?.sentenceConcurrency) || 2,
      retryLimit: Number(config?.retryLimit) || 2,
      wordsPerArticle: Number(config?.wordsPerArticle) || 15,
    },
    llm: ctx.get('llm'),
    defaultModel: ctx.get('agentDefaultModel'),
    web: ctx.get('web'),
    logger: ctx.logger ?? console,
    demo: loadDemo(),
    version: '1.0.0',
  });
  /**
   * The signed-in account's display name, or null when unavailable.
   *
   * Read live from the Host account service rather than cached: the greeting is
   * cosmetic, so a signed-out or failing account must degrade to a plain hello
   * instead of surfacing an error or a stale name.
   */
  async function readAccountName() {
    try {
      const account = ctx.get('deepseekAccount');
      if (account === undefined || typeof account.getProfile !== 'function') return null;
      const profile = await account.getProfile({
        version: '1.0.0',
        locale: 'en',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      const name = profile?.status === 'ready' ? profile.value.name : null;
      const trimmed = typeof name === 'string' ? name.trim() : '';
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      ctx.logger?.warn?.(`english-reader: account name unavailable (${error?.message ?? error})`);
      return null;
    }
  }

  const ops = operations(facade, readAccountName);

  // Seed the sample library and adopt any work a previous process left behind.
  try {
    facade.seedDemo();
    facade.resumeInterrupted();
  } catch (error) {
    ctx.logger?.warn?.(`english-reader: startup recovery failed: ${error.message}`);
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        const failure = toError(error);
        return Response.json(failure.body, { status: failure.status });
      }
      const op = typeof body.op === 'string' ? ops[body.op] : undefined;
      if (op === undefined) {
        return Response.json({ ok: false, error: { code: 'UNKNOWN_OPERATION', message: `Unknown operation "${String(body.op)}".` } }, { status: 404 });
      }
      try {
        const value = await op(body.args ?? {});
        // The `speak` operation returns MP3 bytes; every other operation is
        // JSON. Sending audio as a binary body avoids base64 padding in the
        // browser, while `?format=json` keeps the metadata shape available.
        if (body.op === 'speak' || body.op === 'speakSentence') {
          if (body.format === 'json') return Response.json({ ok: true, value });
          const audio = Buffer.from(value.audio, 'base64');
          return new Response(audio, {
            status: 200,
            headers: {
              'content-type': value.mime ?? 'audio/mpeg',
              'content-length': String(audio.length),
              'cache-control': 'no-store',
              'x-speech-voice': value.voice,
              'x-speech-bytes': String(value.bytes),
            },
          });
        }
        return Response.json({ ok: true, value });
      } catch (error) {
        const failure = toError(error);
        return Response.json(failure.body, { status: failure.status });
      }
    },
  }), 'english-reader: /api/english-reader');

  /** Register one agent tool, logging rather than throwing on failure. */
  const register = (definition) => {
    try {
      ctx.tools.register(definition);
    } catch (error) {
      ctx.logger?.warn?.(`english-reader: tool ${definition.name} was not registered: ${error.message}`);
    }
  };

  register({
    name: 'english_reader_search',
    description: 'Search the English Reader library (articles, vocabulary, phrases, collocations, sentences) and report what exists. Use it before importing so you can tell the user what they already have.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['articles', 'word', 'phrase', 'collocation', 'sentence'],
          description: 'Which collection to search.',
        },
        query: { type: 'string', description: 'Free-text filter; omit to list recent entries.' },
        limit: { type: 'number', description: 'Maximum rows, 1-50 (default 10).' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string' },
          total: { type: 'number' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        },
        required: ['scope', 'total', 'items'],
      },
      render: (_args, value) => text(value.items),
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
      if (args.scope === 'articles') {
        const page = facade.listArticles({ search: args.query, limit });
        return {
          scope: 'articles',
          total: page.total,
          items: page.items.map((item) => ({
            articleId: item.id, title: item.title, source: item.sourceName,
            cefr: item.cefrLevel, words: item.wordCount, status: item.status, reading: item.readingStatus,
          })),
        };
      }
      const rows = facade.searchKnowledge({ kind: args.scope, search: args.query, limit });
      return { scope: args.scope, total: rows.length, items: rows };
    },
  });

  register({
    name: 'english_reader_import',
    description: 'Import one English article into the library, either by URL (fetched and cleaned here) or from pasted text. Returns the new article id and its segmentation counts; duplicate URLs and identical bodies are reported instead of duplicated.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Article URL to fetch. Provide this or text.' },
        text: { type: 'string', description: 'Pasted article body. Provide this or url.' },
        title: { type: 'string', description: 'Title for a pasted article; ignored for URLs.' },
        sourceName: { type: 'string', description: 'Publication name for a pasted article.' },
        analyze: { type: 'boolean', description: 'Start the full AI analysis immediately (default false).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          articleId: { type: 'string' },
          title: { type: 'string' },
          wordCount: { type: 'number' },
          sentenceCount: { type: 'number' },
          analysisId: { type: 'string' },
        },
        required: ['articleId', 'title', 'wordCount', 'sentenceCount'],
      },
      render: (_args, value) => text(`Imported "${value.title}" (${value.wordCount} words, ${value.sentenceCount} sentences) as ${value.articleId}.${value.analysisId ? ` Analysis ${value.analysisId} started.` : ''}`),
    },
    async execute(args) {
      let saved;
      if (typeof args.url === 'string' && args.url.trim().length > 0) {
        const preview = await facade.importUrl(args.url.trim());
        saved = facade.createArticle({
          title: preview.title, text: preview.text, sourceUrl: preview.url,
          sourceName: preview.sourceName, cefrLevel: preview.cefrLevel,
        });
      } else if (typeof args.text === 'string' && args.text.trim().length > 0) {
        saved = facade.createArticle({
          title: args.title ?? 'Untitled article', text: args.text,
          sourceName: args.sourceName ?? null,
        });
      } else {
        throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'Provide a url or article text.');
      }
      const detail = facade.getArticle(saved.id);
      const result = {
        articleId: saved.id, title: detail.article.title, wordCount: detail.wordCount,
        sentenceCount: detail.sentences.length,
      };
      if (args.analyze === true) {
        result.analysisId = facade.startAnalysis(saved.id).analysisId;
      }
      return result;
    },
  });

  register({
    name: 'english_reader_analyze',
    description: 'Run or inspect the AI analysis of one imported article: reading guide, CEFR estimate, vocabulary, phrases, collocations, sentence-by-sentence breakdown, and review questions. Use action "status" to poll progress and "retry" to re-run only one failed stage.',
    parameters: {
      type: 'object',
      properties: {
        articleId: {
          type: 'string',
          description: 'Article id from english_reader_import or a search result.',
        },
        action: {
          type: 'string',
          enum: ['start', 'status', 'retry', 'cancel', 'revalidate'],
          description: 'start begins a full analysis; status reads progress; retry re-runs one stage; cancel stops a run.',
        },
        stage: {
          type: 'string',
          enum: ['OVERVIEW', 'DIFFICULTY', 'VOCABULARY', 'PHRASES', 'COLLOCATIONS', 'SEGMENTATION', 'SENTENCE_ANALYSIS', 'REVIEW'],
          description: 'Stage to retry; required for action retry.',
        },
        sentenceIndex: {
          type: 'number',
          description: 'With action retry and stage SENTENCE_ANALYSIS, re-run this single sentence instead of the whole stage.',
        },
      },
      required: ['articleId', 'action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          articleId: { type: 'string' },
          analysisId: { type: 'string' },
          status: { type: 'string' },
          completed: { type: 'number' },
          total: { type: 'number' },
          stages: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          revalidated: { type: 'object', additionalProperties: true, properties: {} },

        },
        required: ['action', 'articleId', 'total', 'stages'],
      },
      render: (_args, value) => text(value.stages),
    },
    async execute(args, exec) {
      if (args.action === 'start') {
        const started = facade.startAnalysis(args.articleId);
        const state = facade.analysisState(args.articleId);
        return { action: 'start', articleId: args.articleId, analysisId: started.analysisId, status: 'RUNNING', completed: state?.completed ?? 0, total: state?.total ?? 8, stages: state?.stages ?? [] };
      }
      if (args.action === 'retry') {
        if (typeof args.stage !== 'string') throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'action retry needs a stage.');
        if (args.stage === 'SENTENCE_ANALYSIS' && typeof args.sentenceIndex === 'number') {
          const single = await facade.retrySentence(args.articleId, args.sentenceIndex, exec?.signal);
          const state = facade.analysisState(args.articleId);
          return {
            action: 'retry', articleId: args.articleId, analysisId: state?.id,
            status: single.ok ? 'SUCCEEDED' : 'FAILED',
            completed: state?.completed ?? 0, total: state?.total ?? 8, stages: state?.stages ?? [],
          };
        }
        const state = await facade.retryStage(args.articleId, args.stage);
        return { action: 'retry', articleId: args.articleId, analysisId: state?.id, status: state?.status, completed: state?.completed ?? 0, total: state?.total ?? 8, stages: state?.stages ?? [] };
      }
      if (args.action === 'revalidate') {
        const result = facade.revalidateSentences(args.articleId);
        const state = facade.analysisState(args.articleId);
        return {
          action: 'revalidate', articleId: args.articleId, analysisId: state?.id,
          status: state?.status, completed: state?.completed ?? 0, total: state?.total ?? 8,
          stages: state?.stages ?? [], revalidated: result,
        };
      }
      if (args.action === 'cancel') {
        const result = facade.cancelAnalysis(args.articleId);
        const state = facade.analysisState(args.articleId);
        return { action: 'cancel', articleId: args.articleId, analysisId: state?.id, status: result.cancelled ? 'CANCELLED' : state?.status, completed: state?.completed ?? 0, total: state?.total ?? 8, stages: state?.stages ?? [] };
      }
      const state = facade.analysisState(args.articleId);
      if (state === null) throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'That article has no analysis yet; start one first.');
      return { action: 'status', articleId: args.articleId, analysisId: state.id, status: state.status, completed: state.completed, total: state.total, stages: state.stages };
    },
  });

  register({
    name: 'english_reader_speak',
    description: 'Synthesize speech for an English word, phrase or full sentence with Microsoft Edge neural voices (edge-tts). Returns MP3 audio as an attachment, so the result is playable and can be saved. Audio is cached by voice, rate and text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak, up to about 1200 characters. Use this or articleId + sentenceIndex.' },
        articleId: { type: 'string', description: 'Article whose stored sentence should be spoken.' },
        sentenceIndex: { type: 'number', description: 'Zero-based sentence index inside that article.' },
        voice: {
          type: 'string',
          enum: ['en-US-AriaNeural', 'en-US-GuyNeural', 'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-AU-NatashaNeural'],
          description: 'Neural voice; defaults to en-US-AriaNeural.',
        },
        rate: { type: 'number', description: 'Speaking rate percentage, -50 to +100; defaults to 0.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          voice: { type: 'string' },
          rate: { type: 'number' },
          bytes: { type: 'number' },
          cached: { type: 'boolean' },
        },
        required: ['text', 'voice', 'rate', 'bytes', 'cached'],
      },
      render: (_args, value) => text(`Spoke ${JSON.stringify(value.text)} with ${value.voice} (${value.bytes} bytes${value.cached ? ', cached' : ''}).`),
    },
    async execute(args, exec) {
      const source = typeof args.text === 'string' && args.text.trim().length > 0
        ? args.text
        : facade.getArticle(args.articleId).sentences.find((item) => item.sentenceIndex === Number(args.sentenceIndex))?.text;
      if (typeof source !== 'string' || source.trim().length === 0) {
        throw new ReaderError(ERROR_CODES.SCHEMA_VALIDATION_FAILED, 'Provide speech text, or an articleId with a known sentenceIndex.');
      }
      const result = await facade.speak({ text: source, voice: args.voice, rate: args.rate }, exec?.signal);
      return {
        text: source.slice(0, 200), voice: result.voice, rate: result.rate,
        bytes: result.bytes, cached: result.cached,
      };
    },
  });

  register({
    name: 'english_reader_knowledge',
    description: 'Manage the learner knowledge base: bookmark or unbookmark a word/phrase/collocation/sentence, set mastery 0-4, or attach a note. These writes are visible immediately in the plugin UI.',
    parameters: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['word', 'phrase', 'collocation', 'sentence'],
          description: 'Knowledge kind.',
        },
        entityId: { type: 'string', description: 'Entity id from english_reader_search.' },
        favorite: { type: 'boolean', description: 'Bookmark state to set.' },
        masteryLevel: { type: 'number', description: 'Mastery 0 (unseen) to 4 (mastered).' },
        notes: { type: 'string', description: 'Replacement note text.' },
      },
      required: ['entityType', 'entityId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entityType: { type: 'string' },
          entityId: { type: 'string' },
          favorite: { type: 'boolean' },
          masteryLevel: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['entityType', 'entityId', 'favorite', 'masteryLevel', 'notes'],
      },
      render: (_args, value) => text(`${value.entityType} ${value.entityId}: favorite=${value.favorite} mastery=${value.masteryLevel}`),
    },
    async execute(args) {
      const result = facade.updateKnowledge({
        entityType: args.entityType, entityId: args.entityId,
        favorite: args.favorite, masteryLevel: args.masteryLevel, notes: args.notes,
      });
      return { ...result, notes: result.notes ?? '' };
    },
  });
}

export { name, inject };
