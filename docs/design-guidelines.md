# DSH plugin UI guidelines

Design rules for any page, panel, card or dialog a DeepSeek Harness plugin
renders, adapted from **unslop** by Damir Sokolovsky
([@heydamir](https://x.com/heydamir), <https://github.com/heydamir/unslop>,
CC BY 4.0). The pass order, the audit signs and the checklist below follow
unslop; the values are rewritten for DSH's token system and its dark/light
themes. Keep the credit in any copy or adaptation, as the license asks.

Two DSH-specific additions that unslop does not cover (because it targets
standalone pages, not a host shell): the page frame in §2 and the theme
contract in §3. Everything else is unslop's nine passes.

---

## 1. Direction

Written once per plugin, before touching CSS. Derived from the product, never
from what is trending. For this plugin (`dsh-workspace-control`):

- **Product.** A sidebar panel for moving, rebuilding, merging, renaming and
  deleting DSH workspaces, for people who keep many projects open at once.
- **Character.** exact, quiet, a little mechanical.
- **World.** a machine room: labelled drawers, status lamps, index cards.
  Neutral graphite surfaces, one signal colour.
- **Moments.** the per-workspace card grid (the thing people scan) and the
  occupy/blocked state on a card — two places only.
- **Signature.** the status dot on each card: green idle, amber running, red
  missing, the same 6px dot everywhere, never a coloured pill.

Rules that come out of the direction: surfaces stay neutral; colour appears on
the dots, the one primary action and destructive confirmation only; the card
grid is the only dense area on the page.

## 2. Page frame (DSH)

Plugin pages never paint against the window edge. Read out of the shipped
market page, which is the reference for page rhythm:

```css
.pageHost {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) 0 0;
}

.pageHost > .root { flex: 1; width: 100%; min-width: 0; min-height: 0; }

.pageHost .head,
.pageHost .body {
  container-type: inline-size;
  padding-left: max(max(16px, min(4vw, 48px)), 50% - 480px);
  padding-right: max(max(16px, min(4vw, 48px)), 50% - 480px);
}
```

- `max(16px, min(4vw, 48px))` — fluid gutter, 16px on narrow frames, capped at 48px.
- `50% - 480px` — above 960px the column stops growing and stays centred.
- `calc(28px + var(--dsh-frame-top-clearance, 0px))` — top room under the
  harness frame; the variable covers rounded corners and the drag area.
- Scroll container on the page, gutter on the content wrapper, or the gutter
  jumps when the scrollbar appears.
- A dialog is positioned against the viewport, so it is rendered outside the
  gutter wrapper.

## 3. Theme contract (dark and light)

DSH switches theme by swapping the `--dsw-*` custom properties on the document
root. Consequences for plugin CSS:

1. **Style with tokens, never with a theme literal.** A rule written once must
   read correctly in both themes; `#1c1c1f`, `rgba(8,8,10,.45)` and
   `color:#fff` are dark-theme-only answers and are therefore bugs.
2. **Fallbacks must be theme-neutral.** Use `var(--dsw-alias-border-l2,
   rgba(127,127,127,.20))`, not `rgba(255,255,255,.16)` — the latter disappears
   on a light surface. Neutrals in the 127 grey band read acceptably in both.
3. **Do not branch on `prefers-color-scheme`.** It describes the OS, not the
   app theme, and the two disagree whenever the user picks the other theme.
4. **Depth.** Dark: surface steps and hairlines only, no shadows (an overlay
   dialog may keep one soft neutral shadow). Light: small, neutral, soft
   shadows allowed. Nothing gets a coloured shadow in either theme.
5. **Contrast.** Text on an accent needs 4.5:1. On dark themes the primary
   action may be an off-white from the ramp with dark text, with the accent
   reserved for selection and one figure — that reads more deliberate than a
   saturated button.

Token roles, all theme-aware:

| role | token |
| --- | --- |
| page surface, raised surface, skeleton | `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-l2`, `--dsw-alias-bg-skeleton` |
| card fill and stroke | `--dsw-alias-settings-card-fill`, `--dsw-alias-settings-card-stroke` |
| hover / destructive hover | `--dsw-alias-interactive-bg-hover`, `--dsw-alias-interactive-bg-hover-danger` |
| text: primary, secondary, muted, error | `--dsw-alias-label-primary`, `-secondary`, `-tertiary`, `--dsw-alias-label-error` |
| hairlines, separators | `--dsw-alias-border-l1` … `-l4`, `--dsw-alias-separator-primary` |
| semantic state | `--dsw-alias-state-success-primary`, `-warn-primary`, `-error-primary` |
| primary action | `--dsw-alias-button-primary-fill`, `-hover`, `--dsw-alias-label-primary-inverted` |
| shape, focus, mono | `--dsw-radius-xl/-lg/-md/-sm/-xs`, `--dsw-focus-ring-color`, `--dsw-font-family-code` |

Three text roles only. One accent, used rarely: the primary action, the current
selection, the one number that matters.

## 4. The nine passes

Unslop order, one pass across the whole screen before the next. Spacing first
because everything reads differently once the rhythm is right; copy before type
and layout because the length of a label decides its size and position;
visuals and motion last so they fit a screen that already works.

### 4.1 Spacing

- 4px grid for margins, paddings, gaps, fixed heights. A 2px step is fine
  inside small controls; an odd value that exactly centres something stays.
- Same thing, same size: one row height, one gap, one card padding.
- Space shows grouping: inside a group < between groups. A section label sits
  closer to its own items than to the section above (24 above, 8 below).
- Things line up: icons in one column, labels on one line, numbers right-aligned
  in one column. No stray `translate` or one-off margin.
- Density: compact panel and sidebar ~16, cards 20–24, page edge 24–32.
- Kill one-off values (`padding: 14px` in a 4px system, `gap: 9px`).

### 4.2 Color

- One neutral ramp, tinted toward the world. In app chrome the surfaces stay
  neutral grey; a screen whose background reads orange, blue or green has gone
  too far. The world shows in the accent, the status dots and the one moment.
- No hue gradients on surfaces, no gradient text, no glows, no coloured
  shadows, no radial washes, no neon borders.
- Borders are the text colour at 6–10% opacity, i.e.
  `--dsw-alias-border-l1/l2`, half-pixel.
- A gradient is allowed only as a small tone shift inside one neutral.
- Semantic colour only carries meaning (green good, amber busy, red error) and
  is toned down to sit inside the palette — use the `state-*` tokens, never a
  hand-picked `#4bbf83`.

### 4.3 Icons

- No emoji as icons or in labels. One icon set, one size (16 or 18), one stroke
  (1.5). DSH ships its primitives; otherwise inline a 16px line glyph.
- Icons take their text role's colour. They never get their own colour, and the
  icon box is the same width in every row with a fixed 8–10px gap to the label.
- Categories that need colour get a status dot, not a coloured icon.

### 4.4 Copy

- Headlines and labels say what the thing does, in plain words, specific enough
  that they could not fit another product.
- No exclamation marks, ever. No greeting headlines. Title names the context.
- Short labels: `Search`, not `Search anything…`.
- A change says what it compares to: `+12% vs last month`, `3 fewer`.
- Short strings end without a period; only multi-sentence paragraphs keep them.
- No hype words (supercharge, seamless, unlock, magic, revolutionise) and no
  `AI-powered` everywhere. No unverifiable claims.
- Mock data looks real and plausible; never `[X]` or `123,456`.
- Badges like `PRO`, `New ✨` go away unless the product needs them, and then
  they are quiet text.
- Failure copy states what happened, what state the data is in, and the one next
  action. No apology padding, no "Oops".

### 4.5 Type

- One family for the interface plus at most one partner — the code face
  (`--dsw-font-family-code`) for paths, ids and figures.
- A few sizes from a scale; weights 400 and 500, 600 at most for rare emphasis.
  No 700–900 headings, no gradient text.
- Hierarchy comes from size and colour, not from weight.
- **Sentence case everywhere.** Unslop forbids uppercase tracked micro-labels
  (`NAVIGATION`, `PAID THIS MONTH`). This is a deliberate deviation from DSH's
  own settings page, which ships them; the panel uses sentence case with the
  tertiary role instead, so a section label is `_Workspaces_` in text colour,
  not `WORKSPACES` in small caps.
- Small text never gets negative tracking. Tight tracking is display-only.
- Numbers use `tabular-nums` and one format across the screen.
- No italics for emphasis.

### 4.6 Layout

- Keep the sections and their order; inside a section, alignment and proportions
  may change when that makes the screen clearer.
- Real app proportions: the panel fills its column, content capped by §2's
  960px text column, page as long as its content. Never a narrow centred column
  inside a wide frame.
- One primary action, at most one secondary next to it; anything else moves out.
- Small screens: everything stacks in reading order, dense areas simplify
  (fewer columns) instead of shrinking; no text below 11px.
- Vary the rhythm: cards of equal width with the same content read as a
  template. Give the grid a shape — a summary row plus the grid, or a wide
  detail panel beside a narrow list.

### 4.7 Details

- Nested radius: inner = outer − padding between them, never below 4. Controls
  8–10, cards 12–16, panels 14–20. Not everything is a pill.
- Counts and meta are quiet muted mono text, not glowing pills.
- Charts sit on a muted grid with muted mono labels; one accent per chart; one
  main chart, everything else smaller and different in kind.
- Stat cards are numbers: label, big figure, change with its comparison. No
  sparklines or mini bars to fill them.
- Active state is a small surface step plus a hairline highlight, not a gradient
  with a glow.
- Hover and focus exist and stay inside the palette; keyboard focus always gets
  a visible ring (`2px var(--dsw-focus-ring-color)`, offset 2).
- The signature detail appears where it belongs and nowhere else.

### 4.8 Visuals

- Decorative filler goes: glossy blobs, orbs, floating cubes, glowing grids.
- Dashboards and app screens almost never need generated images; their moments
  come from the product itself — a card grid that scans well, a status dot that
  reads instantly, real paths and titles.
- Generate images only for empty states, onboarding or marketing, or when the
  user asks.

### 4.9 Motion

- Remove looping motion that means nothing: pulsing placeholders on non-live
  things, shimmer on headings, breathing glows, floating elements, parallax.
  A loading skeleton is a static surface step; if it must move, one slow opacity
  blend, disabled under `prefers-reduced-motion`.
- Remove `transition: all`, bouncy springs, card `hover:scale`, anything moving
  more than a few pixels on hover.
- Keep motion that explains: a hover is a quick colour change, a press a 1–2%
  scale down, a dialog fades and rises a few pixels from where it opens, a
  changed number tweens.
- Animate only `color`, `background-color`, `border-color`, `opacity`,
  `transform`, and name them. Never width, height, top/left, margins or large
  blurs.
- One easing curve (`cubic-bezier(.16,1,.3,1)`) and two durations (120ms
  feedback, 180ms entering) across the screen.
- At most one entrance on load: a short fade and rise for the main content.

## 5. Dialog pattern

Tasks open as dialogs over the list; the list behind is never replaced.

```css
.modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}

.modalCard {
  width: 100%;
  max-width: 560px;
  max-height: 86vh;
  overflow: auto;
  border-radius: calc(var(--dsw-radius-xl, 14px) + 2px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  /* the one allowed shadow, and only over the scrim */
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
}
```

Non-negotiables: Escape closes, scrim click closes, an inside click does not
bubble out, `role="dialog" aria-modal="true"` with `aria-labelledby`, focus moves
in on open, Tab is trapped, focus returns to the trigger on close, and the cursor
lands in the first field when the dialog is a form.

## 6. Empty, loading, degraded

- Loading: static skeleton cards on `--dsw-alias-bg-skeleton`, no pulse loop.
- Empty: centred block, `max-width: 520px`, `padding: 56px 32px 40px`, 13px
  secondary text, one quiet action.
- Degraded (a capability is missing): a persistent warn-tinted note under the
  head, 12px, never a modal — it is a state, not an event.

## 7. Slop signs to audit for in a DSH plugin

| sign | what it looks like here |
| --- | --- |
| purple-blue gradient, glow | header or button with a hue gradient, coloured `box-shadow`, neon border |
| gradient text | `background-clip:text` on a title |
| emoji labels | `⧉ Workspaces…`, `✨ New`, `🚀` in a button |
| uppercase tracked micro-labels | `WORKSPACES`, `PAID THIS MONTH` |
| hard-coded theme literals | `#1c1c1f`, `color:#fff`, `rgba(255,255,255,.16)` |
| off-grid spacing | `padding: 14px`, `gap: 9px`, `mt-[13px]` |
| looping motion | `animation: pulse` on a skeleton, breathing glow |
| transition-all | `transition: all .2s` |
| template content | `Workspace 1`, `[X]`, `123,456`, placeholder names |
| double action stacking | primary + secondary + a text link + an icon button in one row |
| coloured pills for counts | `3 running` inside a filled amber pill |

## 8. Checklist before shipping a page

Adapted from unslop's checklist, with the DSH items appended.

1. Direction written (five lines) and every pass follows it.
2. Every spacing value on the 4px grid; equal things have equal sizes.
3. Icons, labels and numbers each sit in one aligned column.
4. One neutral ramp, three text roles, one accent with 4.5:1 contrast.
5. No hue gradients, gradient text, glows, coloured shadows or colour blobs.
6. No emoji left in the interface; one icon set, one size, one stroke.
7. Type chosen for the character, weights 400–600, sentence case, no italic,
   no negative tracking on small text.
8. No exclamation marks, no trailing periods on short strings, no greeting
   headlines, no unverified claims; numbers in one format with tabular figures.
9. Nested radii add up; not everything is a pill.
10. First screen composed as a whole, no dead empty band.
11. No looping or bouncy motion; one easing curve; no animated layout properties.
12. Template check: swap the product name for another product's — does the
    screen still fit? If yes, push the direction harder.
13. **DSH:** content inside the §2 gutter, text column ≤960px.
14. **DSH:** every colour from a `--dsw-*` token with a theme-neutral fallback;
    the style reads correctly in both themes and in neither is text invisible.
15. **DSH:** tasks are dialogs over the preserved list, with Escape and focus
    handling; states are notes, not alerts.
16. **DSH:** text from the plugin's locale dictionary, `en` and `zh` key sets
    equal.

## 9. Worked example: this panel

The panel in `client.js` is the reference implementation; read it beside these
rules. Three decisions worth copying:

**The card is three lines, not a pill row.** Dot + name (14px, 500), one meta
line (count · state, 12px, tertiary, tabular), the path (mono, 11px, ellipsis).
State is a word coloured by its semantic token — `1 运行中` in warn, `1 已打开 ·
空闲` in secondary, `目录不存在` in error — never a filled pill. A pill turns
status into decoration and there is nothing left to read when three of them sit
in a row.

**Occupancy is explained once, under the head.** The card says how many and in
what state; the reason and the consequence ("held until DSH exits") appear as a
single note above the grid when any workspace is affected. Repeating that
sentence on every card is the same information priced three times.

**Disabled means explained.** A blocked card's actions are disabled *and* the
note above the grid already said why, so the button never produces a surprise
refusal after the click. If a fact cannot be shown before acting, it belongs in
the dialog that precedes the action, not in a toast after it.

**Numbers stay numbers.** The head reads `4 个工作区 · 11 个会话`; there are no
stat tiles, no sparklines, and no dashboard chrome for a list this small.
