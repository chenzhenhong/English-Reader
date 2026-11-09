/**
 * Collection profile form.
 *
 * Six controls, matching the product specification:
 * 1. CEFR range (A1–C2, multi-select, default B1–B2)
 * 2. Sources (multi-select from the registry, default all)
 * 3. Publication window (24h / 7d / 30d / custom, default 7d)
 * 4. Article types (multi-select, default all)
 * 5. Sensitive-content filter (single choice, default on)
 * 6. Word-count range (default 800–1500)
 *
 * The registry arrives from the Host (`settings.collection`), so this form never
 * hard-codes a publisher list that could drift from the strategy table.
 */

/** Toggle one value inside an array. */
function toggleValue(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** How many candidates one page holds. */
const PAGE_SIZE = 30;

/** A labelled block of checkable chips. */
function ChipGroup({ t, label, options, selected, onToggle, onAll, onNone, hint }) {
  return h('div', { className: 'er-field' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('label', { className: 'er-field-label' }, label),
      selected.length > 0 ? h('span', { className: 'er-card-sub' }, `${selected.length}/${options.length}`) : null,
      h('div', { className: 'er-topbar-spacer' }),
      h(Button, { size: 'sm', variant: 'ghost', onClick: onAll }, t('discover.selectAll')),
      h(Button, { size: 'sm', variant: 'ghost', onClick: onNone }, t('discover.selectNone')),
    ),
    hint ? h('div', { className: 'er-card-sub', style: { marginBottom: 2 } }, hint) : null,
    h('div', { className: 'er-chips' },
      options.map((option) => h('button', {
        key: option.id,
        type: 'button',
        className: 'er-chip',
        'aria-pressed': selected.includes(option.id),
        title: option.title ?? undefined,
        onClick: () => onToggle(option.id),
      }, option.label))));
}

/** Profile controls shared by the discovery form. */
function ProfileForm({ t, profile, collection, onChange }) {
  const update = (patch) => onChange({ ...profile, ...patch });
  const range = profile.levelRange ?? ['B1', 'B2'];
  const levels = collection?.cefrLevels ?? ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const sources = collection?.sources ?? [];
  const types = collection?.articleTypes ?? [];
  const windows = [
    { id: '24h', days: 1, label: t('discover.window24h') },
    { id: '7d', days: 7, label: t('discover.window7d') },
    { id: '30d', days: 30, label: t('discover.window30d') },
    { id: 'custom', days: null, label: t('discover.windowCustom') },
  ];
  const window = profile.publishedWindow ?? '7d';

  /**
   * Select a level: clicking outside the current range extends it, clicking a
   * boundary shrinks it. This keeps one inclusive A→B span rather than a
   * scattered set, which is what "CEFR A1–C2 多选" means in practice.
   */
  const pickLevel = (level) => {
    const index = levels.indexOf(level);
    const low = levels.indexOf(range[0]);
    const high = levels.indexOf(range[1]);
    if (index >= low && index <= high) {
      // Shrinking: move the nearer boundary inward.
      if (range[0] === range[1]) return;
      if (index === low) return update({ levelRange: [levels[index + 1], range[1]] });
      if (index === high) return update({ levelRange: [range[0], levels[index - 1]] });
      return update({ levelRange: [range[0], levels[Math.max(0, index - 1)]] });
    }
    if (index < low) return update({ levelRange: [level, range[1]] });
    if (index > high) return update({ levelRange: [range[0], level] });
    return undefined;
  };

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    // 1. How many articles this run should collect
    h('div', { className: 'er-field' },
      h('label', null, t('discover.articleCount')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('input', {
          className: 'er-input', type: 'number', min: 1, max: 20, step: 1, style: { width: 96 },
          value: profile.articleCount ?? 1,
          onChange: (event) => {
            const raw = Number(event.target.value);
            // Keep the field usable while typing: clamp only to a legal integer.
            update({ articleCount: Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.round(raw))) : 1 });
          },
        }),
        h('span', { className: 'er-card-sub' }, t('discover.articleCountUnit')),
        h('div', { className: 'er-chips', style: { marginLeft: 6 } },
          [1, 3, 5, 10].map((value) => h('button', {
            key: value, type: 'button', className: 'er-chip',
            'aria-pressed': (profile.articleCount ?? 1) === value,
            onClick: () => update({ articleCount: value }),
          }, String(value)))),
        h('div', { className: 'er-topbar-spacer' }),
      ),
      h('div', { className: 'er-card-sub' }, t('discover.articleCountHint'))),

    // 2. CEFR range
    h('div', { className: 'er-field' },
      h('label', null, t('discover.levelRange'), ' ', h('span', { className: 'er-card-sub' }, `${range[0]} – ${range[1]}`)),
      h('div', { className: 'er-chips' },
        levels.map((level) => {
          const inside = levels.indexOf(level) >= levels.indexOf(range[0])
            && levels.indexOf(level) <= levels.indexOf(range[1]);
          return h('button', {
            key: level, type: 'button', className: 'er-chip',
            'aria-pressed': inside,
            onClick: () => pickLevel(level),
          }, level);
        }))),

    // 2. Sources
    h(ChipGroup, {
      t, label: t('discover.sources'), hint: t('discover.sourcesHint'),
      options: sources.map((source) => ({
        id: source.id,
        // An unhealthy source stays selectable but says so up front.
        label: source.health && source.health.ok === false
          ? `${source.name} ⚠`
          : source.name,
        title: [
          source.name,
          source.paywalled ? '可能需订阅' : '',
          source.health && source.health.ok === false ? `上次失败：${source.health.code}` : '',
          source.note ?? '',
        ].filter(Boolean).join(' · '),
      })),
      selected: profile.sourceIds ?? [],
      onToggle: (id) => update({ sourceIds: toggleValue(profile.sourceIds ?? [], id) }),
      onAll: () => update({ sourceIds: sources.map((source) => source.id) }),
      onNone: () => update({ sourceIds: [] }),
    }),

    // 3. Publication window
    h('div', { className: 'er-field' },
      h('label', null, t('discover.window')),
      h('div', { className: 'er-chips' },
        windows.map((item) => h('button', {
          key: item.id, type: 'button', className: 'er-chip',
          'aria-pressed': window === item.id,
          onClick: () => update({
            publishedWindow: item.id,
            publishedWithinDays: item.days ?? profile.publishedWithinDays ?? 7,
          }),
        }, item.label)),
        window === 'custom' && h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 } },
          h('input', {
            className: 'er-input', type: 'number', min: 1, max: 3650, style: { width: 92 },
            value: profile.publishedWithinDays ?? 7,
            onChange: (event) => update({ publishedWithinDays: Math.max(1, Number(event.target.value) || 1) }),
          }),
          h('span', { className: 'er-card-sub' }, t('discover.days')))),
      h('div', { className: 'er-card-sub' }, t('discover.windowHint'))),

    // 4. Article types
    h(ChipGroup, {
      t, label: t('discover.types'),
      options: types.map((type) => ({ id: type, label: t(`type.${type}`, { fallback: type }) })),
      selected: profile.types ?? [],
      onToggle: (id) => update({ types: toggleValue(profile.types ?? [], id) }),
      onAll: () => update({ types: [...types] }),
      onNone: () => update({ types: [] }),
    }),

    // 5. Sensitive-content filter
    h('div', { className: 'er-field' },
      h('label', null, t('discover.sensitive')),
      h('div', { className: 'er-chips' },
        [{ value: true, label: t('discover.sensitiveOn') }, { value: false, label: t('discover.sensitiveOff') }]
          .map((option) => h('button', {
            key: String(option.value), type: 'button', className: 'er-chip',
            'aria-pressed': (profile.filterSensitive !== false) === option.value,
            onClick: () => update({ filterSensitive: option.value }),
          }, option.label))),
      h('div', { className: 'er-card-sub' }, t('discover.sensitiveHint'))),

    // 6. Word count: no limit by default, or an explicit range.
    h('div', { className: 'er-field' },
      h('label', { className: 'er-field-label' }, t('discover.wordRange')),
      h('div', { className: 'er-chips' },
        [{ value: 'unlimited', label: t('discover.wordUnlimited') },
          { value: 'range', label: t('discover.wordRangeOption') }]
          .map((option) => h('button', {
            key: option.value,
            type: 'button',
            className: 'er-chip',
            'aria-pressed': (profile.wordLimitMode === 'range') === (option.value === 'range'),
            onClick: () => {
              // Only act when the mode actually changes: re-clicking the active
              // option must not resurrect a switch the learner turned off.
              if ((profile.wordLimitMode === 'range') === (option.value === 'range')) return;
              update({
                wordLimitMode: option.value,
                // Entering a range turns truncation on (the friendly default);
                // leaving clears it so the profile never claims a behaviour that
                // cannot apply.
                truncate: option.value === 'range',
              });
            },
          }, option.label))),
      profile.wordLimitMode === 'range'
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              className: 'er-input', type: 'number', min: 50, max: 5000, style: { width: 100 },
              value: profile.minWords ?? 800,
              onChange: (event) => update({ minWords: Math.max(1, Number(event.target.value) || 1) }),
            }),
            h('span', { className: 'er-card-sub' }, '–'),
            h('input', {
              className: 'er-input', type: 'number', min: 100, max: 20000, style: { width: 110 },
              value: profile.maxWords ?? 1500,
              onChange: (event) => update({ maxWords: Math.max(1, Number(event.target.value) || 1) }),
            }),
            h('span', { className: 'er-card-sub' }, t('common.words')),
            // A single on/off switch beside the inputs; on by default so an
            // over-long article is cut rather than silently skipped.
            h('label', { className: 'er-check', style: { marginLeft: 6 } },
              h('input', {
                type: 'checkbox',
                checked: profile.truncate === true,
                onChange: (event) => update({ truncate: event.target.checked }),
              }),
              h('span', null, t('discover.truncateOn'))),
            h('span', { className: 'er-card-sub' }, t('discover.truncateHint'))))
        : h('div', { className: 'er-card-sub', style: { marginTop: 8 } }, t('discover.wordUnlimitedHint'))));
}

