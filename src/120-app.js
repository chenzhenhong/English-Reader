/** Application shell: rail navigation, page routing, and the panel registration. */

/** Rail navigation entries; `nav.*` labels come from the plugin locale. */
const NAV_GROUPS = [
  {
    id: 'main',
    items: [
      { id: 'home', icon: 'home' },
      { id: 'discover', icon: 'compass' },
      { id: 'articles', icon: 'book' },
    ],
  },
  {
    id: 'knowledge',
    items: [
      { id: 'words', icon: 'letters' },
      { id: 'phrases', icon: 'link' },
      { id: 'collocations', icon: 'layers' },
      { id: 'sentences', icon: 'quote' },
    ],
  },
  {
    // Practice and progress: these act on the library but are not part of it.
    id: 'practice',
    items: [
      { id: 'review', icon: 'refresh' },
      { id: 'history', icon: 'grid' },
    ],
  },
];

const PANEL_ID = 'english-reader';

/** Brand mark, drawn locally so the rail never depends on host artwork. */
function BrandMark({ size = 30 }) {
  return h('svg', { viewBox: '0 0 64 64', width: size, height: size, role: 'img', 'aria-label': 'English Reader' },
    h('path', {
      d: 'M14 18c0-2 1.6-3.2 3.6-2.6L32 18v30l-14.4-3.2C15.6 44.4 14 43 14 41V18Z',
      fill: '#fff', stroke: '#c9bfff', strokeWidth: 2,
    }),
    h('path', {
      d: 'M50 18c0-2-1.6-3.2-3.6-2.6L32 18v30l14.4-3.2c2-.6 3.6-1.4 3.6-3.4V18Z',
      fill: '#fff', stroke: '#c9bfff', strokeWidth: 2,
    }),
    h('path', { d: 'M32 18v30', stroke: '#c9bfff', strokeWidth: 2 }),
    h('rect', { x: 18, y: 25, width: 9, height: 2.4, rx: 1.2, fill: '#b9aef5' }),
    h('rect', { x: 18, y: 31, width: 7, height: 2.4, rx: 1.2, fill: '#d3cbfa' }),
    h('rect', { x: 36, y: 27, width: 9, height: 2.4, rx: 1.2, fill: '#8b7bf7' }),
    h('circle', { cx: 45, cy: 43, r: 10, fill: '#8b7bf7' }),
    h('path', { d: 'M40.5 43l3 3 5.5-6', fill: 'none', stroke: '#fff', strokeWidth: 2.6, strokeLinecap: 'round' }));
}

/** Rail item with an icon and a localized label. */
function NavItem({ t, id, icon, active, onSelect }) {
  return h('button', {
    type: 'button', className: 'er-nav-item', 'aria-current': active ? 'true' : undefined,
    onClick: () => onSelect(id),
  },
  h('span', { className: 'er-nav-icon' }, h(Icons[icon] ?? Icons.book, null)),
  h('span', { className: 'er-nav-label' }, t(`nav.${id}`)));
}

/**
 * Where the user was.
 *
 * The Harness unmounts the plugin panel when the user leaves for another
 * Session, so the route has to outlive the component: without this, coming
 * back lands on the home page instead of the page the user left.
 */
const ROUTE_KEY = 'english-reader:route';

