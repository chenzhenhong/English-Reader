/**
 * Study history: a contribution grid plus a day-by-day activity feed.
 *
 * Both are built from `study_events`, whose `seconds` are measured while the
 * reader pane is visible. Nothing here estimates time from word counts.
 */

/** Weekday initials, Monday first, matching the grid's row order. */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Local YYYY-MM-DD for a Date, matching the host's day boundary. */
function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parse a YYYY-MM-DD key into a local Date at midnight. */
function parseDay(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Human duration: seconds become "2 小时 15 分" or "8 分钟". */
function duration(t, seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes <= 0) return `0 ${t('common.minutes')}`;
  if (minutes < 60) return `${minutes} ${t('common.minutes')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours} ${t('common.hours')}`
    : `${hours} ${t('common.hours')} ${rest} ${t('common.minutes')}`;
}

/**
 * Build the grid as columns of seven days, newest week last.
 *
 * Levels scale to the learner's own busiest day; a fixed minute scale would make
 * a light user's whole grid level 1 and a heavy user's all level 4.
 */
function buildWeeks(days, peakSeconds, weeks, endDay) {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // A custom range may end in the past, so the last column follows the requested
  // end day rather than always the current week.
  const anchor = endDay ? parseDay(endDay) : today;
  const end = new Date(anchor);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

  const columns = [];
  for (let week = weeks - 1; week >= 0; week -= 1) {
    const column = [];
    for (let row = 0; row < 7; row += 1) {
      const date = new Date(end);
      date.setDate(end.getDate() - week * 7 - (6 - row));
      const key = dayKey(date);
      const entry = byDay.get(key);
      const seconds = entry?.seconds ?? 0;
      let level = 0;
      if (seconds > 0) {
        if (peakSeconds <= 0) level = 1;
        else {
          const ratio = seconds / peakSeconds;
          level = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
        }
      }
      column.push({
        day: key,
        date,
        future: date > today,
        seconds,
        minutes: Math.round(seconds / 60),
        events: entry?.events ?? 0,
        kinds: entry?.kinds ?? [],
        level,
      });
    }
    columns.push(column);
  }
  return columns;
}

/** One-line summary of a day, used as the cell tooltip. */
function daySummary(t, cell) {
  if (cell.future) return cell.day;
  if (cell.events === 0) return `${cell.day} · ${t('history.nothing')}`;
  return `${cell.day} · ${cell.events} ${t('history.events')} · ${duration(t, cell.seconds)}`;
}

/** Month labels positioned over the column where the month changes. */
function monthLabels(columns) {
  const labels = [];
  let previous = -1;
  columns.forEach((column, index) => {
    const first = column[0]?.date;
    if (first && first.getMonth() !== previous) {
      previous = first.getMonth();
      labels.push({ index, text: String(first.getMonth() + 1) });
    }
  });
  return labels;
}

/** The contribution grid. */
function ActivityGrid({ t, days, peakSeconds, weeks, endDay }) {
  const columns = React.useMemo(
    () => buildWeeks(days, peakSeconds, weeks, endDay),
    [days, peakSeconds, weeks, endDay],
  );
  const labels = monthLabels(columns);
  return h('div', { className: 'er-heat' },
    h('div', { className: 'er-heat-rows' },
      h('div', { className: 'er-heat-months', style: { gridTemplateColumns: `repeat(${weeks}, 1fr)` } },
        labels.map((label) => h('span', { key: label.index, style: { gridColumnStart: label.index + 1 } }, label.text))),
      h('div', { className: 'er-heat-body' },
        h('div', { className: 'er-heat-weekdays' },
          WEEKDAY_KEYS.map((key, index) => h('span', {
            key,
            // Labelling all seven rows would crowd a 20px gutter.
            style: { visibility: index % 2 === 0 ? 'visible' : 'hidden' },
          }, t(`history.weekday.${key}`)))),
        h('div', { className: 'er-heat-grid', style: { gridTemplateColumns: `repeat(${weeks}, 1fr)` } },
          columns.map((column) => h('div', { key: column[0]?.day, className: 'er-heat-week' },
            column.map((cell) => h('div', {
              key: cell.day,
              className: 'er-heat-cell',
              'data-level': cell.level,
              'data-future': cell.future === true ? 'true' : undefined,
              title: daySummary(t, cell),
            }))))))),
    h('div', { className: 'er-heat-legend' },
      h('span', { className: 'er-card-sub' }, t('history.less')),
      [0, 1, 2, 3, 4].map((level) => h('span', { key: level, className: 'er-heat-cell', 'data-level': level })),
      h('span', { className: 'er-card-sub' }, t('history.more'))));
}

/**
 * Activity feed: one section per active day, newest first.
 *
 * Each day lists the articles actually read that day with the measured time, so
 * the log answers "where did the time go", not just "did I show up".
 */
