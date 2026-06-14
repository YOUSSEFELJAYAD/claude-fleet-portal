import type { ChatSessionState } from '@fleet/shared';

export interface ChatStateMeta {
  label: string;
  color: string; // hex (HUD status palette)
  live: boolean; // drives the pulsing Dot glow
}

// Chat lifecycle is its own enum (not RunStatus), so it gets its own palette map —
// mirrors lib/status.ts statusMeta but keyed by ChatSessionState (spec §3.1 / §8).
const MAP: Record<ChatSessionState, ChatStateMeta> = {
  live: { label: 'LIVE', color: '#39d4cf', live: true },     // teal — held interactive process
  running: { label: 'RUNNING', color: '#ffb000', live: true }, // amber — a turn is streaming
  idle: { label: 'RESUMABLE', color: '#9aa1ab', live: false }, // dim — resumable fallback (~1s spin-up)
  killed: { label: 'KILLED', color: '#ff7a45', live: false },  // orange — explicitly stopped
};

export const chatStateMeta = (s: ChatSessionState): ChatStateMeta =>
  MAP[s] ?? { label: 'IDLE', color: '#9aa1ab', live: false };
