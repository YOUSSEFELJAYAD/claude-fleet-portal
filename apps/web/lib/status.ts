import type { RunStatus, NodeStatus } from '@fleet/shared';

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

export const effortMeta = (e: string): { label: string; hot: number } => {
  const hot = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }[e] ?? 2;
  return { label: e.toUpperCase(), hot };
};

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
