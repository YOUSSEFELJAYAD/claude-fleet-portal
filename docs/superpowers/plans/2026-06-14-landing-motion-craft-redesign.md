# Landing Motion + Craft Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `next16-claude-starter`'s craft (rem-based adaptive scaling, design-token rigor, a unified vanilla motion engine) and motion-design principles into `site/index.html` as a bold, choreographed redesign — keeping the dark amber/teal mission-control identity and all existing content.

**Architecture:** `site/index.html` stays a single self-contained static page. We add (a) new design-token scales, (b) a `clamp()`-driven rem root so structural spacing/type scale proportionally, (c) ONE shared `requestAnimationFrame` ticker + ONE IntersectionObserver powering reveal/stagger/parallax for all new motion, and (d) per-section entrance choreography. Existing self-contained scripts (three.js scene, hero HUD, live demos, docs tabs, nav) are preserved; only how-it-works is re-choreographed.

**Tech Stack:** Vanilla HTML/CSS/JS (ES modules). three.js (existing CDN import-map). No new dependencies. Verification via the Playwright MCP tools against `file://` URLs.

**Spec:** [`docs/superpowers/specs/2026-06-14-landing-motion-craft-redesign-design.md`](../specs/2026-06-14-landing-motion-craft-redesign-design.md)

**Motion reference:** the `motion-design` skill (`~/.claude/skills/motion-design/`) — consult `reference/timing-easing-tables.md`, `patterns/entrance-exit.md`, `patterns/multi-element.md`, and `director/motion-personality.md`. Personality target: **Precise / Confident** (short travel 8–20px, fast ease-out, no bounce, entrances 200–360ms, stagger 40–70ms).

---

## File structure

Single file edited throughout: `site/index.html`.

| Region (current lines, approx) | Responsibility | Touched by |
|---|---|---|
| `<style>` `:root` (17–27) | Design tokens | Task 1 |
| `<style>` base (28–44) | Root scale, base resets | Task 2 |
| `<style>` end, before `</style>` (≈431) | New motion/reveal utility CSS | Task 3, 5, 7 |
| Body markup (435–1131) | Section markup to annotate with reveal attrs | Tasks 4–7 |
| three.js module (1136–1313) | Scene; add parallax + keep offscreen pause | Task 4 |
| how-it-works script (1577–1604) | Replace auto-cycle with scroll-driven line-draw | Task 5 |
| Before `</body>` (1657) | New shared motion-engine module | Task 3 |

**No new files.** All assets already exist under `site/assets/`.

---

## Conventions for every task

- **Open the page:** `mcp__playwright__playwright_navigate` to `file:///Users/jd/Documents/agent-system/.claude/worktrees/zesty-enchanting-panda/site/index.html` (use the absolute path of the working tree).
- **Check for errors:** after each change, `mcp__playwright__playwright_console_logs` with `type: "error"` → expect empty.
- **Inspect state:** `mcp__playwright__playwright_evaluate` with a JS expression returning a value to assert behavior.
- **Screenshot widths:** desktop = 1440, tablet = 768, mobile = 375 (use `mcp__playwright__playwright_navigate` `width`/`height` or `playwright_screenshot` after a resize).
- **Reduced motion:** `mcp__playwright__playwright_navigate` with no special flag can't set the media feature; use `playwright_evaluate` to read `matchMedia('(prefers-reduced-motion: reduce)').matches`. For the reduced-motion verification (Task 8) launch with the emulation flag via `playwright_evaluate` is insufficient — instead assert the code path by temporarily forcing `window.__reduceMotion` (the engine reads a override hook, defined in Task 3).
- **Commit** at the end of every task with the exact message given.

---

## Task 1: Design-token scales

**Files:**
- Modify: `site/index.html` `:root` block (≈17–27)

- [ ] **Step 1: Capture the baseline**

Open the page and screenshot all three widths to a scratch folder for later before/after comparison.

Run (Playwright MCP): navigate to the `file://` URL, then `playwright_screenshot` named `baseline-1440`, resize to 768 → `baseline-768`, resize to 375 → `baseline-375`.
Expected: page renders, hero + three.js visible, no console errors.

