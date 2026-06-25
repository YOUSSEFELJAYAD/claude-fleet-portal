import type { RunStatus, NodeStatus, AddonStatus } from '@fleet/shared';

export interface StatusMeta {
  label: string;
  color: string; // hex (status signal palette)
  live: boolean;
}

const MAP: Record<RunStatus, StatusMeta> = {
  starting: { label: 'STARTING', color: '#7b828c', live: true },
  running: { label: 'RUNNING', color: '#39d4cf', live: true },
  'awaiting-input': { label: 'AWAITING INPUT', color: '#b08cff', live: true },
  'awaiting-permission': { label: 'AWAITING PERM', color: '#b08cff', live: true },
  orchestrating: { label: 'ORCHESTRATING', color: '#ffb000', live: true },
  completed: { label: 'COMPLETED', color: '#54e08a', live: false },
  failed: { label: 'FAILED', color: '#ff5d5d', live: false },
  killed: { label: 'KILLED', color: '#ff7a45', live: false },
};

export const statusMeta = (s: RunStatus): StatusMeta =>
  MAP[s] ?? { label: String(s).toUpperCase(), color: '#7b828c', live: false };

export const nodeStatusColor = (s: NodeStatus): string =>
  ({ running: '#39d4cf', completed: '#54e08a', failed: '#ff5d5d', killed: '#ff7a45' })[s] ?? '#7b828c';

/** amber — the canonical accent hex (matches the `amber` palette token). */
export const AMBER = '#ffb000';

/** color for an agent role node in the campaign DAG, sourced from the shared palette. */
export const roleColor = (role: string): string =>
  ({
    orchestrator: '#b08cff',
    synthesizer: AMBER,
  })[role] ?? '#7b828c';

export const campaignStatusColor = (s: string): string =>
  ({
    planning: '#b08cff',
    spawning: '#39d4cf',
    running: '#ffb000',
    synthesizing: '#39d4cf',
    completed: '#54e08a',
    failed: '#ff5d5d',
    killed: '#ff7a45',
  })[s] ?? '#7b828c';

export const taskStatusColor = (s: string): string =>
  ({
    pending: '#7b828c',
    blocked: '#5b626d',
    running: '#39d4cf',
    completed: '#54e08a',
    failed: '#ff5d5d',
    skipped: '#5b626d',
  })[s] ?? '#7b828c';

/** git working-tree change-code color, sourced from the shared status palette (not re-literalled). */
export const codeStatusColor = (kind: string): string =>
  ({
    new: '#54e08a', // sig.completed
    added: '#54e08a', // sig.completed
    deleted: '#ff5d5d', // sig.failed
    renamed: '#ffb000', // amber
    modified: '#ffb000', // amber
  })[kind] ?? '#9aa1ab'; // dim

/** benchmark (job) status color — sourced from the same palette as statusMeta/campaignStatusColor. */
export const benchmarkStatusColor = (s: string): string =>
  ({
    completed: '#54e08a', // sig.completed
    running: '#ffb000', // amber
    judging: '#ffb000', // amber
    failed: '#ff5d5d', // sig.failed
    killed: '#ff7a45', // statusMeta.killed
  })[s] ?? '#7b828c'; // statusMeta fallback

/** benchmark run-row status color — same source of truth, with the run-state aliases. */
export const benchmarkRunStatusColor = (s: string): string =>
  ({
    completed: '#54e08a', // sig.completed
    running: '#ffb000', // amber
    starting: '#ffb000', // amber
    orchestrating: '#ffb000', // amber
    failed: '#ff5d5d', // sig.failed
    killed: '#ff7a45', // statusMeta.killed
  })[s] ?? '#7b828c'; // statusMeta fallback

/** the off-palette "not-installed" shade — defined once here so the addon pages don't re-literal it. */
export const ADDON_NOT_INSTALLED = '#e8704a';

/** add-on marketplace status color — its own enum (not the run/campaign enums), sourced
 *  from the shared palette; the one off-palette shade lives in ADDON_NOT_INSTALLED. */
export const addonStatusColor = (s: AddonStatus): string =>
  ({
    running: '#54e08a', // sig.completed
    starting: '#ffb000', // amber
    stopped: '#ffb000', // amber
    error: '#ff5d5d', // sig.failed
    disabled: '#5b626d', // faint
    'not-installed': ADDON_NOT_INSTALLED,
  })[s] ?? '#7b828c';
