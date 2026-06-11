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

// packagers and codesign both mishandle symlinks (electron-builder re-links them, osx-sign
// stats them) — make the payload symlink-free: realize valid links, drop dangling ones.
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
