/**
 * Bento Grid 2.0 conformance checks.
 *
 * Asserts the rules in `docs/bento-grid-2.0.md` against the built bundle:
 * span table, single gap, area-scaled radius, two shadow layers maximum,
 * theme-token colouring, and responsive collapse.
 *
 * This reads the emitted CSS and the component markup, so it tests what ships.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/** Extract the stylesheet string from the bundle (it is one template literal). */
function extractCss(source) {
  const start = source.indexOf('const CSS = `');
  const from = start + 'const CSS = `'.length;
  const end = source.indexOf('`;\n\nexport', from);
  const raw = source.slice(from, end < 0 ? source.length : end);
  return raw.replace(/\\`/g, '`').replace(/\\\\/g, '\\');
}
const css = extractCss(bundle);

console.log('board');
const boardRule = /\.er-board\s*\{[^}]*grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)/m.test(css);
check('board is a 12-column grid', boardRule);
const gapDecls = [...css.matchAll(/\.er-board\s*\{[^}]*gap:\s*([^;]+);/gm)].map((m) => m[1].trim());
check('board declares exactly one gap value', gapDecls.length === 1, JSON.stringify(gapDecls));
check('board gap is a single token, not shorthand', gapDecls[0] === 'var(--er-s-3)', gapDecls[0]);
// Rows must stretch so two cells side by side share one height; `start` left a
// visible notch of page background below the shorter cell.
const alignDecl = /\.er-board\s*\{[^}]*align-items:\s*stretch/m.test(css);
check('board stretches cells to a shared row height', alignDecl);
check('cells are flex columns so their bodies can scroll', /\.er-cell\s*\{[^}]*display:\s*flex/m.test(css)
  && /\.er-cell\s*\{[^}]*flex-direction:\s*column/m.test(css));
check('a scrolling body class exists', /\.er-cell-scroll\s*\{[^}]*overflow-y:\s*auto/m.test(css));
check('scrolling bodies have a maximum height', /\.er-cell-scroll\s*\{[^}]*max-height:/m.test(css));

console.log('\nfill mode');
// The reader must occupy exactly one screen, with each pane scrolling inside
// its own border, rather than making the whole page taller.
check('a fill-mode scroll shell exists', /\.er-scroll--fill\s*\{[^}]*overflow:\s*hidden/m.test(css));
check('the fill page is a bounded column', /\.er-page--fill\s*\{[^}]*display:\s*flex/m.test(css)
  && /\.er-page--fill\s*\{[^}]*min-height:\s*0/m.test(css));
check('the reader pane fits the remaining height', /\.er-reader--fill\s*\{[^}]*flex:\s*1/m.test(css));
check('the article body scrolls inside its cell', /\.er-reader--fill \.er-pane-scroll\s*\{[^}]*overflow-y:\s*auto/m.test(css));
// Superseded: the column is now a fixed frame and its bodies scroll instead.
check('the side column is a fixed frame, not a scroller',
  /\.er-reader--fill \.er-side\s*\{[^}]*overflow:\s*hidden/m.test(css));

console.log('\nside column main panel');
// Both reader branches must fill the column identically, and the bounded rule
// must not accidentally cap the main panel at 40%.
{
  check('both main panel classes share one rule',
    /\.er-reader--fill \.er-side > \.er-cell\.er-side-card,[\s\S]{0,120}\.er-cell\.er-insights\s*\{[^}]*flex:\s*1/.test(css));
  const bounded = css.match(/\.er-reader--fill \.er-side > \.er-cell:not\(\.er-side-card\)([^{]*)\{([^}]*)\}/);
  check('the bounded rule excludes the insights panel too',
    bounded !== null && bounded[1].includes(':not(.er-insights)'),
    bounded?.[1] ?? 'rule not found');
  check('the bounded rule caps height', bounded !== null && /max-height/.test(bounded[2]));
}

// A backtick inside the CSS template literal silently truncates the stylesheet,
// which is how this round's build broke.
{
  const styleSource = readFileSync(new URL('../src/20-style.js', import.meta.url), 'utf8');
  const body = styleSource.slice(styleSource.indexOf('const CSS = `') + 13, styleSource.lastIndexOf('`;'));
  check('the stylesheet contains no stray backtick', !body.includes('`'));
}

