/** Reader: continuous reading and dual-column intensive reading share one article body. */

/** Group analysed sentences into paragraph blocks, preserving order. */
function paragraphBlocks(detail) {
  const groups = [];
  for (const sentence of detail.sentences) {
    const last = groups[groups.length - 1];
    if (last && last.paragraphIndex === sentence.paragraphIndex) last.items.push(sentence);
    else groups.push({ paragraphIndex: sentence.paragraphIndex, items: [sentence] });
  }
  return groups;
}

/** Index analysed vocabulary by lower-cased surface form. */
function wordIndex(detail) {
  const map = new Map();
  for (const word of detail.words) {
    map.set(word.lemma.toLowerCase(), word);
    for (const evidence of word.evidence ?? []) {
      const tokens = String(evidence.exactText ?? '').toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
      for (const token of tokens) {
        if (token.startsWith(word.lemma.toLowerCase().slice(0, Math.min(5, word.lemma.length))) && map.get(token) === undefined) {
          map.set(token, word);
        }
      }
    }
  }
  return map;
}

/** Render one sentence with clickable analysed words inside it. */
function SentenceText({ text, words, onWord, active, onSelect }) {
  const parts = React.useMemo(() => {
    const out = [];
    const pattern = /[A-Za-z][A-Za-z'’\-]*/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) out.push({ kind: 'text', value: text.slice(cursor, match.index) });
      const surface = match[0];
      const word = words.get(surface.toLowerCase().replace(/['’]s$/, ''));
      out.push({ kind: word ? 'word' : 'text', value: surface, word });
      cursor = match.index + surface.length;
    }
    if (cursor < text.length) out.push({ kind: 'text', value: text.slice(cursor) });
    return out;
  }, [text, words]);
  return h('span', {
    className: 'er-sentence',
    'data-active': active === true,
    onClick: onSelect,
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect();
      }
    },
  }, parts.map((part, index) => (part.kind === 'word'
    ? h('span', {
      key: index,
      className: 'er-word',
      'data-known': part.word.masteryLevel >= 3,
      title: part.word.meanings?.[0]?.contextMeaning ?? part.word.meanings?.[0]?.meaning ?? '',
      onClick: (event) => {
        event.stopPropagation();
        onWord(part.word);
      },
    }, part.value)
    : h('span', { key: index }, part.value))));
}

/** Speaker control with a pending/error state, over the Edge-TTS bridge. */
function SpeakButton({ t, text, sentence, size = 'sm', variant = 'ghost', label, onResult }) {
  const [state, setState] = React.useState({ pending: false, playing: false, error: null });
  const run = async (event) => {
    event?.stopPropagation?.();
    if (state.pending) return;
    setState({ pending: true, playing: false, error: null });
    const result = sentence
      ? await speakSentence(sentence.articleId, sentence.sentenceIndex)
      : await speakText(text);
    setState({ pending: false, playing: result.played === true, error: result.played ? null : (result.message ?? '朗读失败') });
    onResult?.(result);
  };
  const icon = state.playing ? Icons.speaker : state.error ? Icons.warning : Icons.speaker;
  // The label doubles as the accessible name: icon-only buttons would otherwise
  // be announced as "button" to a screen reader.
  return h('button', {
    type: 'button',
    className: ['er-btn', variant, size, label === undefined ? 'icon' : ''].filter(Boolean).join(' '),
    disabled: state.pending === true,
    'aria-label': label ?? t('common.pronounce'),
    title: state.error ?? t('common.pronounce'),
    onClick: run,
    style: label === undefined ? undefined : { gap: 6 },
  },
  state.pending ? h('span', { style: { fontSize: 11 } }, '…') : h(icon, null),
  label === undefined ? null : h('span', null, state.playing ? t('common.playing') : label));
}

/** Why one sentence could not be analysed: code, reason, raw excerpt, retry. */
function SentenceFailure({ t, error, sentence }) {
  const [expanded, setExpanded] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const code = error?.code ?? 'LLM_UNAVAILABLE';
  const explain = t(`error.${code}`, { fallback: t('error.unknown') });
  const retry = async () => {
    setRetrying(true);
    try {
      await call('retrySentence', { articleId: sentence.articleId, sentenceIndex: sentence.sentenceIndex });
    } finally {
      setRetrying(false);
    }
  };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', {
      className: 'er-alert error',
      style: { alignItems: 'flex-start', flexDirection: 'column', gap: 6 },
    },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
      h(Icons.warning, null),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600 } }, t('reader.sentenceFailed')),
        h('div', { style: { marginTop: 2, opacity: 0.85 } }, explain)),
      h(Badge, { tone: 'plain' }, code)),
    h('div', { className: 'er-meaning-ctx', style: { color: 'inherit', opacity: 0.8 } },
      error?.message ?? t('error.noDetail')),
    error?.attempts > 1 ? h('div', { className: 'er-meaning-ctx', style: { color: 'inherit', opacity: 0.7 } }, `${t('reader.attempts')} ${error.attempts}`) : null),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h(Button, { size: 'sm', onClick: retry, disabled: retrying }, retrying ? t('common.working') : t('reader.retrySentence')),
      error?.raw ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => setExpanded(!expanded) },
        expanded ? t('reader.hideRaw') : t('reader.showRaw')) : null,
      h('div', { className: 'er-topbar-spacer' }),
      h(SpeakButton, { t, text: sentenceTextOf(sentence), label: t('common.pronounce') }),
      ),
    expanded && error?.raw
      ? h('pre', {
        className: 'er-raw', style: { margin: 0 },
        children: error.raw,
      })
      : null);
}