- [ ] **Step 2: Add token scales to `:root`**

Insert these tokens at the end of the existing `:root` block (immediately before its closing `}` at line 27). Keep all existing tokens unchanged.

```css
    /* ── spacing scale (rem-based; scales with the adaptive root) ── */
    --space-1: .375rem;  --space-2: .625rem; --space-3: .875rem;
    --space-4: 1.125rem; --space-5: 1.5rem;  --space-6: 2rem;
    --space-7: 2.75rem;  --space-8: 3.75rem; --space-section: clamp(4rem, 7vw, 6.5rem);
    --space-gap: 1.125rem;
    /* ── type scale (rem-based) ── */
    --text-display: clamp(2.5rem, 7vw, 4.5rem);
    --text-h2: clamp(1.6rem, 4vw, 2.5rem);
    --text-h3: 1.125rem;
    --text-lead: clamp(1rem, 2.4vw, 1.3rem);
    --text-body: .95rem;
    --text-small: .8rem;
    /* ── motion tokens (motion-design: Precise/Confident) ── */
    --dur-fast: 180ms; --dur-base: 260ms; --dur-slow: 360ms;
    --ease-out: cubic-bezier(.22, 1, .36, 1);     /* snappy ease-out, no overshoot */
    --ease-inout: cubic-bezier(.65, 0, .35, 1);
    --reveal-travel: 14px;
    /* ── radii ── */
    --radius-card: 14px; --radius-pill: 999px;
```

- [ ] **Step 3: Verify no regression**

Reload the page. `playwright_console_logs type:error` → expect empty. `playwright_evaluate`:
```js
getComputedStyle(document.documentElement).getPropertyValue('--dur-base').trim()
```
Expected: `"260ms"`.

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): add spacing/type/motion design-token scales"
```

---

## Task 2: rem adaptive root + apply rhythm tokens to structure

**Files:**
- Modify: `site/index.html` base CSS (29–31, 64, 66, 67, 69) and hero spacing (49, 51, 53)

- [ ] **Step 1: Add the adaptive rem root**

Replace the `html { ... }` rule (line 29) with:
```css
  html { scroll-behavior: smooth; font-size: clamp(13px, 0.45vw + 10.7px, 17px); }
```
This makes every `rem` token scale proportionally with viewport width (the starter signature). Existing px values are unaffected; only the new rem tokens scale.

- [ ] **Step 2: Apply spacing/type tokens to major structure**

Make these exact replacements (left = current, right = new):

`section { ... padding: 96px 24px; }` (line 64) →
```css
  section { max-width: 1120px; margin: 0 auto; padding: var(--space-section) 24px; }
```
`h2 { font-size: clamp(26px, 4vw, 40px); margin: 10px 0 18px; }` (line 66) →
```css
  h2 { font-size: var(--text-h2); margin: var(--space-3) 0 var(--space-4); letter-spacing: .01em; }
```
`.grid { ... gap: 18px; ... margin-top: 42px; }` (line 69) →
```css
  .grid { display: grid; gap: var(--space-gap); grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); margin-top: var(--space-7); }
```

- [ ] **Step 3: Verify proportional scaling**

Reload at 1440 and 768. `playwright_evaluate` at each width:
```js
getComputedStyle(document.querySelector('section')).paddingTop
```
Expected: the value at 1440 is larger than at 768 (clamp scaling). Screenshot `task2-1440` / `task2-768`; confirm layout intact, no overflow, no console errors.

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): adaptive rem root + token-driven section rhythm"
```

---

## Task 3: Vanilla motion engine (shared ticker + reveal/parallax)

**Files:**
- Modify: `site/index.html` — add reveal CSS before `</style>` (≈431); add engine module before `</body>` (1657)

- [ ] **Step 1: Add reveal/parallax utility CSS**

Insert immediately before the closing `</style>` (line 432):

