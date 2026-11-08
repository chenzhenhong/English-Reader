/** Shared primitives: cards, badges, buttons, empty states, dialogs, flash messages. */

/** Create one element. */
const h = React.createElement;

/** Span class for one bento cell, per the design spec table. */
const SPANS = { 12: 'er-span-12', 8: 'er-span-8', 6: 'er-span-6', 4: 'er-span-4', 3: 'er-span-3' };

/**
 * The board: one CSS grid, twelve columns at desktop.
 * Children must carry an explicit `span` so composition stays declarative.
 * @param {object} props `{ children }`.
 */
function Board({ children }) {
  return h('div', { className: 'er-board' }, children);
}

/**
 * One bento cell.
 * @param {object} props
 * @param {number} span columns out of 12.
 * @param {'feature'|'compact'|undefined} size radius/padding class.
 * @param {boolean} tint adds the ≤12% emphasis gradient.
 * @param {boolean} flush removes padding (for lists that own their edges).
 * @param {string} eyebrow small uppercase subject line.
 */
function Cell({ span = 12, size, tint = false, flush = false, eyebrow, icon, title, actions, children, className = '' }) {
  const classes = ['er-cell', SPANS[span] ?? SPANS[12],
    size === 'feature' ? 'er-cell--feature' : '', size === 'compact' ? 'er-cell--compact' : '',
    tint ? 'er-cell--tint' : '', flush ? 'er-cell--flush' : '', className].filter(Boolean).join(' ');
  const head = (eyebrow || title) ? h('div', {
    className: eyebrow ? 'er-eyebrow' : 'er-card-title',
    style: { padding: flush ? undefined : undefined, marginBottom: 12 },
  }, icon ?? null, h('span', null, eyebrow ?? title), actions ? h('div', { className: 'er-topbar-spacer' }) : null, actions ?? null) : null;
  return h('section', { className: classes }, head, children);
}

/** Card surface with an optional titled header. */
function Card({ title, icon, sub, actions, children, pad = true, className = '' }) {
  return h('section', { className: `er-card ${className}` },
    (title || actions) && h('div', { className: 'er-card-head' },
      h('div', { className: 'er-card-title' }, icon, h('span', null, title), sub && h('span', { className: 'er-card-sub' }, sub)),
      h('div', { className: 'er-topbar-spacer' }),
      actions),
    pad ? h('div', { className: 'er-card-pad' }, children) : children);
}

/** Small status pill. */
function Badge({ tone = 'soft', children }) {
  return h('span', { className: `er-badge ${tone}` }, children);
}

/** Button with variants; `variant` ∈ primary|default|ghost. */
function Button({
  variant = 'default', size, icon, iconOnly, wide, onClick, disabled, children,
  type = 'button', title, ariaLabel, ariaExpanded, testId,
}) {
  const classes = ['er-btn', variant === 'primary' ? 'primary' : '', variant === 'ghost' ? 'ghost' : '',
    size === 'sm' ? 'sm' : '', iconOnly ? 'icon' : '', wide ? 'wide' : ''].filter(Boolean).join(' ');
  return h('button', {
    type,
    className: classes,
    onClick,
    disabled: disabled === true,
    // Explicit list, not a spread: a plugin-only prop (a stray `t`, a callback)
    // must never reach the DOM element as an invalid attribute.
    title,
    'aria-label': ariaLabel ?? (iconOnly && typeof children === 'string' ? children : undefined),
    'aria-expanded': ariaExpanded,
    'data-testid': testId,
  }, icon ?? null, iconOnly ? null : children);
}

/** Empty state with an icon, copy and one call to action. */
function Empty({ icon, title, description, action }) {
  return h('div', { className: 'er-empty' },
    h('div', { className: 'er-empty-icon' }, icon),
    h('h3', null, title),
    description && h('p', null, description),
    action);
}

/** Inline alert. */
function Alert({ tone = 'error', children }) {
  const icon = tone === 'ok' ? h(Icons.check, null) : tone === 'warn' ? h(Icons.warning, null) : h(Icons.warning, null);
  return h('div', { className: `er-alert ${tone}`, role: tone === 'error' ? 'alert' : 'status' }, icon, h('div', null, children));
}

/** Shimmer placeholder block. */
function Skeleton({ height = 16, width = '100%', radius = 10 }) {
  return h('div', { className: 'er-skeleton', style: { height, width, borderRadius: radius } });
}

/** A labelled form field wrapper. */
function Field({ label, children, className = '' }) {
  return h('div', { className: `er-field ${className}` }, h('label', null, label), children);
}

/** Segmented tab strip. */
function Tabs({ items, value, onChange, trailing, sticky = false }) {
  return h('div', { className: sticky ? 'er-tabs-bar er-tabs-sticky' : 'er-tabs-bar' },
    h('div', { className: 'er-tabs', role: 'tablist' },
      items.map((item) => h('button', {
        key: item.id, type: 'button', role: 'tab', className: 'er-tab',
        'aria-selected': value === item.id,
        onClick: () => onChange(item.id),
      }, item.label))),
    trailing);
}

/** Modal dialog with Escape handling and a scrim. */
function Dialog({ title, onClose, children, footer }) {
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return h('div', { className: 'er-scrim', onClick: onClose },
    h('div', {
      className: 'er-modal', role: 'dialog', 'aria-modal': true, 'aria-label': title,
      onClick: (event) => event.stopPropagation(),
    },
    h('div', { className: 'er-modal-head' },
      h('div', { className: 'er-modal-title' }, title),
      h(Button, { variant: 'ghost', iconOnly: true, onClick: onClose, children: 'Close' }, h(Icons.close, null))),
    children,
    footer && h('div', { className: 'er-modal-foot' }, footer)));
}

/** Article artwork block used by cards and rows. */
function Thumb({ id, className = '', style }) {
  return h('div', { className: `er-thumb ${className}`, style: { background: artGradient(id), ...style }, 'aria-hidden': true });
}

/** Five-dot mastery indicator. */
function Mastery({ level }) {
  return h('span', { className: 'er-dots', 'aria-label': `掌握程度 ${level}/4` },
    [0, 1, 2, 3].map((index) => h('span', { key: index, className: 'er-dot', 'data-on': index < level })));
}

/** Progress ring for reading completion. */
function ProgressRing({ ratio, label }) {
  const size = 92;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  return h('div', { className: 'er-ring' },
    h('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
      h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'var(--er-line)', strokeWidth: 8 }),
      h('circle', {
        cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'url(#er-ring-grad)', strokeWidth: 8,
        strokeDasharray: circumference, strokeDashoffset: offset, strokeLinecap: 'round',
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
      h('defs', null,
        h('linearGradient', { id: 'er-ring-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0', stopColor: 'var(--er-blue)' }),
          h('stop', { offset: '1', stopColor: 'var(--er-violet)' }))),
      ),
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
      h('div', { className: 'er-ring-value' }, `${Math.round(ratio * 100)}%`),
      label !== undefined && h('div', { className: 'er-ring-label' }, label)));
}

/** Horizontal progress bar. */
function Progress({ ratio }) {
  return h('div', { className: 'er-progress', role: 'progressbar', 'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('span', { style: { width: `${Math.max(1, Math.round(ratio * 100))}%` } }));
}

export { h, Board, Cell, SPANS, Card, Badge, Button, Empty, Alert, Skeleton, Field, Tabs, Dialog, Thumb, Mastery, ProgressRing, Progress };
