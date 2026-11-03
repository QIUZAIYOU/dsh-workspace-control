# DSH plugin UI guidelines

Notes taken from the shipped surfaces (the plugin market page and the settings
page) so that every plugin I write sits on the same page rhythm instead of
inventing its own. Everything below was read out of the real CSS, not guessed.

## 1. The page frame

A plugin that owns a whole page area (a `main` panel, a tab, a marketplace page)
must not paint its content against the window edge. The market plugin wraps its
page in a frame and gives the *content* a gutter, exactly like this:

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

.page-host .head,
.page-host .body {
  container-type: inline-size;
  padding-left: max(max(16px, min(4vw, 48px)), 50% - 480px);
  padding-right: max(max(16px, min(4vw, 48px)), 50% - 480px);
}
```

Reading the `max(max(...))` from the inside out:

| piece | meaning |
| --- | --- |
| `max(16px, min(4vw, 48px))` | fluid gutter: 16px on narrow frames, growing with the viewport, capped at 48px |
| `50% - 480px` | on frames wider than 960px this wins, so the text column stops growing at 960px and stays centred |
| `calc(28px + var(--dsh-frame-top-clearance, 0px))` | top breathing room under the harness's own frame; the variable accounts for window-drag/rounded corners |

Consequences worth remembering:

- Never hard-code `padding: 20px` on a page root. Use the frame rule above; the
  content then stays legible from a 480px panel to a 4K window.
- Keep the scroll container (`height: 100%; min-height: 0; overflow: auto`) on the
  *page*, and the gutter on the *content* wrapper — otherwise the scrollbar sits
  inside the padding and the gutter jumps when it appears.
- `container-type: inline-size` on the gutter element lets the cards react to the
  column width rather than the window width.

## 2. Cards

The settings page and the market page share one card recipe:

```css
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  gap: 12px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, #00000029));
  border-radius: var(--dsw-radius-xl, 20px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, #fff));
  transition: background-image 160ms cubic-bezier(0.16, 1, 0.3, 1);
}

