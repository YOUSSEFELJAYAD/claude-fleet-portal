# Landing page rework — Hercules/Emergent-style, three.js, codex-generated art

**Date:** 2026-06-13
**Target file:** `site/index.html` (single self-contained marketing page)
**Status:** Approved — ready to implement

## Goal

Rework the existing marketing landing page so it adopts the *layout discipline* of
[hercules.app](https://hercules.app) and [emergent.sh](https://app.emergent.sh/landing/) —
centered hero, one outcome headline, one dominant action, a credibility badge, calm
well-spaced sections, an FAQ, and a strong closing CTA — while **keeping the portal's
dark amber mission-control identity** ("Fusion"). Enhance the existing three.js hero scene
and add procedural art generated at build time by the **codex CLI**.

## Non-goals / out of scope

- The Next.js app (`apps/web`, including `app/page.tsx` which is the *dashboard*, not a landing page).
- The server / control plane.
- No new runtime dependencies. three.js stays a CDN ES-module import-map (no bundler).
- No fabricated social proof: no fake testimonials, no invented user counts, no fake logo wall.

## Visual identity — Fusion

Keep the portal tokens (already mirrored in the file):
`--bg #0a0b0e · --panel #101217 · --ink #e9e7df · --dim #9aa1ab · --faint #5b626d ·
--amber #ffb000 · --teal #39d4cf · --coral #e8704a · --violet #b08cff · --green #54e08a`,
blueprint grid + scanlines, fonts Chakra Petch / Archivo / JetBrains Mono.
Adopt Hercules/Emergent's whitespace, centered hero, badge row, FAQ, and closing CTA.

## Section order (top → bottom)

1. **Slim sticky nav** — brand left · How it works / Features / Docs / Releases center · Download + GitHub right.
2. **Hero** — outcome headline **"What can your fleet build?"** + subhead; the **command-console centerpiece**; an honest credibility badge row; three.js fleet behind; scroll cue.
3. **Engine trust strip** — "Runs Claude Code · Codex · OpenCode" (honest, replaces logo walls).
4. **How it works** — keep the existing animated 5-step pipeline, restyled calmer.
5. **Features** — keep the grid; more breathing room; faint procedural-SVG accents.
6. **The cockpit** — keep the *real* product screenshots (honest visuals).
7. **Built in the open** — honest proof band: MIT · 660+ tests · 3 OS · 100% local · GitHub stars. This replaces the testimonial slot; no fabricated quotes.
8. **Docs** + **Releases timeline** — keep as-is (restyled to match).
9. **FAQ accordion** *(new)* — honest Q&A: subscription? · does code leave my machine? · which OSes? · Codex/OpenCode? · really free?
10. **Closing CTA** *(new emphasis)* — "Ready to launch your fleet?" + Download / Star.
11. **Footer** — keep.

## Hero command console

A faux "launch" box (clearly evocative, not a real input): `＋ Launch Agent ▸` with a caret
that **types and cycles** example tasks ("build me a landing page", "refactor the auth module",
"run a security audit", "write tests for…"). Clickable chips below swap the typed line **and**
poke the 3D scene. Honest to a launch-agents product; mirrors Hercules' input box without
implying a hosted builder.

## three.js animation

Enhance the existing octopus-fleet scene (do not replace):

- Keep: wireframe orchestrator core, bézier tentacle-arms ending in agent nodes, 900-particle
  sea, mouse parallax, `setAnimationLoop`, pixel-ratio cap.
- Add: a layered procedural-SVG depth plate behind the canvas (the Emergent "layered bg" trick).
- Interaction: clicking a hero chip makes a tentacle reach out and spawn/pulse an agent node.
- Guards: `prefers-reduced-motion` disables the loop + typing (static fallback frame);
  pause `setAnimationLoop` when the hero is scrolled offscreen (IntersectionObserver);
  keep `setPixelRatio(min(dpr, 2))`.

## Procedural images via codex CLI

The codex CLI generates the imagery by **writing code** (procedural SVG/canvas — the chosen,
OSS-aligned, free approach; no external image API, no API key).

- Driver: `codex exec "<prompt>"` writes a committed generator `site/tools/gen-art.mjs`.
- Deps: OSS only, run via `npx` (e.g. `@resvg/resvg-js` to rasterize SVG → PNG). No runtime deps added to any package.json.
- Output → `site/assets/gen/`:
  - `hero-backdrop.svg` — depth plate behind the three.js canvas (amber/teal nebula + faint grid).
  - `divider-*.svg` — faint topographic section dividers.
  - `og-image.png` (1200×630) — social/OG card, generated SVG → PNG.
- Each generated asset is reviewed before being wired into the page.

## Honesty guardrails

Hercules/Emergent's *structure* without their *claims*. Keep "not affiliated with Anthropic".
No fake users, quotes, or logos. Social proof = real signals only (MIT, test count, OS installers,
local-first, GitHub stars).

## Accessibility & performance

- `prefers-reduced-motion`: disable three.js loop, the typing caret, and the step auto-cycle.
- Pause the 3D loop when offscreen; lazy-load screenshots (already done).
- Procedural art is static and cached; the page remains a single self-contained HTML file
  plus static assets — no build step required to view it.

## Verification

- Open `site/index.html` in a browser (Playwright), screenshot hero + each new section at
  desktop and mobile widths.
- Confirm: three.js renders, the console types/cycles, chips poke the scene, FAQ accordion
  toggles, nav active-section highlight works, reduced-motion path is static, no console errors.
