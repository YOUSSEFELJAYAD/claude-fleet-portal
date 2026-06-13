import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const tokens = {
  background: '#0a0b0e',
  panel: '#101217',
  ink: '#e9e7df',
  dim: '#9aa1ab',
  faint: '#5b626d',
  amber: '#ffb000',
  teal: '#39d4cf',
  coral: '#e8704a',
  violet: '#b08cff',
  green: '#54e08a',
};

const toolDir = path.dirname(path.resolve(process.argv[1] ?? 'site/tools/gen-art.mjs'));
const outDir = path.resolve(toolDir, '../assets/gen');

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function num(value, digits = 2) {
  return Number(value.toFixed(digits)).toString();
}

function svgWrap({ width, height, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-hidden="true">
${body}
</svg>
`;
}

function gridPattern(id, size, opacity, strongEvery = 4) {
  const strong = size * strongEvery;
  return `<pattern id="${id}-minor" width="${size}" height="${size}" patternUnits="userSpaceOnUse">
  <path d="M ${size} 0 H 0 V ${size}" fill="none" stroke="#ffffff" stroke-opacity="${opacity}" stroke-width="1"/>
</pattern>
<pattern id="${id}-major" width="${strong}" height="${strong}" patternUnits="userSpaceOnUse">
  <path d="M ${strong} 0 H 0 V ${strong}" fill="none" stroke="#ffffff" stroke-opacity="${num(opacity * 1.45, 4)}" stroke-width="1"/>
</pattern>`;
}

function scanlinePattern(id, opacity = 0.018) {
  return `<pattern id="${id}" width="1" height="4" patternUnits="userSpaceOnUse">
  <path d="M 0 .5 H 1" stroke="#ffffff" stroke-opacity="${opacity}" stroke-width="1"/>
</pattern>`;
}

function heroNodes() {
  const rng = makeRng(0xC0DE1600);
  const nodes = [];
  while (nodes.length < 30) {
    const x = rng() * 1600;
    const y = rng() * 1000;
    const inCalmCenter = Math.abs(x - 800) < 300 && Math.abs(y - 500) < 190;
    if (inCalmCenter && rng() < 0.72) continue;

    const warm = rng() > 0.38;
    const radius = 1.25 + rng() * 2.45;
    const opacity = inCalmCenter ? 0.08 + rng() * 0.05 : 0.1 + rng() * 0.16;
    nodes.push(`<circle cx="${num(x)}" cy="${num(y)}" r="${num(radius)}" fill="${warm ? tokens.amber : tokens.teal}" fill-opacity="${num(opacity, 3)}"/>`);
  }
  return nodes.join('\n  ');
}

function heroBackdropSvg() {
  const ringCenter = { x: 980, y: 465 };
  const rings = [92, 154, 220, 290, 365, 445]
    .map((r, i) => `<circle cx="${ringCenter.x}" cy="${ringCenter.y}" r="${r}" fill="none" stroke="${tokens.amber}" stroke-opacity="${num(0.062 - i * 0.004, 3)}" stroke-width="${i === 0 ? 1.2 : 1}"/>`)
    .join('\n  ');
  const spokes = Array.from({ length: 12 }, (_, i) => {
    const angle = (i * Math.PI * 2) / 12 - Math.PI / 10;
    const x1 = ringCenter.x + Math.cos(angle) * 80;
    const y1 = ringCenter.y + Math.sin(angle) * 80;
    const x2 = ringCenter.x + Math.cos(angle) * 455;
    const y2 = ringCenter.y + Math.sin(angle) * 455;
    return `<path d="M ${num(x1)} ${num(y1)} L ${num(x2)} ${num(y2)}" stroke="${tokens.amber}" stroke-opacity="0.026" stroke-width="1"/>`;
  }).join('\n  ');

  return svgWrap({
    width: 1600,
    height: 1000,
    body: `<defs>
${gridPattern('hero-grid', 44, 0.02)}
${scanlinePattern('hero-scan', 0.014)}
<radialGradient id="hero-amber-glow" cx="84%" cy="-2%" r="72%">
  <stop offset="0%" stop-color="${tokens.amber}" stop-opacity="0.07"/>
  <stop offset="48%" stop-color="${tokens.amber}" stop-opacity="0.035"/>
  <stop offset="100%" stop-color="${tokens.amber}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="hero-teal-glow" cx="-4%" cy="105%" r="66%">
  <stop offset="0%" stop-color="${tokens.teal}" stop-opacity="0.046"/>
  <stop offset="56%" stop-color="${tokens.teal}" stop-opacity="0.021"/>
  <stop offset="100%" stop-color="${tokens.teal}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="hero-vignette" cx="50%" cy="48%" r="72%">
  <stop offset="58%" stop-color="${tokens.background}" stop-opacity="0"/>
  <stop offset="100%" stop-color="${tokens.background}" stop-opacity="0.42"/>
</radialGradient>
</defs>
<rect width="1600" height="1000" fill="${tokens.background}"/>
<rect width="1600" height="1000" fill="url(#hero-amber-glow)"/>
<rect width="1600" height="1000" fill="url(#hero-teal-glow)"/>
<rect width="1600" height="1000" fill="url(#hero-grid-minor)"/>
<rect width="1600" height="1000" fill="url(#hero-grid-major)"/>
<rect width="1600" height="1000" fill="url(#hero-scan)"/>
<g opacity="0.9">
  ${rings}
  ${spokes}
  <path d="M 1110 178 A 305 305 0 0 1 1292 403" fill="none" stroke="${tokens.amber}" stroke-opacity="0.09" stroke-width="1.25"/>
  <path d="M 691 559 A 338 338 0 0 1 831 186" fill="none" stroke="${tokens.amber}" stroke-opacity="0.045" stroke-width="1"/>
  <path d="M 1207 694 A 302 302 0 0 1 953 758" fill="none" stroke="${tokens.teal}" stroke-opacity="0.038" stroke-width="1"/>
</g>
<g>
  ${heroNodes()}
</g>
<rect width="1600" height="1000" fill="url(#hero-vignette)"/>`,
  });
}

function topoPath(baseY, phase, amp, width = 1600) {
  const points = [];
  for (let x = -40; x <= width + 40; x += 48) {
    const y = baseY
      + Math.sin(x * 0.010 + phase) * amp
      + Math.sin(x * 0.023 + phase * 0.7) * amp * 0.32
      + Math.cos(x * 0.006 - phase) * amp * 0.22;
    points.push(`${x === -40 ? 'M' : 'L'} ${num(x)} ${num(y)}`);
  }
  return points.join(' ');
}

function topoLoop(cx, cy, rx, ry, wobble, phase) {
  const points = [];
  for (let i = 0; i <= 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    const offset = 1 + Math.sin(a * 3 + phase) * wobble + Math.cos(a * 5 - phase) * wobble * 0.42;
    const x = cx + Math.cos(a) * rx * offset;
    const y = cy + Math.sin(a) * ry * offset;
    points.push(`${i === 0 ? 'M' : 'L'} ${num(x)} ${num(y)}`);
  }
  return `${points.join(' ')} Z`;
}

function dividerTopoSvg() {
  const fieldLines = Array.from({ length: 9 }, (_, i) => {
    const base = -25 + i * 21;
    const opacity = i % 2 === 0 ? 0.043 : 0.032;
    return `<path d="${topoPath(base, i * 0.82, 8 + (i % 3) * 2)}" fill="none" stroke="#ffffff" stroke-opacity="${opacity}" stroke-width="1"/>`;
  }).join('\n  ');

  const loops = [
    [330, 54, 112, 31, 0.07, 0.4],
    [348, 54, 78, 22, 0.06, 1.1],
    [1110, 67, 154, 42, 0.055, 2.2],
    [1115, 67, 108, 30, 0.055, 2.9],
    [1305, 31, 68, 20, 0.07, 0.8],
  ].map(([cx, cy, rx, ry, wobble, phase], i) => (
    `<path d="${topoLoop(cx, cy, rx, ry, wobble, phase)}" fill="none" stroke="#ffffff" stroke-opacity="${i % 2 ? 0.035 : 0.046}" stroke-width="1"/>`
  )).join('\n  ');

  return svgWrap({
    width: 1600,
    height: 120,
    body: `<defs>
${scanlinePattern('topo-scan', 0.012)}
<linearGradient id="topo-fade" x1="0" x2="1" y1="0" y2="0">
  <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
  <stop offset="14%" stop-color="#ffffff" stop-opacity="1"/>
  <stop offset="86%" stop-color="#ffffff" stop-opacity="1"/>
  <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
</linearGradient>
<mask id="topo-mask">
  <rect width="1600" height="120" fill="url(#topo-fade)"/>
</mask>
</defs>
<rect width="1600" height="120" fill="${tokens.background}" fill-opacity="0"/>
<g mask="url(#topo-mask)">
  ${fieldLines}
  ${loops}
  <path d="M 0 60 H 1600" stroke="${tokens.amber}" stroke-opacity="0.04" stroke-width="1"/>
  <rect width="1600" height="120" fill="url(#topo-scan)"/>
</g>`,
  });
}

function armPath(cx, cy, angleDeg, length, curl) {
  const angle = (angleDeg * Math.PI) / 180;
  const normal = angle + Math.PI / 2;
  const sx = cx + Math.cos(angle) * 54;
  const sy = cy + Math.sin(angle) * 54;
  const ex = cx + Math.cos(angle) * length;
  const ey = cy + Math.sin(angle) * length * 0.68;
  const c1x = cx + Math.cos(angle) * length * 0.34 + Math.cos(normal) * curl;
  const c1y = cy + Math.sin(angle) * length * 0.25 + Math.sin(normal) * curl;
  const c2x = cx + Math.cos(angle) * length * 0.72 - Math.cos(normal) * curl * 0.72;
  const c2y = cy + Math.sin(angle) * length * 0.54 - Math.sin(normal) * curl * 0.72;
  return {
    path: `M ${num(sx)} ${num(sy)} C ${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(ex)} ${num(ey)}`,
    end: { x: ex, y: ey },
  };
}

function ogCore() {
  const cx = 600;
  const cy = 247;
  const arms = [
    [-156, 252, -38, tokens.amber],
    [-116, 230, 28, tokens.coral],
    [-74, 218, -30, tokens.amber],
    [-32, 248, 36, tokens.amber],
    [28, 250, -32, tokens.amber],
    [70, 218, 28, tokens.coral],
    [114, 232, -30, tokens.amber],
    [154, 252, 40, tokens.amber],
  ];
  const armMarkup = arms.map(([angle, length, curl, color], i) => {
    const arm = armPath(cx, cy, angle, length, curl);
    return `<path d="${arm.path}" fill="none" stroke="${color}" stroke-opacity="${color === tokens.coral ? 0.55 : 0.42}" stroke-width="${i % 2 === 0 ? 1.35 : 1.1}" stroke-linecap="round"/>
  <circle cx="${num(arm.end.x)}" cy="${num(arm.end.y)}" r="${color === tokens.coral ? 5.2 : 4.5}" fill="${color}" fill-opacity="${color === tokens.coral ? 0.76 : 0.64}"/>
  <circle cx="${num(arm.end.x)}" cy="${num(arm.end.y)}" r="${color === tokens.coral ? 10 : 8.5}" fill="none" stroke="${color}" stroke-opacity="0.16" stroke-width="1"/>`;
  }).join('\n  ');

  const rings = [36, 60, 86, 116]
    .map((radius, i) => `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${tokens.amber}" stroke-opacity="${num(0.78 - i * 0.15, 2)}" stroke-width="${i === 0 ? 2 : 1.25}"/>`)
    .join('\n  ');

  return `<g>
  ${armMarkup}
  <circle cx="${cx}" cy="${cy}" r="132" fill="${tokens.amber}" fill-opacity="0.025"/>
  ${rings}
  <path d="M ${cx - 116} ${cy} H ${cx - 82} M ${cx + 82} ${cy} H ${cx + 116} M ${cx} ${cy - 116} V ${cy - 82} M ${cx} ${cy + 82} V ${cy + 116}" stroke="${tokens.amber}" stroke-opacity="0.48" stroke-width="1.1"/>
  <circle cx="${cx}" cy="${cy}" r="18" fill="${tokens.panel}" stroke="${tokens.amber}" stroke-opacity="0.88" stroke-width="1.5"/>
  <circle cx="${cx}" cy="${cy}" r="5" fill="${tokens.teal}" fill-opacity="0.82"/>
</g>`;
}

function ogImageSvg() {
  return svgWrap({
    width: 1200,
    height: 630,
    body: `<defs>
${gridPattern('og-grid', 40, 0.026)}
${scanlinePattern('og-scan', 0.012)}
<radialGradient id="og-amber-glow" cx="88%" cy="-8%" r="82%">
  <stop offset="0%" stop-color="${tokens.amber}" stop-opacity="0.105"/>
  <stop offset="45%" stop-color="${tokens.amber}" stop-opacity="0.045"/>
  <stop offset="100%" stop-color="${tokens.amber}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="og-core-glow" cx="50%" cy="39%" r="32%">
  <stop offset="0%" stop-color="${tokens.amber}" stop-opacity="0.15"/>
  <stop offset="52%" stop-color="${tokens.amber}" stop-opacity="0.045"/>
  <stop offset="100%" stop-color="${tokens.amber}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="og-vignette" cx="50%" cy="46%" r="74%">
  <stop offset="55%" stop-color="${tokens.background}" stop-opacity="0"/>
  <stop offset="100%" stop-color="${tokens.background}" stop-opacity="0.55"/>
</radialGradient>
</defs>
<rect width="1200" height="630" fill="${tokens.background}"/>
<rect width="1200" height="630" fill="url(#og-amber-glow)"/>
<rect width="1200" height="630" fill="url(#og-grid-minor)"/>
<rect width="1200" height="630" fill="url(#og-grid-major)"/>
<rect width="1200" height="630" fill="url(#og-scan)"/>
<rect width="1200" height="630" fill="url(#og-core-glow)"/>
<path d="M 76 94 H 244 M 956 94 H 1124 M 76 536 H 244 M 956 536 H 1124" stroke="${tokens.amber}" stroke-opacity="0.42" stroke-width="1.25"/>
<path d="M 94 76 V 164 M 1106 76 V 164 M 94 466 V 554 M 1106 466 V 554" stroke="${tokens.amber}" stroke-opacity="0.28" stroke-width="1"/>
${ogCore()}
<text x="600" y="463" text-anchor="middle" fill="${tokens.ink}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="64" font-weight="800" letter-spacing="4">CLAUDE FLEET PORTAL</text>
<text x="600" y="514" text-anchor="middle" fill="${tokens.dim}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="26" font-weight="500">mission control for Claude &#183; Codex &#183; OpenCode agents</text>
<g>
  <rect x="501" y="542" width="198" height="38" rx="19" fill="${tokens.panel}" stroke="${tokens.amber}" stroke-opacity="0.32"/>
  <text x="600" y="567" text-anchor="middle" fill="${tokens.green}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="16" font-weight="600" letter-spacing="1.3">MIT &#183; open source</text>
</g>
<rect width="1200" height="630" fill="url(#og-vignette)"/>`,
  });
}

const files = [
  ['hero-backdrop.svg', heroBackdropSvg()],
  ['divider-topo.svg', dividerTopoSvg()],
  ['og-image.svg', ogImageSvg()],
];

mkdirSync(outDir, { recursive: true });

const written = files.map(([name, svg]) => {
  const file = path.join(outDir, name);
  writeFileSync(file, svg, 'utf8');
  return path.relative(process.cwd(), file);
});

console.log('Written files:');
for (const file of written) {
  console.log(`- ${file}`);
}
