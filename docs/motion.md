# Motion — app shell

> The motion standard for this codebase. Cite it in review. It governs **in-app**
> interaction; the marketing page follows `design.md` § Motion stance instead, and where
> the two disagree this file wins inside the app.
>
> Distilled from Emil Kowalski's `emil-design-eng` / `review-animations` skills
> (<https://github.com/emilkowalski/skills>, MIT).

## Precedence

`emil` owns app motion; `hallmark` owns the token system and the marketing page. The one
live conflict is exit easing — hallmark specifies `ease-in` on exits, this file forbids it.
**Inside the app, `ease-out` in both directions.**

## Should it animate? (decide before writing any transition)

| Frequency of the action | Decision |
|---|---|
| 100+ times/day (⌘K palette, keyboard shortcuts) | **No animation. Ever.** |
| Tens of times/day (hover, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, celebration) | Delight is allowed |

**Never animate a keyboard-initiated action.** Valid purposes for motion: spatial
consistency, state indication, explanation, feedback, preventing a jarring change.
"It looks cool" on a frequently-seen element is not a valid purpose.

## Curves

```css
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);      /* entering AND exiting */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);     /* moving/morphing on screen */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);      /* iOS-like drawer */
```

- Entering or exiting → `ease-out`
- Moving / morphing on screen → `ease-in-out`
- Hover / colour change → `ease`
- Constant motion (marquee, progress) → `linear`
- **Never `ease-in` on UI.** It delays the exact moment the user is watching.
- Never ship the browser defaults (`ease`, `ease-in-out`, `cubic-bezier(0.25,0.1,0.25,1)`) —
  they read as uncrafted.

## Durations

| Element | Duration |
|---|---|
| Button press feedback | 100–160 ms |
| Tooltip, small popover | 125–200 ms |
| Dropdown, select | 150–250 ms |
| Modal, drawer | 200–500 ms |

**Hard rule: in-app animations stay under 300 ms**, modals and drawers excepted.

## Physicality

- **Never `scale(0)`.** Enter from `scale(0.9–0.97)` + `opacity: 0`.
- **Origin-aware popovers**: `transform-origin: var(--transform-origin)` so they scale from
  the trigger. Modals are exempt — they keep `transform-origin: center`.
- **Press feedback**: `transform: scale(0.97)` on `:active`, `160ms ease-out`. Any pressable
  element. Keep it in the 0.95–0.98 range.

## Performance

- **Animate only `transform` and `opacity`.** Never `width`, `height`, `top`, `left`,
  `margin`, `padding` — they trigger layout, paint, and composite.
- Accordions animate `grid-template-rows: 0fr → 1fr`, never `height`.
- Don't drive child transforms from a CSS variable on the parent — it restyles every child.
  Set `transform` directly on the element.
- Framer Motion's `x`/`y`/`scale` shorthands are **not** hardware-accelerated. Use the full
  string: `animate={{ transform: "translateX(100px)" }}`.
- CSS animations beat JS under load. Use CSS for predetermined motion, JS only for dynamic
  or interruptible motion. WAAPI when you need JS control at CSS performance.
- `will-change` only on the animating element, only while it animates.

## Interruptibility

CSS **transitions** retarget mid-flight; **keyframes** restart from zero. Anything triggered
rapidly (toasts, toggles, the artifact list re-sorting) uses transitions. Prefer
`@starting-style` for entry without a mount flag.

## Stagger

30–80 ms between items, decorative only, never blocking interaction. The artifact list
staggers on first paint only — never on filter, sort, or pagination.

## Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  /* keep opacity and colour, drop every transform-based motion */
}
@media (hover: hover) and (pointer: fine) {
  /* gate all hover motion — touch fires false hovers on tap */
}
```

Reduced motion means fewer and gentler, not zero. Functional motion — progress bars,
streaming indicators, skeletons — keeps running.

## This project's surfaces

| Surface | Motion |
|---|---|
| ⌘K palette | **None.** Frequency rule. |
| Artifact list / grid | Stagger on first paint only (50 ms). No hover lift, no per-card entrance on re-sort. |
| Share + permissions dialog | base-ui dialog: `scale(0.96) → 1` + opacity, 220 ms `ease-out`, backdrop same duration. Origin center. |
| Privacy level switch | Colour + `clip-path` crossfade, 180 ms. No layout shift — the three options are equal width. |
| Revoke confirmation | No animation on the destructive button. Instant response reads as trustworthy. |
| Artifact iframe load | Skeleton with a functional shimmer until `load` fires, then 150 ms opacity crossfade. Never animate the iframe's size. |
| Live generation stream | Text appends with no per-token animation. One functional indicator (pulsing dot or progress) and a per-file checkmark on `file_end`. Auto-scroll is instant, never smooth — smooth scroll fights a fast stream. |
| Toasts | Sonner defaults. Do not retune them. |
| Admin / audit tables | No row animation. Dense data with moving rows is unreadable. |
| Copy-link button | 160 ms `scale(0.97)` press + an icon swap to a check. This is the one place delight is earned — it's the product's core action. |
