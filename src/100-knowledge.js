/** Knowledge base pages, review centre and settings, all over the same facade. */

const KIND_LABELS = { word: '单词', phrase: '短语', collocation: '搭配', sentence: '句子' };
const MASTERY_LABELS = ['未学习', '初次接触', '认识', '基本掌握', '熟练掌握'];

/** One knowledge card in the library grid. */
function KnowledgeCard({ t, item, onOpen, onDelete }) {
  // A word's card shows the dictionary meaning, not the meaning this article
  // gave it: the context meaning belongs to the reader, not to the library.
  const detailText = Array.isArray(item.detail)
    ? item.detail.map((entry) => entry.meaning ?? entry.contextMeaning ?? '').filter(Boolean).join('；')
    : (typeof item.detail === 'string' ? item.detail : '') || (item.meaning ?? '');
  // A sentence is a clause, not a headword: it must wrap across lines instead
  // of being squeezed into the single-line word row, and it needs no label.
  const isSentence = item.kind === 'sentence';
  return h('div', {
    className: isSentence ? 'er-kcard er-kcard--sentence' : 'er-kcard',
    role: 'button', tabIndex: 0,
    onClick: () => onOpen(item.id),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen(item.id);
      }
    },
  },
  h('div', { className: 'er-kcard-top' },
    // A sentence is a clause, but it is still the card's headword: bold like a
    // word, and on the same line as the delete control. A long clause wraps
    // inside its own span instead of pushing the control to a new line.
    h('span', { className: 'er-kcard-word' }, item.expression),
    !isSentence && item.phonetic ? h('span', { className: 'er-phonetic' }, item.phonetic) : null,
    h('div', { className: 'er-topbar-spacer' }),
    // The card's only action is removal: a learner who wants an entry back can
    // find it in an article, but the library has no separate "favourite" step.
    h('button', {
      type: 'button', className: 'er-btn ghost icon sm', 'aria-label': t('common.delete'),
      onClick: (event) => {
        event.stopPropagation();
        onDelete(item);
      },
    }, h(Icons.trash, null))),
  h('div', { className: 'er-kcard-meaning' }, detailText || '—'),
  h('div', { className: 'er-kcard-foot' },
    item.cefrLevel ? h(Badge, { tone: cefrTone(item.cefrLevel) }, item.cefrLevel) : null,
    h(Mastery, { level: item.masteryLevel }),
    h('div', { className: 'er-topbar-spacer' }),
    h('span', null, `${item.sourceCount} ${t('knowledge.sources')}`)));
}

