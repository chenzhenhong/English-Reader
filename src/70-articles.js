/** Article library: filters, rows, and the analysis entry points. */

/** One library row. */
function ArticleRow({ t, article, onOpen, onAnalyze, onDelete, pending }) {
  // The whole article, not just its id: the delete dialog names what it takes.
  return h('div', { className: 'er-row', style: { cursor: 'default' } },
    h('div', {
      onClick: () => onOpen(article.id),
      style: { display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, cursor: 'pointer' },
    },
    h(Thumb, { id: article.id }),
    h('div', { className: 'er-row-body' },
      h('div', { className: 'er-row-title' }, article.title),
      h('div', { className: 'er-row-meta' },
        h(Badge, { tone: cefrTone(article.cefrLevel) }, article.cefrLevel ?? '—'),
        h('span', null, article.sourceName ?? 'Manual'),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, `${article.wordCount} ${t('common.words')}`),
        h('span', { className: 'er-crumb-dot' }),
        h('span', null, `${article.readingMinutes} ${t('common.minutes')}`),
        h('span', { className: 'er-crumb-dot' }),
        h(Badge, {
          tone: article.status === 'COMPLETED' ? 'mint' : article.status === 'PARTIAL_COMPLETED' ? 'amber' : 'soft',
        }, ARTICLE_STATUS_LABELS[article.status] ?? article.status)),
      article.snippet
        ? h('div', {
          className: 'er-row-meta',
          style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, article.snippet)
        : null)),
    h('div', { className: 'er-row-side' },
      article.demo ? h(Badge, { tone: 'plain' }, 'sample') : null,
      // Only when the article actually came from a URL; pasted text has none.
      article.sourceUrl
        ? h('a', {
          className: 'er-source-link',
          href: article.sourceUrl,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: article.sourceUrl,
          onClick: (event) => event.stopPropagation(),
        }, h(Icons.link, null), h('span', null, t('reader.openSource')))
        : null,
      h(Button, { size: 'sm', onClick: () => onOpen(article.id) }, t('common.read')),
      h(Button, {
        size: 'sm', variant: 'primary', disabled: pending, onClick: () => onAnalyze(article.id),
      }, article.status === 'COMPLETED' ? t('common.reanalyze') : t('articles.analyze')),
      h(Button, {
        size: 'sm', variant: 'ghost', iconOnly: true, children: t('common.delete'),
        icon: h(Icons.trash, null),
        onClick: () => onDelete(article),
      })));
}

/** Library page with filters and the sample-library controls. */
function Articles({ t, notify, onOpenArticle, initialSearch }) {
  const [search, setSearch] = React.useState(initialSearch ?? '');
  const [cefr, setCefr] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [source, setSource] = React.useState('');
  const list = useLoad(() => call('listArticles', { search, cefrLevel: cefr || undefined, analysisStatus: status || undefined, sourceName: source || undefined, limit: 60 }), [search, cefr, status, source]);
  const action = useAction();
  // The article awaiting deletion. The action runs only after the learner has
  // accepted what it costs them.
  const [confirmDelete, setConfirmDelete] = React.useState(null);
  React.useEffect(() => {
    if (initialSearch) setSearch(initialSearch);
  }, [initialSearch]);
  const analyze = async (articleId) => {
    const started = await action.run(() => call('startAnalysis', { articleId }));
    if (started) {
      notify(t('articles.analysisStarted'), 'ok');
      onOpenArticle(articleId);
    }
  };
  /** Ask before removing, then act only on an acceptance. */
  const confirmRemove = async (article) => {
    setConfirmDelete(null);
    const done = await action.run(() => call('deleteArticle', { articleId: article.id }), t('articles.deleted'));
    if (done) {
      notify(t('articles.deleted'), 'ok');
      list.reload();
    }
  };
  return h('div', { className: 'er-page er-page--fill' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.articles'))),
      h('div', { className: 'er-topbar-spacer' })),
    h(Cell, { span: 12, flush: true, className: 'er-articles-cell' },
      h('div', { style: { display: 'flex', gap: 8, padding: '16px 18px 4px', flexWrap: 'wrap' } },
        h('div', { className: 'er-search', style: { flex: '1 1 220px' } },
          h(Icons.search, null),
          h('input', { type: 'search', placeholder: t('articles.searchPlaceholder'), value: search, onChange: (event) => setSearch(event.target.value) })),
        h('select', { className: 'er-select', style: { width: 120 }, value: cefr, onChange: (event) => setCefr(event.target.value) },
          h('option', { value: '' }, t('articles.allLevels')),
          ['A2', 'B1', 'B2', 'C1', 'C2'].map((level) => h('option', { key: level, value: level }, level))),
        h('select', { className: 'er-select', style: { width: 140 }, value: status, onChange: (event) => setStatus(event.target.value) },
          h('option', { value: '' }, t('articles.allStatus')),
          ['FETCHED', 'ANALYZING', 'PARTIAL_COMPLETED', 'COMPLETED', 'ANALYSIS_FAILED'].map((value) => h('option', { key: value, value }, ARTICLE_STATUS_LABELS[value]))),
        h('select', { className: 'er-select', style: { width: 150 }, value: source, onChange: (event) => setSource(event.target.value) },
          h('option', { value: '' }, t('articles.allSources')),
          (list.data?.sources ?? []).map((name) => h('option', { key: name, value: name }, name))),
        h('div', { className: 'er-topbar-spacer' }),
        h('span', { className: 'er-card-sub', style: { alignSelf: 'center' } }, `${list.data?.total ?? 0} ${t('articles.count')}`)),
      list.status === 'loading' && !list.data && h('div', { style: { padding: 20, display: 'flex', flexDirection: 'column', gap: 10 } },
        [0, 1, 2].map((index) => h(Skeleton, { key: index, height: 56, radius: 12 }))),
      list.status === 'error' && h('div', { style: { padding: 20 } }, h(Alert, null, list.error.message)),
      list.data && list.data.items.length === 0 && h(Empty, {
        icon: h(Icons.bookOpen, null),
        title: t('articles.emptyTitle'),
        description: t('articles.emptyBody'),
      }),
      list.data && list.data.items.length > 0 && h('div', {
        className: 'er-row-list er-articles-list',
      },
        list.data.items.map((article) => h(ArticleRow, {
          key: article.id, t, article,
          onOpen: onOpenArticle, onAnalyze: analyze, onDelete: (article) => setConfirmDelete(article), pending: action.pending,
        })))),
    // The same delete the reading page asks for, with the same wording: the
    // operation is identical, so the copy should not drift.
    confirmDelete
      ? h(ConfirmDialog, {
        title: t('reader.deleteConfirmTitle'),
        description: h('div', { className: 'er-confirm-body' },
          h('p', null, t('reader.deleteConfirm', { title: confirmDelete.title })),
          h('p', { className: 'er-confirm-consequence' }, t('reader.deleteConfirmConsequence'))),
        confirmLabel: t('reader.deleteConfirmRun'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => confirmRemove(confirmDelete),
        onCancel: () => setConfirmDelete(null),
      })
      : null,
    action.error && h(Alert, null, action.error.message));
}

export { Articles };