@media (hover: hover) {
  .card:hover { background-image: var(--dsw-alias-interactive-bg-hover); }
}
```

- `minmax(268px, 1fr)` is the shipped minimum; below ~600px of column width the
  grid falls back to a single column on its own.
- `border-radius: var(--dsw-radius-xl)` (20px) is the card radius; nested blocks
  inside a card use `--dsw-radius-lg`/`-md`.
- One hairline border (`0.5px`), no drop shadow for cards. Shadows belong to
  dialogs only.
- `align-self: start` inside the grid when cards should keep their own height
  instead of stretching to the tallest sibling.

## 3. Typography and hierarchy

| role | rule |
| --- | --- |
| page title | `15px / 600 / line-height 22px`, `--dsw-alias-label-primary` |
| page subtitle | `12px / 18px`, `--dsw-alias-label-tertiary`, `margin: 0` |
| group heading | `12px / 600 / letter-spacing 0.06em / uppercase`, `--dsw-alias-label-tertiary` |
| body text | `13px / line-height 1.55`, `--dsw-alias-label-primary` |
| meta, hints | `12px / 18px`, `--dsw-alias-label-secondary` or `-tertiary` |
| identifiers, paths | `var(--dsw-font-family-code)`, `11-12px` |

Head block of a page: `display: flex; flex-direction: column; gap: 8px;
padding: 0 4px 4px`. The `4px` inset lets the title align optically with the
cards below it, which carry their own `14px` inner padding.

## 4. Tokens (always prefer these over literals)

```css
/* surfaces */
--dsw-alias-bg-layer-1, --dsw-alias-bg-l2, --dsw-alias-bg-skeleton
--dsw-alias-settings-card-fill, --dsw-alias-settings-card-stroke
--dsw-alias-interactive-bg-hover, --dsw-alias-interactive-bg-hover-danger
/* text */
--dsw-alias-label-primary, -secondary, -tertiary, -error, -primary-bluish
--dsw-alias-label-primary-inverted
/* lines and states */
--dsw-alias-border-l1 … -l4, --dsw-alias-separator-primary
--dsw-alias-state-warn-primary, --dsw-alias-state-error-primary
--dsw-alias-state-success-primary, --dsw-alias-state-business-primary
/* shape and motion */
--dsw-radius-xl / -lg / -md / -sm / -xs
--dsw-focus-ring-color, --dsw-font-family-code
```

Every one of them needs a literal fallback (`var(--dsw-alias-label-primary,
#1f2328)`) because plugins also render in hosts that only ship the light theme.

Never build a colour by hand (`#5865f2`, `rgba(88,101,242,.2)`). If a state has
no token, compose it from a token with `color-mix()` or use the nearest semantic
token — the panel of this plugin had four hard-coded colours and they were the
first thing to look wrong in dark mode.

## 5. Dialogs and confirmation modals

A dialog is a task, not a page: its content must not replace the list behind it.

```css
.modal {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(1.5px);
}

.modalCard {
  width: 100%; max-width: 560px; max-height: 86vh; overflow: auto;
  border-radius: calc(var(--dsw-radius-xl, 14px) + 2px);
  background: var(--dsw-alias-bg-l1, #1c1c1f);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
}
```

Rules that are not optional:

- `padding: 24px` on the scrim, so a tall dialog never touches the window edge.
- `max-width` in the 520–640px band; `max-height: 86vh` plus `overflow: auto`.
- Escape closes, a click on the scrim closes, a click inside does not bubble out.
- `role="dialog"`, `aria-modal="true"`, and `aria-labelledby`/`aria-label`.
- Move focus into the dialog on open, trap Tab inside it, restore focus to the
  trigger on close. The cursor must be in the first field when the dialog is a
  form.
- The dialog is rendered outside the page's gutter wrapper: it is positioned
  against the viewport, not the column.

## 6. Empty, loading, degraded

- Skeleton: three cards worth of `--dsw-alias-bg-skeleton` bars with a 1.4s
  opacity pulse; wrap the keyframes in `@media (prefers-reduced-motion: reduce)`
  to disable them.
- Empty: centred block, `max-width: 520px; margin: 0 auto; padding: 56px 32px
  40px; font-size: 13px; line-height: 20px`, `--dsw-alias-label-secondary`.
- Degraded (a capability is missing): a persistent note under the head, `12px`,
  `--dsw-alias-state-warn-primary` on a 8% tint, never a modal — it is a state,
  not an event.

## 7. Density and rhythm

- Page gap between blocks: `14px`; inside a card: `10px`; inside a tight row: `6px`.
- Buttons: `padding: 9px 14px`, `border-radius: var(--dsw-radius-md)`, `12px`.
  Secondary buttons are `--dsw-alias-interactive-bg-hover` on transparent;
  destructive ones use `--dsw-alias-state-error-primary` and never the primary
  button fill.
- Hover transitions: `160ms cubic-bezier(0.16, 1, 0.3, 1)`; no bouncy easing.
- Focus: always a visible ring — `outline: 2px solid var(--dsw-focus-ring-color);
  outline-offset: 2px` on `:focus-visible`.

## 8. Checklist before shipping a page

1. Content sits inside the `max(max(16px, min(4vw, 48px)), 50% - 480px)` gutter.
2. Nothing is wider than 960px of text column.
3. Every colour, radius and font comes from a `--dsw-*` token with a fallback.
4. Cards use the hairline border + `--dsw-radius-xl`; no shadows except dialogs.
5. Tasks open as dialogs over the list, with scrim, Escape and focus handling.
6. Empty, loading and degraded states exist and are not alert boxes.
7. `prefers-reduced-motion` disables every animation.
8. Text comes from the plugin's locale dictionary, and both `en` and `zh` have
   the same key set.