/** Entity detail: meanings, mastery selector, editable note, every context. */
function KnowledgeDetail({ t, kind, entityId, onBack, onOpenArticle, notify }) {
  const detail = useLoad(() => call('knowledgeDetail', { kind, entityId }), [kind, entityId]);
  const action = useAction();
  const [noteDraft, setNoteDraft] = React.useState(null);
  const data = detail.data;

  React.useEffect(() => {
    if (data && noteDraft === null) setNoteDraft(data.notes ?? '');
  }, [data, noteDraft]);

  const update = async (patch) => {
    const value = await action.run(() => call('updateKnowledge', { entityType: kind, entityId, ...patch }));
    if (value) {
      detail.reload();
      notify(t('knowledge.updated'), 'ok');
    }
  };
  const [confirm, setConfirm] = React.useState(false);
  /**
   * Remove the entity from the library.
   *
   * The row this page opened is the membership record, so this deletes it
   * rather than merely un-favoriting: a removed entry keeps no trace of the
   * learner's mastery or notes.
   */
  const remove = async () => {
    setConfirm(false);
    const value = await action.run(() => call('deleteKnowledge', { entityType: kind, entityId }));
    if (value) {
      notify(t('knowledge.deleted'), 'ok');
      onBack();
    }
  };
  // A synonym opens the same dictionary popup the article body uses, so the
  // learner reads one source rather than a second, provider-less card.
  const [dictionary, setDictionary] = React.useState({ word: null, provider: null, result: null, error: null, busy: false });
  // Whether the open word's save-to-library request is in flight.
  const [dictionarySaving, setDictionarySaving] = React.useState(false);
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
  /**
   * Save the open word into the learner's library.
   *
   * The lookup payload already carries the provider's definitions, so saving
   * mints a vocabulary row from them; a word the article already analysed keeps
   * its analysed meaning and only gains membership.
   */
  const saveDictionaryWord = async (next) => {
    if (dictionarySaving || dictionary.word === null) return;
    setDictionarySaving(true);
    try {
      const saved = await call('saveDictionaryWord', {
        word: dictionary.word,
        result: dictionary.result,
        favorite: next,
      });
      if (saved) {
        setDictionary((previous) => ({
          ...previous,
          result: previous.result ? { ...previous.result, inLibrary: saved.inLibrary } : previous.result,
        }));
        notify(next ? t('reader.addedToWordLibrary') : t('reader.removedFromWordLibrary'), 'ok');
      }
    } catch (error) {
      notify(error?.message ?? t('reader.dictSaveFailed'), 'error');
    } finally {
      setDictionarySaving(false);
    }
  };

  if (detail.status === 'loading' && !data) {
    return h('div', { className: 'er-page' }, h(Skeleton, { height: 220, radius: 20 }));
  }
  if (detail.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, detail.error.message),
      h('div', null, h(Button, { onClick: onBack }, t('common.back'))));
  }

  const contexts = data.contexts ?? [];
  // The delete control sits on the Cell's eyebrow row, top-right, so it lines up
  // with "详情" instead of floating over the word block.
  const actions = h(Button, {
    size: 'sm', variant: 'ghost', iconOnly: true, 'aria-label': t('common.delete'),
    icon: h(Icons.trash, null),
    onClick: () => setConfirm(true),
  });
  const header = h('div', { className: 'er-dict-head', style: { flex: 1, minWidth: 0 } },
    h('div', { className: 'er-dict-word', style: { fontSize: 22 } }, data.expression),
    h(SpeakButton, { t, text: data.expression, size: 'sm', variant: 'ghost' }),
    data.phonetic ? h('span', { className: 'er-phonetic' }, data.phonetic) : null,
    kind === 'word' && (data.partOfSpeech ?? []).length > 0
      ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        (data.partOfSpeech ?? []).map((pos) => h(Badge, { key: pos, tone: 'soft' }, pos)))
      : null,
    kind === 'word' && data.cefrLevel ? h(Badge, { tone: cefrTone(data.cefrLevel) }, data.cefrLevel) : null);

  const meanings = kind === 'word' ? (data.meanings ?? []) : [];
  const meaningBlock = kind === 'word'
    ? meanings.map((meaning, index) => h('div', { key: index, className: 'er-meaning' },
      h('div', { className: 'er-meaning-cn' }, meaning.meaning),
      meaning.contextMeaning ? h('div', { className: 'er-meaning-ctx' }, meaning.contextMeaning) : null))
    : kind === 'sentence'
      // A sentence's meaning is its translation, which used to be buried in the
      // context list and never reached the detail card.
      ? [h('div', { key: 'translation', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        data.translation?.natural ? h('div', { className: 'er-meaning-cn' }, data.translation.natural) : null,
        data.translation?.literal ? h('div', { className: 'er-meaning-ctx' }, `${t('reader.literal')}：${data.translation.literal}`) : null)]
      : [h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        data.meaning ? h('div', { className: 'er-kv-value' }, data.meaning) : null,
        data.explanation ? h('div', { className: 'er-meaning-ctx' }, data.explanation) : null,
        data.pattern ? h(Badge, { tone: 'blue' }, data.pattern) : null)];
  const synonyms = kind === 'word' && (data.synonyms ?? []).length > 0
    ? h('div', { className: 'er-kv', style: { marginTop: 10 } },
      h('div', { className: 'er-kv-label' }, t('word.synonyms')),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        data.synonyms.map((value) => h('button', {
          key: value, type: 'button', className: 'er-token er-token--lookup',
          title: t('word.lookup'), 'aria-label': `${value} ${t('word.lookup')}`,
          onClick: () => openDictionary(value),
        }, value))))
    : null;
  const masteryRow = h('div', { className: 'er-chips' },
    [0, 1, 2, 3, 4].map((level) => h('button', {
      key: level, type: 'button', className: 'er-chip',
      'aria-pressed': data.masteryLevel === level,
      onClick: () => update({ masteryLevel: level }),
    }, `${level} · ${MASTERY_LABELS[level]}`)));
  const noteBlock = h('div', { style: { marginTop: 14 } },
    h('div', { className: 'er-kv-label', style: { marginBottom: 6 } }, t('knowledge.notes')),
    h('textarea', {
      className: 'er-textarea', style: { minHeight: 82 },
      value: noteDraft ?? '',
      onChange: (event) => setNoteDraft(event.target.value),
    }),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
      h(Button, { size: 'sm', disabled: action.pending, onClick: () => update({ notes: noteDraft ?? '' }) }, t('knowledge.saveNote'))));
  const contextList = contexts.length === 0
    ? h(Empty, { icon: h(Icons.bookOpen, null), title: t('knowledge.noContext'), description: '' })
    : h('div', { className: 'er-cell-scroll er-context-list', style: { display: 'flex', flexDirection: 'column', gap: 8, '--er-cell-max': '460px' } },
      contexts.map((context, index) => {
        // A context that resolves to a sentence opens that article, scrolled to
        // it; one whose evidence no longer matches anything stays static.
        const target = context.articleId !== undefined && context.sentenceIndex !== null && context.sentenceIndex !== undefined
          ? context
          : null;
        const body = h(React.Fragment, null,
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { className: 'er-struct-type', style: { alignSelf: 'flex-start' } }, context.title ?? ''),
            context.cefrLevel ? h(Badge, { tone: cefrTone(context.cefrLevel) }, context.cefrLevel) : null,
            context.sourceName ? h(Badge, { tone: 'soft' }, context.sourceName) : null),
          context.contextMeaning ? h('div', { className: 'er-struct-text' }, context.contextMeaning) : null,
          // Same two shapes as the reader: a bare string or `{exactText}`.
          (context.evidence ?? []).map((item, at) => h('div', {
            key: at, className: 'er-example', style: { marginTop: 4 },
          }, typeof item === 'string' ? item : item?.exactText ?? '')),
          context.analysis?.translation?.natural
            ? h('div', { className: 'er-meaning-ctx', style: { marginTop: 4 } }, context.analysis.translation.natural)
            : null);
        return target === null
          ? h('div', { key: index, className: 'er-struct-item' }, body)
          : h('button', {
            key: index, type: 'button', className: 'er-struct-item er-struct-item--link',
            'aria-label': `${context.title ?? ''} ${t('knowledge.openContext')}`,
            onClick: () => onOpenArticle?.(target.articleId, target.sentenceIndex),
          }, body);
      }));
  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h(Button, { variant: 'ghost', icon: h(Icons.arrowLeft, null), onClick: onBack }, t('common.back')),
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }),
        h('span', null, KIND_LABELS[kind]), h('span', { className: 'er-crumb-dot' }),
        h('span', null, data.expression))),
    h(Board, null,
      h(Cell, { span: 8, size: 'feature', eyebrow: t('knowledge.detail'), actions }, header,
        h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } }, meaningBlock), synonyms,
        h('div', { style: { marginTop: 16 } }, masteryRow)),
      h(Cell, { span: 4, eyebrow: t('knowledge.myNote') }, noteBlock),
      h(Cell, { span: 12, eyebrow: `${t('knowledge.contexts')} · ${contexts.length}`, icon: h(Icons.bookOpen, null) }, contextList)),
    // Removing an entry is destructive to the learner's own record, so it asks
    // first and says what it costs before the button runs it.
    confirm
      ? h(ConfirmDialog, {
        title: t('knowledge.deleteConfirmTitle'),
        description: h('div', { className: 'er-confirm-body' },
          h('p', null, t('knowledge.deleteConfirm', { expression: data.expression }))),
        confirmLabel: t('knowledge.deleteConfirmRun'),
        cancelLabel: t('common.cancel'),
        onConfirm: remove,
        onCancel: () => setConfirm(false),
      })
      : null,
    // A synonym opens the dictionary the same way a word in the article body
    // does; clicking the scrim closes it, as with every dialog.
    dictionary.word
      ? h(DictionaryPopup, {
        t,
        word: dictionary.word,
        result: dictionary.result,
        error: dictionary.error,
        busy: dictionary.busy,
        onClose: closeDictionary,
        onSwitch: switchDictionary,
        onAddToLibrary: saveDictionaryWord,
        saving: dictionarySaving,
      })
      : null,
    action.error ? h(Alert, null, action.error.message) : null);
}

