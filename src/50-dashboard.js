/** Dashboard: study overview, recent reading, and the analysis queue. */

/** One statistic tile. */
function StatTile({ icon, value, unit, label, delta, tone }) {
  return h('div', { className: 'er-stat' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('div', { className: 'er-stat-icon', style: tone ? { color: tone } : undefined }, icon),
      h('div', { className: 'er-stat-label' }, label)),
    h('div', { className: 'er-stat-value' }, String(value), unit && h('small', null, unit)),
    delta && h('div', { className: 'er-stat-delta' }, delta));
}

/** Welcome cell: greeting, search and the study counters. */
function Welcome({ t, onSearch, stats }) {
  // The display name is cosmetic, so it loads on its own: a signed-out account
  // or a slow lookup must never delay the greeting or the counters.
  const account = useLoad(() => call('accountName').catch(() => null), []);
  const name = typeof account.data === 'string' && account.data.trim().length > 0
    ? account.data.trim()
    : null;
  return h(Cell, { span: 12, size: 'feature', tint: true, className: 'er-welcome' },
    h('div', { className: 'er-topbar' },
      h('div', null,
        h('div', { className: 'er-eyebrow' }, h(Icons.sparkle, null), t('home.overview')),
        // With a name: "你好，小明". Without: "你好" alone — no placeholder word.
        h('h1', null, name === null ? t('home.greetingPlain') : `${t('home.greetingPrefix')}${name}`),
        h('p', null, t('home.tagline'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('div', { style: { width: 224 } },
        h('div', { className: 'er-search' },
          h(Icons.search, null),
          h('input', {
            type: 'search', placeholder: t('home.searchPlaceholder'),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && event.currentTarget.value.trim().length > 0) {
                onSearch(event.currentTarget.value.trim());
              }
            },
          })))),
    // The greeting's own totals are the four tiles below, so no extra summary
    // line is repeated and no duplicate entry points are offered.
    h('div', { className: 'er-stats' },
      stats.map((stat) => h(StatTile, { key: stat.label, ...stat }))));
}

/** Recent reading cells: an 8-column list beside a 4-column progress ring. */
function RecentReading({ t, articles, onOpen, progress }) {
  const rows = articles.slice(0, 3);
  let rowNodes;
  if (rows.length === 0) {
    rowNodes = h('div', { style: { padding: '4px 0' } }, h('p', { className: 'er-card-sub' }, t('home.recentEmpty')));
  } else {
    rowNodes = rows.map((article) => h('button', {
      key: article.id,
      className: 'er-row',
      onClick: () => onOpen(article.id),
    },
    h(Thumb, { id: article.id }),
    h('div', { className: 'er-row-body' },
      h('div', { className: 'er-row-title' }, article.title),
      h('div', { className: 'er-row-meta' },
        h(Badge, { tone: cefrTone(article.cefrLevel) }, article.cefrLevel ?? '—'),
        h('span', null, article.topic ?? 'Reading'),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, `${article.readingMinutes} ${t('common.minutes')}`),
        h(Badge, {
          tone: article.readingStatus === 'completed' ? 'mint' : 'violet',
        }, READING_LABELS[article.readingStatus] ?? '未读')))));
  }

  return [
    h(Cell, {
      key: 'recent', span: 8, eyebrow: t('home.recent'), icon: h(Icons.star, { filled: true }),
    },
    h('div', { className: 'er-row-list er-cell-scroll', style: { '--er-cell-max': '232px' } }, rowNodes)),
    h(Cell, {
      key: 'progress', span: 4, eyebrow: t('home.overallLabel'), icon: h(Icons.target, null),
      className: 'er-progress-cell',
    },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 14,
        flex: 1, justifyContent: 'center', minHeight: 0,
      },
    },
    h(ProgressRing, { ratio: progress.ratio, label: t('home.overall') }),
    h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
      h(Progress, { ratio: progress.ratio }),
      h('span', { className: 'er-card-sub' }, t('home.overallHint'))))),
  ];
}

/**
 * Dashboard study block: the very same heatmap card the history page renders.
 *
 * No separate component and no compact variant — the dashboard simply loads the
 * activity and hands it to `StudyHeatmapCard`, adding only a link out.
 */
function StudyMini({ t, onNavigate }) {
  const data = useLoad(() => call('studyActivity', { days: 364 }), []);
  const activity = data.data;
  if (data.status === 'loading' && !activity) {
    return h(Cell, { span: 12, eyebrow: t('history.gridTitle'), icon: h(Icons.grid, null) },
      h(Skeleton, { height: 120, radius: 12 }));
  }
  if (data.status === 'error') {
    return h(Cell, { span: 12, eyebrow: t('history.gridTitle'), icon: h(Icons.grid, null) },
      h(Alert, null, data.error.message));
  }
  return h(StudyHeatmapCard, {
    t,
    activity,
    actions: h(Button, {
      size: 'sm', variant: 'ghost', onClick: () => onNavigate('history'),
    }, t('home.studyMore')),
  });
}

/** The whole dashboard page. */
function Dashboard({ t, onNavigate, onOpen }) {
  const data = useLoad(() => call('dashboard'), []);
  const progress = useLoad(async () => {
    const list = await call('listArticles', { limit: 200 });
    const ratios = list.items.map((item) => (item.readingStatus === 'completed' ? 1 : item.readingStatus === 'reading' ? 0.45 : 0));
    return { ratio: ratios.length === 0 ? 0 : ratios.reduce((sum, value) => sum + value, 0) / ratios.length };
  }, [data.data]);
  if (data.status === 'loading' && !data.data) {
    return h('div', { className: 'er-page' },
      h(Skeleton, { height: 176, radius: 20 }), h(Skeleton, { height: 128, radius: 18 }));
  }
  if (data.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, data.error.message),
      h('div', null, h(Button, { onClick: data.reload }, t('common.retry'))));
  }
  const stats = data.data;
  const tiles = [
    { icon: h(Icons.bookOpen, null), value: stats.articles, label: t('home.statArticles'), delta: t('home.statArticlesDelta') },
    { icon: h(Icons.star, null), value: stats.favoriteWords, label: t('home.statWords'), delta: t('home.statWordsDelta') },
    { icon: h(Icons.clock, null), value: Math.round((stats.readingMinutes / 60) * 10) / 10, unit: t('common.hours'), label: t('home.statTime'), delta: t('home.statTimeDelta') },
    { icon: h(Icons.flame, null), value: stats.streakDays, unit: t('common.days'), label: t('home.statStreak'), delta: t('home.statStreakDelta') },
  ];
  return h('div', { className: 'er-page' },
    h(Board, null,
      h(Welcome, { t, stats: tiles, onSearch: (value) => onNavigate('articles', { search: value }) }),
      ...RecentReading({ t, articles: stats.recent, onOpen, progress: progress.data ?? { ratio: 0 } }),
      h(StudyMini, { t, onNavigate })));
}

export { Dashboard };
