/**
 * English Reader — local persistence layer.
 *
 * SQLite (node:sqlite) plus a per-article file directory. Every write goes
 * through short transactions; migrations are versioned and idempotent so a
 * restart never rebuilds the database.
 *
 * The module deliberately imports only Node builtins: the plugin is installed
 * as a profile bundle and must not depend on host package resolution.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 4;

const MIGRATION_V1 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_name TEXT,
  author TEXT,
  source_url TEXT,
  published_at TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  topic TEXT,
  cefr_level TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  reading_minutes INTEGER,
  content_hash TEXT NOT NULL,
  content_path TEXT,
  thumbnail TEXT,
  snippet TEXT,
  status TEXT NOT NULL DEFAULT 'FETCHED',
  reading_status TEXT NOT NULL DEFAULT 'unread',
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_cefr ON articles(cefr_level);

CREATE TABLE IF NOT EXISTS article_sources (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_name TEXT,
  fetched_at TEXT,
  UNIQUE(article_id, source_url)
);

CREATE TABLE IF NOT EXISTS collection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovered_articles (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source_name TEXT,
  published_at TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  cefr_level TEXT,
  snippet TEXT,
  score REAL NOT NULL DEFAULT 0,
  reasons_json TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  content_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(url)
);

CREATE TABLE IF NOT EXISTS article_analyses (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  prompt_bundle_version TEXT,
  overview_json TEXT,
  difficulty_json TEXT,
  review_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(article_id, version)
);

CREATE TABLE IF NOT EXISTS analysis_tasks (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES article_analyses(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  input_hash TEXT,
  output_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  updated_at TEXT,
  completed_at TEXT,
  UNIQUE(analysis_id, stage)
);

CREATE TABLE IF NOT EXISTS vocabulary (
  id TEXT PRIMARY KEY,
  lemma TEXT NOT NULL,
  normalized_key TEXT NOT NULL UNIQUE,
  phonetic TEXT,
  part_of_speech_json TEXT,
  meanings_json TEXT,
  word_formation_json TEXT,
  cefr_level TEXT,
  synonyms_json TEXT,
  antonyms_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phrases (
  id TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL UNIQUE,
  expression TEXT NOT NULL,
  phrase_type TEXT,
  meaning TEXT,
  explanation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collocations (
  id TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL UNIQUE,
  expression TEXT NOT NULL,
  pattern TEXT,
  meaning TEXT,
  explanation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  normalized_hash TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_words (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  vocabulary_id TEXT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
  context_meaning TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  evidence_json TEXT,
  UNIQUE(article_id, vocabulary_id)
);

CREATE TABLE IF NOT EXISTS article_phrases (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  phrase_id TEXT NOT NULL REFERENCES phrases(id) ON DELETE CASCADE,
  evidence_json TEXT,
  UNIQUE(article_id, phrase_id)
);

CREATE TABLE IF NOT EXISTS article_collocations (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  collocation_id TEXT NOT NULL REFERENCES collocations(id) ON DELETE CASCADE,
  evidence_json TEXT,
  UNIQUE(article_id, collocation_id)
);

CREATE TABLE IF NOT EXISTS article_sentences (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  paragraph_index INTEGER NOT NULL,
  sentence_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  analysis_json TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  error_message TEXT,
  raw_output TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  uncertainty_notes TEXT,
  UNIQUE(article_id, sentence_index)
);

CREATE TABLE IF NOT EXISTS user_knowledge (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  mastery_level INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS reading_progress (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  current_sentence_index INTEGER NOT NULL DEFAULT 0,
  progress_ratio REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_notes (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  sentence_index INTEGER,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_overrides (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES article_analyses(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(analysis_id, entity_type, entity_id, field_path)
);

CREATE TABLE IF NOT EXISTS llm_call_logs (
  id TEXT PRIMARY KEY,
  job TEXT,
  article_id TEXT,
  analysis_id TEXT,
  stage TEXT,
  model TEXT,
  prompt_version TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per real study interaction. The contribution grid is built from
-- these, not from estimated reading time: articles.reading_minutes is an
-- estimate of effort, not evidence that a day was studied.
CREATE TABLE IF NOT EXISTS study_events (
  id TEXT PRIMARY KEY,
  -- Local calendar day (YYYY-MM-DD) so the grid matches the learner's own days.
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  article_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  -- Seconds attributed to this event. Reading time is measured, not estimated.
  seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_events_day ON study_events(day);
CREATE INDEX IF NOT EXISTS idx_study_events_created ON study_events(created_at);
`;

/** ISO timestamp for every written row. */
export function now() {
  return new Date().toISOString();
}