/** The route the user last looked at. */
function readSavedRoute() {
  try {
    const raw = window.localStorage.getItem(ROUTE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.page !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remember the route so leaving the panel does not lose the place. */
function saveRoute(route) {
  try {
    window.localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  } catch {
    /* storage unavailable */
  }
}

/** The whole plugin surface, mounted into the `main` panel. */
function EnglishReaderApp({ t }) {
  const [route, setRoute] = React.useState(() => readSavedRoute() ?? {
    page: 'home', articleId: null, kind: 'words', detailId: null, search: undefined,
    discoverTab: 'spec', discoverMode: 'auto',
  });
  const [toast, setToast] = React.useState(null);
  const notify = React.useCallback((message, tone = 'ok') => {
    setToast({ message, tone, at: Date.now() });
  }, []);
  React.useEffect(() => {
    if (toast === null) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const go = (page, extra) => setRoute((current) => ({ ...current, page, ...extra }));
  // Persist on every change: the panel is unmounted when the user leaves for
  // another Session, and the route has to survive that.
  React.useEffect(() => {
    saveRoute(route);
  }, [route]);
  const openArticle = (articleId) => setRoute({ page: 'article', articleId, kind: 'words', detailId: null });
  const openKnowledge = (kind, detailId) => setRoute({
    page: 'knowledge',
    kind: kind === 'word' ? 'words' : `${kind}s`,
    detailId,
    articleId: null,
  });
  const navigateByNav = (id) => {
    if (id === 'home') go('home');
    else if (id === 'discover') go('discover');
    else if (id === 'articles') go('articles');
    else if (id === 'review') go('review');
    else if (id === 'history') go('history');
    else if (id === 'settings') go('settings');
    else go('knowledge', { kind: id, detailId: null });
  };
  const activeNav = route.page === 'knowledge'
    ? route.kind
    : route.page === 'article' ? 'articles' : route.page;

  const kinds = { words: 'word', phrases: 'phrase', collocations: 'collocation', sentences: 'sentence' };
  let page = null;
  if (route.page === 'home') {
    page = h(Dashboard, { t, onNavigate: go, onOpen: openArticle, onRetry: openArticle });
  } else if (route.page === 'discover') {
    page = h(Discover, {
      t, notify, onOpenArticle: openArticle,
      tab: route.discoverTab, mode: route.discoverMode,
      onTabChange: (next) => go('discover', { discoverTab: next }),
      onModeChange: (next) => go('discover', { discoverMode: next }),
    });
  } else if (route.page === 'articles') {
    page = h(Articles, {
      t, notify, onOpenArticle: openArticle, initialSearch: route.search,
    });
  } else if (route.page === 'article') {
    page = route.articleId === null
      ? h(Empty, { icon: h(Icons.bookOpen, null), title: t('articles.emptyTitle'), description: t('articles.emptyBody') })
      : h(ArticleDetail, {
        t, articleId: route.articleId, notify,
        onBack: () => go('articles'),
        onNavigateKnowledge: openKnowledge,
      });
  } else if (route.page === 'review') {
    page = h(ReviewPage, { t, notify });
  } else if (route.page === 'history') {
    page = h(StudyHistoryPage, { t, notify });
  } else if (route.page === 'settings') {
    page = h(SettingsPage, { t, notify });
  } else if (route.page === 'knowledge') {
    const kind = kinds[route.kind] ?? 'word';
    page = route.detailId
      ? h(KnowledgeDetail, {
        t, kind, entityId: route.detailId, notify,
        onBack: () => go('knowledge', { detailId: null }),
      })
      : h(KnowledgePage, { t, kind, notify });
  }

  const groups = NAV_GROUPS.map((group, groupIndex) => h('div', { key: group.id },
    groupIndex > 0 ? h('div', { className: 'er-nav-group' }, t(`nav.group.${group.id}`)) : null,
    group.items.map((item) => h(NavItem, {
      key: item.id, t, id: item.id, icon: item.icon,
      active: activeNav === item.id, onSelect: navigateByNav,
    }))));

  return h('div', { className: 'er-root' },
    h('nav', { className: 'er-rail', 'aria-label': 'English Reader' },
      h('div', { className: 'er-brand' },
        h('div', { className: 'er-brand-mark' }, h(BrandMark, null)),
        // One line: the rail is 188px wide, so the two words fit together.
        h('div', { className: 'er-brand-name' }, 'English Reader')),
      groups,
      h('div', { className: 'er-rail-foot' },
        h(NavItem, {
          t, id: 'settings', icon: 'settings',
          active: activeNav === 'settings', onSelect: navigateByNav,
        }))),
    h('div', { className: 'er-main' },
      h('div', {
        // A fill-mode page owns its own scrolling, so the shell must not
        // scroll it as well: the page would grow past the viewport instead.
        className: route.page === 'article' || route.page === 'discover' || route.page === 'articles'
          ? 'er-scroll er-scroll--fill'
          : 'er-scroll',
      }, page)),
    toast !== null
      ? h('div', { className: 'er-toast' },
        h('div', {
          className: `er-alert ${toast.tone === 'error' ? 'error' : 'ok'}`,
          role: 'status', style: { boxShadow: 'var(--er-float-lg)' },
        },
        toast.tone === 'error' ? h(Icons.warning, null) : h(Icons.check, null),
        h('div', null, toast.message)))
      : null);
}

export { EnglishReaderApp, BrandMark, PANEL_ID };