/** Icon that matches one knowledge kind. */
const KIND_ICONS = {
  word: 'letters',
  phrase: 'link',
  collocation: 'layers',
  sentence: 'quote',
};

/** One knowledge library page. */
function KnowledgePage({ t, kind, onOpenArticle, notify, onOpenDetail }) {
  const [search, setSearch] = React.useState('');
  // Everything listed is already in the library, so "only favourites" would be a
  // no-op; the useful filter is what still needs learning.
  const [unmasteredOnly, setUnmasteredOnly] = React.useState(false);
  const [openId, setOpenId] = React.useState(null);
  // A detail opened for one kind must not survive a switch to another kind.
  // The same component instance is reused, so the old `openId` would send a
  // word's id to the phrase/collocation/sentence lookup and the page would show
  // "That expression no longer exists." Reset it during the kind change, before
  // the stale detail can render.
  const [kindAtOpen, setKindAtOpen] = React.useState(kind);
  if (kindAtOpen !== kind) {
    setKindAtOpen(kind);
    setOpenId(null);
  }
  // The shell owns the route, so a card there opens the detail through it and
  // the view survives switching away and coming back. Standalone (the tests) the
  // page keeps its own local view.
  const open = (id) => {
    if (onOpenDetail) {
      onOpenDetail(kind, id);
      return;
    }
    setOpenId(id);
  };
  const list = useLoad(() => call('searchKnowledge', {
    kind, search, maxMastery: unmasteredOnly ? 2 : undefined,
    limit: 60,
  }), [kind, search, unmasteredOnly]);
  const action = useAction();
  // The only per-card action is removal, so a card carries the same
  // confirmation the detail page uses: the learner's mastery and notes go with
  // the entry, and that is not something to undo by accident.
  const [confirmId, setConfirmId] = React.useState(null);
  const remove = async () => {
    const target = confirmId;
    setConfirmId(null);
    const value = await action.run(() => call('deleteKnowledge', { entityType: kind, entityId: target }));
    if (value) {
      notify(t('knowledge.deleted'), 'ok');
      list.reload();
    }
  };
  const confirmEntry = list.data?.find((entry) => entry.id === confirmId);
  if (openId !== null) {
    return h(KnowledgeDetail, { t, kind, entityId: openId, onBack: () => setOpenId(null), onOpenArticle, notify });
  }
  const body = list.status === 'loading' && !list.data
    ? h('div', { className: 'er-kgrid' }, [0, 1, 2, 3].map((index) => h(Skeleton, { key: index, height: 112, radius: 15 })))
    : list.status === 'error'
      ? h(Alert, null, list.error.message)
      : list.data.length === 0
        // Each tab explains its own emptiness: words existing says nothing
        // about phrases, and a shared "library is empty" message was simply
        // wrong for the three other tabs.
        ? h(Empty, {
          icon: h(Icons[KIND_ICONS[kind] ?? 'letters'], null),
          title: t(`knowledge.empty.${kind}.title`, { fallback: t('knowledge.emptyTitle') }),
          description: t(`knowledge.empty.${kind}.body`, { fallback: t('knowledge.emptyBody') }),
        })
        : h('div', { className: kind === 'sentence' ? 'er-kgrid er-kgrid--sentence' : 'er-kgrid' }, list.data.map((item) => h(KnowledgeCard, {
          key: item.id, t, item, onOpen: open, onDelete: (entry) => setConfirmId(entry.id),
        })));
  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, KIND_LABELS[kind])),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `${list.data?.length ?? 0} ${t('knowledge.count')}`)),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      h('div', { className: 'er-search', style: { flex: '1 1 240px' } },
        h(Icons.search, null),
        h('input', {
          type: 'search', placeholder: t('knowledge.searchPlaceholder'), value: search,
          onChange: (event) => setSearch(event.target.value),
        })),
      h(Button, {
        icon: h(Icons.target, null),
        variant: unmasteredOnly ? 'primary' : undefined,
        onClick: () => setUnmasteredOnly(!unmasteredOnly),
      }, t('knowledge.notMastered'))),
    body,
    // Removing a card is destructive to the learner's own record, so the card
    // action asks first and names what it costs, exactly as the detail page does.
    confirmId !== null
      ? h(ConfirmDialog, {
        title: t('knowledge.deleteConfirmTitle'),
        description: h('div', { className: 'er-confirm-body' },
          h('p', null, t('knowledge.deleteConfirm', { expression: confirmEntry?.expression ?? '' }))),
        confirmLabel: t('knowledge.deleteConfirmRun'),
        cancelLabel: t('common.cancel'),
        onConfirm: remove,
        onCancel: () => setConfirmId(null),
      })
      : null,
    action.error ? h(Alert, null, action.error.message) : null);
}