/** One candidate row with its explainable score. */
function CandidateRow({ t, candidate, selected, onToggle, failure, onPreview }) {
  return h('div', {
    className: 'er-candidate', 'data-selected': selected === true, 'data-failed': failure !== undefined,
    // Clicking the row opens the preview; the checkbox and the source link
    // keep their own behaviour.
    onClick: onPreview ? () => onPreview(candidate) : undefined,
  },
    h('label', {
      className: 'er-check', style: { flex: 'none' },
      onClick: (event) => event.stopPropagation(),
    },
      h('input', {
        type: 'checkbox', checked: selected === true, onChange: () => onToggle(candidate.id),
        onClick: (event) => event.stopPropagation(),
      })),
    h(Thumb, { id: candidate.id }),
    h('div', { className: 'er-row-body' },
      h('div', { className: 'er-row-title' }, candidate.title),
      h('div', { className: 'er-row-meta' },
        h(Badge, { tone: cefrTone(candidate.cefrLevel) }, candidate.cefrLevel ?? '—'),
        candidate.articleType ? h(Badge, { tone: 'soft' }, t(`type.${candidate.articleType}`, { fallback: candidate.articleType })) : null,
        h('span', null, candidate.sourceName),
        candidate.publishedAt ? h('span', null, shortDate(candidate.publishedAt)) : null,
        candidate.wordCount > 0 ? h('span', null, `~${candidate.wordCount} ${t('common.words')}`) : null),
      candidate.reasons.length > 0 && h('div', { className: 'er-reasons' },
        candidate.reasons.map((reason) => h(Badge, { key: reason, tone: 'violet' }, reason))),
      failure !== undefined && failure.length > 0
        ? h('div', { className: 'er-candidate-error' }, failure)
        : null),
    h('div', { className: 'er-row-side' },
      candidate.imported
        ? h(Badge, { tone: 'mint' }, t('discover.imported'))
        : h(Badge, { tone: 'blue' }, `${candidate.score}`)),
    h('a', {
      href: candidate.url, target: '_blank', rel: 'noreferrer noopener',
      className: 'er-btn ghost sm', style: { textDecoration: 'none' },
      onClick: (event) => event.stopPropagation(),
    }, t('common.source')));
}

