/**
 * Assemble the desktop web payload from the Next standalone build:
 *   apps/web/.next/standalone/**           → desktop/web/            (server.js + traced node_modules)
 *   apps/web/.next/static                  → desktop/web/apps/web/.next/static
 *   apps/web/public                        → desktop/web/apps/web/public
 *   tools/mock-claude.mjs (+ fixtures)     → desktop/mock/
 * Requires a prior `FLEET_STANDALONE=1 pnpm build` at the repo root.
 */
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const standalone = path.join(repo, 'apps', 'web', '.next', 'standalone');
const out = path.resolve(__dirname, '..', 'web');

if (!fs.existsSync(path.join(standalone, 'apps', 'web', 'server.js'))) {
  console.error('No standalone build found — run: FLEET_STANDALONE=1 pnpm build (repo root) first.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(standalone, out, { recursive: true, dereference: true });
fs.cpSync(path.join(repo, 'apps', 'web', '.next', 'static'), path.join(out, 'apps', 'web', '.next', 'static'), {
  recursive: true,
  dereference: true,
});
const pub = path.join(repo, 'apps', 'web', 'public');
if (fs.existsSync(pub)) {
  fs.cpSync(pub, path.join(out, 'apps', 'web', 'public'), { recursive: true });
}

// bundled mock (fallback when the claude CLI is absent) + its fixtures
// the mock resolves fixtures as __dirname/../fixtures — mirror the repo layout
const mockOut = path.resolve(__dirname, '..', 'mock');
fs.rmSync(mockOut, { recursive: true, force: true });
fs.mkdirSync(path.join(mockOut, 'tools'), { recursive: true });
fs.cpSync(path.join(repo, 'tools', 'mock-claude.mjs'), path.join(mockOut, 'tools', 'mock-claude.mjs'));
const fixtures = path.join(repo, 'fixtures');
if (fs.existsSync(fixtures)) fs.cpSync(fixtures, path.join(mockOut, 'fixtures'), { recursive: true });

// pnpm's standalone output is a symlink farm: node_modules/.pnpm/<pkg>/node_modules/<pkg> with
// each package's peers as sibling symlinks, reached from the public entry points (apps/web/
// node_modules/next, …) via symlink + realpath. The dereferencing copy above (and scrubSymlinks
// below) realize those entry points into bare copies WITHOUT their peers — so e.g. `next` can no
// longer resolve `styled-jsx` and the forked web server crashes on boot, which the desktop shell
// reports as "web: down". Rebuild a flat, symlink-free node_modules: copy every package out of the
// .pnpm store up to node_modules/<pkg> so plain Node resolution finds them, then drop the store.
function hoistPnpmStore(webRoot) {
  const top = path.join(webRoot, 'node_modules');
  const store = path.join(top, '.pnpm');
  if (!fs.existsSync(store)) return;
  const versionOf = (d) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
  const placed = new Map(); // package name → version; a flat tree can't host two versions of one name
  let n = 0;
  for (const hash of fs.readdirSync(store)) {
    const nm = path.join(store, hash, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    for (const entry of fs.readdirSync(nm)) {
      const names = entry.startsWith('@')
        ? fs.readdirSync(path.join(nm, entry)).map((s) => `${entry}/${s}`)
        : [entry];
      for (const name of names) {
        const src = path.join(nm, name);
        if (!fs.statSync(src).isDirectory()) continue;
        const version = versionOf(src);
        const prev = placed.get(name);
        if (prev !== undefined) {
          if (version && prev && version !== prev) {
            throw new Error(
              `pnpm hoist conflict: ${name} appears as both ${prev} and ${version}; a flat ` +
                'node_modules cannot host both. Revisit copy-web.cjs (e.g. nest the loser).',
            );
          }
          continue; // same version already hoisted
        }
        placed.set(name, version);
        const dst = path.join(top, name);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true, dereference: true });
        n++;
      }
    }
  }
  fs.rmSync(store, { recursive: true, force: true });
  console.log(`hoisted ${n} packages out of the pnpm store → flat node_modules`);
}
hoistPnpmStore(out);

// packagers and codesign both mishandle symlinks (electron-builder re-links them, osx-sign
// stats them) — make the payload symlink-free: realize valid links, drop dangling ones (e.g. any
// node_modules/.bin entries left pointing into the .pnpm store hoistPnpmStore just removed).
function scrubSymlinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real = null;
      try {
        real = fs.realpathSync(p);
      } catch {
        /* dangling */
      }
      fs.rmSync(p, { force: true });
      if (real) fs.cpSync(real, p, { recursive: true, dereference: true });
    } else if (entry.isDirectory()) {
      scrubSymlinks(p);
    }
  }
}
scrubSymlinks(out);

console.log('desktop web payload assembled (symlink-free) →', out);