```css
  /* ── motion engine: reveal + stagger + parallax (Precise/Confident) ── */
  [data-reveal] { opacity: 0; transform: translateY(var(--reveal-travel)); will-change: opacity, transform; transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
  [data-reveal="left"]  { transform: translateX(calc(-1 * var(--reveal-travel))); }
  [data-reveal="right"] { transform: translateX(var(--reveal-travel)); }
  [data-reveal="scale"] { transform: scale(.985); }
  [data-reveal].in { opacity: 1; transform: none; transition-delay: var(--rv-delay, 0ms); }
  [data-parallax] { will-change: transform; }
  @media (max-width: 860px) { [data-parallax] { transform: none !important; } }
  @media (prefers-reduced-motion: reduce) {
    [data-reveal] { opacity: 1 !important; transform: none !important; transition: none !important; }
    [data-parallax] { transform: none !important; }
  }
```

- [ ] **Step 2: Add the engine module**

Insert immediately before `</body>` (line 1657):

```html
<!-- ── shared motion engine: one rAF ticker + one reveal/parallax observer ──── -->
<script type="module">
(() => {
  // reduced-motion override hook (lets verification force the static path)
  const prefersReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduce = () => window.__reduceMotion ?? prefersReduce;
  const mobile = () => window.matchMedia('(max-width: 860px)').matches;

  // ── one shared requestAnimationFrame ticker (ref-counted) ──
  const subs = new Set();
  let raf = 0;
  function frame() { for (const fn of subs) fn(); raf = subs.size ? requestAnimationFrame(frame) : 0; }
  function subscribe(fn) { subs.add(fn); if (!raf) raf = requestAnimationFrame(frame); return () => subs.delete(fn); }
  window.__ticker = { subscribe };

  // ── frame-rate-independent spring-lerp (critically damped feel) ──
  // returns a stepper: cur = step(cur, target); ~0.18 = snappy/precise
  const lerp = (cur, target, k = 0.18) => cur + (target - cur) * k;
  window.__lerp = lerp;

  // ── reveal: one IntersectionObserver toggles `.in`, honoring stagger ──
  const revealEls = [...document.querySelectorAll('[data-reveal]')];
  if (reduce()) {
    revealEls.forEach((el) => el.classList.add('in'));
  } else {
    // stagger: elements sharing a [data-stagger] parent get incremental delay
    document.querySelectorAll('[data-stagger]').forEach((group) => {
      const stepMs = parseInt(group.dataset.stagger || '55', 10);
      [...group.querySelectorAll('[data-reveal]')].forEach((el, i) => {
        el.style.setProperty('--rv-delay', (i * stepMs) + 'ms');
      });
    });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }
    }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach((el) => io.observe(el));
  }

  // ── parallax: subscribe [data-parallax] elements to the shared ticker ──
  // data-parallax = strength in px of travel across the viewport (e.g. "40")
  if (!reduce() && !mobile()) {
    const items = [...document.querySelectorAll('[data-parallax]')].map((el) => ({ el, str: parseFloat(el.dataset.parallax) || 24, cur: 0 }));
    if (items.length) {
      const vh = () => window.innerHeight || 1;
      let active = false;
      const visObs = new IntersectionObserver((entries) => {
        for (const e of entries) { const it = items.find((x) => x.el === e.target); if (it) it.vis = e.isIntersecting; }
        active = items.some((x) => x.vis);
      }, { threshold: 0 });
      items.forEach((it) => visObs.observe(it.el));
      subscribe(() => {
        if (!active) return;
        for (const it of items) {
          if (!it.vis) continue;
          const r = it.el.getBoundingClientRect();
          const prog = (r.top + r.height / 2) / vh() - 0.5; // -0.5..0.5
          const target = -prog * it.str;
          it.cur = lerp(it.cur, target, 0.12);
          it.el.style.transform = `translate3d(0, ${it.cur.toFixed(2)}px, 0)`;
        }
      });
    }
  }

  // ── expose a scroll-progress helper for section choreography (Task 5) ──
  // onScrollProgress(el, cb): cb(p) where p is 0 (el top hits vh bottom) → 1 (el bottom hits vh top)
  window.__onScrollProgress = (el, cb) => {
    if (reduce()) { cb(1); return () => {}; }
    let raf2 = 0;
    const run = () => {
      const r = el.getBoundingClientRect(); const vh = window.innerHeight || 1;
      const p = Math.max(0, Math.min(1, (vh - r.top) / (vh + r.height)));
      cb(p); raf2 = 0;
    };
    return subscribe(() => { if (!raf2) raf2 = requestAnimationFrame(run); });
  };
})();
</script>
```