/** Live progress panel for one discovery run: bar, per-source state, log. */
function RunProgress({ t, progress }) {
  if (progress === null) return null;
  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const ratio = total === 0 ? (progress.running ? 0.15 : 1) : done / total;
  const stateTone = (status) => (status === 'ok' ? 'mint'
    : status === 'failed' ? 'pink'
      : status === 'empty' ? 'amber'
        : status === 'fetching' ? 'violet' : 'soft');
  return h(Cell, {
    span: 12,
    eyebrow: progress.running ? t('discover.running') : t('discover.runDone'),
    icon: h(Icons.clock, null),
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h('div', { style: { flex: 1 } }, h(Progress, { ratio })),
      h('span', { className: 'er-card-sub' }, `${done} / ${total}`),
      h('span', { className: 'er-card-sub' }, `· ${t('discover.candidatesCount')} ${progress.candidates ?? 0}`)),
    progress.sources?.length > 0
      ? h('div', { className: 'er-chips' },
        progress.sources.map((source) => h(Badge, {
          key: source.sourceId, tone: stateTone(source.status),
        }, `${source.sourceName}${source.fetched > 0 ? ` ${source.fetched}` : ''}`)))
      : null,
    progress.log?.length > 0
      ? h('div', {
        className: 'er-raw',
        style: { maxHeight: 140, display: 'flex', flexDirection: 'column', gap: 2 },
      },
      // Newest first: the interesting line is the one that just happened.
      [...progress.log].reverse().map((line, index) => h('div', {
        key: `${line.at}-${index}`,
        style: { color: line.level === 'error' ? 'var(--dsw-alias-state-error-primary)' : undefined },
      }, `${line.at.slice(11, 19)}  ${line.message}`)))
      : null,
    progress.error ? h(Alert, null, progress.error) : null));
}

/**
 * The shared discovery state: the profile, the running sweep, and the
 * candidates it produced.
 *
 * The collection profile and the discovered content are two tabs of one
 * workflow, so they share this state: a run started on the profile tab fills
 * the candidates on the content tab.
 *
 * The candidate list is paginated: the content pane holds one screen and asks
 * for the next page as the reader scrolls, so a long tail of candidates never
 * makes the pane taller than the viewport.
 */
