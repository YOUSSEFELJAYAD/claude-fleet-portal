/**
 * Bundle the control plane for the desktop app. CJS output (utilityProcess.fork-able from
 * Electron), better-sqlite3 left external (native — provided by desktop/node_modules and
 * rebuilt for Electron's ABI by electron-builder). esbuild does not emulate import.meta.url
 * in CJS, so it is defined to a shimmed equivalent of __filename.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const bundleDir = path.resolve(__dirname, '..', 'bundle');

buildSync({
  entryPoints: [path.resolve(__dirname, '..', '..', 'apps', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(bundleDir, 'server.cjs'),
  external: ['better-sqlite3'],
  define: { 'import.meta.url': '__fleet_import_meta_url' },
  banner: { js: "const __fleet_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});

// The bundled server resolves the PreToolUse permission-gate hook via permissionHookPath()
// (apps/server/src/processManager.ts), which prefers FLEET_PERMISSION_HOOK_PATH. The packaged
// app has no repo `tools/` dir, so copy the hook next to server.cjs at a known path; main.cjs
// points FLEET_PERMISSION_HOOK_PATH at this same location.
const hookSrc = path.resolve(__dirname, '..', '..', 'tools', 'fleet-permission-hook.mjs');
const hookDst = path.join(bundleDir, 'fleet-permission-hook.mjs');
fs.mkdirSync(bundleDir, { recursive: true });
fs.copyFileSync(hookSrc, hookDst);
console.log('copied permission-gate hook →', hookDst);