function sentenceTextOf(sentence) {
  return sentence?.text ?? '';
}

/** Dictionary card for one word, shared by the reader drawer and knowledge. */
function WordCard({ t, word, onFavorite, onMastery, onNote }) {
  // `favorite` doubles as "is in the library": a user_knowledge row is only
  // created when the learner adds the word, so this is the opt-in flag.
  const inLibrary = word.favorite === true;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { className: 'er-dict-head' },
      h('div', { className: 'er-dict-word' }, word.lemma),
      word.phonetic && h('span', { className: 'er-phonetic' }, word.phonetic),
      h(SpeakButton, { t, text: word.lemma, size: 'sm', variant: 'ghost' }),
      h('div', { className: 'er-topbar-spacer' }),
      h(Button, {
        size: 'sm',
        variant: inLibrary ? 'ghost' : 'primary',
        onClick: () => onFavorite(word.id, !inLibrary),
      }, inLibrary
        ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
          h(Icons.check, null), t('reader.inLibrary'))
        : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
          h(Icons.plus, null), t('reader.addToLibrary'))),
      h(Button, {
        size: 'sm', variant: 'ghost', iconOnly: true, children: t('word.addPlan'),
        icon: h(Icons.target, null),
        onClick: () => onMastery(word.id, Math.min(4, (word.masteryLevel ?? 0) + 1)),
      })),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
      (word.partOfSpeech ?? []).map((pos) => h(Badge, { key: pos, tone: 'soft' }, pos)),
      word.cefrLevel && h(Badge, { tone: cefrTone(word.cefrLevel) }, word.cefrLevel),
      h(Mastery, { level: word.masteryLevel ?? 0 })),
    (word.meanings ?? []).map((meaning, index) => h('div', { key: index, className: 'er-meaning' },
      h('div', { className: 'er-meaning-cn' }, meaning.meaning),
      meaning.contextMeaning && h('div', { className: 'er-meaning-ctx' }, `${t('word.inArticle')}${meaning.contextMeaning}`))),
    word.wordFormation && (word.wordFormation.components ?? []).length > 0 && h('div', { className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('word.formation')),
      h('div', { className: 'er-kv-value' },
        h('span', { className: 'er-en' }, word.wordFormation.components.join(' + ')),
        ` → ${word.wordFormation.explanation}`)),
    (word.evidence ?? []).length > 0 && h('div', { className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('word.evidence')),
      (word.evidence ?? []).map((item, index) => h('div', { key: index, className: 'er-example' }, item.exactText))),
    (word.synonyms ?? []).length > 0 && h('div', { className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('word.synonyms')),
      h('div', { className: 'er-kv-value', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        word.synonyms.map((value) => h('span', { key: value, className: 'er-token' }, value))),
    ));
}

