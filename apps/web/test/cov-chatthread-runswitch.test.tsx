/**
 * cov-chatthread-runswitch — regression: the result-seq dedup is PER-RUN. Switching sessions
 * (or an evict→relaunch / kill→resume that mints a new run id) must NOT block the new run's
 * reply from persisting just because its seq is lower than the previous run's last seq.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChatThread } from '../components/ChatThread';
import type { ChatMessage, NormalizedEvent, Run } from '@fleet/shared';

const msg = (p: Partial<ChatMessage>): ChatMessage =>
  ({ id: Math.random().toString(36).slice(2), sessionId: 's', role: 'user', kind: 'text', content: '', runId: null, turnId: '', createdAt: 0, ...p });
const ev = (p: Partial<NormalizedEvent> & { type: string }): NormalizedEvent =>
  ({ runId: 's', nodeId: 's', seq: 1, ts: 0, payload: {}, ...p } as unknown as NormalizedEvent);
const noop = () => {};

describe('ChatThread per-run seq dedup', () => {
  it('persists the new run\'s reply after switching to a lower-seq run', () => {
    const onTurnComplete = vi.fn();
    const base = { sessionId: 's', messages: [msg({ content: 'q' })] as ChatMessage[], partials: {}, error: null, onTurnComplete, onTurnError: noop };

    // Run A reaches a high seq result → fires once.
    const { rerender } = render(
      <ChatThread {...base} run={{ id: 'runA', status: 'running' } as Run}
        events={[ev({ type: 'result', runId: 'runA', seq: 40, payload: { result: 'A reply' } })]} />,
    );
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenLastCalledWith('runA', 'A reply');

    // Switch to run B (new id) whose seq space restarts low — must STILL fire (not blocked by seq<=40).
    act(() => {
      rerender(
        <ChatThread {...base} run={{ id: 'runB', status: 'running' } as Run}
          events={[ev({ type: 'result', runId: 'runB', seq: 6, payload: { result: 'B reply' } })]} />,
      );
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(2);
    expect(onTurnComplete).toHaveBeenLastCalledWith('runB', 'B reply');
  });
});
