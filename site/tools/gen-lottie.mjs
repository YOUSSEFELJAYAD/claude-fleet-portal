// Generates a bespoke, on-brand agent-robot Lottie with TWO working arms and
// per-state reaction segments on one timeline:
//   loop[0-45] success[46-80] halt[81-110] pulse[111-135]  (30fps, op=135)
// Run: node site/tools/gen-lottie.mjs → writes site/assets/lottie/robot.js (window.__fxRobotData)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/lottie/robot.js', import.meta.url));

const amber = [1, 0.69, 0], teal = [0.224, 0.831, 0.812], panel = [0.086, 0.098, 0.133], ink = [0.914, 0.906, 0.875];
const E = { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] } };
const P = (t, v, last = false) => last ? { t, s: v } : { t, s: v, ...E };       // position keyframe (2D/3D)
const S = (t, v, last = false) => last ? { t, s: [v] } : { t, s: [v], ...E };   // 1D keyframe (opacity)

const fill = (c) => ({ ty: 'fl', c: { a: 0, k: [...c, 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'fl' });
const rect = (w, h, x, y, r = 0) => ({ ty: 'rc', d: 1, s: { a: 0, k: [w, h] }, p: { a: 0, k: [x, y] }, r: { a: 0, k: r }, nm: 'rc' });
const ell = (w, h, x, y) => ({ ty: 'el', d: 1, s: { a: 0, k: [w, h] }, p: { a: 0, k: [x, y] }, nm: 'el' });
const tr0 = () => ({ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, nm: 'tr' });
const trP = (kfs) => ({ ty: 'tr', p: { a: 1, k: kfs }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, nm: 'tr' });
const trO = (okfs) => ({ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 1, k: okfs }, nm: 'tr' });
const grp = (nm, shape, color, transform = tr0()) => ({ ty: 'gr', nm, it: [shape, fill(color), transform] });

// arm pump offsets (2D) across the whole timeline
const armL_kf = [
  P(0,[0,0]),P(11,[0,5]),P(22,[0,0]),P(33,[0,-5]),P(45,[0,0]),
  P(46,[0,0]),P(56,[0,-16]),P(68,[0,-16]),P(80,[0,0]),
  P(81,[0,0]),P(88,[0,6]),P(100,[0,6]),P(110,[0,0]),
  P(111,[0,0]),P(117,[0,-6]),P(123,[0,5]),P(129,[0,-3]),P(135,[0,0],true),
];
const armR_kf = [
  P(0,[0,0]),P(11,[0,-5]),P(22,[0,0]),P(33,[0,5]),P(45,[0,0]),
  P(46,[0,0]),P(56,[0,-16]),P(68,[0,-16]),P(80,[0,0]),
  P(81,[0,0]),P(88,[0,6]),P(100,[0,6]),P(110,[0,0]),
  P(111,[0,0]),P(117,[0,6]),P(123,[0,-5]),P(129,[0,3]),P(135,[0,0],true),
];
const layerP = [
  P(0,[120,120,0]),P(22,[120,112,0]),P(45,[120,120,0]),
  P(46,[120,120,0]),P(56,[120,98,0]),P(68,[120,124,0]),P(80,[120,120,0]),
  P(81,[120,120,0]),P(86,[128,120,0]),P(91,[112,120,0]),P(96,[126,120,0]),P(101,[115,120,0]),P(110,[120,120,0]),
  P(111,[120,120,0]),P(120,[120,115,0]),P(135,[120,120,0],true),
];
const layerS = [
  P(0,[100,100,100]),P(46,[100,100,100]),P(54,[110,110,100]),P(70,[100,100,100]),
  P(111,[100,100,100]),P(119,[108,108,100]),P(130,[100,100,100]),P(135,[100,100,100],true),
];
const flick = [];
for (let f = 0, on = true; f <= 135; f += 11, on = !on) flick.push(S(f, on ? 100 : 45, f + 11 > 135));

const trArmL = trP(armL_kf), trArmR = trP(armR_kf);

const shapes = [
  grp('pupil', ell(12, 12, 120, 112), panel),
  grp('visor', rect(60, 20, 120, 112, 10), amber),
  grp('antennaTip', ell(9, 9, 120, 70), teal),
  grp('antenna', rect(3, 18, 120, 82), ink),
  grp('armL_fore', rect(7, 22, 70, 150, 3), ink, trArmL),
  grp('armL_hand', ell(13, 13, 68, 165), teal, trArmL),
  grp('armR_fore', rect(7, 22, 170, 150, 3), ink, trArmR),
  grp('armR_hand', ell(13, 13, 172, 165), teal, trArmR),
  grp('thrusterL', rect(16, 10, 100, 162, 5), teal, trO(flick)),
  grp('thrusterR', rect(16, 10, 140, 162, 5), teal, trO(flick)),
  grp('body', rect(96, 70, 120, 120, 18), panel),
  grp('bodyRim', rect(102, 76, 120, 120, 21), amber),
];

const anim = {
  v: '5.7.4', fr: 30, ip: 0, op: 135, w: 240, h: 240, nm: 'fx-robot', ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: 'robot', sr: 1,
    ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 1, k: layerP }, a: { a: 0, k: [120, 120, 0] }, s: { a: 1, k: layerS } },
    ao: 0, shapes, ip: 0, op: 135, st: 0, bm: 0,
  }],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, 'window.__fxRobotData=' + JSON.stringify(anim) + ';\n');
console.log('wrote', OUT, 'op=' + anim.op);
