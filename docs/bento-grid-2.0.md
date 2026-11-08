# Bento Grid 2.0 — Design Specification

> Scope: the collection of rules the English Reader UI follows.
> Provenance is marked per rule: **[measured]** values read out of shipping
> implementations, **[derived]** rules inferred from how those implementations
> compose, and **[constraint]** rules imposed by the Harness host (theme tokens,
> localisation, accessibility). Nothing here is presented as a published
> standard; it is a working specification derived from practice.

## 1. What "bento" means

A bento layout is a **fixed set of cells of unequal size**, arranged so the
whole reads as one composed board rather than a list of rows. The visual
metaphor is a Japanese bento box: each compartment holds exactly one thing,
sizes differ to express priority, and the seams between compartments are
uniform.

Rules that make it bento rather than "a card grid":

| # | Rule | Why |
|---|---|---|
| B1 | Cells differ in **span**, never in padding | Unequal size is the hierarchy signal |
| B2 | The gaps are **equal everywhere** | Equal seams make separate cells read as one board |
| B3 | A cell holds **one subject** | Two subjects in a cell collapse back to a list |
| B4 | Cell size follows **content value**, not a repeating pattern | A uniform 3×N grid is a gallery, not a bento |
| B5 | The board has a **clear edge** | Cells align to one outer rectangle |

## 2. Grid

**[measured]** Framer's bento sections use `grid-template-columns:
repeat(3, minmax(50px, 1fr))` and `repeat(4, minmax(55px, 1fr))`, with
`gap: 40px 20px` (row 40, column 20) at desktop and `gap: 40px 0` at a
breakpoint. **[derived]** the horizontal gap stays smaller than the vertical gap
because cells are wider than tall.

The Reader uses a **12-column base** with item-level spans:

```
grid-template-columns: repeat(12, minmax(0, 1fr));
column-gap: 12px;        /* measured range 10–20px */
row-gap: 12px;
```

Spans in use:

| Span | Cell | Content class |
|---|---|---|
| `span 12` | full board | a reader, a table, a form |
| `span 8` | wide | primary content, article body |
| `span 6` | half | two-up comparisons |
| `span 4` | third | metric tiles, side panels |
| `span 3` | quarter | small counters |

**[derived]** the smallest cell must stay ≥ 220px wide, because below that a
"cell" loses its one-subject property and becomes a row. At < 1180px the
12-column base collapses to 6, and at < 900px to 2; spans map down
(`12→6/2`, `8→6/2`, `6→6/1`, `4→3/1`, `3→2/1`).

## 3. Radius

**[measured]** shipping values cluster at **8px** (small controls),
**15–18px** (cards), and **25px** (feature panels); Framer uses 15/18/25
heavily. Apple's store tiles use 10/12/15/18px with `0 0 18px 18px` for
half-round sheets.

**[derived]** Bento Grid *2.0* is the rounder generation: the same hierarchy
with a larger radius step.

| Token | Value | Use |
|---|---|---|
| `--er-r-xs` | 8px | chips, inputs, small buttons |
| `--er-r-sm` | 12px | inner rows, thumbnails |
| `--er-r-md` | 18px | standard cell |
| `--er-r-lg` | 24px | feature cell / panel |
| `--er-r-xl` | 28px | board container, modal |
| `--er-r-pill` | 999px | pills, avatars |

Rule: **radius grows with cell area** — a 1×1 cell is `md`, a 2×2 cell is `lg`.

## 4. Surface and elevation

**[measured]** Supabase's tile CSS keeps radius small (6–8px, one 20/24px
panel) and relies on a hairline border; Framer's feature card pairs
`border-radius:25px` with a near-invisible border and a large soft shadow.
Apple uses a 0.5px hairline plus a very wide, very low-opacity shadow.

**[derived]** the "2.0" surface is **border-first, shadow-second**:

```css
/* standard cell */
border: 1px solid color-mix(in srgb, var(--er-line) 78%, transparent);
box-shadow: 0 1px 1px rgba(24, 22, 60, .04),
            0 18px 36px -28px rgba(24, 22, 60, .28);