function useDiscoveryState(t, notify) {
  const profiles = useLoad(() => call('listProfiles'), []);
  const settings = useLoad(() => call('settings'), []);
  const [profile, setProfile] = React.useState(null);
  // Hydrated from `discovered_articles`, so switching pages and coming back
  // shows the same pending list instead of an empty pane.
  const pending = useLoad(() => call('pendingCandidates', { limit: PAGE_SIZE }), []);
  const [candidates, setCandidates] = React.useState(null);
  const [total, setTotal] = React.useState(0);
  // Whether the Host answers with real pages. A Host that predates pagination
  // sends the top rows as one array and ignores the offset, so the client cuts
  // the pages out of that array itself.
  const [paged, setPaged] = React.useState(true);
  const [hasMore, setHasMore] = React.useState(false);
  const [reports, setReports] = React.useState([]);
  const [selected, setSelected] = React.useState([]);
  // Why a candidate refused to import, keyed by its id.
  const [failures, setFailures] = React.useState(() => new Map());
  const [loadingMore, setLoadingMore] = React.useState(false);
  const action = useAction();
  React.useEffect(() => {
    if (profiles.data && profile === null) setProfile(profiles.data[0]);
  }, [profiles.data, profile]);
  // `null` means "not chosen yet", so a run's own results are never overwritten
  // by a late hydration.
  React.useEffect(() => {
    if (candidates !== null) return;
    const payload = pending.data;
    if (!payload) return;
    const legacy = Array.isArray(payload);
    setPaged(!legacy);
    const items = legacy ? payload : (payload.items ?? []);
    setCandidates(items);
    setTotal(legacy ? items.length : (payload.total ?? items.length));
    // A legacy Host returned as many rows as were asked for, so a full page
    // means there may be more behind it.
    setHasMore(legacy ? items.length >= PAGE_SIZE : items.length < (payload.total ?? 0));
  }, [pending.data, candidates]);
  const shown = candidates ?? [];

  // Live run state, polled while a sweep is in flight.
  const [progress, setProgress] = React.useState(null);
  const polling = React.useRef(null);
  const stopPolling = () => {
    if (polling.current !== null) {
      clearInterval(polling.current);
      polling.current = null;
    }
  };
  React.useEffect(() => stopPolling, []);
  const startPolling = () => {
    stopPolling();
    polling.current = setInterval(() => {
      call('discoverProgress')
        .then((value) => {
          if (value === null || value === undefined) return;
          setProgress(value);
          if (value.running !== true) stopPolling();
        })
        .catch(() => stopPolling());
    }, 600);
  };

  const search = async () => {
    setProgress({ running: true, total: 0, done: 0, sources: [], log: [] });
    startPolling();
    const result = await action.run(async () => {
      const current = await call('saveProfile', { profile });
      // The profile carries `articleCount`; passing no limit keeps that in charge.
      return call('discover', { profileId: current.id });
    });
    stopPolling();
    // Read the final state once the sweep settles, so the log is complete even
    // if the last poll landed mid-flight.
    await call('discoverProgress').then(setProgress).catch(() => undefined);
    if (result) {
      setCandidates(result.candidates ?? []);
      setTotal(result.candidates?.length ?? 0);
      setHasMore(false);
      setReports(result.sources ?? []);
      setSelected([]);
    }
  };
  const toggle = (id) => setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  /**
   * Import the selected candidates.
   *
   * Every candidate is reported separately, because one unreachable source
   * must not hide the ones that worked. A candidate that was imported leaves
   * the discovered list; one that failed stays, so the reader can retry it.
   */
  const importSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const results = await action.run(() => call('confirmImport', { candidateIds: ids }));
    if (!results) return;
    const imported = results.filter((item) => item.ok);
    const failed = results.filter((item) => !item.ok);
    // Imported candidates are no longer pending, so drop them from the list.
    const done = new Set(imported.map((item) => item.id));
    setCandidates((current) => (current ?? []).filter((item) => !done.has(item.id)));
    setTotal((count) => Math.max(0, count - done.size));
    setSelected([]);
    // A failed candidate stays in the list with its reason attached, so the
    // reader sees why it did not import and can retry it.
    const reasons = new Map(failed.map((item) => [item.id, item.error ?? '']));
    setFailures(reasons);
    if (imported.length > 0) pending.reload();
    if (failed.length === 0) {
      notify(t('discover.importDone', { count: imported.length }), 'ok');
    } else if (imported.length === 0) {
      // Nothing worked: the reason matters more than the count.
      notify(failed[0].error ?? t('discover.importNone'), 'error');
    } else {
      notify(t('discover.importPartial', { done: imported.length, failed: failed.length }), 'error');
    }
  };
  /**
   * Set the selected candidates aside.
   *
   * Opposite of importing: the learner decided these are not worth keeping, so
   * they leave the candidate list without becoming articles.
   */
  const discardSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const result = await action.run(() => call('discardCandidates', { candidateIds: ids }));
    if (!result) return;
    // The discarded ones leave the list, exactly like the imported ones.
    setCandidates((current) => (current ?? []).filter((item) => !ids.includes(item.id)));
    setTotal((count) => Math.max(0, count - result.removed));
    setSelected([]);
    setFailures((current) => {
      const next = new Map(current ?? []);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (result.removed > 0) pending.reload();
    notify(t('discover.discarded', { count: result.removed }), 'ok');
  };

  /**
   * Load the next page of candidates.
   *
   * Appended, never replaced: the reader has already scrolled past the rows
   * that are on screen, and replacing them would jump the list back to the top.
   */
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    const offset = shown.length;
    setLoadingMore(true);
    try {
      // A legacy Host ignores the offset, so it is asked for every row up to
      // the end of this page and the page is cut out of the answer.
      const limit = paged ? PAGE_SIZE : offset + PAGE_SIZE;
      const payload = await call('pendingCandidates', { limit, offset: paged ? offset : 0 });
      const legacy = Array.isArray(payload);
      const items = legacy ? payload.slice(offset) : (payload?.items ?? []);
      if (items.length === 0) {
        setHasMore(false);
        return;
      }
      setCandidates((current) => {
        const seen = new Set((current ?? []).map((row) => row.id));
        const fresh = items.filter((row) => !seen.has(row.id));
        return [...(current ?? []), ...fresh];
      });
      if (legacy) {
        setTotal(offset + items.length);
        setHasMore(payload.length >= limit);
      } else {
        const count = payload?.total ?? offset + items.length;
        setTotal(count);
        setHasMore(offset + items.length < count);
      }
    } catch {
      /* a failed page must not break the list already on screen */
    } finally {
      setLoadingMore(false);
    }
  };
  return {
    profiles, settings, profile, setProfile, pending, candidates, setCandidates, setTotal,
    reports, selected, action, shown, total, paged, hasMore, progress, search,
    toggle, importSelected, discardSelected, loadMore, loadingMore, failures,
  };
}

