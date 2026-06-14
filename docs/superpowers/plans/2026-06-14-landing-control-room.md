# Landing Control Room + Lottie Robot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bespoke Lottie agent-robot scroll-guide and a "Control Room" section (a monitor streaming simulated portal-event popups) to the landing, wired into the existing motion engine, with a stable `#fx-*` id on every animated node.

**Architecture:** `site/index.html` stays the single page. Only the robot uses Lottie (`lottie-web` light, CDN, MIT); the monitor + popups are CSS/SVG + DOM. The robot's intrinsic motion is Lottie (hover loop); its on-page path is driven by the existing engine (`window.__ticker`/`__onScrollProgress`/`__lerp`). All new motion honors `prefers-reduced-motion`, pauses offscreen, and simplifies on mobile.

**Tech Stack:** Vanilla HTML/CSS/JS, `lottie-web@5.12.2` (light, CDN), Node (for the asset generator only). Verification via Playwright MCP against `file://`.

**Spec:** [`docs/superpowers/specs/2026-06-14-landing-control-room-design.md`](../specs/2026-06-14-landing-control-room-design.md)

**Motion reference:** the `motion-design` skill — Precise/Confident personality (short travel, fast ease-out, no bounce; entrances ~200–360ms).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `site/tools/gen-lottie.mjs` | Node generator that emits the bespoke robot Lottie JSON | 1 |
| `site/assets/lottie/robot.json` | Generated robot animation (committed) | 1 |
| `site/index.html` `<head>` | `lottie-web` light CDN tag | 1 |
| `site/index.html` (after `#showcase`) | Control Room section markup (`#control-room`, `#fx-screen`, popups) | 2,3 |
| `site/index.html` `<style>` | Monitor + popup + robot CSS (before `</style>`) | 2,3,4 |
| `site/index.html` (after `</nav>`) | `#fx-robot` overlay markup | 4 |
| `site/index.html` (before `</body>`) | popup-cycle `<script>` + robot `<script>` | 3,4 |

## Conventions for every task

- Open the page: `mcp__playwright__playwright_navigate` to `file:///Users/jd/Documents/agent-system/.claude/worktrees/zesty-enchanting-panda/site/index.html`.
- **Viewport changes require close+relaunch** (the Playwright MCP keeps a persistent context; re-navigation does NOT resize). Use `mcp__playwright__playwright_close` then `playwright_navigate` with the new `width`.
- After each change: `mcp__playwright__playwright_console_logs` `type:error` → expect empty.
- Reveals/visibility fire on real scroll; when scripting scroll in `playwright_evaluate`, set `document.documentElement.style.scrollBehavior='auto'` and step in small increments with a few rAFs between, then settle — synthetic ultra-fast scroll can outrun IntersectionObserver.
- Commit at the end of every task with the exact message given.

---

## Task 1: Robot Lottie asset + lottie-web

**Files:**
- Create: `site/tools/gen-lottie.mjs`
- Create (generated): `site/assets/lottie/robot.json`
- Modify: `site/index.html` (`<head>`)

- [ ] **Step 1: Write the generator**

Create `site/tools/gen-lottie.mjs` with exactly:

