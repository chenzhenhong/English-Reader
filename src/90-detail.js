/** Article detail: the reading surface (continuous mode + dual-column mode). */

/**
 * Stage order, label key and the one-line subject each stage produces.
 * The hint exists because "切分" and "逐句" both show a sentence count: without
 * it, 15/15 next to 15/15 reads like the same measurement twice.
 */
const STAGES_ORDER = [
  { id: 'OVERVIEW', labelKey: 'stage.OVERVIEW', hintKey: 'stageHint.OVERVIEW' },
  { id: 'DIFFICULTY', labelKey: 'stage.DIFFICULTY', hintKey: 'stageHint.DIFFICULTY' },
  { id: 'VOCABULARY', labelKey: 'stage.VOCABULARY', hintKey: 'stageHint.VOCABULARY' },
  { id: 'PHRASES', labelKey: 'stage.PHRASES', hintKey: 'stageHint.PHRASES' },
  { id: 'COLLOCATIONS', labelKey: 'stage.COLLOCATIONS', hintKey: 'stageHint.COLLOCATIONS' },
  { id: 'SEGMENTATION', labelKey: 'stage.SEGMENTATION', hintKey: 'stageHint.SEGMENTATION' },
  { id: 'SENTENCE_ANALYSIS', labelKey: 'stage.SENTENCE_ANALYSIS', hintKey: 'stageHint.SENTENCE_ANALYSIS' },
  { id: 'REVIEW', labelKey: 'stage.REVIEW', hintKey: 'stageHint.REVIEW' },
];

/** How often the detail page re-reads an analysis that is still in flight. */
const ANALYSIS_POLL_MS = 2000;

/**
 * Whether the article's analysis is still in flight.
 *
 * The article row, the analysis version and the per-stage rows can disagree
 * while a run is transitioning, so any of them saying "in flight" counts.
 * @param {object} detail the `getArticle` payload.
 * @returns {boolean} true while something is still running.
 */
function isAnalysisRunning(detail) {
  if (!detail) return false;
  if (detail.analysis?.status === 'RUNNING') return true;
  if (detail.article?.status === 'ANALYZING') return true;
  return (detail.tasks ?? []).some((task) => task.status === 'RUNNING');
}

/**
 * Per-stage counter text.
 *
 * A count must describe work actually finished, so each stage reads its own
 * progress payload:
 * - SEGMENTATION reports how many sentences were cut.
 * - SENTENCE_ANALYSIS reports analysed/total, never the success-only count.
 * Other stages have no countable unit and show none.
 * @returns {string} suffix such as ` 4/15`, or an empty string.
 */
function stageCounter(stageId, progress) {
  if (!progress) return '';
  if (stageId === 'SEGMENTATION') {
    // A single, finished action: report the sentence total, not a ratio that
    // looks like progress.
    const total = Number(progress.sentences);
    return Number.isFinite(total) && total > 0 ? ` ${total}` : '';
  }
  if (stageId === 'SENTENCE_ANALYSIS') {
    const total = Number(progress.sentences);
    if (!Number.isFinite(total) || total <= 0) return '';
    const analysed = Number.isFinite(progress.analysed)
      ? progress.analysed
      : (Number(progress.done) || 0) + (Number(progress.needsReview) || 0);
    return ` ${analysed}/${total}`;
  }
  return '';
}

/**
 * Stage progress strip.
 *
 * A failed stage is a button, not a banner: its detail — the error code, the
 * model's raw output and every failed sentence — belongs in a dialog the
 * learner opens on demand, not in a red panel that takes a whole column away
 * from the article they are reading. A stage that did not fail stays plain
 * text, so nothing suggests it is clickable.
 * @param {object} props
 * @param {(stageId: string) => void} props.onInspect opens the stage's detail.
 */