/** The collection profile tab: what to collect, and the button that collects it. */
function DiscoveryTab({ t, notify, state }) {
  const {
    profiles, settings, profile, setProfile, action, progress, search,
  } = state;
  return h('div', { className: 'er-discover-spec' },
    h(Cell, { span: 12, size: 'feature', eyebrow: t('discover.specTitle'), icon: h(Icons.grid, null) },
      profiles.status === 'loading' ? h(Skeleton, { height: 120 }) : null,
      profile ? h(ProfileForm, {
        t, profile,
        collection: settings.data?.collection,
        onChange: setProfile,
      }) : null,
      h('div', {
        style: {
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          gap: 8, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--er-line)',
        },
      },
      h('span', { className: 'er-card-sub', style: { flex: 1, minWidth: 0 } },
        profile ? `${(profile.sourceIds ?? []).length} ${t('discover.sourcesSelected')}` : ''),
      h(Button, {
        onClick: () => action.run(() => call('saveProfile', { profile }), t('discover.profileSaved')),
        disabled: action.pending || profile === null,
      }, t('discover.saveProfile')),
      h(Button, {
        variant: 'primary',
        icon: h(Icons.sparkle, null),
        disabled: action.pending || profile === null,
        onClick: search,
      }, action.pending
        ? t('common.working')
        : `${t('discover.start')} · ${profile?.articleCount ?? 1}`)),
      action.error ? h('div', { style: { marginTop: 10 } }, h(Alert, null, action.error.message)) : null),
    h(RunProgress, { t, progress }));
}

/**
 * Preview one candidate before importing it.
 *
 * Clicking a candidate row opens this dialog with the cleaned body, the
 * counts and the two decisions the reader can make about it: import it into
 * the library, or drop it from the candidate list. Both are per-article, so
 * one bad candidate cannot affect the others.
 */
