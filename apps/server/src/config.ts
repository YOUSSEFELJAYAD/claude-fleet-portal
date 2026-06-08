import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PortalConfig } from '@fleet/shared';

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

export const HOME = os.homedir();
/** The `claude` binary (or the mock-claude replayer). DC.md D-009. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const TASKS_DIR = path.join(HOME, '.claude', 'tasks');
export const USER_SKILLS_DIR = path.join(HOME, '.claude', 'skills');
export const PROJECT_SKILLS_DIRNAME = path.join('.claude', 'skills');
export const USER_AGENTS_DIR = path.join(HOME, '.claude', 'agents');
export const PROJECT_AGENTS_DIRNAME = path.join('.claude', 'agents');

export const DATA_DIR = process.env.FLEET_DATA_DIR || path.join(REPO_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'fleet.db');

export const HOST = process.env.FLEET_HOST || '127.0.0.1';
export const PORT = Number(process.env.FLEET_SERVER_PORT || 4319);

/** Default guardrails (PRD §7.7). ultracode runs get a tighter ceiling (DC.md D-008). */
export const DEFAULT_CONFIG: PortalConfig = {
  maxConcurrentRuns: 8,
  defaultBudgetUsd: 5,
  ultracodeBudgetUsd: 15,
  permissionDefault: 'default',
  subagentConcurrentCeiling: 16,
  subagentTotalCeiling: 1000,
};