function AnalysisProgress({ t, tasks, onRetry, pending, onInspect, failedCount }) {
  const cells = STAGES_ORDER.map((stage) => {
    const task = tasks.find((item) => item.stage === stage.id);
    const status = task?.status ?? 'PENDING';
    const counter = stageCounter(stage.id, task?.progress);
    const review = stage.id === 'SENTENCE_ANALYSIS' && (task?.progress?.needsReview ?? 0) > 0
      ? ` · ${t('reader.needsReviewCount')} ${task.progress.needsReview}`
      : '';
    // The sentence stage fails per sentence, not as a stage: a run that stopped
    // early leaves the task at PENDING while individual sentences are marked
    // failed. Its detail is worth opening whenever either says so.
    const sentenceFailures = stage.id === 'SENTENCE_ANALYSIS' && failedCount > 0;
    // A review-flagged sentence is not a failure, but its quotes failed the
    // evidence check, so the card opens the same detail dialog.
    const reviewCount = stage.id === 'SENTENCE_ANALYSIS' ? (task?.progress?.needsReview ?? 0) : 0;
    // A run that stopped part-way leaves the stage PENDING so it stays
    // retryable, but it did start: its partial results are already on screen.
    // Calling that "待执行" is wrong, and it hides the retry button.
    const started = Number(task?.progress?.done ?? 0) > 0 || Number(task?.progress?.failed ?? 0) > 0;
    const interrupted = status === 'PENDING' && started;
    const shownStatus = interrupted ? 'INTERRUPTED' : status;
    const inspectable = status === 'FAILED' || status === 'NEEDS_REVIEW' || interrupted || sentenceFailures || reviewCount > 0;
    // A stage that has detail but did not itself fail still needs to say how
    // many sentences went wrong, or the card looks successful.
    const failedBadge = sentenceFailures
      ? h('span', { className: 'er-stage-failed-count' }, `${failedCount} ${t('reader.sentencesFailed')}`)
      : null;
    const body = h(React.Fragment, null,
      h('div', { className: 'er-stage-name' }, t(stage.labelKey, { fallback: stage.id }),
        inspectable ? h(Icons.chevron, { dir: 'right' }) : null),
      h('div', { className: 'er-stage-hint' }, t(stage.hintKey, { fallback: '' }),
        // The status line is where the count lives, so it stays last.
      ),
      h('div', { className: 'er-stage-status' }, `${STATUS_LABELS[shownStatus] ?? shownStatus}${counter}${review}`),
      failedBadge);
    return h('div', { key: stage.id, className: 'er-stage', 'data-status': shownStatus, 'data-inspectable': inspectable },
      inspectable
        ? h('button', {
          type: 'button',
          className: 'er-stage-hit',
          'aria-label': `${t(stage.labelKey, { fallback: stage.id })} · ${t('reader.inspectStage')}`,
          onClick: () => onInspect(stage.id),
        }, body)
        : h('div', { className: 'er-stage-hit er-stage-hit--static' }, body),
      status === 'FAILED' || interrupted
        ? h(Button, { size: 'sm', variant: 'ghost', disabled: pending, onClick: () => onRetry(stage.id) }, t('common.retry'))
        : null);
  });
  return h('div', { className: 'er-stage-list' }, cells);
}

/**
 * Reader progress band.
 *
 * Collapses to a single progress line unless something needs attention (a failed
 * stage, a review flag, or a run in flight). The stage grid is tall; when every
 * stage succeeded it only repeats "done" eight times and steals height from the
 * article. `open` lets the learner override either way.
 * @param {object} props
 * @param {boolean|null} props.open null = follow the automatic rule.
 */
