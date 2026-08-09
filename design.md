# Design — enclave

Locked design system. Future Hallmark runs read this file first; pages defer
to it. Amend intentionally — the file is the rule.

In-app motion and interaction are **not** governed here — see
`docs/motion.md`. This file owns colour, type, space, depth, and the
marketing page's structure.

## System
- Genre · modern-minimal
- Macrostructure · Narrative Workflow (14)
- Theme · catalog TECHNICAL
- Axes · light-paper / grotesque-display / amber-accent (anchor hue 60)

Anchor hue 60 is a deliberate rejection of the blue-and-purple default every
model reaches for. Neutrals are warm-tinted toward the anchor; the accent is a
single signal amber. There is no gradient anywhere in this system.

## Tokens (canonical · `tokens.css` is the source of truth)
```css
:root {
  --color-paper:      oklch(97%  0.008 60);
  --color-paper-2:    oklch(94%  0.010 60);
  --color-ink:        oklch(19%  0.010 60);
  --color-ink-2:      oklch(44%  0.008 60);
  --color-rule:       oklch(84%  0.008 60);
  --color-control-border: oklch(61% 0.008 60);   /* 3:1 minimum — WCAG 1.4.11 */
  --color-accent:     oklch(53%  0.130 55);      /* paired with --color-accent-ink */
  --color-accent-ink: oklch(99%  0.005 60);
  --color-focus:      oklch(58%  0.190 55);

  --font-display: "Geist", ui-sans-serif, system-ui, sans-serif;
  --font-body:    "Geist", ui-sans-serif, system-ui, sans-serif;
  --font-mono:    "JetBrains Mono", ui-monospace, monospace;

  /* 4-pt spacing scale, named: --space-3xs … --space-4xl. See tokens.css.   */
  /* Type scale, 1.25 (major-third) ratio: --text-xs … --text-display.       */
  /* --text-display: clamp(2.75rem, 5vw + 1rem, 5.25rem);                    */

  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-fast: 180ms;  --dur-base: 240ms;  --dur-slow: 320ms;

  --radius-card: 6px;  --radius-pill: 999px;  --radius-input: 6px;

  --z-base: 1; --z-raised: 10; --z-dropdown: 100; --z-sticky: 200;
  --z-modal: 400; --z-toast: 500; --z-tooltip: 600;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-paper:   oklch(15%  0.010 60);
    --color-paper-2: oklch(19%  0.011 60);
    --color-ink:     oklch(94%  0.006 70);
    --color-ink-2:   oklch(72%  0.006 60);
    --color-rule:    oklch(31%  0.008 60);
    --color-control-border: oklch(52% 0.008 60);   /* 3:1 minimum — WCAG 1.4.11 */
    --color-accent:  oklch(70%  0.130 55);         /* paired with --color-accent-ink */
    --color-accent-ink: oklch(19% 0.010 60);
    --color-focus:   oklch(72%  0.190 55);
  }
  body { font-weight: 350; }
}
```

## Typography rules
- Two families. `JetBrains Mono` carries the wordmark, artifact IDs, file paths,
  and code — that is its whole role. Never a third family.
- Display weight 700 against body 400 (300-unit contrast minimum).
- Body 16px minimum, line-height 1.55, `max-width: 65ch`.
- Display line-height 1.05, tracking `-0.03em`.
- `font-variant-numeric: tabular-nums` on every byte count, quota figure, and
  audit timestamp.
- Five type sizes per page, maximum.

## CTA voice
- Primary · accent **border and text**, paper fill, `--radius-input`,
  `--space-sm` block / `--space-lg` inline. The accent is a highlighter, not a
  colour block — it stays under 3% of any viewport.
- Secondary · `--color-control-border` hairline outline (3:1 minimum — WCAG 1.4.11),
  same radius, ink text.
- Marketing page ships one final CTA strip with **one** button.

## Depth
- Hierarchy comes from weight, size, and hue — not shadow.
- One shadow only, and only on a raised surface:
  `0 1px 2px oklch(20% 0.01 60 / 0.05)`.
- Never a coloured glow. Never card-in-card. Never stacked shadows.

## Motion stance
- Marketing page · one orchestrated reveal, staggered by DOM index, capped at
  500 ms total. No parallax, no scroll-scrubbing.
- App shell · governed entirely by `docs/motion.md`.
- Reduced-motion fallback · ≤150 ms opacity crossfade, all spatial motion cut.

## Marketing page structure (Narrative Workflow)
Four numbered stages, each a fold: **1.0 Describe** → **2.0 Generate** →
**3.0 Choose who sees it** → **4.0 Share, then take it back.** Stage 3 is the
page's centre of gravity — the three privacy levels are the product. Then:
self-host block (`docker compose up`, verbatim), FAQ, one CTA strip, tabular
footer.

Bans specific to this page: no `min-height: 100vh` hero, no three-equal-column
feature grid, no everything-centred fold, no logo wall (there are no customers
yet and inventing them is a lie).

## Exports
`tokens.css` (in this project) is the source of truth. For Tailwind v4
`@theme`, DTCG `tokens.json`, or shadcn/ui CSS variables, ask *"extend
design.md with Tailwind exports"* — Hallmark will append them.

## Notes
- Component base is `base-ui`, styled only from these tokens. Nothing arrives
  pre-styled, so there is no vendor default to override.
- Artifact content renders inside a sandboxed iframe on a separate origin. This
  system does **not** apply inside that frame — an artifact's design belongs to
  whoever generated it. Style the chrome around the frame, never the contents.