/** Flashcards over the not-yet-mastered vocabulary. */
function ReviewPage({ t, notify }) {
  const queue = useLoad(() => call('reviewQueue', { limit: 20 }), []);
  const [index, setIndex] = React.useState(0);
  const [revealed, setRevealed] = React.useState(false);
  const action = useAction();
  const items = queue.data?.items ?? [];
  const current = items[Math.min(index, Math.max(0, items.length - 1))];

  const score = async (level) => {
    if (!current) return;
    const updated = await action.run(() => call('updateKnowledge', {
      entityType: 'word', entityId: current.id, masteryLevel: level,
    }));
    if (updated) {
      setRevealed(false);
      setIndex((value) => value + 1);
      queue.reload();
      notify(t('review.next'), 'ok');
    }
  };

  if (queue.status === 'loading' && !queue.data) {
    return h('div', { className: 'er-page' }, h(Skeleton, { height: 240, radius: 20 }));
  }
  if (queue.status === 'error') {
    return h('div', { className: 'er-page' }, h(Alert, null, queue.error.message));
  }

  const reviewed = queue.data.reviewedToday;
  const target = queue.data.target;

  const flashCell = h(Cell, { span: 8, size: 'feature', tint: true },
    h('div', { className: 'er-flash-words', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 } },
      current
        ? h(React.Fragment, null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { className: 'er-flash-word' }, current.expression),
            h(SpeakButton, { t, text: current.expression, size: 'sm', variant: 'ghost' })),
          current.phonetic ? h('span', { className: 'er-phonetic' }, current.phonetic) : null,
          revealed
            ? h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 } },
              (current.meanings ?? []).map((meaning, index2) => h('div', { key: index2, className: 'er-meaning-cn' }, meaning.meaning)),
              h('span', { className: 'er-card-sub' }, MASTERY_LABELS[current.masteryLevel]))
            : h(Button, { variant: 'ghost', onClick: () => setRevealed(true) }, t('review.reveal')),
          revealed
            ? h('div', { className: 'er-flash-answers' },
              h(Button, { variant: 'primary', onClick: () => score(4) }, t('review.mastered')),
              h(Button, { onClick: () => score(2) }, t('review.again')),
              h(Button, { variant: 'ghost', onClick: () => score(0) }, t('review.unsure')))
            : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', marginTop: 4 } },
            h('span', { className: 'er-card-sub' }, `${Math.min(index + 1, items.length)} / ${items.length}`),
            h('div', { style: { flex: 1 } }, h(Progress, { ratio: items.length === 0 ? 0 : (index + 1) / items.length }))))
        : h(Empty, { icon: h(Icons.check, null), title: t('review.emptyTitle'), description: t('review.emptyBody') })));

  const counterCell = h(Cell, { span: 4, eyebrow: t('review.today'), icon: h(Icons.target, null) },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h(StatTile, { icon: h(Icons.star, null), value: queue.data.total, label: t('review.totalWords') }),
      h(StatTile, { icon: h(Icons.target, null), value: queue.data.mastered, label: t('review.masteredCount') }),
      h(StatTile, { icon: h(Icons.clock, null), value: reviewed, label: t('review.todayReviewed') }),
      h(StatTile, { icon: h(Icons.flame, null), value: queue.data.items.length, label: t('review.remaining') })));

  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.review'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `${t('review.today')} ${reviewed} / ${target}`)),
    h(Board, null, flashCell, counterCell));
}