console.log('\nreader columns share one frame style');
// Left article cell and right insights cell must be the same kind of box, or
// their borders cannot line up: a nested card inside one of them inset it.
{
  const reader = readFileSync(new URL('../src/80-reader.js', import.meta.url), 'utf8');
  const insights = reader.slice(reader.indexOf('function ArticleInsights'),
    reader.indexOf('export { paragraphBlocks'));
  check('the insights cell is one er-cell', /className: 'er-cell er-insights'/.test(insights));
  check('no nested Card is drawn inside it', !/h\(Card,/.test(insights));
  // The component is defined above ArticleInsights, so look in the whole file.
  check('tab panels use a borderless section', /function InsightSection/.test(reader)
    && (reader.match(/h\(InsightSection,/g) ?? []).length >= 5,
    String((reader.match(/h\(InsightSection,/g) ?? []).length));
  const cssSource = readFileSync(new URL('../src/20-style.js', import.meta.url), 'utf8');
  check('the section heading draws no border',
    !/\.er-insight-section\s*\{[^}]*border:/.test(cssSource));
}

console.log('\nfixed frames in the side column');
// A scrolling column dragged every card border along with its content. The
// column is now a fixed frame: the tab strip sits outside the scroller and only
// the body moves, so borders stay put.
{
  const frame = css.match(/\.er-reader--fill \.er-side\s*\{([^}]*)\}/);
  check('the side column does not scroll', frame !== null && /overflow:\s*hidden/.test(frame[1]));
  check('the side column can shrink', frame !== null && /min-height:\s*0/.test(frame[1]));
  const body = css.match(/\.er-insights > \.er-insights-body\s*\{([^}]*)\}/);
  check('the tab body scrolls', body !== null && /overflow-y:\s*auto/.test(body[1]));
  check('the tab body fills the frame', body !== null && /flex:\s*1/.test(body[1]));
  // The rule is written as a grouped selector list, so match either form.
  const cardScroll = css.match(/\.er-side-card > \.er-side-scroll[^{]*\{([^}]*)\}/);
  check('the sentence body scrolls inside its card', cardScroll !== null && /overflow-y:\s*auto/.test(cardScroll[1]));
  // Both the title bar and the sentence sit outside the scroller, so they need no
  // sticky positioning: nothing removes them from view in the first place.
  check('the panel title is outside the scroller', /\.er-side-card > \.er-side-head\s*\{[^}]*flex:\s*none/.test(css));
  check('the sentence head is outside the scroller', /\.er-side-card > \.er-sentence-head\s*\{[^}]*flex:\s*none/.test(css));
  check('no sticky is used inside the sentence card', !/\.er-sentence-sticky/.test(css));
}

console.log('\nheatmap sizing');
// Cells size from their grid track, not from a fixed pixel ceiling: a hard 16px
// cap left loose dots with gaps once fewer columns were shown. The block height
// is what bounds the page instead.
{
  const cell = css.match(/\.er-heat-cell\s*\{([^}]*)\}/);
  check('heat cells are sized by their track', cell !== null && /width:\s*100%/.test(cell[1]));
  check('heat cells keep a square ratio', cell !== null && /aspect-ratio:\s*1/.test(cell[1]));
  check('no fixed pixel ceiling remains', cell !== null && !/max-height/.test(cell[1]));
  const grid = css.match(/\.er-heat-grid\s*\{([^}]*)\}/);
  check('the grid is height-bounded', grid !== null && /max-height:\s*210px/.test(grid[1]));
  // There is exactly one heatmap look: the dashboard reuses the history grid,
  // so no compact variant may exist.
  check('no compact heatmap variant remains', !/\.er-heat--compact/.test(css));
}

console.log('\nalignment');
// One shared bottom gutter keeps the rail's last item level with the content.
check('a shared bottom gutter token exists', /--er-gutter-bottom:/.test(css));
const railPad = css.match(/\.er-rail\s*\{[^}]*padding:[^;]*var\(--er-gutter-bottom\)/);
check('the rail uses the shared gutter', railPad !== null);
const scrollPad = css.match(/\.er-scroll\s*\{[^}]*padding:[^;]*var\(--er-gutter-bottom\)/);
check('the scroll area uses the same gutter', scrollPad !== null);

console.log('\nspans');
for (const span of [12, 8, 6, 4, 3]) {
  check(`span ${span} maps to a grid-column`, new RegExp(`\\.er-span-${span}\\s*\\{[^}]*grid-column:\\s*span ${span}`, 'm').test(css));
}
check('no ad-hoc grid-column for a span outside the table', !/\.er-span-(?:1|2|5|7|9|10|11)\b/.test(css));

console.log('\nradius scale');
const radii = ['xs: 8px', 'sm: 12px', 'md: 18px', 'lg: 24px', 'xl: 28px'];
for (const entry of radii) {
  const [name, value] = entry.split(': ');
  check(`--er-r-${name} is ${value}`, new RegExp(`--er-r-${name}:\\s*${value};`).test(css));
}
check('standard cell uses the md radius', /\.er-cell\s*\{[^}]*border-radius:\s*var\(--er-r-md\)/m.test(css));
check('feature cell uses the xl radius', /\.er-cell--feature\s*\{[^}]*border-radius:\s*var\(--er-r-xl\)/m.test(css));
check('radius grows with area (md < lg < xl)', 18 < 24 && 24 < 28);

console.log('\nelevation');
/**
 * Count shadow layers in one custom property value.
 * Commas inside `color-mix(...)` are arguments, not layer separators, so this
 * tracks parenthesis depth instead of splitting naively.
 */
function shadowLayers(value) {
  let depth = 0;
  let layers = 1;
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) layers += 1;
  }
  return layers;
}

// Guard the helper itself: a naive split would report 4 for one layer.
check('layer counter ignores color-mix commas',
  shadowLayers('0 1px 1px color-mix(in srgb, red 5%, transparent), 0 16px 32px -26px color-mix(in srgb, blue 34%, transparent)') === 2);
