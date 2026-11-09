/**
 * Bento Grid 2.0 surface for English Reader.
 *
 * Implements `docs/bento-grid-2.0.md`. The rules that matter most here:
 * - a 12-column board with spans from the spec (never ad-hoc widths);
 * - one `gap` value across the whole board;
 * - radius grows with cell area (18 / 24 / 28px);
 * - two shadow layers maximum: a 1px contact plus one wide ambient;
 * - colour resolves through `--dsw-alias-*` (or a mix of them) so light and dark
 *   both work; the board's own tints stay ≤ 12%.
 */

const CSS = `
.er-root {
  /* ---------------------------------------------------------------- palette */
  --er-violet: #7b6cf6;
  --er-violet-2: #a78bfa;
  --er-violet-soft: #eeebfd;
  --er-blue: #4f7cf7;
  --er-blue-soft: #e8eeff;
  --er-mint: #34b98a;
  --er-mint-soft: #e2f6ee;
  --er-amber: #d98b21;
  --er-amber-soft: #fdf0dc;
  --er-pink: #db6d9b;
  --er-pink-soft: #fdeaf2;

  --er-ink: var(--dsw-alias-label-primary);
  --er-ink-2: var(--dsw-alias-label-secondary);
  --er-ink-3: var(--dsw-alias-label-tertiary);
  --er-card: var(--dsw-alias-bg-layer-1);
  --er-line: color-mix(in srgb, var(--dsw-alias-border-l2) 82%, var(--er-violet) 6%);

  /* ------------------------------------------------------------- geometry */
  --er-r-xs: 8px;
  --er-r-sm: 12px;
  --er-r-md: 18px;
  --er-r-lg: 24px;
  --er-r-xl: 28px;
  --er-s-1: 4px;
  --er-s-2: 8px;
  --er-s-3: 12px;
  --er-s-4: 16px;
  --er-s-5: 20px;
  --er-s-6: 24px;
  --er-s-8: 32px;
  /* Shared bottom gutter: the rail's last item aligns with the content edge. */
  --er-gutter-bottom: 20px;

  /* Two layers only: 1px contact + one wide ambient. */
  --er-lift-1: 0 1px 1px color-mix(in srgb, var(--er-ink) 5%, transparent),
    0 16px 32px -26px color-mix(in srgb, var(--er-violet) 34%, transparent);
  --er-lift-2: 0 2px 2px color-mix(in srgb, var(--er-ink) 6%, transparent),
    0 30px 56px -32px color-mix(in srgb, var(--er-violet) 38%, transparent);
  --er-lift-3: 0 3px 4px color-mix(in srgb, var(--er-ink) 8%, transparent),
    0 44px 76px -38px color-mix(in srgb, var(--er-violet) 42%, transparent);

  display: flex;
  height: 100%;
  min-height: 0;
  color: var(--er-ink);
  font-family: var(--dsw-font-family, inherit);
  background:
    radial-gradient(980px 520px at 4% -10%, color-mix(in srgb, var(--er-violet) 11%, transparent), transparent 62%),
    radial-gradient(820px 460px at 98% 4%, color-mix(in srgb, var(--er-blue) 9%, transparent), transparent 58%),
    color-mix(in srgb, var(--dsw-alias-bg-base) 92%, var(--er-violet-soft) 8%);
}

body[data-ds-dark-theme] .er-root {
  --er-violet: #9b8bff;
  --er-violet-2: #c4b5fd;
  --er-violet-soft: #221f3a;
  --er-blue: #7d9bff;
  --er-blue-soft: #1b2038;
  --er-mint: #4bd3a3;
  --er-mint-soft: #14261f;
  --er-amber: #e8ae5e;
  --er-amber-soft: #2a2114;
  --er-pink: #e795ba;
  --er-pink-soft: #2a1a22;
  background:
    radial-gradient(980px 520px at 4% -10%, color-mix(in srgb, var(--er-violet) 10%, transparent), transparent 62%),
    radial-gradient(820px 460px at 98% 4%, color-mix(in srgb, var(--er-blue) 8%, transparent), transparent 58%),
    color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #16132a 6%);
}

/* ------------------------------------------------------------------- rail */
.er-rail {
  flex: none;
  width: 188px;
  display: flex;
  flex-direction: column;
  gap: var(--er-s-1);
  padding: var(--er-s-4) var(--er-s-3) var(--er-gutter-bottom);
  overflow-y: auto;
  border-right: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-card) 70%, transparent);
  backdrop-filter: blur(20px);
}
.er-brand { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: var(--er-s-2) 0 var(--er-s-5); }
.er-brand-mark {
  display: grid; place-items: center; width: 46px; height: 46px; border-radius: var(--er-r-md);
  background: linear-gradient(155deg, color-mix(in srgb, var(--er-violet) 12%, var(--er-card)), var(--er-card) 70%);
  border: 1px solid color-mix(in srgb, var(--er-violet) 22%, transparent);
  box-shadow: var(--er-lift-1);
}
.er-brand-mark svg { width: 28px; height: 28px; }
.er-brand-name {
  font-size: 12.5px; font-weight: 650; line-height: 16px;
  color: var(--er-ink); text-align: center;
  /* One line, always: the label must never re-wrap into "English / Reader". */
  white-space: nowrap;
  max-width: 100%;
}
.er-brand-sub { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--er-ink-3); }

.er-nav-item {
  display: flex; align-items: center; gap: var(--er-s-2);
  padding: 8px 10px; border-radius: var(--er-r-sm); border: 1px solid transparent;
  font-size: 12.5px; line-height: 18px; color: var(--er-ink-2); cursor: pointer;
  background: transparent; width: 100%; text-align: left; font-family: inherit;
  transition: background .13s ease, color .13s ease, border-color .13s ease;
}
.er-nav-item:hover { background: color-mix(in srgb, var(--er-violet) 7%, transparent); color: var(--er-ink); }
.er-nav-item[aria-current="true"] {
  color: var(--er-ink); font-weight: 600;
  background: color-mix(in srgb, var(--er-violet) 10%, var(--er-card));
  border-color: color-mix(in srgb, var(--er-violet) 26%, transparent);
}
.er-nav-icon { flex: none; display: grid; place-items: center; width: 18px; height: 18px; color: currentColor; opacity: .8; }
.er-nav-icon svg { width: 15px; height: 15px; }
.er-nav-group { margin: var(--er-s-3) 0 var(--er-s-1); padding: 0 10px; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--er-ink-3); }
.er-rail-foot { margin-top: auto; padding-top: var(--er-s-3); }

/* ----------------------------------------------------------------- content */
.er-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.er-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--er-s-5) var(--er-s-6) var(--er-gutter-bottom);
}
.er-page {
  max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--er-s-3);
  /* The page is a flex item of the scroll shell: without this it keeps its
     content's min-content width and the shell scrolls sideways. */
  min-width: 0;
}
.er-topbar { display: flex; align-items: center; gap: var(--er-s-3); }
.er-crumb { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--er-ink-3); min-width: 0; }
.er-crumb-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .5; flex: none; }
.er-topbar-spacer { flex: 1; }

/* ------------------------------------------------------------------ board */
/* The board is one grid; every child is a cell with an explicit span. */
.er-board {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--er-s-3);
  /* stretch, not start: a short cell beside a tall one left a visible notch
     under its border. Rows still size to their tallest cell. */
  align-items: stretch;
}
.er-span-12 { grid-column: span 12; }
.er-span-8 { grid-column: span 8; }
.er-span-6 { grid-column: span 6; }
.er-span-4 { grid-column: span 4; }
.er-span-3 { grid-column: span 3; }

/* ------------------------------------------------------------------- cells */
.er-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* The cell is a grid item: the min-width above lets it shrink, and this
     keeps the box from growing past its column. */
  max-width: 100%;
  padding: var(--er-s-5);
  border-radius: var(--er-r-md);
  border: 1px solid color-mix(in srgb, var(--er-line) 82%, transparent);
  background: var(--er-card);
  box-shadow: var(--er-lift-1);
  transition: box-shadow .15s ease, border-color .15s ease;
}
.er-cell:hover { box-shadow: var(--er-lift-2); border-color: color-mix(in srgb, var(--er-violet) 24%, var(--er-line)); }
/* Area-scaled radius: feature cells are rounder than small ones. */
.er-cell--feature { padding: var(--er-s-6); border-radius: var(--er-r-xl); box-shadow: var(--er-lift-2); }
.er-cell--feature:hover { box-shadow: var(--er-lift-3); }
.er-cell--compact { padding: var(--er-s-4); }
/* Optional emphasis: a tint gradient at ≤12%, never a shadow stack. */
.er-cell--tint {
  background: linear-gradient(158deg,
    color-mix(in srgb, var(--er-violet) 11%, var(--er-card)) 0%,
    var(--er-card) 62%);
}
.er-cell--flush { padding: 0; overflow: hidden; }

/* Content that would otherwise stretch the cell scrolls inside it. */
.er-cell-scroll {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* A visible maximum keeps one long list from owning the whole page. */
  max-height: var(--er-cell-max, 420px);
  /* Room for the scrollbar so text never sits under it. */
  padding-right: 4px;
  /* The list never scrolls sideways: a wide row would draw a second bar. */
  overflow-x: hidden;
}
.er-cell-scroll::-webkit-scrollbar { width: 8px; }
.er-cell-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--er-ink-3) 30%, transparent);
}

.er-card { /* legacy alias kept so older markup keeps the cell surface */
  position: relative; min-width: 0;
  border-radius: var(--er-r-md);
  border: 1px solid color-mix(in srgb, var(--er-line) 82%, transparent);
  background: var(--er-card);
  box-shadow: var(--er-lift-1);
}
.er-card-pad { padding: var(--er-s-5); }
.er-card-head {
  display: flex; align-items: center; gap: var(--er-s-2);
  padding: var(--er-s-4) var(--er-s-5) 0;
}
.er-card-title { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 650; letter-spacing: .01em; color: var(--er-ink); }
.er-card-title svg { width: 14px; height: 14px; color: var(--er-violet); }
.er-card-sub { font-size: 11px; color: var(--er-ink-3); }

/* A cell's own header: eyebrow + figure + support. */
.er-eyebrow {
  display: flex; align-items: center; gap: 6px;
  font-size: 9.5px; font-weight: 600; letter-spacing: .13em; text-transform: uppercase;
  color: var(--er-ink-3);
}
.er-eyebrow svg { width: 12px; height: 12px; color: var(--er-violet); }

/* ------------------------------------------------------------- welcome cell */
.er-welcome { display: flex; flex-direction: column; gap: var(--er-s-4); }
.er-welcome h1 { margin: 0; font-size: 26px; line-height: 33px; font-weight: 720; letter-spacing: -.015em; }
.er-welcome p { margin: 3px 0 0; font-size: 12.5px; line-height: 19px; color: var(--er-ink-2); }
.er-welcome-body { display: flex; align-items: center; gap: var(--er-s-5); flex-wrap: wrap; }
.er-books { position: relative; flex: none; width: 118px; height: 78px; }
.er-books span { position: absolute; left: 0; right: 0; border-radius: var(--er-r-xs); }
.er-books .b3 { bottom: 0; height: 18px; left: 8px; right: 2px; background: linear-gradient(135deg, var(--er-pink-soft), color-mix(in srgb, var(--er-pink) 44%, var(--er-card))); }
.er-books .b2 { bottom: 18px; height: 16px; left: 0; right: 10px; background: linear-gradient(135deg, var(--er-violet-soft), color-mix(in srgb, var(--er-violet) 40%, var(--er-card))); }
.er-books .b1 { bottom: 34px; height: 14px; left: 14px; right: 0; background: linear-gradient(135deg, var(--er-blue-soft), color-mix(in srgb, var(--er-blue) 34%, var(--er-card))); }
.er-books .b0 { bottom: 48px; height: 13px; left: 2px; right: 14px; background: linear-gradient(135deg, var(--er-mint-soft), color-mix(in srgb, var(--er-mint) 30%, var(--er-card))); }
.er-books .open {
  position: absolute; bottom: 20px; left: 30px; width: 58px; height: 40px;
  border-radius: var(--er-r-xs);
  background: linear-gradient(160deg, var(--er-violet-2), var(--er-violet));
  box-shadow: 0 14px 24px -16px color-mix(in srgb, var(--er-violet) 80%, transparent);
}

/* ----------------------------------------------------------------- search */
.er-search {
  display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 11px;
  border-radius: var(--er-r-xs); border: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-card) 88%, var(--er-violet-soft));
}
.er-search svg { width: 14px; height: 14px; color: var(--er-ink-3); flex: none; }
.er-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; font-size: 12px; color: var(--er-ink); }
.er-search input::placeholder { color: var(--er-ink-3); }

/* --------------------------------------------------------- reader band */
/* The band is a flex child of the fill page, so collapsing it hands the freed
   height straight to the reader below: no measurement, no JS. */
.er-page--fill > .er-reader-band { flex: none; }
.er-reader-band--collapsed { padding-top: 10px; padding-bottom: 10px; }
.er-reader-band--collapsed > div { gap: 0; }

/* -------------------------------------------------------------- stat cells */
.er-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--er-s-3); }
.er-stat {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--er-s-3) var(--er-s-4);
  border-radius: var(--er-r-sm);
  background: color-mix(in srgb, var(--er-card) 80%, var(--er-violet-soft));
  border: 1px solid color-mix(in srgb, var(--er-line) 70%, transparent);
}
.er-stat-icon { width: 24px; height: 24px; border-radius: var(--er-r-xs); display: grid; place-items: center; color: var(--er-violet); background: color-mix(in srgb, var(--er-violet) 10%, var(--er-card)); margin-bottom: 4px; }
.er-stat-icon svg { width: 13px; height: 13px; }
.er-stat-value { font-size: 21px; line-height: 26px; font-weight: 720; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.er-stat-value small { font-size: 10.5px; font-weight: 500; color: var(--er-ink-3); margin-left: 3px; }
.er-stat-label { font-size: 10.5px; color: var(--er-ink-3); }
.er-stat-delta { font-size: 10px; color: var(--er-mint); font-weight: 600; }

/* ----------------------------------------------------------- article rows */
.er-row-list { display: flex; flex-direction: column; }
.er-row {
  display: flex; align-items: center; gap: var(--er-s-3); padding: 10px var(--er-s-5);
  border: 1px solid transparent; border-radius: var(--er-r-sm); background: transparent;
  text-align: left; font-family: inherit; color: inherit; width: 100%; cursor: pointer;
  /* A full-width row plus the list's own padding overflowed the box, which
     drew a horizontal scrollbar under the list. */
  box-sizing: border-box; min-width: 0;
  transition: background .13s ease;
}
.er-row:hover { background: color-mix(in srgb, var(--er-violet) 6%, transparent); }
.er-thumb { flex: none; width: 54px; height: 40px; border-radius: var(--er-r-sm); position: relative; overflow: hidden; border: 1px solid color-mix(in srgb, var(--er-line) 60%, transparent); }
.er-thumb::after { content: ""; position: absolute; inset: 0; background: radial-gradient(120% 80% at 22% 8%, color-mix(in srgb, white 42%, transparent), transparent 62%); }
.er-row-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.er-row-title { font-size: 13px; font-weight: 620; line-height: 19px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-row-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--er-ink-3); flex-wrap: wrap; min-width: 0; }
.er-row-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.er-row-side { flex: none; display: flex; align-items: center; gap: var(--er-s-2); font-size: 11px; color: var(--er-ink-3); }

/* The article list fills the page: the cell owns the screen and the list
   scrolls inside it, so the list never grows past the viewport. */
.er-articles-cell { flex: 1; min-height: 0; }
.er-articles-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 8px 6px 14px;
}
.er-articles-list::-webkit-scrollbar { width: 8px; }
.er-articles-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--er-ink-3) 30%, transparent);
}

/* ---------------------------------------------------------------- badges */
.er-badge {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px;
  border-radius: var(--er-r-xs); font-size: 10px; font-weight: 600; letter-spacing: .02em; white-space: nowrap;
  border: 1px solid transparent;
}
.er-badge.blue { color: var(--er-blue); background: var(--er-blue-soft); border-color: color-mix(in srgb, var(--er-blue) 20%, transparent); }
.er-badge.violet { color: var(--er-violet); background: var(--er-violet-soft); border-color: color-mix(in srgb, var(--er-violet) 22%, transparent); }
.er-badge.mint { color: var(--er-mint); background: var(--er-mint-soft); border-color: color-mix(in srgb, var(--er-mint) 24%, transparent); }
.er-badge.amber { color: var(--er-amber); background: var(--er-amber-soft); border-color: color-mix(in srgb, var(--er-amber) 24%, transparent); }
.er-badge.pink { color: var(--er-pink); background: var(--er-pink-soft); border-color: color-mix(in srgb, var(--er-pink) 24%, transparent); }
.er-badge.soft { color: var(--er-ink-2); background: color-mix(in srgb, var(--er-ink-3) 10%, transparent); border-color: var(--er-line); }
.er-badge.neutral, .er-badge.plain { color: var(--er-ink-3); background: transparent; border-color: var(--er-line); }

/* ---------------------------------------------------------------- controls */
.er-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 13px; border-radius: var(--er-r-sm);
  font-family: inherit; font-size: 12px; font-weight: 550; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--er-line); background: var(--er-card); color: var(--er-ink);
  transition: background .13s ease, border-color .13s ease, box-shadow .13s ease;
}
.er-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--er-card) 86%, var(--er-violet-soft)); border-color: color-mix(in srgb, var(--er-violet) 22%, var(--er-line)); }
.er-btn:active:not(:disabled) { box-shadow: inset 0 1px 2px color-mix(in srgb, var(--er-ink) 12%, transparent); }
.er-btn:disabled { opacity: .5; cursor: default; }
.er-btn svg { width: 13px; height: 13px; }
.er-btn.primary {
  border-color: color-mix(in srgb, var(--er-violet) 46%, transparent); color: #fff;
  background: linear-gradient(140deg, var(--er-blue) 0%, var(--er-violet) 62%, var(--er-violet-2) 100%);
  box-shadow: 0 1px 1px color-mix(in srgb, var(--er-violet) 40%, transparent), 0 14px 26px -18px color-mix(in srgb, var(--er-violet) 78%, transparent);
}
.er-btn.primary:hover:not(:disabled) { background: linear-gradient(140deg, var(--er-blue) 0%, var(--er-violet) 58%, var(--er-violet-2) 96%); }
.er-btn.ghost { border-color: transparent; background: transparent; color: var(--er-ink-2); }
.er-btn.ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--er-violet) 8%, transparent); border-color: transparent; }
.er-btn.sm { height: 26px; padding: 0 9px; font-size: 11px; border-radius: var(--er-r-xs); }
.er-btn.icon { width: 28px; height: 28px; padding: 0; }
.er-btn.wide { width: 100%; }

/* ------------------------------------------------------------------- tabs */
.er-tabs { display: flex; align-items: center; gap: 2px; }
.er-tab {
  height: 30px; padding: 0 12px; border-radius: var(--er-r-xs); border: 1px solid transparent;
  background: transparent; color: var(--er-ink-2); font-family: inherit; font-size: 12px; cursor: pointer;
  transition: color .13s ease, background .13s ease;
}
.er-tab:hover { color: var(--er-ink); background: color-mix(in srgb, var(--er-violet) 7%, transparent); }
.er-tab[aria-selected="true"] {
  color: var(--er-ink); font-weight: 620;
  background: var(--er-card); border-color: var(--er-line);
}
.er-tabs-bar {
  display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-3);
  padding: 4px; border-radius: var(--er-r-md);
  background: color-mix(in srgb, var(--er-card) 74%, var(--er-violet-soft));
  border: 1px solid var(--er-line);
}
/* Pin a tab strip to the top of whatever scroll container holds it. The
   negative top and matching padding keep the strip's own border off the edge. */
.er-tabs-sticky {
  position: sticky;
  top: 0;
  z-index: 3;
  /* Opaque so panels scrolling underneath do not show through the strip. */
  background: color-mix(in srgb, var(--er-card) 97%, var(--er-violet-soft));
  box-shadow: 0 6px 12px -10px color-mix(in srgb, var(--er-ink) 40%, transparent);
}

/* ----------------------------------------------------------------- fields */
.er-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.er-field > label,
.er-field-label {
  font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--er-ink-3); line-height: 16px;
}
.er-input, .er-select, .er-textarea {
  width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px;
  border-radius: var(--er-r-xs); border: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-card) 94%, var(--er-violet-soft)); color: var(--er-ink);
  font-family: inherit; font-size: 12px; outline: none;
}
.er-textarea { height: auto; min-height: 104px; padding: 9px 10px; line-height: 19px; resize: vertical; }
.er-input:focus, .er-select:focus, .er-textarea:focus { border-color: color-mix(in srgb, var(--er-violet) 52%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--er-violet) 14%, transparent); }
.er-select {
  appearance: none; padding-right: 26px;
  background-image: linear-gradient(45deg, transparent 50%, var(--er-ink-3) 50%), linear-gradient(135deg, var(--er-ink-3) 50%, transparent 50%);
  background-position: calc(100% - 14px) 14px, calc(100% - 9px) 14px;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.er-check { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--er-ink-2); cursor: pointer; }
.er-check input { width: 14px; height: 14px; accent-color: var(--er-violet); cursor: pointer; margin: 0; }
.er-form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--er-s-3); }
.er-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.er-chip {
  height: 25px; padding: 0 9px; border-radius: var(--er-r-xs); font-family: inherit; font-size: 11px; cursor: pointer;
  border: 1px solid var(--er-line); background: var(--er-card); color: var(--er-ink-2);
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.er-chip:hover { border-color: color-mix(in srgb, var(--er-violet) 28%, var(--er-line)); }
.er-chip[aria-pressed="true"] { color: var(--er-violet); border-color: color-mix(in srgb, var(--er-violet) 42%, transparent); background: var(--er-violet-soft); font-weight: 600; }

/* -------------------------------------------------------------- candidates */
.er-candidate {
  display: flex; align-items: center; gap: var(--er-s-3); padding: 10px var(--er-s-4);
  border-radius: var(--er-r-sm); border: 1px solid var(--er-line); background: var(--er-card);
  transition: border-color .13s ease, box-shadow .13s ease;
}
.er-candidate[data-selected="true"] { border-color: color-mix(in srgb, var(--er-violet) 40%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--er-violet) 12%, transparent); }
/* A candidate that refused to import keeps its reason on the row, so the
   reader sees why instead of a silent no-op. */
.er-candidate[data-failed="true"] { border-color: color-mix(in srgb, var(--er-amber) 45%, transparent); }
.er-candidate-error { margin-top: 4px; font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-state-error-primary); }
.er-candidate .er-thumb { width: 78px; height: 54px; border-radius: var(--er-r-sm); }
.er-reasons { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }

/* ----------------------------------------------------------------- reader */
.er-reader { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: var(--er-s-3); align-items: stretch; }

/* Fill mode: the page is exactly one viewport tall and each pane scrolls
   inside its own border. This is what keeps the reader on one screen. */
.er-scroll--fill { overflow: hidden; display: flex; padding-bottom: var(--er-gutter-bottom); }
.er-page--fill { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.er-page--fill > .er-topbar { flex: none; }

/* The discover page: one tab strip, then a pane that fills the rest of the
   screen and scrolls inside its own border. */
.er-discover-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--er-s-3); }
.er-discover-pane > .er-tabs-bar { flex: none; }
.er-discover-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: var(--er-s-3);
}
.er-discover-spec, .er-discover-results { display: flex; flex-direction: column; gap: var(--er-s-3); }
/* The results board fills the pane and each cell scrolls inside its border, so
   the candidate list uses the whole screen instead of leaving dead space. */
.er-discover-results { flex: 1; min-height: 0; }
.er-discover-results .er-board { flex: 1; min-height: 0; }
.er-discover-results .er-cell { min-height: 0; }
/* The results pane owns the scroll itself, so the board inside it can be
   taller than the viewport without growing the page. */
.er-discover-body--fixed { overflow: hidden; }
.er-discover-body--fixed .er-discover-results { overflow-y: auto; }
.er-discover-results .er-cell-scroll {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
/* The candidate list owns its own gap so the trailing "load more" row sits
   right under the last candidate. */
.er-candidate-scroll { display: flex; flex-direction: column; gap: 8px; }
.er-more { display: flex; justify-content: center; padding: 6px 0 2px; }
.er-more--end { color: var(--er-ink-3); font-size: 11px; }
.er-discover-body::-webkit-scrollbar { width: 8px; }
.er-discover-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--er-ink-3) 32%, transparent);
  border-radius: 999px;
}
.er-discover-body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--er-ink-3) 52%, transparent);
}

.er-reader--fill { flex: 1; min-height: 0; }
.er-reader--fill > .er-cell,
.er-reader--fill > .er-side { min-height: 0; overflow: hidden; }
/* The article pane is a column: fixed header, scrolling body. */
.er-reader--fill > .er-cell { display: flex; flex-direction: column; }
.er-reader--fill .er-pane-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 6px;
}
.er-reader--fill .er-side {
  display: flex;
  flex-direction: column;
  gap: var(--er-s-3);
  /* Fixed frame: the column itself does not scroll, so no border drifts. */
  min-height: 0;
  overflow: hidden;
}
.er-pane-scroll::-webkit-scrollbar,
.er-side-scroll::-webkit-scrollbar { width: 8px; }
.er-pane-scroll::-webkit-scrollbar-thumb,
.er-side-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--er-ink-3) 30%, transparent);
}
/* The main panel of the side column fills the remaining height and scrolls its
   own body. Both branch classes are listed: split uses .er-side-card,
   continuous uses .er-insights, and they must behave identically or one column
   ends shorter than the article beside it. */
.er-reader--fill .er-side > .er-cell.er-side-card,
.er-reader--fill .er-side > .er-cell.er-insights {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* Card bodies scroll inside their fixed border. */
.er-side-card > .er-side-scroll,
.er-insights > .er-insights-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
}
/* Section headings inside the insights cell: the cell owns the only border, so
   these must not draw one of their own. */
.er-insight-section { display: flex; flex-direction: column; gap: 10px; }
.er-insight-head { display: flex; align-items: center; gap: 8px; }
.er-insight-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 650; color: var(--er-ink);
}
.er-insight-title svg { width: 14px; height: 14px; color: var(--er-violet); }
.er-insight-title .er-card-sub { font-weight: 500; }

/* Secondary panels (failure summary, notes) are bounded so they cannot crowd out
   the main one. Both excluded classes are the panels that must fill the column. */
.er-reader--fill .er-side > .er-cell:not(.er-side-card):not(.er-insights) {
  flex: none;
  max-height: 40%;
  overflow-y: auto;
}
.er-article-card { display: flex; flex-direction: column; gap: var(--er-s-4); }
.er-article-title { margin: 0; font-size: 21px; line-height: 29px; font-weight: 700; letter-spacing: -.012em; }
.er-article-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11px; color: var(--er-ink-3); }
/* Back to the publisher: reads as metadata, not as a call to action. */
.er-source-link {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 7px 1px 5px; border-radius: var(--er-r-xs);
  font-size: 10.5px; font-weight: 550; text-decoration: none;
  color: var(--er-violet);
  background: color-mix(in srgb, var(--er-violet) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--er-violet) 22%, transparent);
  transition: background .13s ease, border-color .13s ease;
}
.er-source-link:hover { background: color-mix(in srgb, var(--er-violet) 16%, transparent); border-color: color-mix(in srgb, var(--er-violet) 34%, transparent); }
.er-source-link svg { width: 11px; height: 11px; }
.er-prose { font-size: 14.5px; line-height: 28px; color: var(--er-ink); }
.er-prose p { margin: 0 0 14px; }
.er-prose p:last-child { margin-bottom: 0; }
.er-sentence { cursor: pointer; border-radius: var(--er-r-xs); padding: 1px 2px; margin: 0 -2px; transition: background .13s ease, box-shadow .13s ease; }
.er-sentence:hover { background: color-mix(in srgb, var(--er-blue) 11%, transparent); }
.er-sentence[data-active="true"] { background: color-mix(in srgb, var(--er-violet) 16%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--er-violet) 20%, transparent); }
.er-word { cursor: pointer; border-radius: 4px; padding: 0 1px; border-bottom: 1.5px dotted color-mix(in srgb, var(--er-violet) 50%, transparent); }
.er-word:hover { background: var(--er-violet-soft); }
.er-word[data-known="true"] { border-bottom-color: color-mix(in srgb, var(--er-mint) 66%, transparent); }

.er-side { display: flex; flex-direction: column; gap: var(--er-s-3); min-width: 0; }
.er-side-card { display: flex; flex-direction: column; gap: var(--er-s-3); }
.er-side-head { display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-2); }

/* The side column scrolls as one region, so the sentence panel's own header and
   sentence must pin to the top of that scroll area; without this the panel title
   and the sentence you are reading scroll away with the analysis below them. */
.er-side {
  /* One source of truth for the sticky stack; the sentence header offsets by
     the panel header's measured height. */
  --er-side-head-h: 33px;
}
/* Both the panel title and the sentence it explains are part of the fixed
   frame: they sit outside .er-side-scroll, so no sticky trickery is needed. */
.er-side-card > .er-side-head {
  flex: none;
  padding-bottom: var(--er-s-2);
  border-bottom: 1px solid var(--er-line);
}
.er-side-card > .er-sentence-head {
  flex: none;
  /* Slight tint so the pinned block reads as a header, not as content. */
  background: var(--er-card);
}
.er-side-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; }
.er-side-title svg { width: 14px; height: 14px; color: var(--er-violet); }
.er-sentence-head { font-size: 13px; line-height: 21px; font-weight: 620; padding-bottom: var(--er-s-2); border-bottom: 1px solid var(--er-line); }

.er-kv { display: flex; flex-direction: column; gap: 3px; }
.er-kv-label { font-size: 9.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--er-ink-3); }
.er-kv-value { font-size: 12px; line-height: 19px; color: var(--er-ink-2); }
.er-token { display: inline-flex; align-items: center; height: 21px; padding: 0 7px; border-radius: var(--er-r-xs); font-size: 11px; background: var(--er-blue-soft); color: var(--er-blue); border: 1px solid color-mix(in srgb, var(--er-blue) 20%, transparent); }
.er-struct { display: flex; flex-direction: column; gap: 6px; }
.er-struct-item { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--er-r-sm); background: color-mix(in srgb, var(--er-violet) 5%, transparent); border: 1px solid var(--er-line); }
.er-struct-type { align-self: flex-start; font-size: 10px; font-weight: 600; color: var(--er-violet); }
.er-struct-text { font-size: 12px; line-height: 19px; color: var(--er-ink); }
.er-en { font-family: var(--ds-font-family-code, inherit); font-size: 11.5px; color: var(--er-ink); }
.er-phonetic { font-family: var(--ds-font-family-code, inherit); font-size: 11px; color: var(--er-ink-3); }

.er-dict-head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.er-dict-word { font-size: 23px; font-weight: 720; letter-spacing: -.022em; }
.er-meaning { display: flex; flex-direction: column; gap: 1px; padding: 7px 0; border-bottom: 1px solid var(--er-line); }
.er-meaning:last-child { border-bottom: none; }
.er-meaning-cn { font-size: 12.5px; font-weight: 550; }
.er-meaning-ctx { font-size: 11px; line-height: 17px; color: var(--er-ink-3); }
.er-example { font-size: 11px; line-height: 17px; color: var(--er-ink-2); padding: 7px 9px; border-radius: var(--er-r-xs); background: var(--er-violet-soft); }

/* --------------------------------------------------------------- progress */
.er-progress { height: 5px; border-radius: var(--er-r-xs); background: color-mix(in srgb, var(--er-ink-3) 14%, transparent); overflow: hidden; }
.er-progress > span { display: block; height: 100%; border-radius: var(--er-r-xs); background: linear-gradient(90deg, var(--er-blue), var(--er-violet)); }
.er-ring { position: relative; width: 88px; height: 88px; display: grid; place-items: center; flex: none; }
.er-ring svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.er-ring-value { font-size: 19px; font-weight: 720; font-variant-numeric: tabular-nums; z-index: 1; }
.er-ring-label { font-size: 10px; color: var(--er-ink-3); z-index: 1; }

/* ----------------------------------------------------------------- study history */
/* A contribution grid: 7 rows (weekdays) x N week columns. Cells are square via
   aspect-ratio so the board stays a grid at any width. */
.er-heat { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.er-heat-rows { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.er-heat-months {
  display: grid; gap: 3px; padding-left: 26px;
  font-size: 9.5px; color: var(--er-ink-3); line-height: 12px;
}
.er-heat-body { display: flex; gap: 6px; min-width: 0; }
.er-heat-weekdays {
  flex: none; display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px;
  font-size: 9px; color: var(--er-ink-3); width: 20px; align-items: center;
}
/* The grid never grows past this height: a year of days is a fixed band, not a
   block that scales with the window width. */
.er-heat-grid { flex: 1; display: grid; gap: 3px; min-width: 0; max-height: 210px; }
.er-heat-week { display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; min-width: 0; }
.er-heat-cell {
  /* Square, sized by its grid track: many columns -> small cells, few columns ->
     larger ones, never taller than the row allows. */
  aspect-ratio: 1;
  width: 100%;
  min-width: 0;
  border-radius: 3px;
  background: color-mix(in srgb, var(--er-ink-3) 12%, transparent);
  border: 1px solid transparent;
  transition: transform .1s ease, border-color .1s ease;
}
.er-heat-cell[data-level="1"] { background: color-mix(in srgb, var(--er-violet) 26%, transparent); }
.er-heat-cell[data-level="2"] { background: color-mix(in srgb, var(--er-violet) 45%, transparent); }
.er-heat-cell[data-level="3"] { background: color-mix(in srgb, var(--er-violet) 66%, transparent); }
.er-heat-cell[data-level="4"] { background: var(--er-violet); }
.er-heat-cell[data-future="true"] { background: transparent; border-color: color-mix(in srgb, var(--er-line) 60%, transparent); }
.er-heat-grid .er-heat-cell:hover { border-color: color-mix(in srgb, var(--er-violet) 70%, transparent); transform: scale(1.18); }
.er-heat-legend { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.er-heat-legend .er-heat-cell { width: 10px; height: 10px; aspect-ratio: auto; }
/* -------------------------------------------------------------- study feed */
.er-feed { display: flex; flex-direction: column; gap: 0; }
.er-feed-headline { margin: 0; font-size: 17px; line-height: 24px; font-weight: 680; letter-spacing: -.01em; }
.er-feed-day { display: flex; flex-direction: column; gap: 6px; padding: 14px 0; }
/* Only the first rule draws a divider: the list reads as one continuous feed. */
.er-feed-day + .er-feed-day { border-top: 1px solid var(--er-line); }
.er-feed-dayhead { display: flex; align-items: center; gap: 8px; }
.er-feed-date { font-size: 12px; font-weight: 650; letter-spacing: .01em; }
.er-feed-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; border-radius: var(--er-r-sm);
  transition: background .12s ease;
}
.er-feed-row:hover { background: color-mix(in srgb, var(--er-violet) 5%, transparent); }
.er-feed-icon {
  flex: none; width: 24px; height: 24px; border-radius: var(--er-r-xs);
  display: grid; place-items: center;
  color: var(--er-violet);
  background: color-mix(in srgb, var(--er-violet) 9%, var(--er-card));
}
.er-feed-icon svg { width: 13px; height: 13px; }
.er-feed-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.er-feed-title { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-feed-meta { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--er-ink-3); flex-wrap: wrap; }
.er-feed-time { flex: none; font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--er-ink-2); }

/* -------------------------------------------------------------- knowledge */
.er-kgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--er-s-3); }
.er-kcard {
  display: flex; flex-direction: column; gap: 6px; padding: var(--er-s-4);
  border-radius: var(--er-r-md); border: 1px solid var(--er-line); background: var(--er-card);
  box-shadow: var(--er-lift-1); cursor: pointer; text-align: left; font-family: inherit; color: inherit;
  transition: box-shadow .13s ease;
}
.er-kcard:hover { box-shadow: var(--er-lift-2); }
.er-kcard-top { display: flex; align-items: baseline; gap: 6px; }
.er-kcard-word { font-size: 15.5px; font-weight: 680; letter-spacing: -.01em; }
.er-kcard-meaning { font-size: 11.5px; line-height: 18px; color: var(--er-ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.er-kcard-foot {
  display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--er-ink-3); margin-top: auto;
}
.er-dots { display: inline-flex; gap: 3px; }
.er-dot { width: 6px; height: 6px; border-radius: 50%; background: color-mix(in srgb, var(--er-ink-3) 22%, transparent); }
.er-dot[data-on="true"] { background: var(--er-mint); }

/* --------------------------------------------------------------- flashcard */
.er-flash {
  display: flex; flex-direction: column; align-items: center; gap: var(--er-s-3);
  padding: var(--er-s-8);
  border-radius: var(--er-r-xl);
  border: 1px solid color-mix(in srgb, var(--er-violet) 20%, var(--er-line));
  background: linear-gradient(158deg, color-mix(in srgb, var(--er-violet) 11%, var(--er-card)) 0%, var(--er-card) 62%);
  box-shadow: var(--er-lift-2);
}
.er-flash-word { font-size: 29px; font-weight: 720; letter-spacing: -.024em; }
.er-flash-answers { display: flex; gap: 7px; flex-wrap: wrap; justify-content: center; }

/* ------------------------------------------------------------ empty/loading */
.er-empty { display: flex; flex-direction: column; align-items: center; gap: var(--er-s-2); padding: 38px var(--er-s-5); text-align: center; }
.er-empty-icon {
  width: 54px; height: 54px; border-radius: var(--er-r-md); display: grid; place-items: center;
  background: linear-gradient(150deg, var(--er-violet-soft), color-mix(in srgb, var(--er-blue) 10%, var(--er-card)));
  border: 1px solid color-mix(in srgb, var(--er-violet) 18%, transparent);
}
.er-empty-icon svg { width: 26px; height: 26px; color: var(--er-violet); }
.er-empty h3 { margin: 0; font-size: 14px; font-weight: 650; }
.er-empty p { margin: 0; font-size: 11.5px; line-height: 18px; color: var(--er-ink-3); max-width: 340px; }
.er-skeleton {
  border-radius: var(--er-r-sm);
  background: linear-gradient(90deg, color-mix(in srgb, var(--er-ink-3) 11%, transparent), color-mix(in srgb, var(--er-ink-3) 3%, transparent), color-mix(in srgb, var(--er-ink-3) 11%, transparent));
  background-size: 200% 100%; animation: er-shimmer 1.5s ease-in-out infinite;
}
@keyframes er-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -20% 0; } }

.er-alert { display: flex; align-items: flex-start; gap: 7px; padding: 9px 11px; border-radius: var(--er-r-sm); font-size: 11.5px; line-height: 18px; }
.er-alert.error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--er-card)); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent); }
.er-alert.ok { color: var(--er-mint); background: var(--er-mint-soft); border: 1px solid color-mix(in srgb, var(--er-mint) 24%, transparent); }
.er-alert.warn { color: var(--er-amber); background: var(--er-amber-soft); border: 1px solid color-mix(in srgb, var(--er-amber) 26%, transparent); }
.er-alert svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }

/* -------------------------------------------------------------------- modal */
.er-scrim { position: fixed; inset: 0; z-index: 900; display: grid; place-items: center; padding: var(--er-s-6); background: var(--dsw-alias-bg-mask-1); backdrop-filter: blur(4px); }
.er-modal {
  width: min(520px, 100%); max-height: 84vh; overflow: auto; display: flex; flex-direction: column; gap: var(--er-s-4);
  padding: var(--er-s-5); border-radius: var(--er-r-xl);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--er-line); box-shadow: var(--er-lift-3);
}
.er-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-2); }
.er-modal-title { font-size: 14px; font-weight: 680; }
.er-modal-foot { display: flex; justify-content: flex-end; gap: var(--er-s-2); }
.er-toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 950; }

/* ----------------------------------------------------------- raw diagnostics */
.er-raw {
  max-height: 210px; overflow: auto; padding: 9px 11px; border-radius: var(--er-r-sm);
  background: var(--dsw-alias-markdown-code-block); border: 1px solid var(--er-line);
  font-family: var(--ds-font-family-code, monospace); font-size: 10.5px; line-height: 16px;
  color: var(--er-ink-2); white-space: pre-wrap; word-break: break-all;
}

/* ---------------------------------------------------------------- settings */
.er-set-row { display: flex; align-items: center; justify-content: space-between; gap: var(--er-s-4); padding: 12px 0; border-bottom: 1px solid var(--er-line); }
.er-set-row:last-child { border-bottom: none; }
.er-set-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
/* A row whose control must span the full width stacks instead of competing for
   space: a 100%-wide control inside a flex row squeezes the label to nothing. */
.er-set-row--stack { flex-direction: column; align-items: stretch; gap: 6px; }
.er-set-row--stack > .er-set-row-text { flex: none; }
.er-set-row-title { font-size: 12.5px; font-weight: 550; }
.er-set-row-desc { font-size: 11px; line-height: 17px; color: var(--er-ink-3); }
.er-mono { font-family: var(--ds-font-family-code, inherit); font-size: 11px; color: var(--er-ink-2); word-break: break-all; }

/* Backup guidance: three paths, each with one line saying what it holds. */
.er-backup-list { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--er-r-sm); border: 1px solid var(--er-line); background: color-mix(in srgb, var(--er-ink-3) 5%, transparent); }
.er-backup-item { display: flex; flex-direction: column; gap: 1px; }
.er-backup-path { font-weight: 550; }

.er-stage-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.er-stage { display: flex; flex-direction: column; gap: 3px; padding: 8px 9px; border-radius: var(--er-r-sm); border: 1px solid var(--er-line); background: var(--er-card); font-size: 10.5px; }
.er-stage-name { font-weight: 650; font-size: 11px; }
/* A one-line subject so two stages showing the same number stay distinguishable. */
.er-stage-hint {
  font-size: 9.5px; line-height: 13px;
  color: var(--er-ink-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.er-stage-status { font-size: 10px; color: var(--er-ink-3); }
.er-stage[data-status="SUCCEEDED"] .er-stage-status { color: var(--er-mint); }
.er-stage[data-status="RUNNING"] .er-stage-status { color: var(--er-blue); }
.er-stage[data-status="FAILED"] .er-stage-status { color: var(--dsw-alias-state-error-primary); }
.er-stage[data-status="NEEDS_REVIEW"] .er-stage-status { color: var(--er-amber); }

.er-recent-row { display: grid; grid-template-columns: minmax(0, 8fr) minmax(0, 4fr); gap: var(--er-s-3); align-items: stretch; }

/* ------------------------------------------------------------- responsive */
@media (max-width: 1180px) {
  .er-board { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .er-span-8 { grid-column: span 6; }
  .er-span-6 { grid-column: span 3; }
  .er-span-4 { grid-column: span 3; }
  .er-span-3 { grid-column: span 2; }
  .er-reader { grid-template-columns: minmax(0, 1fr); }
  .er-recent-row { grid-template-columns: minmax(0, 1fr); }
  .er-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .er-stage-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }

/* A failed stage is clickable, so its whole surface is the hit target. */
.er-stage[data-inspectable="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, var(--er-line)); }
.er-stage[data-inspectable="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, var(--er-card)); }
.er-stage-hit {
  display: flex; flex-direction: column; gap: 3px; width: 100%;
  background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit;
  text-align: left; cursor: pointer;
}
.er-stage-hit--static { cursor: default; }
.er-stage-hit:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: var(--er-r-xs); }
.er-stage[data-inspectable="true"] .er-stage-name { display: flex; align-items: center; gap: 4px; }
.er-stage[data-inspectable="true"] .er-stage-name svg { width: 11px; height: 11px; opacity: .7; }
/* "3 句失败": the stage itself may not fail when only some sentences did. */
.er-stage-failed-count { font-size: 10px; color: var(--dsw-alias-state-error-primary); }

/* Stage detail dialog: codes, the reason, and the failing sentences. */
.er-stage-detail { display: flex; flex-direction: column; gap: 12px; padding: 14px var(--er-s-5) 16px; }
.er-stage-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.er-stage-detail-codes { display: flex; flex-direction: column; gap: 8px; }
.er-stage-detail-code { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.er-stage-detail-meaning { font-size: 11.5px; color: var(--er-ink-2); }
.er-stage-detail-msg {
  font-size: 11.5px; line-height: 17px; color: var(--er-ink-2);
  padding: 8px 10px; border-radius: var(--er-r-sm);
  background: color-mix(in srgb, var(--er-ink-3) 8%, transparent);
  word-break: break-word;
}
.er-stage-detail-list { display: flex; flex-direction: column; gap: 6px; }
.er-stage-detail-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-radius: var(--er-r-sm); border: 1px solid var(--er-line);
  background: var(--er-card);
}
.er-stage-detail-text {
  flex: 1; min-width: 0; font-size: 11.5px; line-height: 17px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.er-stage-detail-raw {
  max-height: 160px; overflow: auto; font-size: 10.5px; line-height: 15px;
  padding: 8px 10px; border-radius: var(--er-r-sm);
  border: 1px solid var(--er-line);
  background: color-mix(in srgb, var(--er-ink-3) 6%, transparent);
  white-space: pre-wrap; word-break: break-word; color: var(--er-ink-2);
}
  .er-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .er-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .er-span-12, .er-span-8, .er-span-6, .er-span-4, .er-span-3 { grid-column: span 2; }
  .er-rail { width: 60px; padding: var(--er-s-3) var(--er-s-2); }
  .er-brand-name, .er-brand-sub, .er-nav-group, .er-nav-label { display: none; }
  .er-nav-item { justify-content: center; padding: 8px 0; }
  .er-scroll { padding: var(--er-s-4) var(--er-s-4) var(--er-gutter-bottom); }
}
@media (prefers-reduced-motion: reduce) {
  .er-root *, .er-root *::before, .er-root *::after { transition: none !important; animation: none !important; }
}
`;

export { CSS };