/**
 * Right column: the selected sentence's analysis.
 * `onAddToLibrary(sentence, next)` writes the knowledge row; without a click the
 * sentence stays a candidate and never appears in the library.
 */
function SentencePane({ t, sentence, sentenceText, onAddToLibrary }) {
  if (!sentence) {
    return {
      head: null,
      body: h(Empty, { icon: h(Icons.target, null), title: t('reader.pickSentence'), description: t('reader.pickSentenceBody') }),
    };
  }
  const analysis = sentence.analysis;
  const inLibrary = sentence.inLibrary === true;
  /** Add/added toggle; disabled until the sentence has an id to store. */
  const libraryButton = sentence.id
    ? h(Button, {
      size: 'sm',
      variant: inLibrary ? 'ghost' : 'primary',
      onClick: () => onAddToLibrary?.(sentence, !inLibrary),
    }, inLibrary
      ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        h(Icons.check, null), t('reader.inLibrary'))
      : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        h(Icons.plus, null), t('reader.addToLibrary')))
    : null;
  // The sentence and its controls are the reference for everything below, so the
  // caller keeps them out of the scroller entirely.
  const head = h('div', { className: 'er-sentence-head' },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
      h('div', { style: { flex: 1, minWidth: 0 } }, sentenceText),
      h(SpeakButton, {
        t,
        text: sentenceText,
        sentence: { articleId: sentence.articleId, sentenceIndex: sentence.sentenceIndex },
      })),
    libraryButton ? h('div', { style: { marginTop: 8 } }, libraryButton) : null);
  if (!analysis) {
    // A sentence is listenable before analysis finishes: pronunciation does
    // not depend on the model's output.
    const failed = sentence.analysisStatus === 'failed';
    return {
      head,
      body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        failed
          ? h(SentenceFailure, { t, error: sentence.error, analysisStatus: sentence.analysisStatus, sentence })
          : h(Alert, { tone: 'warn' }, t('reader.noAnalysis'))),
    };
  }
  const parts = [];
  parts.push(h('div', { key: 'literal', className: 'er-kv' },
    h('div', { className: 'er-kv-label' }, t('reader.literal')),
    h('div', { className: 'er-kv-value' }, analysis.translation?.literal ?? '')));
  parts.push(h('div', { key: 'natural', className: 'er-kv' },
    h('div', { className: 'er-kv-label' }, t('reader.natural')),
    h('div', { className: 'er-kv-value' }, analysis.translation?.natural ?? '')));
  if (analysis.structure?.mainClause) {
    parts.push(h('div', { key: 'main', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.mainClause')),
      h('div', { className: 'er-kv-value er-en' }, analysis.structure.mainClause)));
  }
  const components = analysis.structure?.components ?? [];
  if (components.length > 0) {
    parts.push(h('div', { key: 'structure', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.structure')),
      h('div', { className: 'er-struct' }, components.map((part, index) => h('div', {
        key: index, className: 'er-struct-item',
      },
      h('span', { className: 'er-struct-type' }, part.type),
      h('div', { className: 'er-struct-text' }, part.text),
      part.explanation ? h('div', { className: 'er-meaning-ctx' }, part.explanation) : null)))));
  }
  const grammar = analysis.grammarPoints ?? [];
  if (grammar.length > 0) {
    parts.push(h('div', { key: 'grammar', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.grammar')),
      grammar.map((point, index) => h('div', { key: index, style: { marginBottom: 8 } },
        h('div', { className: 'er-kv-value', style: { fontWeight: 600 } }, point.title),
        h('div', { className: 'er-kv-value' }, point.explanation),
        point.evidence ? h('div', { className: 'er-example', style: { marginTop: 5 } }, point.evidence) : null))));
  }
  const expressions = analysis.keyExpressions ?? [];
  if (expressions.length > 0) {
    parts.push(h('div', { key: 'expressions', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.expressions')),
      expressions.map((item, index) => h('div', { key: index, style: { marginBottom: 6 } },
        h('span', { className: 'er-token', style: { marginRight: 6 } }, item.expression),
        h('span', { className: 'er-kv-value' }, item.meaning)))));
  }
  const uncertain = analysis.uncertaintyNotes ?? [];
  if (uncertain.length > 0) parts.push(h(Alert, { key: 'uncertain', tone: 'warn' }, uncertain.join('；')));
  if (sentence.analysisStatus === 'needs_review') {
    parts.push(h('div', { key: 'review-flag', className: 'er-meaning-ctx' }, t('reader.needsReview')));
  }
  const notes = analysis.difficultyNotes ?? [];
  if (notes.length > 0) {
    parts.push(h('div', { key: 'notes', className: 'er-kv' },
      h('div', { className: 'er-kv-label' }, t('reader.notes')),
      h('div', { className: 'er-kv-value' }, notes.join('；'))));
  }
  return {
    head,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, parts),
  };
}

/** Article body renderer used by both reading modes. */
function ArticleBody({ detail, words, activeIndex, onSelect, onWord }) {
  const blocks = React.useMemo(() => paragraphBlocks(detail), [detail]);
  const paragraphs = blocks.map((block) => {
    // Segmentation trims every sentence, so concatenating spans would lose the
    // space after the full stop ("changes.A new study"). A literal space between
    // sentences keeps the text identical to the stored body.
    const children = [];
    block.items.forEach((sentence, index) => {
      if (index > 0) children.push(' ');
      children.push(h(SentenceText, {
        key: sentence.sentenceIndex,
        text: sentence.text,
        words,
        active: sentence.sentenceIndex === activeIndex,
        onSelect: () => onSelect(sentence.sentenceIndex),
        onWord,
      }));
    });
    return h('p', { key: block.paragraphIndex }, children);
  });
  return h('div', { className: 'er-prose' }, paragraphs);
}

/** Compact add/added control used by every candidate list. */
function LibraryToggle({ t, inLibrary, onToggle }) {
  return h(Button, {
    size: 'sm',
    variant: inLibrary ? 'ghost' : 'primary',
    onClick: (event) => {
      event.stopPropagation();
      onToggle();
    },
  }, inLibrary
    ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
      h(Icons.check, null), t('reader.inLibrary'))
    : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
      h(Icons.plus, null), t('reader.addToLibrary')));
}