- [ ] **Step 3: Smoke-test the engine API**

Reload. `playwright_console_logs type:error` → expect empty. `playwright_evaluate`:
```js
[typeof window.__ticker?.subscribe, typeof window.__lerp, typeof window.__onScrollProgress].join(',')
```
Expected: `"function,function,function"`.

- [ ] **Step 4: Verify a reveal fires**

Add a temporary probe: `playwright_evaluate`:
```js
(() => { const n = document.createElement('div'); n.setAttribute('data-reveal',''); n.id='__probe'; document.querySelector('#features').prepend(n); return getComputedStyle(n).opacity; })()
```
Expected: `"0"` (hidden before intersect). Then scroll `#features` into view (`playwright_evaluate` `document.querySelector('#features').scrollIntoView()`), wait briefly, and re-read `getComputedStyle(document.getElementById('__probe')).opacity` → expect `"1"`. Remove the probe: `document.getElementById('__probe').remove()`.

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): vanilla motion engine — shared ticker, reveal, parallax, scroll-progress"
```

---

## Task 4: Hero entrance choreography + three.js parallax

**Files:**
- Modify: `site/index.html` hero markup (467–496); three.js module (add parallax read)

- [ ] **Step 1: Annotate hero children for staggered reveal**

In `.hero-inner` (line 467), add `data-stagger="70"` to the `.hero-inner` div, and `data-reveal` to each direct child in order: `.hero-badge`, `h1`, `.tagline`, `.console`, `.hero-cta`, `.cred-row`. Example for the opening tag and first two children:

```html
  <div class="hero-inner" data-stagger="70">
    <div class="hero-badge" data-reveal>⚖ <b>100% open source</b> · MIT licensed</div>
    <h1 data-reveal>What can your <span class="amber">fleet</span> build?</h1>
```
Apply `data-reveal` likewise to `.tagline`, `.console`, `.hero-cta`, `.cred-row`.

- [ ] **Step 2: Slide the HUD panels in from the edges**

Add `data-reveal="left"` to `aside.hud-left` (457) and `data-reveal="right"` to `aside.hud-right` (462). They keep their existing `aria-hidden`.

- [ ] **Step 3: Headline word reveal**

Replace the `<h1 data-reveal>` line with a span-wrapped version so words rise in sequence (engine staggers via the parent):
```html
    <h1 data-reveal class="h1-words" data-stagger="60">
      <span data-reveal>What</span> <span data-reveal>can</span> <span data-reveal>your</span>
      <span data-reveal class="amber">fleet</span> <span data-reveal>build?</span>
    </h1>
```
Add CSS before `</style>`:
```css
  .h1-words span { display: inline-block; }
```

- [ ] **Step 4: three.js subtle scroll parallax + keep offscreen pause**

The scene element is `#scene`. Add `data-parallax="36"` to the `<div id="scene"></div>` (line 454) so the shared engine drifts it on scroll. (The existing `setAnimationLoop` + offscreen pause in the three.js module is preserved — do not remove it.)

- [ ] **Step 5: Verify hero choreography**

Reload at 1440. `playwright_evaluate`:
```js
[...document.querySelectorAll('.hero-inner > [data-reveal]')].map(e => e.style.getPropertyValue('--rv-delay'))
```
Expected: ascending delays like `["0ms","70ms","140ms",...]`. After load, `getComputedStyle(document.querySelector('.hero-badge')).opacity` → expect `"1"`. Screenshot `task4-hero-1440`; confirm three.js still renders, HUDs visible, no console errors.

