import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { api } from '../lib/api';

describe('chat input/interrupt helpers', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => vi.restoreAllMocks());

  it('chatInput POSTs the input body to /input', async () => {
    await api.chatInput('s1', { type: 'permission', requestId: 'r9', decision: 'allow' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/chat/sessions/s1/input');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ type: 'permission', requestId: 'r9', decision: 'allow' });
  });

  it('chatInterrupt POSTs to /interrupt with no body', async () => {
    await api.chatInterrupt('s1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/chat/sessions/s1/interrupt');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});
