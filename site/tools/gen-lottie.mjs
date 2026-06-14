// Generates a bespoke, on-brand agent-robot Lottie (OSS / self-owned).
// Run: node site/tools/gen-lottie.mjs  → writes site/assets/lottie/robot.js (window.__fxRobotData)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/lottie/robot.js', import.meta.url));

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

const flicker = { a: 1, k: [
  { t: 0,  s: [100], ...ease }, { t: 15, s: [45], ...ease },
  { t: 30, s: [100], ...ease }, { t: 45, s: [60], ...ease }, { t: 60, s: [100] },
] };

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
writeFileSync(OUT, 'window.__fxRobotData=' + JSON.stringify(anim) + ';\n');
console.log('wrote', OUT);