```js
// Generates a bespoke, on-brand agent-robot Lottie (OSS / self-owned).
// Run: node site/tools/gen-lottie.mjs  → writes site/assets/lottie/robot.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/lottie/robot.json', import.meta.url));

// brand colors (0..1 rgb)
const amber = [1, 0.69, 0];
const teal  = [0.224, 0.831, 0.812];
const panel = [0.086, 0.098, 0.133];
const ink   = [0.914, 0.906, 0.875];

const fill = (c) => ({ ty: 'fl', c: { a: 0, k: [...c, 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'fill' });
const tr = (o = { a: 0, k: 100 }) => ({ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o, nm: 'tr' });
const rect = (w, h, x, y, r = 0) => ({ ty: 'rc', d: 1, s: { a: 0, k: [w, h] }, p: { a: 0, k: [x, y] }, r: { a: 0, k: r }, nm: 'rc' });
const ell = (w, h, x, y) => ({ ty: 'el', d: 1, s: { a: 0, k: [w, h] }, p: { a: 0, k: [x, y] }, nm: 'el' });
const grp = (nm, shape, color, transform = tr()) => ({ ty: 'gr', nm, it: [shape, fill(color), transform] });

const ease = { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] } };

// thruster opacity flicker (1D opacity keyframes)
const flicker = { a: 1, k: [
  { t: 0,  s: [100], ...ease }, { t: 15, s: [45], ...ease },
  { t: 30, s: [100], ...ease }, { t: 45, s: [60], ...ease }, { t: 60, s: [100] },
] };

// vertical bob for the whole robot layer (3D position keyframes)
const bob = { a: 1, k: [
  { t: 0,  s: [120, 123, 0], ...ease, to: [0, -2, 0], ti: [0, 0, 0] },
  { t: 30, s: [120, 110, 0], ...ease, to: [0, 0, 0], ti: [0, -2, 0] },
  { t: 60, s: [120, 123, 0] },
] };

const shapes = [
  grp('pupil', ell(12, 12, 120, 112), panel),
  grp('visor', rect(60, 20, 120, 112, 10), amber),
  grp('antennaTip', ell(9, 9, 120, 70), teal),
  grp('antenna', rect(3, 18, 120, 82), ink),
  grp('thrusterL', rect(16, 10, 100, 162, 5), teal, tr(flicker)),
  grp('thrusterR', rect(16, 10, 140, 162, 5), teal, tr(flicker)),
  grp('body', rect(96, 70, 120, 120, 18), panel),
  grp('bodyRim', rect(102, 76, 120, 120, 21), amber),
];

const anim = {
  v: '5.7.4', fr: 30, ip: 0, op: 60, w: 240, h: 240, nm: 'fx-robot', ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: 'robot', sr: 1,
    ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: bob, a: { a: 0, k: [120, 120, 0] }, s: { a: 0, k: [100, 100, 100] } },
    ao: 0, shapes, ip: 0, op: 60, st: 0, bm: 0,
  }],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(anim));
console.log('wrote', OUT);
```

- [ ] **Step 2: Generate and validate the asset**

Run:
```bash
node site/tools/gen-lottie.mjs
node -e "const a=require('./site/assets/lottie/robot.json'); if(!a.layers||a.layers.length!==1||a.w!==240) throw new Error('bad lottie'); console.log('valid lottie: '+a.layers[0].shapes.length+' groups, op='+a.op);"
```
Expected: `wrote …/robot.json` then `valid lottie: 8 groups, op=60`.

- [ ] **Step 3: Add lottie-web to `<head>` with Subresource Integrity**