function CandidatePreview({ t, notify, candidate, onClose, onChanged }) {
  const action = useAction();
  const [preview, setPreview] = React.useState(null);
  const [error, setError] = React.useState(null);

  // Fetch the body on open. The candidate row only carries the title and a
  // snippet, which is not enough to judge whether the article is worth keeping.
  React.useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    call('importUrl', { url: candidate.url }).then((result) => {
      if (!cancelled) setPreview(result);
    }).catch((err) => {
      if (!cancelled) setError(err?.message ?? t('discover.previewFailed'));
    });
    return () => { cancelled = true; };
  }, [candidate.id, candidate.url]);

  const importOne = async () => {
    const results = await action.run(() => call('confirmImport', { candidateIds: [candidate.id] }));
    if (results) {
      const ok = results.filter((item) => item.ok);
      if (ok.length > 0) {
        notify(t('discover.importDone', { count: ok.length }), 'ok');
        onChanged([candidate.id]);
        onClose();
      } else {
        notify(results[0]?.error ?? t('discover.importNone'), 'error');
      }
    }
  };

  const deleteOne = async () => {
    const result = await action.run(() => call('discardCandidates', { candidateIds: [candidate.id] }));
    if (result) {
      notify(t('discover.discarded', { count: result.removed }), 'ok');
      onChanged([candidate.id]);
      onClose();
    }
  };

  const body = h('div', { className: 'er-candidate-preview' },
    h('div', { className: 'er-row-meta' },
      h(Badge, { tone: cefrTone(preview?.cefrLevel ?? candidate.cefrLevel) }, `${preview?.cefrLevel ?? candidate.cefrLevel ?? '—'} · AI 估计`),
      h('span', null, `${preview?.wordCount ?? candidate.wordCount ?? 0} ${t('common.words')}`),
      preview && h('span', { className: 'er-crumb-dot' }),
      preview && h('span', null, `${preview.sentenceCount} ${t('common.sentences')}`),
      preview && h('span', { className: 'er-crumb-dot' }),
      preview && h('span', null, `${preview.paragraphCount} ${t('common.paragraphs')}`)),
    preview?.duplicateArticleId
      ? h(Alert, { tone: 'warn' }, t('discover.duplicate'))
      : null,
    error
      ? h(Alert, null, error)
      : preview
        ? h('div', {
          className: 'er-prose er-candidate-preview-body',
        },
          preview.text.split(/\n{2,}/).map((paragraph, index) => h('p', { key: index }, paragraph)))
        // The fetch takes seconds. Show a label and a shimmering block, not a
        // blank dialog the reader has to figure out.
        : h('div', { className: 'er-candidate-loading' },
          h('div', { className: 'er-card-sub', style: { marginBottom: 10 } }, t('discover.previewLoading')),
          [0, 1, 2, 3, 4, 5].map((index) => h(Skeleton, {
            key: index,
            height: 14,
            radius: 8,
            // A shorter last line reads as a paragraph block rather than a
            // six identical bars.
            width: index === 5 ? '72%' : '100%',
          }))));

  return h(Dialog, {
    title: candidate.title,
    size: 'wide',
    onClose,
    footer: h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
      h(Button, { variant: 'ghost', onClick: onClose }, t('common.close')),
      h(Button, { variant: 'danger', disabled: action.pending, onClick: deleteOne }, t('discover.discardSelected')),
      h(Button, {
        variant: 'primary', disabled: action.pending || (preview?.duplicateArticleId !== undefined && preview.duplicateArticleId !== null),
        onClick: importOne,
      }, preview?.duplicateArticleId ? t('discover.alreadySaved') : t('discover.importSelected'))),
  }, body);
}

/**
 * The discovered content tab: the candidates a run produced, and the report.
 *
 * The list is one screen tall and loads the next page when the reader reaches
 * the bottom, so the pane never grows past the viewport.
 */