- [ ] **Step 6: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): cinematic hero entrance choreography + scene parallax"
```

---

## Task 5: Engines strip + how-it-works line-draw choreography

**Files:**
- Modify: `site/index.html` engines markup (500–507); how-it-works markup (517–548); replace how-it-works script (1577–1604); add CSS before `</style>`

- [ ] **Step 1: Engines strip reveal**

Add `data-stagger="80"` to `#engines .row` (line 502) and `data-reveal` to each `.eng` span (503–505).

- [ ] **Step 2: Add the connecting line + reveal to steps**

Add `data-stagger="90"` to `.steps` (line 517) and `data-reveal` to each `.step` (518, 524, 530, 536, 542). Then add a draw-line element as the first child inside `.steps`:
```html
  <div class="steps" id="steps" data-stagger="90">
    <span class="steps-line" aria-hidden="true"></span>
```

- [ ] **Step 3: Add line CSS**

Before `</style>`:
```css
  .steps { position: relative; }
  .steps-line { position: absolute; left: 0; top: 50%; height: 2px; width: 0%; background: linear-gradient(90deg, var(--amber), var(--teal)); opacity: .5; transform: translateY(-50%); pointer-events: none; z-index: 0; }
  @media (max-width: 980px) { .steps-line { left: 50%; top: 0; width: 2px; height: 0%; transform: translateX(-50%); background: linear-gradient(180deg, var(--amber), var(--teal)); } }
  .step { position: relative; z-index: 1; }
  @media (prefers-reduced-motion: reduce) { .steps-line { width: 100%; } }
```

- [ ] **Step 4: Replace the how-it-works script**

Replace the entire `<script>` block at 1577–1604 with a scroll-driven version that draws the line and lights steps by scroll progress (uses the engine from Task 3):
```html
<script>
(() => {
  const steps = [...document.querySelectorAll('#steps .step')];
  const line = document.querySelector('.steps-line');
  const root = document.getElementById('steps');
  if (!steps.length || !root) return;
  const vertical = () => window.matchMedia('(max-width: 980px)').matches;
  const apply = (p) => {
    // p: 0..1 progress of #steps through the viewport
    const pct = Math.max(0, Math.min(1, (p - 0.15) / 0.7));
    if (line) line.style[vertical() ? 'height' : 'width'] = (pct * 100) + '%';
    const lit = Math.round(pct * steps.length);
    steps.forEach((el, k) => { el.classList.toggle('active', k === Math.min(lit, steps.length - 1) && pct > 0 && pct < 1); el.classList.toggle('done', k < lit - 1); });
  };
  // hover still lets a user inspect a single step
  steps.forEach((el, k) => el.addEventListener('pointerenter', () => { steps.forEach((s, j) => s.classList.toggle('active', j === k)); }));
  if (window.__onScrollProgress) window.__onScrollProgress(root, apply);
  else { steps.forEach((s) => s.classList.add('done')); if (line) line.style.width = '100%'; }
})();
</script>
```
Also remove the now-unused `fillBar` auto-cycle animation usage: leave the `@keyframes fillBar`/`stepPulse` (still used by `.step.active .ico` pulse) but the `.step.active .bar { animation: fillBar ... }` is no longer triggered by JS — that's fine, harmless. Keep `.step.active` styling.

- [ ] **Step 5: Verify line draws and steps light on scroll**

Reload. Scroll `#how` through view via `playwright_evaluate`:
```js
document.getElementById('how').scrollIntoView({block:'center'});
```
Then read line width: `getComputedStyle(document.querySelector('.steps-line')).width` → expect a non-`"0px"` value. `document.querySelectorAll('#steps .step.active, #steps .step.done').length` → expect ≥ 1. Screenshot `task5-how`. No console errors.

- [ ] **Step 6: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): engines reveal + scroll-driven how-it-works line-draw"
```

---

## Task 6: Features wave + showcase + tour reveals

**Files:**
- Modify: `site/index.html` features grid (558–570), showcase grid (578–635), tour shots (645–652)

- [ ] **Step 1: Features stagger wave**

Add `data-stagger="50"` to the features `.grid` (line 558) and `data-reveal="scale"` to each of the 10 `.card` elements (559–569).

- [ ] **Step 2: Section headers reveal**

For sections `#features`, `#showcase`, `#tour`: add `data-reveal` to each `.kicker`, its `h2`, and its `.lead`. (These are direct children of each `<section>`; do NOT add `data-stagger` to the `<section>` itself to avoid staggering large content blocks — only the small header trio plus the grid wave.)

