# Landing — Lottie agent-robot guide + Control Room popups

**Date:** 2026-06-14
**Target file:** `site/index.html` (single self-contained marketing page) + `site/assets/lottie/` + `site/tools/gen-lottie.mjs`
**Status:** Draft — awaiting user review
**Builds on:** [`2026-06-14-landing-motion-craft-redesign-design.md`](./2026-06-14-landing-motion-craft-redesign-design.md) (reuses its vanilla motion engine)

## Goal

Add three things to the landing, as a single cohesive "the fleet sends an agent" narrative:
1. A **Lottie agent-robot** (`#fx-robot`) that flies down the page as a persistent scroll-guide.
2. A new **Control Room** section (`#control-room`) — a monitor/"machine screen" that streams **popups of simulated portal events** (runs, cost, merges, guardrails, campaigns, notifications).
3. A stable **`id` on every animated node** (`#fx-*`) so each is addressable.

Keep the existing **three.js octopus hero** untouched. All new motion rides the **existing vanilla motion engine** (shared rAF ticker, IntersectionObserver, spring-lerp, `__onScrollProgress`) and honors `prefers-reduced-motion`, offscreen-pause, and mobile simplification.

## Confirmed decisions

| Decision | Choice |
|----------|--------|
| three.js hero | **Keep unchanged**; Lottie lives elsewhere on the page |
| Robot behavior | **Page-long scroll guide** (desktop), **docked** at Control Room on mobile |
| Popups | **New Control Room section** with a monitor streaming simulated portal events |
| Asset sourcing | **Hybrid** — bespoke robot Lottie (self-generated), ≤1 optional CC0 ambient |
| Lottie runtime | `lottie-web` **light** build via CDN (MIT) — reverses the earlier "vanilla-only" call, per explicit request |
| New libs | Only `lottie-web` (OSS). Monitor + popups are CSS/SVG + DOM, **not** Lottie |
| Branch | Continue on `feat/landing-redesign` (same landing deliverable; updates PR #2) |

## Non-goals / out of scope

- The app itself, the server, real backend data (popups are simulated, clearly "live").
- Replacing or restyling the three.js hero.
- Heavy 3D, multiple concurrent Lottie players (only the robot uses Lottie).
- Fabricated social proof or real-metric claims (honesty guardrails preserved).

## Architecture & file layout

- `site/index.html` — add: `lottie-web` CDN tag; the `#fx-robot` overlay markup; the `#control-room` section markup; CSS for monitor/popups/robot; a JS module that wires robot + popups into the existing engine.
- `site/assets/lottie/robot.json` — the bespoke robot animation (committed output).
- `site/tools/gen-lottie.mjs` — Node generator that emits `robot.json` (reproducible, OSS/self-owned; mirrors the existing `site/tools/gen-art.mjs` pattern). Run with `node`/`npx`; no runtime deps added to any package.json.
- (optional) `site/assets/lottie/<ambient>.json` — at most one CC0/free accent, license recorded in the spec/commit, only if it earns its place.

## Component 1 — Lottie runtime

- Load `lottie-web` light (`lottie_light.min.js`) from a CDN (jsDelivr/cdnjs), `defer`.
- Create the robot Lottie instance **lazily** when its zone nears the viewport (IntersectionObserver), SVG renderer, `loop: true`, `autoplay: false`.
- Play only while on-screen; pause when offscreen. Never destroyed (reused).
- Lottie animates the robot's **intrinsic** motion only (idle hover, thruster flicker). The robot's **position** on the page is driven by the existing engine, not Lottie.

## Component 2 — Robot scroll-guide (`#fx-robot`)

- `position: fixed`, pinned to a side **gutter** (right gutter desktop; clamped so it never overlaps the centered content column). Contains `#fx-robot-lottie` (the Lottie mount).
- **Path**: vertical position maps to scroll progress; a gentle left↔right sine weave; both smoothed via `__lerp` and driven on the shared ticker (waking on scroll, idling when settled).
- **Reactions**: subtle tilt/scale toward the section currently centered; when `#control-room` is in view, the robot eases to a **dock point** beside the monitor and its presence triggers popup emission.
- **Desktop only** (`> 860px`) for the flight. On **mobile** the robot is a small static/perched accent inside `#control-room` (no full-page flight — clutter/perf).
- **Reduced-motion**: robot hidden (no flight, no Lottie playback); the page reads fine without it.

## Component 3 — Control Room section (`#control-room`)

Inserted **after `#showcase`** ("Watch the fleet work"). Structure:
- Standard section header (kicker "control room" / live, h2, lead) with `data-reveal` like other sections.
- **Monitor** (`#fx-screen`): CSS/SVG — bezel, stand, scanline glow, amber/teal, containing `#fx-screen-ui` (a stylized mini-dashboard: a couple of run cards + a cost gauge, built from existing tokens).
- **Popup system**: DOM cards (`.fx-pop`) that emerge from the screen edge, drift up/out, then fade, on a loop while the section is in view (engine-gated, Precise/Confident timing: short travel, fast ease-out). Six simulated, feature-authentic events, each with an id:
  - `#fx-pop-run` — "run a3f9 · opus-4.8 · high · running" (mini cost gauge)
  - `#fx-pop-cost` — "Headroom · −74% tokens · $0.38 saved"
  - `#fx-pop-merge` — "✓ PM merged #128 → main"
  - `#fx-pop-budget` — "⛔ ceiling $5.00 — auto-killed"
  - `#fx-pop-campaign` — "Campaign · 6 subagents spawned"
  - `#fx-pop-notify` — "🔔 3 runs awaiting approval"
- **Honesty**: the section carries the existing **"live"** simulated framing (same as the showcase tiles). Values are illustrative; events mirror real features (runs/cost/PM/guardrails/campaigns/notifications). No real-metric claims.
- **Reduced-motion**: a few popups rendered statically, no loop. **Mobile**: monitor scales down, popups stack vertically, fewer shown, robot docked.

## Component 4 — `id` scheme

Documented `#fx-*` convention (in a CSS/JS comment block): `#fx-robot`, `#fx-robot-lottie`, `#fx-screen`, `#fx-screen-ui`, `#fx-pop-run|cost|merge|budget|campaign|notify`, and any ambient accent `#fx-amb-1…`. Every animated node added by this work gets one.

## Engine integration & guardrails

- Reuse `window.__ticker.subscribe`, `window.__onScrollProgress`, `window.__lerp`, and the reveal IntersectionObserver — no second rAF loop.
- A new `<script>` consumer must wait for the engine like the how-it-works script does (run on `DOMContentLoaded` if `window.__ticker` isn't defined yet, since the engine is a deferred module).
- Lottie + popups + robot all gate on `prefers-reduced-motion` and on visibility (pause offscreen). At most one Lottie player active.
- No horizontal overflow at any width; zero console errors.

## Verification

- Playwright at 1440 / 768 / 375:
  - Robot flies on desktop (position tracks scroll), docks at `#control-room`; hidden/perched on mobile; hidden under reduced-motion.
  - Control Room: monitor renders; popups cycle while in view, pause offscreen; static under reduced-motion; stacked on mobile.
  - Every `#fx-*` id present in the DOM.
  - `lottie-web` loads; robot Lottie plays only in view; no console errors; no horizontal overflow.
- Confirm the three.js hero and all prior sections are unchanged (no regression).

## Build sequence (for the plan)

1. `gen-lottie.mjs` → `robot.json`; review the asset; add `lottie-web` CDN tag.
2. Robot overlay markup + CSS + scroll-guide JS (engine-driven path, desktop/mobile/reduced-motion gates), lazy Lottie init.
3. Control Room section markup + monitor CSS/SVG + `#fx-screen-ui`.
4. Popup system (DOM cards + simulated event loop, engine-gated, a11y/mobile variants).
5. Robot↔Control-Room docking + popup trigger integration.
6. Full a11y / mobile / cross-width verification pass.
