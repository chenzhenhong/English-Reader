/**
 * Dictionary popup for one looked-up word.
 *
 * The card is intentionally the same shape as the knowledge `WordCard`, but it
 * renders whatever the scraped provider returned. Nothing here is persisted:
 * the learner reads the entry and closes the dialog, and the source stays a
 * page that the Host scraped rather than a library record.
 *
 * Pronunciation comes from the provider's own audio, never from the TTS
 * bridge: the learner hears the same voice the dictionary page uses.
 */

/** Localised name of one provider, for the source line and the retry button. */
function dictionaryProviderName(t, id) {
  if (id === 'youdao') return t('settings.dictionaryYoudao');
  if (id === 'bing') return t('settings.dictionaryBing');
  return id ?? '';
}

/** The other provider, so a failed lookup can offer one switch. */
function otherProvider(id) {
  return id === 'youdao' ? 'bing' : 'youdao';
}

/**
 * Play one phonetic through the provider's own audio.
 *
 * The element is created on first tap and lives only as long as the popup; a
 * failed play shows the reason instead of silently doing nothing, and the
 * button returns to idle when the clip ends.
 * @param {object} props
 * @param {string} props.audio the audio URL from the scraped page.
 * @param {string} props.label the accessible name of the button.
 * @param {string} props.failedLabel shown when playback is refused.
 */
function PhoneticAudio({ audio, label, failedLabel }) {
  const audioRef = React.useRef(null);
  const [playing, setPlaying] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const ensure = () => {
    if (audioRef.current !== null) return audioRef.current;
    if (typeof Audio !== 'function') return null;
    const element = new Audio(audio);
    element.addEventListener('ended', () => setPlaying(false));
    audioRef.current = element;
    return element;
  };
  const run = () => {
    const element = ensure();
    if (element === null) return;
    if (playing) {
      element.pause();
      setPlaying(false);
      return;
    }
    element.play().then(() => setPlaying(true)).catch(() => setFailed(true));
  };
  return h('button', {
    type: 'button',
    className: 'er-audio-btn',
    'aria-label': label,
    title: failed ? failedLabel : label,
    onClick: run,
  }, h(Icons.speaker, null));
}

/** Dictionary entry body, rendered inside the reader's Dialog. */
function DictionaryCard({ t, word, result, error, busy, onSwitch }) {
  const provider = result?.provider ?? 'youdao';
  const phonetics = Array.isArray(result?.phonetics) ? result.phonetics : [];
  const definitions = Array.isArray(result?.definitions) ? result.definitions : [];
  const examples = Array.isArray(result?.examples) ? result.examples : [];
  const fallback = otherProvider(provider);

  const renderPhonetic = (item, index) => {
    const text = [item.label ? `${item.label} ` : '', item.text];
    if (!item.audio) return h('span', { key: index, className: 'er-phonetic' }, text);
    return h('span', { key: index, className: 'er-phonetic-item' },
      h('span', { className: 'er-phonetic' }, text),
      h(PhoneticAudio, {
        audio: item.audio,
        label: item.label ? `${item.label} ${t('common.pronounce')}` : t('common.pronounce'),
        failedLabel: t('reader.dictAudioFailed'),
      }));
  };

  // The popup opens on the word alone, so the wait before the first result has
  // to be visible on its own rather than a blank card.
  if (busy) {
    return h('div', { className: 'er-dict-loading' },
      h('div', { className: 'er-dict-spinner', 'aria-hidden': true }),
      h('div', { className: 'er-dict-loading-text' }, t('reader.dictLoading')));
  }
  if (error !== undefined && error !== null) {
    return h('div', { className: 'er-dict-card' },
      h(Alert, { tone: 'error' }, error?.message ?? t('reader.dictNotFound')),
      h('div', { style: { marginTop: 10, display: 'flex', justifyContent: 'flex-end' } },
        h(Button, {
          size: 'sm', variant: 'ghost',
          onClick: () => onSwitch?.(fallback),
        }, t('reader.dictSwitchTo', { name: dictionaryProviderName(t, fallback) }))));
  }

  return h('div', { className: 'er-dict-card' },
    h('div', { className: 'er-dict-head' },
      h('div', { className: 'er-dict-word' }, word),
      phonetics.map(renderPhonetic),
      h('div', { className: 'er-topbar-spacer' }),
      h('div', { className: 'er-dict-source' }, t('reader.dictSourceLabel', {
        name: dictionaryProviderName(t, provider),
      }))),
    definitions.length > 0
      ? h('div', { className: 'er-dict-section' },
        h('div', { className: 'er-dict-section-title' }, t('reader.dictDefinitions')),
        definitions.map((item, index) => h('div', { key: index, className: 'er-dict-def' },
          item.pos ? h('span', { className: 'er-dict-pos' }, item.pos) : null,
          h('span', { className: 'er-dict-def-text' }, item.text))))
      : null,
    examples.length > 0
      ? h('div', { className: 'er-dict-section' },
        h('div', { className: 'er-dict-section-title' }, t('reader.dictExamples')),
        examples.map((item, index) => h('div', { key: index, className: 'er-dict-example' },
          h('div', { className: 'er-dict-example-en' }, item.en),
          item.zh ? h('div', { className: 'er-dict-example-zh' }, item.zh) : null)))
      : null);
}

export { DictionaryCard, PhoneticAudio };