- [ ] **Step 3: Showcase tiles reveal**

Add `data-stagger="60"` to `#showcase .show-grid` (578) and `data-reveal` to each `.show-card` (580, 591, 606, 616, 629). The demos' internal animation already starts/stops on visibility (existing script) — leave it.

- [ ] **Step 4: Tour shots reveal + parallax**

Add `data-reveal` to the standalone `.shot` images (646, 651) and to `.shot-row` (647). Add a gentle `data-parallax="20"` to the first `.shot` (646) for depth.

- [ ] **Step 5: Verify**

Reload. Scroll to `#features` (`document.getElementById('features').scrollIntoView()`). `playwright_evaluate`:
```js
[...document.querySelectorAll('#features .card')].filter(c => c.classList.contains('in')).length
```
Expected: 10 after the section is in view. Confirm stagger delays differ:
```js
[...document.querySelectorAll('#features .card')].slice(0,3).map(c => c.style.getPropertyValue('--rv-delay'))
```
Expected: `["0ms","50ms","100ms"]`. Screenshot `task6-features`. No console errors.

- [ ] **Step 6: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): feature stagger wave + showcase/tour reveals"
```

---

## Task 7: Docs swap + releases/install/oss/faq/cta reveals

**Files:**
- Modify: `site/index.html` docs CSS (170–171) + docs tab script (1607–1626); releases/install/oss/faq/cta markup; faq CSS

- [ ] **Step 1: Smooth docs tab swap**

Replace the doc-section show/hide CSS (lines 170–171):
```css
  .doc-content .doc-section { display: none; opacity: 0; transform: translateY(6px); transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
  .doc-content .doc-section.active { display: block; opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) { .doc-content .doc-section { transition: none; } }
```
Because `display:none` blocks transition, update the tab script (1607–1626) to defer the class toggle one frame. Replace the `sections.forEach(...)` block inside the click handler with:
```js
      sections.forEach((s) => {
        if (s.id === 'doc-' + target) { s.style.display = 'block'; requestAnimationFrame(() => s.classList.add('active')); }
        else { s.classList.remove('active'); s.style.display = 'none'; }
      });
```

- [ ] **Step 2: Header reveals for remaining sections**

Add `data-reveal` to the `.kicker`, `h2`, and `.lead`/intro of each: `#docs`, `#releases`, `#install`, `#oss`, `#faq`. Add `data-stagger="60"` + `data-reveal` to: `#oss .stats` children (`.stat`), `#faq .faq-list` children (`.faq-item`), `#install .install-cols` children.

- [ ] **Step 3: Smooth FAQ accordion**

The FAQ uses native `<details>`. Add a content-reveal transition by wrapping is unnecessary; instead animate the answer with CSS grid-rows. Replace `.faq-a` (277) and add an open transition:
```css
  .faq-item .faq-a { padding: 0 22px; color: var(--dim); font-size: 14.5px; line-height: 1.7; display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-base) var(--ease-out), padding var(--dur-base) var(--ease-out); }
  .faq-item[open] .faq-a { grid-template-rows: 1fr; padding: 0 22px 20px; }
  .faq-item .faq-a > * { overflow: hidden; min-height: 0; }
  @media (prefers-reduced-motion: reduce) { .faq-item .faq-a { transition: none; } }
```
Note: this requires each `.faq-a`'s text to be wrapped in a single child element. If a `.faq-a` contains raw text/multiple nodes, wrap its inner content in a `<div>`. Inspect each `.faq-a` in the markup and wrap as needed.

- [ ] **Step 4: Closing CTA emphatic reveal**

Add `data-stagger="80"` to `.cta-card` (line ≈1114) and `data-reveal` to its `.kicker`, `h2`, `p`, and `.cta`.

- [ ] **Step 5: Verify**

Reload. Click a docs sidebar link via `playwright_click` on e.g. `.doc-sidebar a[data-doc="orchestration"]`, then `playwright_evaluate` `document.getElementById('doc-orchestration').classList.contains('active')` → expect `true`, and screenshot `task7-docs`. Toggle a FAQ item (`playwright_click` on a `.faq-item summary`) and confirm `document.querySelector('.faq-item[open]')` is non-null. Scroll to `#oss`, confirm `.stat.in` count > 0. No console errors.

- [ ] **Step 6: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): smooth docs swap, faq accordion, section + cta reveals"
```

---

## Task 8: Reduced-motion, mobile, and full verification pass

**Files:**
- Modify: `site/index.html` only if verification surfaces a gap

- [ ] **Step 1: Reduced-motion path**

Force the static path via the engine override, reload semantics: `playwright_evaluate` set `window.__reduceMotion = true` is too late (engine already ran). Instead verify the CSS guard: `playwright_evaluate`:
```js
(() => { const s = document.createElement('style'); s.textContent='@media all{[data-reveal]{}}'; return true; })()
```
Primary check: launch a fresh context with reduced motion. Use `mcp__playwright__playwright_navigate` then `playwright_evaluate`:
```js
matchMedia('(prefers-reduced-motion: reduce)').matches
```
If the runner supports emulating reduced motion, enable it and reload; assert every `[data-reveal]` has computed `opacity:1` and `transform:none`:
```js
[...document.querySelectorAll('[data-reveal]')].every(e => getComputedStyle(e).opacity === '1')
```
Expected: `true`. The how-it-works line must be full width (`.steps-line` width === steps width) and three.js loop must not run (no `setAnimationLoop` ticking — assert the scene canvas exists but is static).

- [ ] **Step 2: Mobile path (375px)**

Resize to 375. `playwright_evaluate`:
```js
[...document.querySelectorAll('[data-parallax]')].every(e => getComputedStyle(e).transform === 'none' || e.style.transform === '')
```
Expected: `true` (parallax disabled ≤860px). Confirm HUDs are hidden (`#hero .hud` `display:none` at ≤1279px), nav collapses, no horizontal scroll:
```js
document.documentElement.scrollWidth <= window.innerWidth + 1
```
Expected: `true`. Screenshot `task8-375`.