First compute the SRI hash of the exact pinned file (version is pinned, so the hash is stable):
```bash
curl -s https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```
Copy the printed base64 hash. Then in `site/index.html`, find `</head>` (appears once) and insert immediately before it, substituting the hash you got for `<HASH>`:
```html
<script defer src="https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js" integrity="sha384-<HASH>" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
```
(SRI + `crossorigin` protect against CDN compromise; required per the repo's security guidance for external scripts.)

- [ ] **Step 4: Verify lottie loads in the browser**

Navigate to the page. `playwright_evaluate`:
```js
(async () => { for (let i=0;i<40 && !window.lottie;i++) await new Promise(r=>setTimeout(r,50)); const res = await fetch('assets/lottie/robot.json').then(r=>r.json()).catch(e=>({err:String(e)})); return { lottie: typeof window.lottie, robotLayers: res.layers ? res.layers.length : res }; })();
```
Expected: `{ lottie: "object", robotLayers: 1 }`. `playwright_console_logs type:error` → empty.

- [ ] **Step 5: Commit**

```bash
git add site/tools/gen-lottie.mjs site/assets/lottie/robot.json site/index.html
git commit -m "feat(landing): bespoke robot Lottie generator + asset + lottie-web"
```

---

## Task 2: Control Room section + monitor

**Files:**
- Modify: `site/index.html` — section markup after `#showcase`; monitor CSS before `</style>`

- [ ] **Step 1: Insert the Control Room section**

Find the showcase section's closing tag followed by the screenshots comment. The anchor (appears once) is:
```
<!-- ── SCREENSHOTS ──────────────────────────────────────────────────────── -->
```
Insert the following IMMEDIATELY BEFORE that comment:
```html
<!-- ── CONTROL ROOM — monitor streaming simulated portal events ──────────── -->
<section id="control-room">
  <div class="kicker" data-reveal>control room · live</div>
  <h2 data-reveal>Your fleet, on one screen</h2>
  <p class="lead" data-reveal>A simulated peek at what the portal streams while your agents work — runs, cost, merges, guardrails and campaigns, live.</p>
  <div class="cr-stage" data-reveal>
    <div id="fx-screen" class="cr-monitor">
      <div id="fx-screen-ui" class="cr-screen">
        <div class="cr-ui-head"><span class="cr-ui-dot"></span> fleet · mission control</div>
        <div class="cr-ui-cards">
          <div class="cr-ui-card"><span>run · auth refactor</span><b>opus-4.8</b></div>
          <div class="cr-ui-card"><span>run · landing</span><b>sonnet-4.6</b></div>
          <div class="cr-ui-card"><span>run · security audit</span><b>codex</b></div>
        </div>
        <div class="cr-ui-gauge"><i></i></div>
      </div>
      <div class="cr-neck"></div>
      <div class="cr-base"></div>
    </div>
    <div id="fx-pops" class="cr-pops" aria-hidden="true">
      <div class="fx-pop" id="fx-pop-run"><span class="fx-pop-ic">◉</span><div class="fx-pop-tx"><b>run a3f9</b><em>opus-4.8 · high · running</em></div></div>
      <div class="fx-pop" id="fx-pop-cost"><span class="fx-pop-ic">◌</span><div class="fx-pop-tx"><b>−74% tokens</b><em>Headroom · $0.38 saved</em></div></div>
      <div class="fx-pop ok" id="fx-pop-merge"><span class="fx-pop-ic">✓</span><div class="fx-pop-tx"><b>PM merged #128</b><em>into main</em></div></div>
      <div class="fx-pop warn" id="fx-pop-budget"><span class="fx-pop-ic">⊘</span><div class="fx-pop-tx"><b>auto-killed</b><em>ceiling $5.00 reached</em></div></div>
      <div class="fx-pop" id="fx-pop-campaign"><span class="fx-pop-ic">⛓</span><div class="fx-pop-tx"><b>campaign planned</b><em>6 subagents spawned</em></div></div>
      <div class="fx-pop" id="fx-pop-notify"><span class="fx-pop-ic">🔔</span><div class="fx-pop-tx"><b>3 awaiting approval</b><em>review &amp; merge</em></div></div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Add monitor CSS**

Insert before the single `</style>`:
```css
  /* ── fx: control room monitor ── */
  #control-room .cr-stage { position: relative; margin-top: var(--space-7); display: flex; justify-content: center; }
  .cr-monitor { width: min(560px, 100%); }
  .cr-screen { position: relative; aspect-ratio: 16 / 10; border-radius: 14px; padding: 16px; overflow: hidden;
    background: linear-gradient(180deg, rgba(255,255,255,.03), transparent), var(--panel);
    border: 1px solid var(--line2); box-shadow: 0 30px 80px -30px rgba(0,0,0,.8), inset 0 0 0 1px rgba(255,176,0,.06), 0 0 60px -20px rgba(255,176,0,.18); }
  .cr-screen::after { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(0deg, rgba(255,255,255,.02), rgba(255,255,255,.02) 1px, transparent 1px, transparent 3px); }
  .cr-ui-head { font-family: var(--display); font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--faint); display: flex; align-items: center; gap: 8px; }
  .cr-ui-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--amber); box-shadow: 0 0 8px var(--amber); }
  .cr-ui-cards { display: grid; gap: 8px; margin: 14px 0; }
  .cr-ui-card { display: flex; justify-content: space-between; align-items: center; font-family: var(--monoF); font-size: 11.5px; color: var(--dim); border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: rgba(0,0,0,.25); }
  .cr-ui-card b { color: var(--amber); font-weight: 600; }
  .cr-ui-gauge { height: 8px; border-radius: 4px; background: rgba(255,255,255,.06); overflow: hidden; }
  .cr-ui-gauge > i { display: block; height: 100%; width: 62%; background: linear-gradient(90deg, var(--amberdeep), var(--amber)); }
  .cr-neck { width: 14px; height: 22px; margin: 0 auto; background: var(--panel2); border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
  .cr-base { width: 120px; height: 10px; margin: 0 auto; border-radius: 0 0 8px 8px; background: var(--panel2); border: 1px solid var(--line); }
```

- [ ] **Step 3: Verify the section renders + reveals**

Navigate. `playwright_evaluate`:
```js
(async () => {
  document.documentElement.style.scrollBehavior='auto';
  const cr = document.getElementById('control-room');
  cr.scrollIntoView({block:'center'});
  await new Promise(r=>{let n=0;const t=()=>{(++n<20)?requestAnimationFrame(t):r();};requestAnimationFrame(t);});
  return { exists: !!cr, screen: !!document.getElementById('fx-screen'),
    headerRevealed: getComputedStyle(cr.querySelector('.kicker')).opacity,
    monitorW: Math.round(document.querySelector('.cr-screen').getBoundingClientRect().width) };
})();
```
Expected: `exists:true, screen:true, headerRevealed:"1", monitorW` > 200. Screenshot `cr-task2`. `console_logs type:error` → empty.

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): Control Room section + monitor"
```

---

## Task 3: Popup cycle system

**Files:**
- Modify: `site/index.html` — popup CSS before `</style>`; popup `<script>` before `</body>`

- [ ] **Step 1: Add popup CSS**

Insert before `</style>`:
```css
  /* ── fx: control room popups ── */
  .cr-pops { position: absolute; top: 6%; right: max(8px, calc(50% - 470px)); width: 230px; height: 84%; pointer-events: none; }
  @media (max-width: 980px) { .cr-pops { position: static; width: 100%; height: auto; margin-top: 18px; } }
  .fx-pop { position: absolute; right: 0; bottom: 0; width: 100%;
    display: flex; align-items: center; gap: 10px; padding: 11px 13px; border-radius: 10px;
    background: linear-gradient(180deg, rgba(255,255,255,.03), transparent), rgba(12,14,19,.92);
    border: 1px solid var(--line2); box-shadow: 0 18px 50px -22px rgba(0,0,0,.85);
    opacity: 0; transform: translateY(14px) scale(.96); will-change: opacity, transform;
    transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
  .fx-pop.show { opacity: 1; transform: none; }
  .fx-pop-ic { font-size: 16px; color: var(--amber); flex: none; }
  .fx-pop.ok .fx-pop-ic { color: var(--green); }
  .fx-pop.warn .fx-pop-ic { color: var(--red); }
  .fx-pop-tx { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
  .fx-pop-tx b { font-family: var(--display); font-size: 13px; letter-spacing: .02em; color: var(--ink); }
  .fx-pop-tx em { font-family: var(--monoF); font-size: 10.5px; font-style: normal; color: var(--faint); }
  /* static (reduced-motion / fallback) list mode */
  .cr-pops.static { position: static; width: 100%; height: auto; margin-top: 18px; display: flex; flex-direction: column; gap: 10px; }
  .cr-pops.static .fx-pop { position: static; opacity: 1; transform: none; transition: none; }
  @media (prefers-reduced-motion: reduce) { .fx-pop { transition: none; } }
```

- [ ] **Step 2: Add the popup cycle script**

Insert before `</body>`:
```html
<!-- ── fx: control-room popup stream ── -->
<script>
(() => {
  const start = () => {
    const host = document.getElementById('fx-pops');
    const cr = document.getElementById('control-room');
    if (!host || !cr) return;
    const pops = [...host.querySelectorAll('.fx-pop')];
    const reduce = window.__reduceMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { host.classList.add('static'); return; }
    let i = 0, timer = null, inView = false;
    function next() {
      pops.forEach((p) => p.classList.remove('show'));
      const p = pops[i % pops.length]; i++;
      p.classList.add('show');
      timer = setTimeout(() => { p.classList.remove('show'); timer = setTimeout(next, 360); }, 2200);
    }
    new IntersectionObserver((es) => {
      for (const e of es) {
        inView = e.isIntersecting;
        if (inView && !timer) next();
        else if (!inView && timer) { clearTimeout(timer); timer = null; pops.forEach((p) => p.classList.remove('show')); }
      }
    }, { threshold: 0.25 }).observe(cr);
  };
  if (document.readyState !== 'loading') start(); else addEventListener('DOMContentLoaded', start);
})();
</script>
```

- [ ] **Step 3: Verify popups cycle in view + pause offscreen**

Navigate. `playwright_evaluate`:
```js
(async () => {
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.documentElement.style.scrollBehavior='auto';
  document.getElementById('control-room').scrollIntoView({block:'center'});
  await wait(300);
  const shownA = document.querySelectorAll('#fx-pops .fx-pop.show').length;
  await wait(2700);
  const idsSeen = document.querySelector('#fx-pops .fx-pop.show')?.id || null;
  // scroll away → should pause (no show)
  window.scrollTo(0,0); await wait(400);
  const shownAway = document.querySelectorAll('#fx-pops .fx-pop.show').length;
  return { shownInView: shownA, oneShownId: idsSeen, shownAfterScrollAway: shownAway };
})();
```
Expected: `shownInView` is 1, `oneShownId` is a non-null `fx-pop-*`, `shownAfterScrollAway` is 0. `console_logs type:error` → empty.

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): control-room popup event stream (engine-gated, a11y)"
```

---

## Task 4: Robot scroll-guide overlay

**Files:**
- Modify: `site/index.html` — `#fx-robot` markup after `</nav>`; robot CSS before `</style>`; robot `<script>` before `</body>`

