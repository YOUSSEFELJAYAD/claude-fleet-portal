/**
 * fn-chat-stream-strip — the chat-scoped stream must NOT replay the backing run's historical
 * event log into the live turn (it lives in persisted chat_messages; replaying duplicates the
 * transcript and reorders it on reload). stripHelloEvents empties hello.events; everything else
 * passes through untouched.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-strip-'));

const { stripHelloEvents } = await import('../src/chat.js');

describe('stripHelloEvents', () => {
  it('empties the events array of a hello frame', () => {
    const hello = { kind: 'hello', run: { id: 'r1', status: 'completed' }, events: [{ seq: 1, type: 'assistant_text' }], truncatedBefore: 0 };
    const out = stripHelloEvents(hello) as any;
    expect(out.kind).toBe('hello');
    expect(out.events).toEqual([]);
    expect(out.run).toEqual({ id: 'r1', status: 'completed' }); // other fields preserved
  });

  it('passes a live event frame through unchanged', () => {
    const evt = { kind: 'event', event: { seq: 9, type: 'assistant_text', payload: { text: 'hi' } } };
    expect(stripHelloEvents(evt)).toBe(evt);
  });

  it('passes a run frame and a session_state frame through unchanged', () => {
    const run = { kind: 'run', run: { id: 'r1', status: 'running' } };
    const ss = { kind: 'session_state', state: 'running', live: true };
    expect(stripHelloEvents(run)).toBe(run);
    expect(stripHelloEvents(ss)).toBe(ss);
  });
});
