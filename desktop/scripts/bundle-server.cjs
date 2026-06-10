/**
 * Bundle the control plane for the desktop app. CJS output (utilityProcess.fork-able from
 * Electron), better-sqlite3 left external (native — provided by desktop/node_modules and
 * rebuilt for Electron's ABI by electron-builder). esbuild does not emulate import.meta.url
 * in CJS, so it is defined to a shimmed equivalent of __filename.
 */
const path = require('node:path');
const { buildSync } = require('esbuild');

buildSync({
  entryPoints: [path.resolve(__dirname, '..', '..', 'apps', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.resolve(__dirname, '..', 'bundle', 'server.cjs'),
  external: ['better-sqlite3'],
  define: { 'import.meta.url': '__fleet_import_meta_url' },
  banner: { js: "const __fleet_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});