function DiscoveredTab({ t, notify, state }) {
  const {
    shown, total, paged, hasMore, reports, selected, action, toggle, pending,
    setCandidates, setTotal,
    importSelected, discardSelected, progress, loadMore, loadingMore, failures,
  } = state;
  // Which candidate the reader opened for a preview.
  const [previewCandidate, setPreviewCandidate] = React.useState(null);
  const failedSources = reports.filter((report) => report.ok === false);

  const reportRows = reports.map((report) => h('div', {
    key: report.sourceId,
    style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 },
  },
  h('span', { style: { minWidth: 170 } }, report.sourceName),
  report.ok ? h(Badge, { tone: 'mint' }, `${report.fetched}`) : h(Badge, { tone: 'pink' }, report.code ?? 'error'),
  h('span', { className: 'er-card-sub', style: { flex: 1, minWidth: 0 } },
    report.ok
      ? [report.filtered ? `${t('discover.filtered')} ${report.filtered}` : '', report.skipped ?? ''].filter(Boolean).join(' · ')
      : (report.error ?? ''))));

  // `resultsCard` decides its own span from this flag, so it must be known
  // before that cell is constructed.
  const hasReport = reports.length > 0;
  const reportCard = !hasReport ? null : h(Cell, {
    span: 4, eyebrow: `${t('discover.sourceReport')} · ${reports.length}`, icon: h(Icons.info, null),
  },
  h('div', { className: 'er-cell-scroll', style: { display: 'flex', flexDirection: 'column', gap: 6, '--er-cell-max': '360px' } }, reportRows),
  failedSources.length > 0 ? h(Alert, { tone: 'warn' }, `${failedSources.length} ${t('discover.sourcesFailed')}`) : null);

  const candidateRows = shown.map((candidate) => h(CandidateRow, {
    key: candidate.id, t, candidate, selected: selected.includes(candidate.id),
    onToggle: toggle, failure: failures.get(candidate.id),
    onPreview: (candidate) => setPreviewCandidate(candidate),
  }));

  // The list scrolls inside its own border; when the reader reaches the
  // bottom, the next page is fetched and appended.
  const onScroll = React.useCallback((event) => {
    const box = event.target;
    const remaining = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (remaining < 160) loadMore();
  }, [loadMore]);
  const count = paged ? `${shown.length}/${total}` : `${shown.length}${hasMore ? '+' : ''}`;
  const resultsCard = h(Cell, {
    span: hasReport ? 8 : 12,
    eyebrow: `${t('discover.results')}${shown.length > 0 ? ` · ${count}` : ''}`,
    icon: h(Icons.compass, null),
    actions: selected.length > 0
      ? h('div', { style: { display: 'flex', gap: 8 } },
        h(Button, { variant: 'primary', onClick: importSelected, disabled: action.pending }, `${t('discover.importSelected')} (${selected.length})`),
        h(Button, { variant: 'danger', onClick: discardSelected, disabled: action.pending }, `${t('discover.discardSelected')} (${selected.length})`))
      : null,
  },
  shown.length === 0
    ? h(Empty, { icon: h(Icons.compass, null), title: t('discover.emptyTitle'), description: t('discover.emptyBody') })
    : h('div', { className: 'er-cell-scroll er-candidate-scroll', onScroll },
      candidateRows,
      hasMore
        ? h('div', { className: 'er-more' },
          h(Button, {
            variant: 'ghost', disabled: loadingMore, onClick: loadMore,
          }, loadingMore ? t('common.working') : t('discover.loadMore')))
        : h('div', { className: 'er-more er-more--end' }, t('discover.listEnd'))));

  return h('div', { className: 'er-discover-results' },
    progress?.running === true ? h(RunProgress, { t, progress }) : null,
    h(Board, null, resultsCard, reportCard),
    previewCandidate
      ? h(CandidatePreview, {
        t, notify, candidate: previewCandidate,
        onClose: () => setPreviewCandidate(null),
        onChanged: (removedIds) => {
          // Drop the rows locally so the list updates immediately; the reload
          // is the background refresh for the total and any later pages.
          if (Array.isArray(removedIds) && removedIds.length > 0) {
            setCandidates((current) => (current ?? []).filter((item) => !removedIds.includes(item.id)));
            setTotal((count) => Math.max(0, count - removedIds.length));
          }
          pending.reload();
        },
      })
      : null);
}

/** URL import tab with a fetched preview. */
function UrlTab({ t, notify, onOpenArticle }) {
  const [url, setUrl] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const action = useAction();
  const fetchPreview = async () => {
    if (url.trim().length === 0) return;
    const result = await action.run(() => call('importUrl', { url: url.trim() }));
    if (result) setPreview(result);
  };
  const save = async () => {
    if (!preview) return;
    const created = await action.run(() => call('createArticle', {
      article: {
        title: preview.title, text: preview.text, sourceUrl: preview.url,
        sourceName: preview.sourceName, cefrLevel: preview.cefrLevel,
      },
    }), t('discover.saved'));
    if (created) {
      notify(`${t('discover.saved')} ${created.wordCount} ${t('common.words')}`, 'ok');
      setPreview(null);
      setUrl('');
      onOpenArticle(created.id);
    }
  };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    h(Card, { title: t('discover.urlTitle'), icon: h(Icons.link, null) },
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', {
          className: 'er-input', placeholder: 'https://www.bbc.com/news/articles/...', value: url,
          onChange: (event) => setUrl(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') fetchPreview();
          },
        }),
        h(Button, { variant: 'primary', onClick: fetchPreview, disabled: action.pending, icon: h(Icons.search, null) },
          action.pending ? t('common.fetching') : t('discover.fetch'))),
      h('p', { className: 'er-card-sub', style: { marginTop: 8 } }, t('discover.urlHint')),
      action.error && h('div', { style: { marginTop: 10 } }, h(Alert, null, action.error.message))),
    preview && h(Card, { title: t('discover.previewTitle'), icon: h(Icons.bookOpen, null) },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        preview.duplicateArticleId && h(Alert, { tone: 'warn' }, t('discover.duplicate')),
        h('div', { className: 'er-row-meta' },
          h(Badge, { tone: cefrTone(preview.cefrLevel) }, `${preview.cefrLevel} · AI 估计`),
          h('span', null, `${preview.wordCount} ${t('common.words')}`),
          h('span', { className: 'er-crumb-dot' }),
          h('span', null, `${preview.sentenceCount} ${t('common.sentences')}`),
          h('span', { className: 'er-crumb-dot' }),
          h('span', null, `${preview.paragraphCount} ${t('common.paragraphs')}`)),
        h('div', { className: 'er-prose', style: { maxHeight: 260, overflowY: 'auto', paddingRight: 6, fontSize: 13, lineHeight: 24 } },
          preview.text.split(/\n{2,}/).map((paragraph, index) => h('p', { key: index }, paragraph))),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(Button, { variant: 'ghost', onClick: () => setPreview(null) }, t('common.cancel')),
          h(Button, {
            variant: 'primary', disabled: action.pending || preview.duplicateArticleId !== null, onClick: save,
          }, preview.duplicateArticleId ? t('discover.alreadySaved') : t('discover.saveArticle'))))));
}