function ActivityFeed({ t, activity }) {
  const byDay = new Map();
  for (const event of activity.events ?? []) {
    if (!byDay.has(event.day)) byDay.set(event.day, []);
    byDay.get(event.day).push(event);
  }
  // Group per day, then per article inside the day.
  const sections = [...byDay.entries()]
    .sort((left, right) => (left[0] < right[0] ? 1 : -1))
    .map(([day, events]) => {
      const perArticle = new Map();
      let seconds = 0;
      for (const event of events) {
        seconds += event.seconds;
        const key = event.articleId ?? '_none';
        if (!perArticle.has(key)) {
          perArticle.set(key, {
            articleId: event.articleId,
            title: event.title ?? t('history.unknownArticle'),
            cefrLevel: event.cefrLevel ?? null,
            kinds: new Set(),
            seconds: 0,
            events: 0,
          });
        }
        const entry = perArticle.get(key);
        entry.seconds += event.seconds;
        entry.events += 1;
        if (event.kind) entry.kinds.add(event.kind);
      }
      return { day, seconds, articles: [...perArticle.values()].sort((a, b) => b.seconds - a.seconds) };
    });

  if (sections.length === 0) {
    return h(Empty, {
      icon: h(Icons.clock, null),
      title: t('history.emptyTitle'),
      description: t('history.emptyBody'),
    });
  }

  const dayNodes = sections.map((section) => h('section', {
    key: section.day,
    className: 'er-feed-day',
  },
  h('div', { className: 'er-feed-dayhead' },
    h('span', { className: 'er-feed-date' }, section.day),
    h('span', { className: 'er-card-sub' }, `${section.articles.length} ${t('history.articles')}`),
    h('div', { className: 'er-topbar-spacer' }),
    h(Badge, { tone: section.seconds >= 600 ? 'mint' : 'soft' }, duration(t, section.seconds))),
  section.articles.map((article) => h('div', {
    key: `${section.day}-${article.articleId ?? 'none'}`,
    className: 'er-feed-row',
  },
  h('div', { className: 'er-feed-icon' }, h(Icons.bookOpen, null)),
  h('div', { className: 'er-feed-body' },
    h('div', { className: 'er-feed-title' }, article.title),
    h('div', { className: 'er-feed-meta' },
      article.cefrLevel ? h(Badge, { tone: cefrTone(article.cefrLevel) }, article.cefrLevel) : null,
      [...article.kinds].map((kind) => h('span', { key: kind },
        t(`history.kind.${kind}`, { fallback: kind }))),
      h('span', { className: 'er-crumb-dot' }),
      h('span', null, `${article.events} ${t('history.events')}`))),
  h('div', { className: 'er-feed-time' }, duration(t, article.seconds))))));

  return h('div', { className: 'er-feed' }, dayNodes);
}

/** The log always covers one year: 53 week columns. */
const HISTORY_WEEKS = 53;



/**
 * The study heatmap block: totals, the year grid and the empty hint.
 *
 * Extracted so the dashboard renders exactly this, not a look-alike. `actions`
 * lets a host add a link without duplicating the body.
 */
function StudyHeatmapCard({ t, activity, actions }) {
  const totals = activity.totals;
  return h(Cell, {
    span: 12,
    eyebrow: t('history.gridTitle'),
    icon: h(Icons.grid, null),
    actions,
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
      h('span', { className: 'er-card-sub' },
        `${t('history.currentStreak')} ${totals.currentStreak} ${t('common.days')}`),
      h('span', { className: 'er-card-sub' },
        `${totals.activeDays} ${t('history.activeDays')}`),
      h('span', { className: 'er-card-sub' }, duration(t, totals.seconds))),
    h(ActivityGrid, {
      t,
      days: activity.days,
      peakSeconds: activity.peakSeconds,
      weeks: HISTORY_WEEKS,
      endDay: activity.endDay,
    }),
    activity.days.length === 0 ? h(Alert, { tone: 'warn' }, t('history.emptyHint')) : null));
}

/** Study history page: totals, the grid, and the day-by-day feed. */
function StudyHistoryPage({ t, notify }) {
  const data = useLoad(
    () => call('studyActivity', { days: HISTORY_WEEKS * 7, includeEvents: true }),
    [],
  );
  if (data.status === 'loading' && !data.data) {
    return h('div', { className: 'er-page' },
      h(Skeleton, { height: 150, radius: 18 }), h(Skeleton, { height: 180, radius: 18 }));
  }
  if (data.status === 'error') {
    return h('div', { className: 'er-page' }, h(Alert, null, data.error.message));
  }
  const activity = data.data;
  const totals = activity.totals;

  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, t('nav.history'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `${activity.startDay} → ${activity.endDay ?? activity.today}`)),

    // Headline sentence, mirroring "2,533 contributions in the last year".
    h(Cell, { span: 12, size: 'feature', tint: true },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('h2', { className: 'er-feed-headline' },
          t('history.headline', {
            time: duration(t, totals.seconds),
            days: totals.activeDays,
            fallback: t('history.headlineFallback'),
          })),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
          h('span', { className: 'er-card-sub' },
            `${t('history.currentStreak')} ${totals.currentStreak} ${t('common.days')}`),
          h('span', { className: 'er-card-sub' },
            `${t('history.longestStreak')} ${totals.longestStreak} ${t('common.days')}`),
          h('span', { className: 'er-card-sub' },
            `${t('history.byKind')} · ${(activity.byArticle ?? []).length} ${t('history.articles')}`)))),

    h(StudyHeatmapCard, { t, activity }),

    h(Cell, { span: 12, eyebrow: t('history.feedTitle'), icon: h(Icons.clock, null) },
      h(ActivityFeed, { t, activity })));
}

export { StudyHistoryPage, StudyHeatmapCard, buildWeeks, dayKey, duration, ActivityFeed };