/** SHA-256 hex of a string. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable domain key: lower-case, whitespace/punctuation collapsed. */
export function normalizeKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Article statuses used across the workflow. */
export const ARTICLE_STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  FETCHING: 'FETCHING',
  FETCHED: 'FETCHED',
  ANALYZING: 'ANALYZING',
  PARTIAL_COMPLETED: 'PARTIAL_COMPLETED',
  COMPLETED: 'COMPLETED',
  FETCH_FAILED: 'FETCH_FAILED',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
});

/** Ordered analysis stages, with their dependencies. */
export const STAGES = Object.freeze([
  { name: 'OVERVIEW', dependsOn: [] },
  { name: 'DIFFICULTY', dependsOn: [] },
  { name: 'VOCABULARY', dependsOn: [] },
  { name: 'PHRASES', dependsOn: [] },
  { name: 'COLLOCATIONS', dependsOn: [] },
  { name: 'SEGMENTATION', dependsOn: [] },
  { name: 'SENTENCE_ANALYSIS', dependsOn: ['SEGMENTATION'] },
  { name: 'REVIEW', dependsOn: ['OVERVIEW', 'SEGMENTATION'] },
]);

/**
 * Open (or create) the English Reader database and run migrations.
 * @param {string} dataDir absolute data directory.
 * @returns {{db: DatabaseSync, dirs: Record<string, string>}} opened handle.
 */
export function openStore(dataDir) {
  const dirs = {
    root: dataDir,
    database: join(dataDir, 'database'),
    articles: join(dataDir, 'articles'),
    exports: join(dataDir, 'exports'),
    backups: join(dataDir, 'backups'),
    logs: join(dataDir, 'logs'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dirs.database, 'english-reader.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // A fresh database has no schema_meta table yet, so existence is read from
  // sqlite_master before the version row can be queried.
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
  if (hasMeta === undefined) {
    db.exec(MIGRATION_V1);
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else {
    const current = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    if (current === undefined) {
      db.exec(MIGRATION_V1);
      db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(current.value) < SCHEMA_VERSION) {
      db.exec(MIGRATION_V1);
      // v2 adds per-sentence diagnostics. `ALTER TABLE` is idempotent-guarded by
      // probing the existing columns, so an interrupted upgrade can rerun.
      const columns = new Set(db.prepare('PRAGMA table_info(article_sentences)').all().map((row) => row.name));
      const pending = [];
      for (const [name, type] of [
        ['error_code', 'TEXT'], ['error_message', 'TEXT'], ['raw_output', 'TEXT'],
        ['attempts', 'INTEGER NOT NULL DEFAULT 1'],
      ]) {
        if (!columns.has(name)) pending.push([name, type]);
      }
      // A concurrent reader (another Harness process) can hold the schema lock
      // briefly; retry a few times rather than failing plugin activation.
      let lastError;
      for (let attempt = 0; attempt < 5 && pending.length > 0; attempt += 1) {
        try {
          while (pending.length > 0) {
            const [name, type] = pending[0];
            db.exec(`ALTER TABLE article_sentences ADD COLUMN ${name} ${type}`);
            pending.shift();
          }
        } catch (error) {
          lastError = error;
          if (!/locked|busy/i.test(String(error?.message ?? ''))) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (attempt + 1));
        }
      }
      if (pending.length > 0) throw lastError;
      // v3: add the column the parser now fills, without rewriting existing
      // verdicts. A migration is the wrong place to overrule a recorded
      // evidence failure; `revalidateSentences()` is the audited path for that.
      const cols2 = new Set(db.prepare('PRAGMA table_info(article_sentences)').all().map((row) => row.name));
      if (!cols2.has('uncertainty_notes')) {
        db.exec('ALTER TABLE article_sentences ADD COLUMN uncertainty_notes TEXT');
      }
      db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    }
  }
  return { db, dirs };
}

/** Read one article's cleaned text from its file, falling back to nothing. */
export function readArticleBody(dirs, article) {
  if (!article?.content_path) return '';
  const path = join(dirs.root, article.content_path);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Persist cleaned text and return the relative content path. */
export function writeArticleBody(dirs, articleId, text, rawHtml) {
  const dir = join(dirs.articles, articleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cleaned.md'), text, 'utf8');
  if (rawHtml) writeFileSync(join(dir, 'source.html'), rawHtml, 'utf8');
  return join('articles', articleId, 'cleaned.md');
}

/** Remove an article's files. */
export function removeArticleBody(dirs, articleId) {
  const dir = join(dirs.articles, articleId);
  if (dir.startsWith(dirs.articles) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Data directory facts for the settings page. */
export function diskUsage(dirs) {
  let bytes = 0;
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        try {
          bytes += statSync(child).size;
        } catch {
          /* unreadable file counts as zero */
        }
      }
    }
  };
  walk(dirs.root);
  return bytes;
}

/** A fresh identifier. */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