/** Section heading inside the insights cell: no border, no nested card. */
function InsightSection({ t, icon, title, sub, children }) {
  return h('div', { className: 'er-insight-section' },
    h('div', { className: 'er-insight-head' },
      h('div', { className: 'er-insight-title' }, icon, h('span', null, title),
        sub === undefined || sub === null || sub === '' ? null : h('span', { className: 'er-card-sub' }, String(sub))),
      h('div', { className: 'er-topbar-spacer' })),
    children);
}

/** Tabs body for the article: overview / vocab / phrases / review. */
function ArticleInsights({ t, detail, tab, onTab, onWord, onAnalysis, onAddToLibrary }) {
  const overview = detail.overview;
  const difficulty = detail.difficulty;
  const review = detail.review;
  return h('div', {
    className: 'er-cell er-insights',
    style: { display: 'flex', flexDirection: 'column', gap: 0 },
  },
  // The strip is part of the frame, not a scrolled child: it must never move.
  h('div', { style: { paddingBottom: 12 } },
    h(Tabs, {
      items: [
        { id: 'guide', label: t('reader.tabGuide') },
        { id: 'words', label: t('reader.tabWords') },
        { id: 'phrases', label: t('reader.tabPhrases') },
        { id: 'review', label: t('reader.tabReview') },
      ],
      value: tab, onChange: onTab,
    })),
  h('div', { className: 'er-insights-body', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    tab === 'guide' && h(InsightSection, { t, title: t('reader.guideTitle'), icon: h(Icons.bookOpen, null) },
      !overview && h(Empty, {
        icon: h(Icons.sparkle, null), title: t('reader.notAnalysed'), description: t('reader.notAnalysedBody'),
        action: h(Button, { variant: 'primary', onClick: onAnalysis }, t('articles.analyze')),
      }),
      overview && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-label' }, t('reader.background')), h('div', { className: 'er-kv-value' }, overview.background)),
        h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-label' }, t('reader.mainIdea')), h('div', { className: 'er-kv-value' }, overview.mainIdea)),
        overview.keyPoints?.length > 0 && h('div', { className: 'er-kv' },
          h('div', { className: 'er-kv-label' }, t('reader.keyPoints')),
          overview.keyPoints.map((point, index) => h('div', { key: index, className: 'er-kv-value' }, `• ${point}`))),
        overview.readingFocus?.length > 0 && h('div', { className: 'er-kv' },
          h('div', { className: 'er-kv-label' }, t('reader.readingFocus')),
          overview.readingFocus.map((point, index) => h('div', { key: index, className: 'er-kv-value' }, `• ${point}`))),
        difficulty && h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(Badge, { tone: cefrTone(difficulty.cefrLevel) }, `${difficulty.cefrLevel} · AI`),
          h('span', { className: 'er-card-sub' }, `${t('reader.readingMinutes')} ${overview.estimatedReadingMinutes ?? detail.article.readingMinutes}`)))),
    tab === 'words' && h(InsightSection, { t, title: t('reader.wordsTitle'), icon: h(Icons.letters, null), sub: detail.words.length },
      detail.words.length === 0
        ? h(Empty, { icon: h(Icons.letters, null), title: t('reader.noWords'), description: t('reader.noWordsBody') })
        : h('div', { className: 'er-kgrid' },
          // A button cannot contain another button, so the card is a div with
          // role=button; the add control stops propagation.
          detail.words.map((word) => h('div', {
            key: word.id,
            className: 'er-kcard',
            role: 'button',
            tabIndex: 0,
            onClick: () => onWord(word),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') onWord(word);
            },
          },
          h('div', { className: 'er-kcard-top' },
            h('span', { className: 'er-kcard-word' }, word.lemma),
            word.phonetic && h('span', { className: 'er-phonetic' }, word.phonetic),
            h('div', { className: 'er-topbar-spacer' }),
            h(LibraryToggle, {
              t, inLibrary: word.favorite === true,
              onToggle: () => onAddToLibrary?.('word', word.id, !word.favorite),
            })),
          h('div', { className: 'er-kcard-meaning' }, word.meanings?.[0]?.contextMeaning ?? word.meanings?.[0]?.meaning ?? ''),
          h('div', { className: 'er-kcard-foot' },
            h(Badge, { tone: cefrTone(word.cefrLevel) }, word.cefrLevel ?? '—'),
            h('span', null, `${word.occurrences}×`),
            h(Mastery, { level: word.masteryLevel ?? 0 })))),
        ),
      ),
    tab === 'phrases' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h(InsightSection, { t, title: t('reader.phrasesTitle'), icon: h(Icons.link, null), sub: detail.phrases.length },
        detail.phrases.length === 0
          ? h(Empty, { icon: h(Icons.link, null), title: t('reader.noPhrases'), description: t('reader.noPhrasesBody') })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            detail.phrases.map((phrase) => h('div', { key: phrase.id, className: 'er-struct-item' },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { className: 'er-en', style: { fontWeight: 600 } }, phrase.expression),
                phrase.phraseType && h(Badge, { tone: 'violet' }, phrase.phraseType),
                h('div', { className: 'er-topbar-spacer' }),
                h(LibraryToggle, {
                  t, inLibrary: phrase.favorite === true,
                  onToggle: () => onAddToLibrary?.('phrase', phrase.id, !phrase.favorite),
                })),
              phrase.meaning && h('div', { className: 'er-kv-value' }, phrase.meaning),
              phrase.explanation && h('div', { className: 'er-meaning-ctx' }, phrase.explanation)))),
        ),
      h(InsightSection, { t, title: t('reader.collocationsTitle'), icon: h(Icons.layers, null), sub: detail.collocations.length },
        detail.collocations.length === 0
          ? h(Empty, { icon: h(Icons.layers, null), title: t('reader.noCollocations'), description: t('reader.noCollocationsBody') })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            detail.collocations.map((item) => h('div', { key: item.id, className: 'er-struct-item' },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { className: 'er-en', style: { fontWeight: 600 } }, item.expression),
                item.pattern && h(Badge, { tone: 'blue' }, item.pattern),
                h('div', { className: 'er-topbar-spacer' }),
                h(LibraryToggle, {
                  t, inLibrary: item.favorite === true,
                  onToggle: () => onAddToLibrary?.('collocation', item.id, !item.favorite),
                })),
              item.meaning && h('div', { className: 'er-kv-value' }, item.meaning),
              item.explanation && h('div', { className: 'er-meaning-ctx' }, item.explanation)))),
        ),
      ),
    tab === 'review' && h(InsightSection, { t, title: t('reader.reviewTitle'), icon: h(Icons.target, null) },
      !review
        ? h(Empty, { icon: h(Icons.target, null), title: t('reader.noReview'), description: t('reader.noReviewBody') })
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { className: 'er-kv' }, h('div', { className: 'er-kv-label' }, t('reader.summary')), h('div', { className: 'er-kv-value' }, review.summary)),
          (review.logicalStructure ?? []).length > 0 && h('div', { className: 'er-kv' },
            h('div', { className: 'er-kv-label' }, t('reader.logicalStructure')),
            (review.logicalStructure ?? []).map((step, index) => h('div', { key: index, className: 'er-struct-item', style: { marginBottom: 6 } },
              h('span', { className: 'er-struct-type' }, `${step.step ?? index + 1} · ${step.title}`),
              h('div', { className: 'er-struct-text' }, step.description)))),
          (review.keyTakeaways ?? []).length > 0 && h('div', { className: 'er-kv' },
            h('div', { className: 'er-kv-label' }, t('reader.takeaways')),
            (review.keyTakeaways ?? []).map((item, index) => h('div', { key: index, className: 'er-kv-value' }, `• ${item}`))),
          (review.questions ?? []).length > 0 && h('div', { className: 'er-kv' },
            h('div', { className: 'er-kv-label' }, t('reader.questions')),
            (review.questions ?? []).map((question, index) => h(QuestionItem, { key: index, t, question, index }))))
      ))
  );
}

/** One comprehension question with a reveal toggle. */
function QuestionItem({ t, question, index }) {
  const [revealed, setRevealed] = React.useState(false);
  return h('div', { className: 'er-struct-item', style: { marginBottom: 8 } },
    h('div', { className: 'er-struct-text', style: { fontWeight: 600 } }, `${index + 1}. ${question.question}`),
    question.type === 'choice' && h('div', { className: 'er-kv-value' },
      (question.options ?? []).map((option, at) => h('div', { key: at }, option))),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
      h(Button, { size: 'sm', onClick: () => setRevealed(!revealed) }, revealed ? t('reader.hideAnswer') : t('reader.showAnswer')),
      revealed && h(Badge, { tone: 'mint' }, question.answer)),
    revealed && h('div', { className: 'er-meaning-ctx', style: { marginTop: 6 } }, question.explanation || ''));
}

export { paragraphBlocks, wordIndex, SentenceText, WordCard, SentencePane, ArticleBody, ArticleInsights };