- [ ] **Step 1: Add the robot markup**

Find `</nav>` (the topnav close, appears once) and insert immediately after it:
```html
<div id="fx-robot" aria-hidden="true"><div id="fx-robot-lottie"></div></div>
```

- [ ] **Step 2: Add robot CSS**

Insert before `</style>`:
```css
  /* ── fx: agent-robot scroll guide ── */
  #fx-robot { position: fixed; top: 0; left: 0; width: 88px; height: 88px; z-index: 60; pointer-events: none;
    opacity: 0; transition: opacity .45s var(--ease-out); transform: translate3d(-200px,-200px,0); }
  #fx-robot.on { opacity: 1; }
  #fx-robot-lottie { width: 100%; height: 100%; filter: drop-shadow(0 8px 22px rgba(255,176,0,.28)); }
  @media (prefers-reduced-motion: reduce) { #fx-robot { display: none !important; } }
```

- [ ] **Step 3: Add the robot script**

Insert before `</body>` (after the popup script is fine):
```html
<!-- ── fx: agent-robot scroll guide ── -->
<script>
(() => {
  const start = () => {
    const robot = document.getElementById('fx-robot');
    const mount = document.getElementById('fx-robot-lottie');
    const cr = document.getElementById('control-room');
    if (!robot || !mount) return;
    const reduce = window.__reduceMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return; // CSS hides it
    const lerp = window.__lerp || ((a,b,k)=>a+(b-a)*k);

    // lazy Lottie build
    let anim = null;
    function build() { if (anim || !window.lottie) return; anim = window.lottie.loadAnimation({ container: mount, renderer: 'svg', loop: true, autoplay: true, path: 'assets/lottie/robot.json' }); }
    // wait for lottie global, then build
    (function waitL(n){ if (window.lottie) build(); else if (n>0) setTimeout(()=>waitL(n-1), 60); })(50);
    document.addEventListener('visibilitychange', () => { if (!anim) return; document.hidden ? anim.pause() : anim.play(); });

    const flight = () => window.innerWidth >= 1200; // enough side gutter to fly
    let crVis = false;
    if (cr) new IntersectionObserver((es)=>{ for (const e of es) crVis = e.isIntersecting; if (window.__ticker) window.__ticker.wake(); }, { threshold: 0.2 }).observe(cr);

    let curX = window.innerWidth - 120, curY = window.innerHeight * 0.45;
    function target() {
      const vw = window.innerWidth, vh = window.innerHeight;
      if (crVis && cr) { // dock beside the monitor
        const r = cr.getBoundingClientRect();
        const tx = flight() ? Math.min(vw - 110, vw * 0.5 + 250) : (vw - 104);
        const ty = Math.max(80, Math.min(vh - 150, r.top + r.height * 0.32));
        return [tx, ty];
      }
      const sy = window.scrollY;
      const tx = vw - 128 - 26 * Math.sin(sy / 320);
      const ty = Math.max(96, Math.min(vh - 150, vh * 0.42 + 72 * Math.sin(sy / 260)));
      return [tx, ty];
    }
    function frame() {
      // visible only when flying (wide) OR docked at control room
      const show = flight() || crVis;
      robot.classList.toggle('on', show);
      const [tx, ty] = target();
      curX = lerp(curX, tx, 0.12); curY = lerp(curY, ty, 0.12);
      robot.style.transform = `translate3d(${curX.toFixed(1)}px, ${curY.toFixed(1)}px, 0)`;
      return (Math.abs(curX - tx) > 0.3 || Math.abs(curY - ty) > 0.3);
    }
    if (window.__ticker) { window.__ticker.subscribe(frame); window.__ticker.wake(); }
    else { addEventListener('scroll', frame, { passive: true }); frame(); }
  };
  if (window.__ticker) start(); else addEventListener('DOMContentLoaded', start);
})();
</script>
```