/** Manual paste tab. */
function PasteTab({ t, notify, onOpenArticle }) {
  const [title, setTitle] = React.useState('');
  const [source, setSource] = React.useState('');
  const [text, setText] = React.useState('');
  const action = useAction();
  const save = async () => {
    const created = await action.run(() => call('createArticle', {
      article: { title: title.trim() || undefined, text, sourceName: source.trim() || undefined },
    }), t('discover.saved'));
    if (created) {
      notify(t('discover.saved'), 'ok');
      setTitle('');
      setText('');
      setSource('');
      onOpenArticle(created.id);
    }
  };
  const words = text.trim().length === 0 ? 0 : (text.match(/[A-Za-z][A-Za-z'\-]*/g) ?? []).length;
  return h(Card, { title: t('discover.pasteTitle'), icon: h(Icons.note, null) },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h('div', { className: 'er-form-grid', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' } },
        h(Field, { label: t('discover.pasteTitleLabel') },
          h('input', { className: 'er-input', value: title, onChange: (event) => setTitle(event.target.value) })),
        h(Field, { label: t('discover.pasteSource') },
          h('input', { className: 'er-input', value: source, onChange: (event) => setSource(event.target.value) }))),
      h(Field, { label: t('discover.pasteBody') },
        h('textarea', {
          className: 'er-textarea', value: text, placeholder: t('discover.pastePlaceholder'),
          onChange: (event) => setText(event.target.value),
        })),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h('span', { className: 'er-card-sub' }, `${words} ${t('common.words')}`),
        h('div', { className: 'er-topbar-spacer' }),
        h(Button, { variant: 'primary', disabled: action.pending || words < 10, onClick: save }, t('discover.saveArticle'))),
      action.error && h(Alert, null, action.error.message)));
}

/**
 * The discover page.
 *
 * Two levels, never three at once: the outer tab strip switches between the
 * collection profile and the discovered content, and the profile tab carries
 * the three collection modes (auto / URL / paste) as its own inner strip. Each
 * pane fills the screen and scrolls inside its own border, so the page never
 * grows past one viewport.
 *
 * Both tab levels are controlled by the shell: the shell persists them, so
 * leaving the panel for another Session and coming back restores the exact
 * tab the user was on.
 */
function Discover({ t, notify, onOpenArticle, tab: tabProp, mode: modeProp, onTabChange, onModeChange }) {
  const [ownTab, setOwnTab] = React.useState('spec');
  const [ownMode, setOwnMode] = React.useState('auto');
  const controlled = typeof tabProp === 'string';
  const tab = controlled ? tabProp : ownTab;
  const mode = controlled ? (modeProp ?? 'auto') : ownMode;
  const setTab = (next) => {
    if (!controlled) setOwnTab(next);
    onTabChange?.(next);
  };
  const setMode = (next) => {
    if (!controlled) setOwnMode(next);
    onModeChange?.(next);
  };
  const state = useDiscoveryState(t, notify);
  return h('div', { className: 'er-page er-page--fill' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.discover'))),
      h('div', { className: 'er-topbar-spacer' }),
      h(Tabs, {
        items: [
          { id: 'spec', label: t('discover.tabSpec') },
          { id: 'results', label: t('discover.tabResults') },
        ],
        value: tab, onChange: setTab,
      })),
    tab === 'spec'
      ? h('div', { className: 'er-discover-pane' },
        h(Tabs, {
          items: [
            { id: 'auto', label: t('discover.tabAuto') },
            { id: 'url', label: t('discover.tabUrl') },
            { id: 'paste', label: t('discover.tabPaste') },
          ],
          value: mode, onChange: setMode,
        }),
        h('div', { className: 'er-discover-body' },
          mode === 'auto' && h(DiscoveryTab, { t, notify, state }),
          mode === 'url' && h(UrlTab, { t, notify, onOpenArticle }),
          mode === 'paste' && h(PasteTab, { t, notify, onOpenArticle })))
      : h('div', { className: 'er-discover-pane' },
        h('div', { className: 'er-discover-body er-discover-body--fixed' },
          h(DiscoveredTab, { t, notify, state }))));
}

export { Discover, ProfileForm, CandidateRow, DiscoveryTab, DiscoveredTab };