function Band({ t, ratio, position, tasks, running, onRetry, pending, open, onToggle, onInspect, failedCount }) {
  const needsAttention = running || failedCount > 0 || tasks.some((task) => (
    task.status === 'FAILED' || task.status === 'NEEDS_REVIEW'
  ));
  const expanded = open === null ? needsAttention : open;

  // The badge counts what the learner can act on. A stage that failed or has
  // sentences to review counts once; a stage whose sentences failed without
  // the stage itself failing still counts, because its card carries the retry
  // button. Without that, an article with eight failed sentences and no
  // failed stage reported "0 项待处理".
  const failedStages = tasks.filter((task) => task.status === 'FAILED' || task.status === 'NEEDS_REVIEW').length;
  const sentenceStageFailed = failedCount > 0
    && !tasks.some((task) => task.stage === 'SENTENCE_ANALYSIS' && (task.status === 'FAILED' || task.status === 'NEEDS_REVIEW'))
    ? 1
    : 0;
  const attentionCount = failedStages + sentenceStageFailed;
  const label = task => STATUS_LABELS[task.status] ?? task.status;

  const bar = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
    h('span', { className: 'er-card-sub', style: { flex: 'none' } }, t('reader.progress')),
    h('div', { style: { flex: 1, minWidth: 80 } }, h(Progress, { ratio })),
    h('span', { className: 'er-card-sub', style: { flex: 'none' } }, `${Math.round(ratio * 100)}%`),
    h('span', { className: 'er-card-sub', style: { flex: 'none' } }, position),
    needsAttention && !expanded
      ? h(Badge, { tone: 'pink' }, `${attentionCount} ${t('reader.needsAttention')}`)
      : null,
    // `onToggle` receives the *next* state. Passing the current one made the
    // parent store the value it already had, so the button looked dead.
    h(Button, {
      size: 'sm',
      variant: 'ghost',
      icon: h(Icons.chevron, { dir: expanded ? 'up' : 'down' }),
      iconOnly: true,
      ariaExpanded: expanded,
      ariaLabel: expanded ? t('reader.collapseBand') : t('reader.expandBand'),
      title: expanded ? t('reader.collapseBand') : t('reader.expandBand'),
      onClick: () => onToggle(!expanded),
    }));

  return h(Cell, {
    span: 12,
    size: 'compact',
    // Collapsed: no bottom padding, so the reader starts right beneath the bar.
    className: expanded ? 'er-reader-band' : 'er-reader-band er-reader-band--collapsed',
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: expanded ? 10 : 0 } },
    bar,
    expanded
      ? h(React.Fragment, null,
        h(AnalysisProgress, { t, tasks, onRetry, pending, onInspect, failedCount }),
        running ? h(Alert, { tone: 'warn' }, t('reader.analysisRunning')) : null)
      : null));
}

/**
 * Detail dialog for one stage.
 *
 * Opened when the learner clicks a failed (or review-flagged) stage card. It
 * lists the error codes with their meanings, the model's raw output when there
 * is one, and — for the sentence stage — every failed sentence with a jump
 * button, so the reader can go straight to it and retry.
 *
 * The page itself stays clean: a red summary panel used to sit in the aside
 * and push the article aside even when the learner only wanted to read.
 */
function StageDetailDialog({ t, stageId, tasks, sentences, onClose, onJump, onRetry }) {
  const stage = STAGES_ORDER.find((item) => item.id === stageId);
  const task = tasks.find((item) => item.stage === stageId);
  const status = task?.status ?? 'PENDING';
  const stageName = stage ? t(stage.labelKey, { fallback: stageId }) : stageId;

  // Only the sentence stage fails per item; the others fail as a whole stage.
  const failed = stageId === 'SENTENCE_ANALYSIS'
    ? sentences.filter((item) => item.analysisStatus === 'failed')
    : [];
  // A review-flagged sentence is not a failure, but it did fail the evidence
  // check, so the dialog lists it with the quotes that could not be matched.
  const reviewed = stageId === 'SENTENCE_ANALYSIS'
    ? sentences.filter((item) => item.analysisStatus === 'needs_review')
    : [];
  const codes = new Map();
  if (failed.length > 0) {
    for (const item of failed) {
      const code = item.error?.code ?? 'LLM_UNAVAILABLE';
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  } else if (task?.errorCode) {
    codes.set(task.errorCode, 1);
  }
  const counter = stageCounter(stageId, task?.progress);
  const review = stageId === 'SENTENCE_ANALYSIS' && (task?.progress?.needsReview ?? 0) > 0
    ? ` · ${t('reader.needsReviewCount')} ${task.progress.needsReview}`
    : '';

  const rawOutput = failed.find((item) => typeof item.error?.raw === 'string' && item.error.raw.length > 0)?.error.raw ?? null;

  const body = h('div', { className: 'er-stage-detail' },
    h('div', { className: 'er-stage-detail-head' },
      h(Badge, { tone: status === 'FAILED' ? 'pink' : 'amber' }, `${STATUS_LABELS[status] ?? status}${counter}${review}`),
      h('div', { className: 'er-stage-hint' }, t(stage?.hintKey ?? '', { fallback: '' }))),
    codes.size > 0
      ? h('div', { className: 'er-stage-detail-codes' },
        [...codes.entries()].map(([code, count]) => h('div', { key: code, className: 'er-stage-detail-code' },
          h(Badge, { tone: 'pink' }, `${code} × ${count}`),
          h('div', { className: 'er-stage-detail-meaning' }, t(`error.${code}`, { fallback: t('error.unknown') })))))
      : null,
    task?.errorMessage
      ? h('div', { className: 'er-stage-detail-msg' }, task.errorMessage)
      : null,
    // A per-sentence failure usually says the same thing as the stage; only
    // show it when it adds a specific reason.
    failed.length > 0
      ? h('div', { className: 'er-stage-detail-list' },
        failed.map((item) => h('div', { key: item.sentenceIndex, className: 'er-stage-detail-row' },
          h('span', { className: 'er-badge plain' }, `#${item.sentenceIndex + 1}`),
          h('span', { className: 'er-stage-detail-text' }, item.text),
          item.error?.message ? h('span', { className: 'er-meaning-ctx' }, item.error.message) : null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => onJump(item.sentenceIndex) }, t('reader.jumpToSentence')))))
      : null,
    // The review list says which sentences were flagged and, for each, exactly
    // which quoted excerpts could not be found in the article body.
    reviewed.length > 0
      ? h('div', { className: 'er-stage-detail-list' },
        h('div', { className: 'er-stage-detail-title' }, t('reader.needsReviewTitle')),
        reviewed.map((item) => h('div', { key: item.sentenceIndex, className: 'er-stage-detail-row er-stage-detail-row--review' },
          h('span', { className: 'er-badge plain' }, `#${item.sentenceIndex + 1}`),
          h('span', { className: 'er-stage-detail-text' }, item.text),
          (item.review?.missing ?? []).length > 0
            ? h('div', { className: 'er-stage-detail-quotes' },
              h('div', { className: 'er-stage-detail-quotes-label' }, t('reader.needsReviewReason')),
              (item.review.missing).map((quote, index) => h('div', { key: index, className: 'er-stage-detail-quote' },
                h('span', { className: 'er-badge plain' }, quote))))
            : null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => onJump(item.sentenceIndex) }, t('reader.jumpToSentence')))))
      : null,
    // The model's raw output is the fastest way to tell a truncation from a
    // refusal; it is stored per sentence, so show the first one there is.
    rawOutput
      ? h('div', { className: 'er-stage-detail-raw er-mono' }, rawOutput)
      : null);

  return h(Dialog, {
    // Long error text and raw JSON need horizontal room.
    size: 'wide',
    title: `${stageName} · ${t('reader.stageDetail')}`,
    onClose,
    footer: status === 'FAILED'
      ? h(Button, { disabled: false, onClick: () => { onRetry(stageId); onClose(); } }, t('common.retry'))
      : null,
  }, body);
}