/**
 * Group a flat provider/model list into provider groups.
 *
 * The fallback for a shell whose model catalog is not reachable: the Host
 * route carries every model, but without the provider display names.
 * @param {object[]} rows flat model rows.
 * @returns {object[]} provider groups.
 */
function groupFlatModels(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.provider)) groups.set(row.provider, { provider: row.provider, name: row.provider, models: [] });
    groups.get(row.provider).models.push({ model: row.model, label: row.label ?? row.model });
  }
  return [...groups.values()];
}

/** Settings: model status, parser knobs, data facts, backup guidance, demo data. */
function SettingsPage({ t, notify }) {
  const data = useLoad(() => call('settings'), []);
  const action = useAction();
  const [trial, setTrial] = React.useState('Small habits can lead to big changes.');
  const [voicePref, setVoicePref] = React.useState(() => speechPrefs());
  // The model the conversation is actually running on. The Host only knows the
  // deployment default, so this is read from the current Session in the browser.
  const sessionModel = useSessionModel();
  // The Harness model catalog: the same provider-grouped roster the shell's own
  // model picker shows. The browser half owns it; the Host route carries the
  // same models as a flat list, which is the fallback when the catalog is not
  // reachable (an older shell, or a session without a model yet).
  const catalog = useModelCatalog();
  const modelGroups = catalog?.groups
    ? catalog.groups.map((group) => ({
      provider: group.id ?? group.provider,
      name: group.name ?? group.provider ?? group.id,
      models: (group.models ?? []).map((model) => ({
        model: model.id ?? model.model,
        label: model.name ?? model.label ?? model.id ?? model.model,
      })),
    }))
    : groupFlatModels(data.data?.availableModels ?? []);
  // Name the session's model the way the picker names it: the friendly label
  // when the roster knows it, the raw model id otherwise.
  const sessionLabel = sessionModel === null
    ? ''
    : (modelGroups.flatMap((group) => group.models
      .filter((row) => row.model === sessionModel.model)
      .map((row) => row.label))[0] ?? sessionModel.model);
  // Draft for the editable model/tuning. Derived from the payload on first
  // render and then owned by the controls, so a save never fights a re-render.
  const [draftState, setDraft] = React.useState(null);
  const draft = data.data ? (draftState ?? {
    modelOverride: data.data.modelOverride ?? null,
    sentenceConcurrency: data.data.tuning?.sentenceConcurrency ?? 2,
    retryLimit: data.data.tuning?.retryLimit ?? 2,
    dictionary: data.data.dictionary ?? 'youdao',
  }) : null;
  /**
   * Apply an edit and persist it immediately: these are preferences, so a save
   * button would only add a step that can be forgotten. The control updates
   * optimistically, and a rejected save is reported and rolled back.
   */
  const applyDraft = async (patch) => {
    const next = { ...draft, ...patch };
    const previous = draft;
    setDraft(next);
    try {
      const result = await call('savePluginSettings', {
        tuning: {
          sentenceConcurrency: next.sentenceConcurrency,
          retryLimit: next.retryLimit,
        },
        modelOverride: next.modelOverride,
        dictionary: next.dictionary,
      });
      if (result?.saved === false) {
        // The chosen model disappeared from the Harness: keep the old value.
        setDraft(previous);
        notify(t('settings.modelUnknown'), 'error');
      }
    } catch (error) {
      setDraft(previous);
      notify(error.message, 'error');
    }
  };
  if (data.status === 'loading' && !data.data) {
    return h('div', { className: 'er-page' }, h(Skeleton, { height: 220, radius: 20 }));
  }
  // Without this branch a failed RPC rendered `vundefined` everywhere.
  if (data.status === 'error') {
    return h('div', { className: 'er-page' },
      h(Alert, null, data.error.message),
      h('div', { style: { marginTop: 10 } }, h(Button, { onClick: data.reload }, t('common.retry'))));
  }
  const settings = data.data ?? {};
  return h('div', { className: 'er-page' },
    h('div', { className: 'er-topbar' },
      h('div', { className: 'er-crumb' },
        h('span', null, 'English Reader'), h('span', { className: 'er-crumb-dot' }), h('span', null, t('nav.settings'))),
      h('div', { className: 'er-topbar-spacer' }),
      h('span', { className: 'er-card-sub' }, `v${settings.version} · schema ${settings.schemaVersion}`)),
    h(Board, null,
      h(Cell, { span: 6, eyebrow: t('settings.model'), icon: h(Icons.sparkle, null) },
        h('div', { className: 'er-set-row er-set-row--stack' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.modelRoute')),
            h('div', { className: 'er-set-row-desc' },
              sessionModel === null
                ? t('settings.modelHint')
                : t('settings.modelSessionNow', { model: sessionLabel }))),
          h('select', {
            className: 'er-select', style: { width: '100%' },
            value: draft.modelOverride ? `${draft.modelOverride.provider}:${draft.modelOverride.model}` : '',
            onChange: (event) => {
              const next = event.target.value;
              if (next === '') { applyDraft({ modelOverride: null }); return; }
              const at = next.indexOf(':');
              applyDraft({ modelOverride: { provider: next.slice(0, at), model: next.slice(at + 1) } });
            },
          },
          h('option', { value: '' },
            sessionModel === null
              ? t('settings.modelFollowSession')
              : t('settings.modelFollowSessionNamed', { model: sessionLabel })),
          modelGroups.map((group) => h('optgroup', {
            key: group.provider,
            label: group.name ?? group.provider,
          }, group.models.map((row) => h('option', {
            key: `${group.provider}:${row.model}`,
            value: `${group.provider}:${row.model}`,
          }, row.label)))))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.sentenceConcurrency')),
            h('div', { className: 'er-set-row-desc' }, t('settings.sentenceConcurrencyHint'))),
          h('input', {
            className: 'er-input', type: 'number', min: 1, max: 5, style: { width: 70 },
            value: draft.sentenceConcurrency,
            onChange: (event) => applyDraft({ sentenceConcurrency: Math.max(1, Math.min(5, Number(event.target.value) || 1)) }),
          })),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.retryLimit')),
            h('div', { className: 'er-set-row-desc' }, t('settings.retryLimitHint'))),
          h('input', {
            className: 'er-input', type: 'number', min: 1, max: 5, style: { width: 70 },
            value: draft.retryLimit,
            onChange: (event) => applyDraft({ retryLimit: Math.max(1, Math.min(5, Number(event.target.value) || 1)) }),
          })),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.dictionary')),
            h('div', { className: 'er-set-row-desc' }, t('settings.dictionaryHint'))),
          h('select', {
            className: 'er-select', style: { width: 150 }, value: draft.dictionary,
            onChange: (event) => applyDraft({ dictionary: event.target.value }),
          },
            h('option', { value: 'youdao' }, t('settings.dictionaryYoudao')),
            h('option', { value: 'bing' }, t('settings.dictionaryBing')))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.llmService')),
            h('div', { className: 'er-set-row-desc' }, t('settings.llmServiceHint'))),
          h(Badge, { tone: settings.llmAvailable ? 'mint' : 'pink' }, settings.llmAvailable ? t('settings.ready') : t('settings.unavailable'))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.searchService')),
            h('div', { className: 'er-set-row-desc' }, t('settings.searchServiceHint'))),
          h(Badge, { tone: settings.searchAvailable ? 'mint' : 'amber' }, settings.searchAvailable ? t('settings.ready') : t('settings.unavailable')))),
      h(Cell, { span: 6, eyebrow: t('settings.speech'), icon: h(Icons.speaker, null) },
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechEngine')),
            h('div', { className: 'er-set-row-desc' }, t('settings.speechEngineHint'))),
          h(Badge, { tone: settings.speech?.available ? 'mint' : 'pink' },
            settings.speech?.available ? 'edge-tts' : t('settings.unavailable'))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechCache')),
            h('div', { className: 'er-set-row-desc' }, `${settings.speech?.cachedFiles ?? 0} · ${bytes(settings.speech?.cachedBytes ?? 0)}`)),
          h(Button, {
            disabled: action.pending, onClick: async () => {
              const result = await action.run(() => call('clearSpeechCache'));
              if (result) {
                notify(`${t('settings.speechCleared')} ${result.removed}`, 'ok');
                data.reload();
              }
            },
          }, t('settings.speechClear'))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14 } },
          h('div', { className: 'er-set-row-title' }, t('settings.speechTrial')),
          h('div', { className: 'er-set-row-desc' }, t('settings.speechTrialHint')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('input', {
              className: 'er-input', style: { flex: '1 1 220px' }, value: trial, placeholder: 'Small habits can lead to big changes.',
              onChange: (event) => setTrial(event.target.value),
            }),
            h(SpeakButton, {
              t, text: trial || 'Small habits can lead to big changes.',
              label: t('settings.speechPlay'), variant: 'primary', size: 'sm',
              sentence: undefined,
            }))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechVoice')),
            h('div', { className: 'er-set-row-desc' }, t('settings.speechVoiceHint'))),
          h('select', {
            className: 'er-select', style: { width: 210 }, value: voicePref.voice,
            onChange: (event) => {
              const next = { ...voicePref, voice: event.target.value };
              setVoicePref(next);
              saveSpeechPrefs(next);
            },
          }, (Array.isArray(settings.speech?.voices) ? settings.speech.voices : []).map((voice) => h('option', { key: voice.id, value: voice.id }, voice.label)))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.speechRate')),
            h('div', { className: 'er-set-row-desc' }, `${voicePref.rate}%`)),
          h('input', {
            type: 'range', min: -40, max: 50, step: 5, value: voicePref.rate,
            onChange: (event) => {
              const next = { ...voicePref, rate: Number(event.target.value) };
              setVoicePref(next);
              saveSpeechPrefs(next);
            },
          }))),
      h(Cell, { span: 12, eyebrow: t('settings.data'), icon: h(Icons.layers, null) },
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.dataDir')),
            h('div', { className: 'er-set-row-desc er-mono' }, settings.dataDir ?? '')),
          h(Badge, { tone: 'soft' }, bytes(settings.bytes))),
        h('div', { className: 'er-set-row' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.counts')),
            h('div', { className: 'er-set-row-desc' },
              Object.entries(settings.counts ?? {}).map(([key, value]) => `${key}: ${value}`).join(' · '))),
          null),
        h('div', { className: 'er-set-row er-set-row--stack' },
          h('div', { className: 'er-set-row-text' },
            h('div', { className: 'er-set-row-title' }, t('settings.backup')),
            h('div', { className: 'er-set-row-desc' }, t('settings.backupHint'))),
          h('div', { className: 'er-backup-list' },
            h('div', { className: 'er-backup-item' },
              h('div', { className: 'er-backup-path er-mono' }, `${settings.dataDir ?? ''}/database`),
              h('div', { className: 'er-set-row-desc' }, t('settings.backupDatabase'))),
            h('div', { className: 'er-backup-item' },
              h('div', { className: 'er-backup-path er-mono' }, `${settings.dataDir ?? ''}/articles`),
              h('div', { className: 'er-set-row-desc' }, t('settings.backupArticles'))),
            h('div', { className: 'er-backup-item' },
              h('div', { className: 'er-backup-path er-mono' }, `${settings.dataDir ?? ''}/cache`),
              h('div', { className: 'er-set-row-desc' }, t('settings.backupCache')))),
          h('div', { className: 'er-set-row-desc' }, t('settings.backupRestore')))),
      h(Cell, { span: 12, eyebrow: t('settings.about'), icon: h(Icons.info, null) },
        h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-value' }, t('settings.aboutBody'))),
        h('div', { className: 'er-kv', style: { marginTop: 8 } },
          h('div', { className: 'er-kv-label' }, t('settings.database')),
          h('div', { className: 'er-kv-value er-mono' }, settings.databasePath ?? '')))),
    action.error ? h(Alert, null, action.error.message) : null);
}

export { KnowledgePage, ReviewPage, SettingsPage, KIND_LABELS };