/* feature cell */
box-shadow: 0 2px 3px rgba(24, 22, 60, .05),
            0 32px 60px -34px rgba(24, 22, 60, .34);
```

Two layers only: a 1px contact shadow and one wide ambient shadow. Multi-layer
"glow" stacks (5+ shadows) are the 1.0 signature and are excluded.

**Material note:** feature cells may carry a very low-saturation gradient
(`linear-gradient(160deg, tint 0%, card 62%)`) where the tint is derived from
the cell's semantic colour at ≤ 12% mix. Flatter cells stay flat — gradient is
for the one or two cells that need emphasis, not the whole board.

## 5. Spacing rhythm

**[measured]** Framer gaps: 10 / 20 / 40px; internal padding commonly 15–25px.
Apple's spacing scale is a 17px-derived rem ladder, i.e. a ratio scale rather
than a pixel ladder.

**Reader scale (4px base, 8px rhythm):**

| Token | Value | Use |
|---|---|---|
| `--er-s-1` | 4px | icon↔label |
| `--er-s-2` | 8px | chip↔chip |
| `--er-s-3` | 12px | **grid gap** |
| `--er-s-4` | 16px | cell padding (compact) |
| `--er-s-5` | 20px | cell padding (standard) |
| `--er-s-6` | 24px | cell padding (feature) |
| `--er-s-8` | 32px | board padding |

Rule: **gaps are never larger than the smallest cell's padding**, otherwise
cells stop reading as separate compartments and the board looks cracked.

## 6. Typography inside cells

- One **eyebrow** (10–11px, uppercase, letter-spaced) naming the cell's subject.
- One **primary figure or title** (20–32px depending on span).
- Supporting text at 11–13px, never more than two lines in a 1×1 cell.
- Numbers are tabular and right-aligned when they form a column.

**[derived]** a 1×1 cell gets at most 3 typographic levels; a 2×2 cell may use 4. More levels in a small cell is the most common way a bento layout degrades into a dashboard.

## 7. Interaction

- Cell hover: border tint + shadow step up **one** level. No scale transforms
  > 1px, no colour floods.
- Focus: visible ring using the host focus token, offset −2px inside the cell.
- A cell is one click target; nested actions are icon-only and must stop
  propagation.
- Motion: 120–160ms ease-out, and `prefers-reduced-motion` disables it.

## 8. Accessibility and host constraints

**[constraint]** this UI renders inside Harness, so:

| Constraint | Consequence |
|---|---|
| Theme tokens are the only shared styling dependency | every colour resolves to `--dsw-alias-*` or a `color-mix` of them |
| Light and dark both exist | the bento surface defines both palettes explicitly |
| Text goes through the locale service | no literal user-facing strings in components |
| Cells are slots, not absolute geometry | the board is CSS grid; no JS measurement, no ResizeObserver |

Contrast: cell background vs page background stays ≥ 1.2:1 for separation
(perceivable seam), and text stays ≥ 4.5:1. A bento board with invisible seams
fails the metaphor.

## 9. What "2.0" changes relative to 1.0

| Aspect | 1.0 | 2.0 (this spec) |
|---|---|---|
| Radius | 8–12px uniform | 18/24/28px, scaled by area |
| Elevation | long multi-layer glow | 2 layers: 1px contact + 1 wide ambient |
| Surface | flat white card | hairline + optional ≤12% tint gradient |
| Composition | uniform repeated grid | asymmetric spans with one feature cell |
| Density | tight, dashboard-like | one subject per cell, generous inner padding |
| Motion | decorative | only state transitions |

## 10. Verification criteria

A layout is conformant when all hold:

1. Every cell's span comes from the table in §2 — no ad-hoc widths.
2. `gap` is a single value across the board.
3. Radius matches `--er-r-*` and grows with span.
4. At most two shadow layers per cell.
5. Each cell has one subject and ≤ 4 type levels.
6. Seams are visible in light **and** dark.
7. At 900px the board reflows without horizontal scrolling.

`tests/bento.mjs` asserts 1–3 and 5–7 against the built bundle; 4 is asserted by
counting shadow layers in the emitted CSS.