- [ ] **Step 4: Verify robot on desktop (≥1200) — renders, plays, tracks scroll, docks**

Navigate (default 1280×800 ≥1200). `playwright_evaluate`:
```js
(async () => {
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.documentElement.style.scrollBehavior='auto';
  await wait(600); // let lottie build
  const robot = document.getElementById('fx-robot');
  const built = !!document.querySelector('#fx-robot-lottie svg');
  const onEarly = robot.classList.contains('on');
  const t1 = robot.style.transform;
  // scroll down a bit, robot target should change
  window.scrollTo(0, 1400); await wait(600);
  const t2 = robot.style.transform;
  // dock at control room
  document.getElementById('control-room').scrollIntoView({block:'center'}); await wait(700);
  const docked = robot.classList.contains('on');
  return { built, onEarly, movedWithScroll: t1 !== t2, dockedVisible: docked, winW: innerWidth };
})();
```
Expected: `built:true, onEarly:true, movedWithScroll:true, dockedVisible:true`. `console_logs type:error` → empty. Screenshot `cr-robot-desktop`.

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat(landing): Lottie agent-robot scroll-guide + control-room dock"
```

---

## Task 5: A11y / mobile / cross-width verification + id audit

**Files:** `site/index.html` only if a gap is found.

- [ ] **Step 1: id audit (every animated node addressable)**

Navigate. `playwright_evaluate`:
```js
(() => {
  const ids = ['fx-robot','fx-robot-lottie','fx-screen','fx-screen-ui','fx-pop-run','fx-pop-cost','fx-pop-merge','fx-pop-budget','fx-pop-campaign','fx-pop-notify'];
  return { missing: ids.filter(id=>!document.getElementById(id)) };
})();
```
Expected: `{ missing: [] }`.

- [ ] **Step 2: Mobile (375) — robot docked only, popups stack, no overflow**

`playwright_close`, then `playwright_navigate` width 375 height 812. `playwright_evaluate`:
```js
(async () => {
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.documentElement.style.scrollBehavior='auto';
  await wait(500);
  const robot = document.getElementById('fx-robot');
  const onAtTop = robot.classList.contains('on'); // should be false (not flying, cr not in view)
  // scroll control room into view
  document.getElementById('control-room').scrollIntoView({block:'center'}); await wait(700);
  const onAtCR = robot.classList.contains('on'); // docked → true
  const popsStatic = getComputedStyle(document.getElementById('fx-pops')).position; // static via media query
  let overflow=false; const max=document.documentElement.scrollHeight-innerHeight;
  for (let y=0;y<=max;y+=80){window.scrollTo(0,y);await wait(16);if(document.documentElement.scrollWidth>innerWidth+1)overflow=true;}
  window.scrollTo(0,0);
  return { winW: innerWidth, onAtTop, onAtCR, popsPosition: popsStatic, horizontalOverflow: overflow };
})();
```
Expected: `winW:375, onAtTop:false, onAtCR:true, popsPosition:"static", horizontalOverflow:false`. Screenshot `cr-mobile`.

- [ ] **Step 3: Reduced-motion path (inspection + static popups)**

The Playwright MCP can't emulate `prefers-reduced-motion`; verify the guards exist and the static fallback works by forcing it. `playwright_close`, `playwright_navigate` width 1280. `playwright_evaluate`:
```js
(() => {
  // CSS guard present?
  const hasRobotGuard = [...document.styleSheets].some(s=>{try{return [...s.cssRules].some(r=>r.cssText.includes('prefers-reduced-motion')&&r.cssText.includes('fx-robot'))}catch(e){return false}});
  // force the popup static fallback to confirm it renders all 6 as a list
  const host=document.getElementById('fx-pops'); host.classList.add('static');
  const allVisible=[...host.querySelectorAll('.fx-pop')].every(p=>getComputedStyle(p).opacity==='1');
  const stacked=getComputedStyle(host).flexDirection==='column';
  host.classList.remove('static');
  return { hasRobotReducedMotionGuard: hasRobotGuard, staticShowsAll: allVisible, staticStacked: stacked };
})();
```
Expected: `hasRobotReducedMotionGuard:true, staticShowsAll:true, staticStacked:true`. (Note in the report: live reduced-motion emulation unavailable via MCP; verified via CSS-guard inspection + forced static fallback + code review.)

- [ ] **Step 4: Desktop regression — hero + prior sections intact, no errors**

`playwright_evaluate`:
```js
(async () => {
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.documentElement.style.scrollBehavior='auto';
  for (let y=0;y<=document.documentElement.scrollHeight-innerHeight;y+=200){window.scrollTo(0,y);await wait(20);}
  window.scrollTo(0,0);
  return { sceneCanvas: !!document.querySelector('#scene canvas'), steps: document.querySelectorAll('#steps .step').length, controlRoom: !!document.getElementById('control-room'), docW: document.documentElement.scrollWidth, winW: innerWidth };
})();
```
Expected: `sceneCanvas:true, steps:5, controlRoom:true, docW===winW`. `console_logs type:error` → empty.

- [ ] **Step 5: Fix any gaps, then final commit**

If steps 1–4 surfaced issues, fix inline (smallest change), re-verify the affected step. Then:
```bash
git add site/index.html
git commit -m "test(landing): control-room + robot a11y/mobile/cross-width verification"
```

---

## Self-review notes (author)

- **Spec coverage:** Lottie runtime + bespoke robot asset/generator (T1) · Control Room section + monitor (T2) · popup stream with simulated feature-authentic events (T3) · robot scroll-guide + dock + lazy Lottie + a11y/mobile gates (T4) · id audit + mobile + reduced-motion + regression (T5). Hybrid assets: bespoke robot built; the optional CC0 ambient is intentionally **omitted** (YAGNI — not needed for the effect; can add later).
- **Type/name consistency:** engine globals consumed: `window.__ticker.{subscribe,wake}`, `window.__lerp`, `window.__reduceMotion`. New ids: `#fx-robot`, `#fx-robot-lottie`, `#fx-screen`, `#fx-screen-ui`, `#fx-pop-{run,cost,merge,budget,campaign,notify}`, `#fx-pops`. Classes: `.cr-monitor/.cr-screen/.cr-pops/.fx-pop(.show/.ok/.warn/.static)`. Used identically across tasks.
- **Honesty:** popups are clearly "live"-labeled simulations (matching the existing showcase tiles); values illustrative, events mirror real features. No copy elsewhere changed.
- **Perf:** exactly one Lottie player (robot); monitor + popups are CSS/DOM; robot position rides the demand-driven ticker (idles when not scrolling); Lottie pauses on tab-hidden; reduced-motion disables the robot entirely.
