/**
 * §31 — load the managed `.env` into process.env BEFORE config.ts freezes env at import.
 * Computes the data dir the same way config.ts does, WITHOUT importing config.ts (which would
 * read env before this runs). Imported first in index.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './envfile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.FLEET_REPO_ROOT || path.resolve(here, '..', '..', '..');
const dataDir = process.env.FLEET_DATA_DIR || path.join(repoRoot, 'data');

export const MANAGED_ENV_PATH = path.join(dataDir, '.env');
load(MANAGED_ENV_PATH);
