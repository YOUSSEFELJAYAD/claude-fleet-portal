# Landing page — bold motion + craft redesign (starter merge)

**Date:** 2026-06-14
**Target file:** `site/index.html` (single self-contained marketing page)
**Status:** Draft — awaiting user review
**Builds on:** [`2026-06-13-landing-hercules-rework-design.md`](./2026-06-13-landing-hercules-rework-design.md)

## Goal

Take the design *craft* of the [`next16-claude-starter`](https://github.com/textura-agency/next16-claude-starter)
(spring-feel motion, rem-based adaptive grid, token/CSS-layer discipline, smooth-scroll feel,
semantic rigor) and merge it into our existing marketing landing as a **bold redesign** — while
**keeping the dark amber/teal mission-control identity ("Fusion")** and all existing content.

The starter ships an intentionally *empty* visual theme; its value is the **system**, not a skin.
So "north-star" means adopting its *engineering + motion discipline*, re-implemented **vanilla**
(no React, no react-spring), and applying the **motion-design** skill's principles to every motion
(`~/.claude/skills/motion-design/` — timing/easing tables, choreography, a11y).

This is a **craft + motion layer + bold restructure** on top of the Hercules rework — not a
rewrite of content or a change of brand.

## Confirmed decisions

| Decision | Choice |
|----------|--------|
| End state | Enhance `site/index.html` **in place** — stays a single self-contained static page |
| Scope | **Bold redesign** (restructure layout + elevate craft), dark cockpit identity kept |
| Dependencies | **Vanilla only — no new libs.** three.js stays (existing CDN import-map, not new) |
| North-star | Starter's *craft & motion architecture*, re-implemented vanilla |
| Motion personality | **Precise / Confident** — crisp, purposeful, slightly snappy; no bounce/play |
| Driver | Apply **motion-design** principles (timing/easing tables, choreography, a11y) throughout |

## Non-goals / out of scope

- The Next.js app (`apps/web`) — `app/page.tsx` is the *dashboard*, not the landing.
- The server / control plane / any backend.
- No new runtime dependencies; no bundler/build step to view the page.
- No content/copy rewrites, no new sections, no fabricated social proof (keep all
  honesty guardrails from the Hercules rework: real signals only, "not affiliated with Anthropic").
- Not adopting react-spring / Lenis / spring-text-engine (React-only or rejected as new deps);
  their *behaviour* is re-created in vanilla JS/CSS.

## Architecture — internal discipline (single file, starter-style bones)

The file stays one `index.html`, but its internals are reorganized to the starter's standard:

1. **`<style>` reorganized into tokens → layers:**
   - `:root` — color tokens (keep existing) **plus** new `--space-*` spacing scale,
     `--text-*` type scale, `--ease-*` / `--dur-*` motion tokens, `--radius-*`.
   - `@layer base` — element resets, semantic defaults (h1–h3, p, a, lists).
   - `@layer components` — only pseudo-elements / complex selectors that utilities can't express.
   - `@layer utilities` — single-purpose helpers (`.reveal`, `.stagger`, `.mono`, …).
2. **One `<script type="module">` motion controller** replacing today's scattered `<script>` blocks
   (the three.js scene module stays separate as it already is).

## rem-based adaptive grid (starter signature)

Root font-size is driven by `clamp()` against the viewport so the **whole design scales
proportionally** instead of via fixed px:

```css
:root { font-size: clamp(14px, 0.55vw + 11px, 18px); } /* tune curve during build */
```

All spacing, type, and layout values become `rem`-based tokens, so one root scale governs the
page across breakpoints. Existing `px`/hardcoded values are migrated to tokens.

## Typography rhythm (refined, same fonts)

Keep **Chakra Petch** (display) / **Archivo** (sans) / **JetBrains Mono** (mono) — they suit the
cockpit. Tighten into a real scale with consistent vertical rhythm:

- Type scale tokens: `--text-display / -h1 / -h2 / -h3 / -lead / -body / -small / -mono`.
- Tuned line-heights + letter-spacing per role; consistent section padding rhythm via `--space-*`.

## Vanilla motion engine (ported from the starter's architecture)

Re-creates the starter's engine ideas without React:

- **One shared rAF ticker** — a single `requestAnimationFrame` loop drives all scroll-progress /
  parallax / scrub effects (the starter's `subscribeToTicker`). Reference-counted: starts on first
  subscriber, stops on last, so an idle page costs nothing. Replaces ad-hoc per-effect loops.
- **One IntersectionObserver** — drives all in-view reveals (`.reveal`, staggered groups), instead
  of multiple observers.
- **Spring-feel without react-spring** — tuned `cubic-bezier` curves for discrete transitions +
  a tiny vanilla **spring-lerp** (critically-damped, frame-rate-independent) for scroll-scrubbed
  values, so continuous motion feels physical, not linear.
- **Motion tokens** — durations/easings drawn from the motion-design timing/easing tables,
  expressed as `--dur-*` / `--ease-*` so the whole page shares one motion vocabulary.

### Accessibility & performance (motion-design a11y + perf)

- **`prefers-reduced-motion`** fully honored: disables parallax, scrub, text reveals, the three.js
  loop, and auto-cycles; elements snap to their final state (no motion, no layout shift).
- **Mobile**: hover and heavy parallax disabled below a `--mobile` breakpoint (starter's
  `disableOnMobile` idea); entrance reveals kept (cheap).
- Pause the three.js `setAnimationLoop` when the hero is offscreen (IntersectionObserver);
  keep `setPixelRatio(min(dpr, 2))`. Lazy-load screenshots (already done).
- Reveals use transform/opacity only (compositor-friendly); no layout-thrashing properties.

## Motion personality — Precise / Confident

One consistent identity across the page (motion-design motion-personality):

- Short travel distances (8–20px), fast tuned ease-out, **no overshoot/bounce**.
- Entrance durations ~200–360ms; stagger steps ~40–70ms.
- Motion reads as *instruments responding* — deliberate, snappy, calm. Never decorative.

## Section-by-section restructure (bold; all content preserved)

Each section gets a choreographed entrance (kicker → heading text-reveal → lead → content),
re-timed to the motion personality. Specific moves:

1. **Hero** — cinematic entrance choreography: logo → headline word-by-word reveal → tagline →
   console begins typing → CTAs stagger in → HUD panels slide from the edges. three.js scene
   gains subtle scroll-parallax via the shared ticker. Console typing/cycling retained.
2. **Engine trust strip** — dots pulse in sequence on reveal; tighter rhythm.
3. **How it works (5 steps)** — multi-element choreography: a connecting line **draws** down the
   column and each step lights up as it enters view (replaces/upgrades the current auto-cycle).
4. **Features (10 cards)** — staggered grid reveal "wave"; refined hover micro-interactions
   (motion-design state-feedback: lift + accent, fast in / slightly slower out).
5. **Live demos (5 tiles)** — keep the sims; re-time their internal animations to motion-design
   state-feedback curves; reveal on scroll; only animate while in view (ticker-gated).
6. **Tour / screenshots** — reveal + subtle parallax depth.
7. **Docs (tabbed)** — smooth content swap on tab change (Handle-style cross-fade/height).
8. **Releases / Install / OSS / FAQ / Closing CTA** — consistent reveal choreography; FAQ
   accordion gets a smooth height/opacity transition; CTA gets an emphatic final reveal.

## Honesty guardrails (unchanged from Hercules rework)

Structure & polish only — no new claims. No fake users/quotes/logos. Real signals only
(MIT, 660+ tests, 3 OS installers, 100% local, GitHub stars). Keep "not affiliated with Anthropic".

## Verification

- Open `site/index.html` in a browser (Playwright). Screenshot hero + each section at desktop
  **and** mobile widths; compare against current page for parity of content.
- Confirm: rem-grid scales cleanly across widths; all reveals fire once and land on final state;
  three.js renders and pauses offscreen; console types/cycles; how-it-works line draws + steps
  light; feature hover micro-interactions; docs tab swap; FAQ accordion; nav active-section
  highlight.
- **Reduced-motion path**: with `prefers-reduced-motion: reduce`, every section renders fully and
  statically — no motion, no caret, no 3D loop, no layout shift.
- No console errors. Single self-contained file still opens with no build step.

## Build sequence (for the implementation plan)

1. Token + CSS-layer refactor (`:root` scales, `@layer` reorg) — no visual change yet.
2. rem-grid root scale + type-rhythm migration.
3. Vanilla motion engine (ticker + IntersectionObserver + spring-lerp + motion tokens + a11y guards).
4. Section choreography, top → bottom (hero first), each verified in browser.
5. three.js parallax + offscreen-pause integration via the shared ticker.
6. Full reduced-motion + mobile + cross-width verification pass.