/** Note list for the article, above the reader. */
function NoteList({ t, notes }) {
  if (notes.length === 0) return null;
  return h(Cell, { span: 12, eyebrow: `${t('reader.notes')} · ${notes.length}`, icon: h(Icons.note, null) },
    notes.map((note) => h('div', { key: note.id, className: 'er-struct-item', style: { marginBottom: 8 } },
      h('div', { className: 'er-struct-text' }, note.body),
      h('div', { className: 'er-meaning-ctx' },
        note.sentenceIndex !== null && note.sentenceIndex !== undefined
          ? `${t('reader.sentence')} #${note.sentenceIndex + 1}`
          : t('reader.articleNote'),
        ' · ', relativeDate(note.createdAt)))));
}

/**
 * Refresh the detail page while the article's analysis is still in flight.
 *
 * A run can be started from the library list, the dashboard or an import, so
 * the learner can open the article while it is still parsing. Polling the same
 * `getArticle` payload keeps the stage strip and the sentence analyses moving
 * instead of freezing at whatever was on screen when the page loaded. The run
 * state is read from the latest payload, so the interval stops acting on its
 * own once the Host settles the analysis.
 * @param {object} detail the detail page's `useLoad` handle.
 * @param {string} articleId the article being read.
 */
function useAnalysisPolling(detail, articleId) {
  const reloadRef = React.useRef(detail.reload);
  reloadRef.current = detail.reload;
  const running = isAnalysisRunning(detail.data);
  React.useEffect(() => {
    // Poll only while a run is actually in flight, so a settled article never
    // keeps a timer alive. `detail` is rebuilt every render, so the reload is
    // read through a ref instead of being a dependency.
    if (!running) return undefined;
    // The render harness has no repeating timer, so a page that would poll
    // there would spin forever against a static "RUNNING" fixture; only a real
    // browser runs the loop.
    if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined;
    const timer = window.setInterval(() => reloadRef.current(), ANALYSIS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, articleId]);
}

/** The reading page. */
function ArticleDetail({ t, articleId, notify, onBack, onNavigateKnowledge, sentenceIndex }) {
  const detail = useLoad(() => call('getArticle', { articleId }), [articleId]);
  useAnalysisPolling(detail, articleId);
  const [mode, setMode] = React.useState('split');
  const [active, setActive] = React.useState(-1);
  const [drawerWord, setDrawerWord] = React.useState(null);
  const [insightTab, setInsightTab] = React.useState('guide');
  // The stage strip only earns its space when something needs attention; a fully
  // successful analysis collapses to a single progress line, and the reader gets
  // the height back. The learner can always open it to inspect the detail.
  const [bandOpen, setBandOpen] = React.useState(null);
  // Which stage's detail dialog is open, or null when none is.
  const [inspectStage, setInspectStage] = React.useState(null);
  const [noteDraft, setNoteDraft] = React.useState('');
  // Dictionary lookup for a word in the selected sentence: the word open, the
  // provider it was queried with, what came back, and whether a request is in
  // flight. Nothing is persisted; closing the dialog forgets it.
  const [dictionary, setDictionary] = React.useState({ word: null, provider: null, result: null, error: null, busy: false });
  const action = useAction();
  const words = React.useMemo(() => (detail.data ? wordIndex(detail.data) : new Map()), [detail.data]);
  const sentences = detail.data?.sentences ?? [];
  const activeSentence = sentences.find((sentence) => sentence.sentenceIndex === active) ?? null;

  React.useEffect(() => {
    if (detail.data && active < 0) setActive(detail.data.progress?.sentenceIndex ?? 0);
  }, [detail.data, active]);

  // A context from the library can jump here at one sentence. Apply it once,
  // then scroll that sentence into view; the flag keeps a later click from
  // re-scrolling, and the target lives in a ref so a re-render cannot re-apply
  // it.
  const jumpRef = React.useRef(null);
  const jumpedRef = React.useRef(false);
  React.useEffect(() => {
    if (sentenceIndex === undefined || sentenceIndex < 0) {
      jumpRef.current = null;
      jumpedRef.current = false;
      return;
    }
    if (jumpRef.current === sentenceIndex) return;
    jumpRef.current = sentenceIndex;
    jumpedRef.current = true;
    setActive(sentenceIndex);
  }, [sentenceIndex, detail.data]);

  React.useEffect(() => {
    if (!jumpedRef.current || typeof document === 'undefined') return;
    const node = document.querySelector('.er-sentence[data-active="true"]');
    if (node !== null) {
      node.scrollIntoView?.({ block: 'center' });
      jumpedRef.current = false;
    }
  }, [active, sentences.length]);

  // Reading time is measured, not estimated: accumulate wall-clock time only
  // while this pane is visible, and attribute it to the article on the next save.
  const readMs = React.useRef(0);
  const visibleSince = React.useRef(null);
  React.useEffect(() => {
    const markVisible = () => {
      if (visibleSince.current === null) visibleSince.current = Date.now();
    };
    // Without a DOM there is no visibility signal; count elapsed time only.
    if (typeof document === 'undefined') return undefined;
    const flush = () => {
      if (visibleSince.current !== null) {
        readMs.current += Date.now() - visibleSince.current;
        visibleSince.current = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markVisible();
      else flush();
    };
    markVisible();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [articleId]);

  // Reading position is saved once the selection settles, so dragging through
  // sentences does not write a row per click. The save carries the seconds read
  // since the previous save, so the study log reflects real attention.
  React.useEffect(() => {
    if (detail.data === undefined || active < 0) return undefined;
    const total = Math.max(1, sentences.length - 1);
    const ratio = Math.min(1, Math.max(0, active) / total);
    const timer = setTimeout(() => {
      // Fold the currently-visible span in before reporting.
      if (visibleSince.current !== null) {
        readMs.current += Date.now() - visibleSince.current;
        visibleSince.current = Date.now();
      }
      const seconds = Math.round(readMs.current / 1000);
      readMs.current = 0;
      call('saveProgress', { articleId, sentenceIndex: active, ratio, seconds }).catch(() => undefined);
    }, 900);
    return () => clearTimeout(timer);
  }, [active, articleId, detail.data, sentences.length]);

  const updateWord = async (wordId, patch) => {
    const value = await action.run(() => call('updateKnowledge', { entityType: 'word', entityId: wordId, ...patch }));
    if (value) detail.reload();
  };
  /**
   * Add or remove one entity from the knowledge library.
   * Nothing is stored until this runs, which is what keeps parsing from
   * silently filling the library.
   */
  const setInLibrary = async (kind, entityId, next) => {
    const value = await action.run(() => call('updateKnowledge', {
      entityType: kind, entityId, favorite: next,
    }));
    if (value) {
      notify(next ? t('reader.addedToLibrary') : t('reader.removedFromLibrary'), 'ok');
      detail.reload();
    }
  };
  /**
   * Look one word up on the provider the learner picked.
   *
   * The popup replaces the local card for that word: a word in the selected
   * sentence answers with the dictionary, so the learner reads one source
   * rather than two. The article's own analysis stays available from the
   * sentence pane.
   */
  const openDictionary = async (surface) => {
    if (surface.length === 0 || dictionary.busy) return;
    setDictionary({ word: surface, provider: null, result: null, error: null, busy: true });
    try {
      const result = await call('lookupWord', { word: surface });
      setDictionary({
        word: surface, provider: result?.provider ?? null, result, error: null, busy: false,
      });
    } catch (error) {
      setDictionary({ word: surface, provider: null, result: null, error, busy: false });
    }
  };
  const closeDictionary = () => setDictionary({ word: null, provider: null, result: null, error: null, busy: false });
  /**
   * Retry the open word on the other provider.
   *
   * The provider is a stored preference, so switching it first is what makes
   * the retry land on the other source; `force` skips the cache, which would
   * otherwise hand back the failure for the same key.
   */
  const switchDictionary = async (provider) => {
    if (dictionary.busy || dictionary.word === null) return;
    setDictionary((previous) => ({ ...previous, busy: true, error: null }));
    try {
      await call('savePluginSettings', { dictionary: provider });
      const result = await call('lookupWord', { word: dictionary.word, force: true });
      setDictionary({ word: dictionary.word, provider, result, error: null, busy: false });
    } catch (error) {
      setDictionary((previous) => ({ ...previous, busy: false, error }));
    }
  };
  const startAnalysis = async () => {
    const started = await action.run(() => call('startAnalysis', { articleId }));
    if (started) {
      notify(t('articles.analysisStarted'), 'ok');
      detail.reload();
    }
  };
  const retry = async (stage) => {
    const state = await action.run(() => call('retryStage', { articleId, stage }));
    if (state) {
      notify(t('articles.retryDone'), 'ok');
      detail.reload();
    }
  };
  const addNote = async () => {
    if (noteDraft.trim().length === 0) return;
    const saved = await action.run(() => call('saveNote', {
      articleId, body: noteDraft, sentenceIndex: active >= 0 ? active : undefined,
    }));
    if (saved) {
      setNoteDraft('');
      detail.reload();
    }
  };
  /**
   * Re-fetch the source page, keep only the prose and re-segment the article.
   *
   * An article imported before the cleaner existed still carries the page's
   * chrome in its body. Cleaning it changes every sentence offset, so the
   * analysis is dropped and the reader is told to run it again.
   */
  // Which destructive action is waiting for a yes. The action itself runs
  // only after the learner has read what it costs them.
  const [confirm, setConfirm] = React.useState(null);

  /** Run the body cleaner once the learner has accepted its cost. */
  const confirmClean = async () => {
    setConfirm(null);
    const result = await action.run(() => call('cleanArticle', { articleId }));
    if (!result) return;
    notify(t('reader.cleaned', {
      before: result.wordsBefore,
      after: result.wordsAfter,
    }), 'ok');
    detail.reload();
  };
  const confirmDelete = async () => {
    setConfirm(null);
    const removed = await action.run(() => call('deleteArticle', { articleId }));
    if (removed) onBack();
  };

  if (detail.status === 'loading' && !detail.data) {
    return h('div', { className: 'er-page' },
      h(Skeleton, { height: 44, radius: 14 }), h(Skeleton, { height: 320, radius: 20 }));
  }
  if (detail.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, detail.error.message),
      h('div', null, h(Button, { onClick: detail.reload }, t('common.retry'))));
  }

  const data = detail.data;
  const article = data.article;
  const total = Math.max(1, sentences.length);
  const ratio = sentences.length > 1 ? Math.min(1, Math.max(0, active) / (sentences.length - 1)) : 0;
  const running = isAnalysisRunning(data);

  const jumpToSentence = (index) => {
    setActive(index);
    setMode('split');
  };

  const pane = SentencePane({
    t,
    sentence: activeSentence ? { ...activeSentence, articleId } : null,
    sentenceText: activeSentence?.text ?? '',
    onAddToLibrary: (sentence, next) => setInLibrary('sentence', sentence.id, next),
  });
  const sentencePanel = h('section', { className: 'er-cell er-side-card' },
    h('div', { className: 'er-side-head' },
      h('div', { className: 'er-side-title' }, h(Icons.target, null), h('span', null, t('reader.sentenceTab'))),
      h('div', { style: { display: 'flex', gap: 4 } },
        h(Button, {
          size: 'sm', variant: 'ghost', disabled: active <= 0,
          onClick: () => setActive(Math.max(0, active - 1)),
        }, '‹'),
        h(Button, {
          size: 'sm', variant: 'ghost', disabled: active >= sentences.length - 1,
          onClick: () => setActive(Math.min(sentences.length - 1, active + 1)),
        }, '›'))),
    // Header (title + sentence + add button) is part of the fixed frame; only
    // the analysis below it scrolls.
    pane.head,
    // The note composer travels with the analysis instead of pinning itself to
    // the panel bottom: a fixed footer reserved height for a field the reader
    // may never use, and the analysis had to shrink to fit around it. It now
    // arrives at the end of the scroll, where a note naturally belongs.
    h('div', { className: 'er-side-scroll', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      pane.body,
      activeSentence
        ? h('div', { className: 'er-note-compose' },
          h('div', { className: 'er-kv-label', style: { marginBottom: 6 } }, t('reader.noteForSentence')),
          h('textarea', {
            className: 'er-textarea', style: { minHeight: 74, fontSize: 12 },
            value: noteDraft, placeholder: t('reader.notePlaceholder'),
            onChange: (event) => setNoteDraft(event.target.value),
          }),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
            h(Button, {
              size: 'sm', disabled: action.pending || noteDraft.trim().length === 0, onClick: addNote,
            }, t('reader.saveNote'))))
        : null));

  const insightPanel = h(ArticleInsights, {
    onAddToLibrary: (kind, id, next) => setInLibrary(kind, id, next),
    t, detail: data, tab: insightTab, onTab: setInsightTab, onWord: setDrawerWord,
    onAnalysis: startAnalysis,
  });

  return h('div', { className: 'er-page er-page--fill' },
    h('div', { className: 'er-topbar' },
      h(Button, { variant: 'ghost', icon: h(Icons.arrowLeft, null), onClick: onBack }, t('common.back')),
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, article.title)),
      h('div', { className: 'er-topbar-spacer' }),
      h(Tabs, {
        items: [
          { id: 'split', label: t('reader.modeSplit') },
          { id: 'continuous', label: t('reader.modeContinuous') },
        ],
        value: mode, onChange: setMode,
      }),
      h(Button, {
        variant: 'ghost', icon: h(Icons.broom, null), disabled: action.pending || running, onClick: () => setConfirm('clean'),
        title: t('reader.cleanHint'),
      }, t('reader.clean')),
      h(Button, {
        variant: 'primary', icon: h(Icons.sparkle, null), disabled: action.pending || running, onClick: startAnalysis,
      }, running ? t('reader.analyzing') : data.analysis ? t('common.reanalyze') : t('articles.analyze'))),

    h(Band, {
      t,
      ratio,
      position: `${Math.max(1, active + 1)} / ${total}`,
      tasks: data.tasks,
      running,
      onRetry: retry,
      pending: action.pending,
      open: bandOpen,
      onToggle: setBandOpen,
      onInspect: setInspectStage,
      failedCount: sentences.filter((item) => item.analysisStatus === 'failed').length,
    }),

    // Only say how to look up a word once a sentence is actually selected; the
    // hint would otherwise float over a body the learner is only reading.
    active >= 0 && sentences.length > 0
      ? h('div', { className: 'er-dict-hint' }, t('reader.dictHint'))
      : null,

    h('div', { className: 'er-reader er-reader--fill' },
      h('section', { className: 'er-cell er-article-card' },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
          h(Thumb, { id: article.id, style: { width: 76, height: 56, flex: 'none' } }),
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('h2', { className: 'er-article-title' }, article.title),
            h('div', { className: 'er-article-meta' },
              h(Badge, { tone: cefrTone(article.cefrLevel) }, `${article.cefrLevel ?? '—'} · AI 估计`),
              h(Badge, { tone: 'soft' }, article.sourceName ?? 'Manual'),
              h('span', null, `${data.wordCount} ${t('common.words')}`),
              h('span', { className: 'er-crumb-dot' }),
              h('span', null, `${article.readingMinutes} ${t('common.minutes')}`),
              article.publishedAt ? h('span', null, shortDate(article.publishedAt)) : null,
              article.sourceUrl
                ? h('a', {
                  className: 'er-source-link',
                  href: article.sourceUrl,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: article.sourceUrl,
                }, h(Icons.link, null), h('span', null, t('reader.openSource')))
                : null)),
          h(Button, {
            variant: 'ghost', iconOnly: true, children: t('common.delete'), onClick: () => setConfirm('delete'),
            icon: h(Icons.trash, null),
          })),
        h('div', { className: 'er-pane-scroll' },
          sentences.length === 0
            ? h(Empty, { icon: h(Icons.bookOpen, null), title: t('reader.emptyBody'), description: t('reader.emptyBodyHint') })
            : h(ArticleBody, {
              detail: data, words, activeIndex: active, onSelect: setActive, onWord: setDrawerWord,
              onDictionary: openDictionary,
            }))),
      mode === 'split'
        ? h('aside', { className: 'er-side' },
          // Both children render their own cell, or nothing at all.
          sentencePanel,
          h(NoteList, { t, notes: data.notes }))
        : h('aside', { className: 'er-side' },
          insightPanel,
          h(NoteList, { t, notes: data.notes }))),


    inspectStage
      ? h(StageDetailDialog, {
        t,
        stageId: inspectStage,
        tasks: data.tasks,
        sentences,
        onClose: () => setInspectStage(null),
        onJump: (index) => {
          setInspectStage(null);
          jumpToSentence(index);
        },
        onRetry: retry,
      })
      : null,

    // Both remaining actions change data the learner cannot recover. Each one
    // states what it costs before asking again.
    confirm === 'clean'
      ? h(ConfirmDialog, {
        title: t('reader.cleanConfirmTitle'),
        description: h('div', { className: 'er-confirm-body' },
          h('p', null, t('reader.cleanConfirm')),
          h('p', { className: 'er-confirm-consequence' }, t('reader.cleanConfirmAnalysis'))),
        confirmLabel: t('reader.cleanConfirmRun'),
        cancelLabel: t('common.cancel'),
        onConfirm: confirmClean,
        onCancel: () => setConfirm(null),
      })
      : null,
    confirm === 'delete'
      ? h(ConfirmDialog, {
        title: t('reader.deleteConfirmTitle'),
        description: h('div', { className: 'er-confirm-body' },
          h('p', null, t('reader.deleteConfirm', { title: article.title })),
          h('p', { className: 'er-confirm-consequence' }, t('reader.deleteConfirmConsequence'))),
        confirmLabel: t('reader.deleteConfirmRun'),
        cancelLabel: t('common.cancel'),
        onConfirm: confirmDelete,
        onCancel: () => setConfirm(null),
      })
      : null,

    drawerWord
      ? h(Dialog, {
        title: t('reader.wordDetail'), onClose: () => setDrawerWord(null),
        footer: h(Button, {
          onClick: () => {
            const wordId = drawerWord.id;
            setDrawerWord(null);
            onNavigateKnowledge('word', wordId);
          },
        }, t('reader.openInKnowledge')),
      },
      h(WordCard, {
        t, word: drawerWord,
        onFavorite: (id, value) => updateWord(id, { favorite: value }),
        onMastery: (id, value) => updateWord(id, { masteryLevel: value }),
      }))
      : null,

    // The selected sentence's words answer with the dictionary, not the
    // article's own card. Clicking the scrim closes it, as with every dialog.
    dictionary.word
      ? h(Dialog, {
        title: dictionary.busy
          ? t('reader.dictLoading')
          : `${dictionary.word} · ${t('reader.dictionaryTitle')}`,
        onClose: closeDictionary,
      }, h(DictionaryCard, {
        t,
        word: dictionary.word,
        result: dictionary.result,
        error: dictionary.error,
        busy: dictionary.busy,
        onSwitch: switchDictionary,
      }))
      : null,

    action.error ? h(Alert, null, action.error.message) : null);
}

export { ArticleDetail };
