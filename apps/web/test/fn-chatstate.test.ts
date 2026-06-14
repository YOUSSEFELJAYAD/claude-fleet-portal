import { describe, it, expect } from 'vitest';
import { chatStateMeta } from '../lib/chatState';

describe('chatStateMeta', () => {
  it('maps each ChatSessionState to a HUD label/color/live triple', () => {
    expect(chatStateMeta('live')).toEqual({ label: 'LIVE', color: '#39d4cf', live: true });
    expect(chatStateMeta('running')).toEqual({ label: 'RUNNING', color: '#ffb000', live: true });
    expect(chatStateMeta('idle')).toEqual({ label: 'RESUMABLE', color: '#9aa1ab', live: false });
    expect(chatStateMeta('killed')).toEqual({ label: 'KILLED', color: '#ff7a45', live: false });
  });

  it('falls back to a dim idle-like triple for an unknown state', () => {
    // @ts-expect-error — exercising the runtime fallback for a value outside the union
    expect(chatStateMeta('bogus')).toEqual({ label: 'IDLE', color: '#9aa1ab', live: false });
  });
});