- [ ] **Step 3: Cross-width visual pass**

Screenshot `final-1440`, `final-768`, `final-375`. Compare against `baseline-*` from Task 1: all content present, identical copy, dark cockpit identity intact, motion polish added. No layout breakage.

- [ ] **Step 4: Console + behavior audit**

`playwright_console_logs type:error` after a full scroll top→bottom → expect empty. Confirm interactive bits still work: console types/cycles, chips poke the scene, demos animate in view, how-it-works lights on scroll, docs tabs swap, FAQ toggles, nav active highlight tracks scroll.

- [ ] **Step 5: Fix any gaps found, then final commit**

If Steps 1–4 surfaced issues, fix inline (smallest change), re-verify the affected step. Then:
```bash
git add site/index.html
git commit -m "test(landing): reduced-motion + mobile + cross-width verification pass"
```

---

## Self-review notes (author)

- **Spec coverage:** tokens (T1) · rem grid (T2) · type rhythm (T2) · shared ticker + IO + spring-lerp + a11y/mobile guards (T3) · hero choreography + scene parallax (T4) · engines + how-it-works line-draw (T5) · features wave + showcase + tour (T6) · docs swap + faq + releases/install/oss/cta (T7) · reduced-motion + mobile + verification (T8). The spec's full `@layer` CSS reorg is **intentionally descoped** — see plan intro (low value / high regression risk in a working single-file page); token discipline is still delivered via the new scales.
- **Type consistency:** engine globals are `window.__ticker.subscribe`, `window.__lerp`, `window.__onScrollProgress`, `window.__reduceMotion`; reveal contract is `[data-reveal]` + `.in` + `--rv-delay` from `[data-stagger]`; parallax is `[data-parallax]="<px>"`. These names are used identically across Tasks 3–8.
- **Honesty guardrails:** no copy/content changes — only attributes + motion. All real-signal social proof preserved.