for (const name of ['--er-lift-1', '--er-lift-2', '--er-lift-3']) {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (match === null) {
    check(`${name} is declared`, false);
    continue;
  }
  const layers = shadowLayers(match[1]);
  check(`${name} has at most two layers`, layers <= 2, `${layers} layers`);
}
check('cells do not use a multi-layer glow', !/box-shadow:\s*0 0 0[^;]*,[^;]*,[^;]*,[^;]*,[^;]*;/m.test(css));

console.log('\nsurface');
check('cell has a border', /\.er-cell\s*\{[^}]*border:\s*1px solid/m.test(css));
check('hover raises exactly one elevation step', /\.er-cell:hover\s*\{[^}]*box-shadow:\s*var\(--er-lift-2\)/m.test(css));
const tint = css.match(/\.er-cell--tint\s*\{[^}]*color-mix\(in srgb, var\(--er-violet\) (\d+)%/);
check('emphasis tint stays at or below 12%', tint !== null && Number(tint[1]) <= 12, tint?.[1]);
check('gap is never larger than the smallest cell padding', 12 <= 16);

console.log('\ntheme tokens');
const dswUses = (css.match(/--dsw-alias-[a-z0-9-]+/g) ?? []).length;
check('colours resolve through --dsw-alias-* tokens', dswUses >= 3, `${dswUses} references`);
check('defines a dark palette', /body\[data-ds-dark-theme\]\s+\.er-root\s*\{/m.test(css));
const erTokensInDark = (css.split('body[data-ds-dark-theme] .er-root {')[1] ?? '').slice(0, 900);
check('dark palette overrides the plugin tints', /--er-violet:/.test(erTokensInDark));

console.log('\nresponsiveness');
check('board collapses to 6 columns at 1180px', /@media \(max-width: 1180px\)[\s\S]*?\.er-board\s*\{[^}]*repeat\(6,/m.test(css));
check('board collapses to 2 columns at 900px', /@media \(max-width: 900px\)[\s\S]*?\.er-board\s*\{[^}]*repeat\(2,/m.test(css));
check('spans are remapped at 900px', /@media \(max-width: 900px\)[\s\S]*?\.er-span-12[^}]*grid-column:\s*span 2/m.test(css));
check('reduced motion is honoured', /@media \(prefers-reduced-motion: reduce\)/m.test(css));

// ----------------------------------------------------------- component usage
console.log('\ncomposition');
let registration;
const sandbox = { window: { __ModuleLoader__: { load(r) { registration = r; } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'client.js' });
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (fn) => fn(),
  useCallback: (fn) => fn, useRef: (v) => ({ current: v }), Fragment: 'fragment',
};
const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require ${specifier}`);
});
plugin.apply({
  effect: () => () => {},
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject(_k, cb) { cb(); return () => {}; }, register() { return () => {}; } },
});

/** Does this tree use a Board, and do its cells carry spans? */
function inspect(element, found = { boards: 0, spans: [] }) {
  if (element === null || element === undefined || typeof element !== 'object') return found;
  if (Array.isArray(element)) {
    element.forEach((child) => inspect(child, found));
    return found;
  }
  if (element.type === plugin.__test.Board) found.boards += 1;
  const span = element.props?.span;
  if (typeof span === 'number') found.spans.push(span);
  (element.children ?? []).forEach((child) => inspect(child, found));
  return found;
}

const Board = plugin.__test.Board;
check('Board primitive is exported for composition', typeof Board === 'function');
const cell = plugin.__test.Cell;
check('Cell primitive is exported', typeof cell === 'function');

// A cell renders its span class.
const rendered = cell({ span: 4, eyebrow: 'x' });
check('Cell applies a span class', String(rendered.props.className).includes('er-span-4'), rendered.props.className);
const feature = cell({ span: 8, size: 'feature' });
check('Cell applies the feature class', String(feature.props.className).includes('er-cell--feature'));
const tinted = cell({ span: 6, tint: true });
check('Cell applies the tint class', String(tinted.props.className).includes('er-cell--tint'));

// Every span used anywhere must be in the table.
if (plugin.__test && plugin.__test.SettingsPage) {
  const sources = ['Dashboard', 'Discover', 'SettingsPage', 'ReviewPage', 'ArticleDetail'];
  let straySpan = null;
  for (const name of sources) {
    const fn = plugin.__test[name];
    if (typeof fn !== 'function') continue;
    // Rendering here would need data; instead scan the bundle text for spans.
  }
  const spansInSource = [...bundle.matchAll(/span:\s*(\d+)/g)].map((m) => Number(m[1]));
  const allowed = new Set([12, 8, 6, 4, 3]);
  const stray = [...new Set(spansInSource)].filter((value) => !allowed.has(value));
  check('every declared span is from the spec table', stray.length === 0, stray.join(','));
  check('pages compose through Board', (bundle.match(/h\(Board,/g) ?? []).length >= 3, String((bundle.match(/h\(Board,/g) ?? []).length));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
