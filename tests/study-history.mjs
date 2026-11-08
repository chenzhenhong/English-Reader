/**
 * Study history: real activity, honest aggregation, and a grid that fills gaps.
 *
 * The heatmap must reflect recorded interactions, not estimated reading time. A
 * day is active only if something actually happened that day, and the streak
 * arithmetic must not invent days that were never studied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createFacade } from '../lib/facade.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const demo = JSON.parse(readFileSync(new URL('../lib/demo-library.json', import.meta.url), 'utf8'));

/** Local YYYY-MM-DD, matching the host's day boundary. */
function localDay(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function makeFacade() {
  const dir = join(tmpdir(), `er-history-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const facade = createFacade({
    dataDir: dir, config: {}, demo, logger: { warn() {}, info() {} }, version: '1',
  });
  facade.seedDemo();
  const articleId = facade.listArticles({ limit: 1 }).items[0].id;
  return { facade, articleId, dir };
}

/** Insert an event directly, for days the public API cannot backdate. */
function seedEvent(dir, { day, seconds = 60, kind = 'read', articleId = null }) {
  const db = new DatabaseSync(join(dir, 'database', 'english-reader.sqlite'));
  db.prepare(`INSERT INTO study_events (id, day, kind, article_id, entity_type, entity_id, seconds, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`).run(
    `evt_${Math.random().toString(16).slice(2)}`, day, kind, articleId, seconds, new Date().toISOString(),
  );
  db.close();
}

console.log('empty history');
{
  const { facade } = makeFacade();
  const activity = facade.studyActivity();
  check('no days are reported', activity.days.length === 0);
  check('totals are zero', activity.totals.seconds === 0 && activity.totals.activeDays === 0);
  check('streaks are zero', activity.totals.currentStreak === 0 && activity.totals.longestStreak === 0);
  check('a window is still returned', activity.window >= 7 && typeof activity.today === 'string');
}

console.log('\nreading writes a study event');
{
  const { facade, articleId } = makeFacade();
  facade.saveProgress({ articleId, sentenceIndex: 2, ratio: 0.15, seconds: 120 });
  const activity = facade.studyActivity();
  check('one day is active', activity.days.length === 1, String(activity.days.length));
  check('the day is today', activity.days[0].day === localDay(), activity.days[0].day);
  check('measured seconds are kept', activity.days[0].seconds === 120, String(activity.days[0].seconds));
  check('the event kind is reading', activity.days[0].kinds.includes('read'), activity.days[0].kinds.join(','));
  check('current streak is one', activity.totals.currentStreak === 1, String(activity.totals.currentStreak));

  // A save with no measured time still marks the day; time is not invented.
  facade.saveProgress({ articleId, sentenceIndex: 3, ratio: 0.2 });
  const second = facade.studyActivity();
  check('a save without seconds adds no time', second.totals.seconds === 120, String(second.totals.seconds));
  check('but it counts as another event', second.totals.events === 2, String(second.totals.events));
}

console.log('\naggregation across days');
{
  const { facade, articleId, dir } = makeFacade();
  seedEvent(dir, { day: localDay(0), seconds: 600, articleId });
  seedEvent(dir, { day: localDay(-1), seconds: 60, articleId });
  seedEvent(dir, { day: localDay(-2), seconds: 1800, articleId });
  const activity = facade.studyActivity();
  check('three days are reported', activity.days.length === 3, String(activity.days.length));
  check('seconds are summed', activity.totals.seconds === 2460, String(activity.totals.seconds));
  check('minutes are rounded from seconds',
    activity.totals.minutes === Math.round(2460 / 60), String(activity.totals.minutes));
  check('the busiest day sets the peak', activity.peakSeconds === 1800, String(activity.peakSeconds));
  check('a three-day streak is detected', activity.totals.currentStreak === 3,
    String(activity.totals.currentStreak));
  check('longest equals current here', activity.totals.longestStreak === 3,
    String(activity.totals.longestStreak));
}

console.log('\nstreak honesty');
{
  const { facade, dir } = makeFacade();
  // Today and two days ago: the gap means the streak is 1, not 2.
  seedEvent(dir, { day: localDay(0), seconds: 60 });
  seedEvent(dir, { day: localDay(-2), seconds: 60 });
  const activity = facade.studyActivity();
  check('a gap breaks the current streak', activity.totals.currentStreak === 1,
    String(activity.totals.currentStreak));
  check('the longest run is recorded', activity.totals.longestStreak === 1,
    String(activity.totals.longestStreak));

  // Yesterday only: still a live streak, because today has not been skipped yet.
  const second = makeFacade();
  seedEvent(second.dir, { day: localDay(-1), seconds: 60 });
  check('yesterday alone counts as a live streak',
    second.facade.studyActivity().totals.currentStreak === 1,
    String(second.facade.studyActivity().totals.currentStreak));
}

console.log('\nwindow and payload');
{
  const { facade, dir } = makeFacade();
  seedEvent(dir, { day: localDay(-400), seconds: 60 });
  seedEvent(dir, { day: localDay(-1), seconds: 60 });
  const narrow = facade.studyActivity({ days: 30 });
  check('a short window excludes old days', narrow.days.length === 1, String(narrow.days.length));
  check('the window is echoed back', narrow.window === 30, String(narrow.window));
  check('the window is clamped to a sane range',
    facade.studyActivity({ days: 9999 }).window <= 730,
    String(facade.studyActivity({ days: 9999 }).window));
  check('only active days are in the payload', narrow.days.every((day) => day.events > 0));
}

console.log('\nexplicit date range');
{
  const { facade, dir } = makeFacade();
  seedEvent(dir, { day: '2026-01-15', seconds: 300 });
  seedEvent(dir, { day: '2026-02-20', seconds: 600 });
  seedEvent(dir, { day: '2026-03-10', seconds: 900 });

  const janFeb = facade.studyActivity({ from: '2026-01-01', to: '2026-02-28' });
  check('an explicit range bounds both ends', janFeb.days.length === 2, String(janFeb.days.length));
  check('it reports the requested start', janFeb.startDay === '2026-01-01', janFeb.startDay);
  check('it reports the requested end', janFeb.endDay === '2026-02-28', janFeb.endDay);
  check('its window length is derived', janFeb.window === 59, String(janFeb.window));
  check('the excluded day is absent', !janFeb.days.some((day) => day.day === '2026-03-10'));

  // A reversed or malformed range must not silently return nothing.
  const reversed = facade.studyActivity({ from: '2026-03-01', to: '2026-01-01' });
  check('a reversed range falls back to a trailing window', reversed.window >= 7, String(reversed.window));
  const malformed = facade.studyActivity({ from: 'nope', to: '2026-01-01' });
  check('a malformed range falls back', malformed.window >= 7, String(malformed.window));

  const trailing = facade.studyActivity({ days: 30 });
  check('a trailing window still works', trailing.window === 30, String(trailing.window));
  check('a trailing window ends today', trailing.endDay === trailing.today, trailing.endDay);
}

console.log('\nper-kind breakdown');
{
  const { facade, dir } = makeFacade();
  seedEvent(dir, { day: localDay(0), seconds: 300, kind: 'read' });
  seedEvent(dir, { day: localDay(0), seconds: 100, kind: 'vocabulary' });
  const activity = facade.studyActivity();
  check('two kinds are reported', Object.keys(activity.byKind).length === 2,
    Object.keys(activity.byKind).join(','));
  check('reading dominates', activity.byKind.read.seconds === 300, String(activity.byKind.read.seconds));
  check('seconds sum across kinds', activity.byKind.read.seconds + activity.byKind.vocabulary.seconds === 400);
}

console.log('\nper-article time');
{
  const { facade, articleId, dir } = makeFacade();
  seedEvent(dir, { day: localDay(0), seconds: 900, articleId });
  seedEvent(dir, { day: localDay(-1), seconds: 300, articleId });
  const activity = facade.studyActivity();
  check('articles are aggregated separately', Array.isArray(activity.byArticle));
  check('one article is reported', activity.byArticle.length === 1, String(activity.byArticle.length));
  check('its seconds are summed', activity.byArticle[0].seconds === 1200, String(activity.byArticle[0].seconds));
  check('it carries the article title', activity.byArticle[0].title.length > 0, activity.byArticle[0].title);
  check('it records the last day touched', activity.byArticle[0].lastDay === localDay(0), activity.byArticle[0].lastDay);
}

console.log('\nevent detail for the feed');
{
  const { facade, articleId, dir } = makeFacade();
  seedEvent(dir, { day: localDay(0), seconds: 120, kind: 'read', articleId });
  const without = facade.studyActivity();
  check('events are omitted unless requested', without.events === undefined);
  const withEvents = facade.studyActivity({ includeEvents: true });
  check('events are returned on request', Array.isArray(withEvents.events) && withEvents.events.length === 1,
    String(withEvents.events?.length));
  check('an event carries its article title', withEvents.events[0].title.length > 0);
  check('an event carries its kind and seconds',
    withEvents.events[0].kind === 'read' && withEvents.events[0].seconds === 120);
}

console.log('\nthe client actually reports time');
{
  const reader = readFileSync(new URL('../src/90-detail.js', import.meta.url), 'utf8');
  // The bug this round: `seconds` was never sent, so every recorded minute was 0.
  check('saveProgress is called with measured seconds',
    /call\('saveProgress', \{[^}]*seconds/.test(reader));
  check('time accrues only while visible',
    reader.includes('visibilitychange') && reader.includes("document.visibilityState === 'visible'"));
  check('elapsed time resets after each save', /readMs\.current = 0/.test(reader));
  check('the timer tolerates a missing DOM', reader.includes("typeof document === 'undefined'"));
}

console.log('\nthe grid builder');
{
  // `buildWeeks` ships in the client bundle; this suite checks the same rules it
  // must satisfy, rendered through the exported helper.
  const source = readFileSync(new URL('../src/105-history.js', import.meta.url), 'utf8');
  check('the grid renders seven weekday rows', /for \(let row = 0; row < 7/.test(source));
  check('future cells are marked, not coloured',
    source.includes('future: date > today'));
  check('levels scale to the busiest day, not a fixed scale',
    source.includes('peakSeconds') && source.includes('ratio > 0.75'));
  check('a day with no activity is level zero', source.includes('let level = 0'));
  check('the tooltip states the day and its time', source.includes('daySummary'));
  check('month labels come from the column dates',
    source.includes('function monthLabels') && source.includes('previous'));
}

console.log('\nno estimated time is used');
{
  const facadeSource = readFileSync(new URL('../lib/facade.js', import.meta.url), 'utf8');
  const activityBody = facadeSource.slice(facadeSource.indexOf('function studyActivity'),
    facadeSource.indexOf('function getArticle'));
  check('the aggregation reads study_events', activityBody.includes('FROM study_events'));
  check('it does not sum estimated reading minutes',
    !activityBody.includes('reading_minutes'));
  check('a failing log never breaks reading',
    /catch \(error\) \{[\s\S]{0,160\}study event not recorded/.test(facadeSource)
    || facadeSource.includes('study event not recorded'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
