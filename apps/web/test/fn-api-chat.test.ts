/**
 * api.ts chat-surface helpers (Unit 2). `fetch` is NOT globally mocked, so we stub
 * globalThis.fetch per-test and assert the URL/method/body the helper builds, then
 * restore. We import the singleton `api` object.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../lib/api';

const okJson = (body: unknown) =>
  vi.fn(async () => ({ ok: true, json: async () => body, statusText: 'OK' }) as any);

afterEach(() => { vi.restoreAllMocks(); });

describe('api.listCommands', () => {
  it('GETs /api/commands and returns the CommandDef[]', async () => {
    const defs = [{ name: 'kill', group: 'control', usage: '/kill <run-id>', args: [], description: 'x', resultKind: 'ack' }];
    const f = okJson(defs);
    vi.stubGlobal('fetch', f);
    const out = await api.listCommands();
    expect((f.mock.calls as any)[0][0]).toContain('/api/commands');
    expect(out).toEqual(defs);
  });
});

describe('api.findFiles', () => {
  it('GETs /api/files/find with cwd, q and limit query params (url-encoded)', async () => {
    const rows = [{ path: 'src/a.ts', kind: 'file', score: 9 }];
    const f = okJson(rows);
    vi.stubGlobal('fetch', f);
    const out = await api.findFiles('/work/space', 'a.ts', 20);
    const url = String((f.mock.calls as any)[0][0]);
    expect(url).toContain('/api/files/find');
    expect(url).toContain('cwd=' + encodeURIComponent('/work/space'));
    expect(url).toContain('q=' + encodeURIComponent('a.ts'));
    expect(url).toContain('limit=20');
    expect(out).toEqual(rows);
  });

  it('omits limit from the query when not supplied', async () => {
    const f = okJson([]);
    vi.stubGlobal('fetch', f);
    await api.findFiles('/c', 'x');
    expect(String((f.mock.calls as any)[0][0])).not.toContain('limit=');
  });
});

describe('api chat control helpers', () => {
  const captured = () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({}), statusText: 'OK' }) as any);
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('chatInput POSTs the input body to /input', async () => {
    const f = captured();
    await api.chatInput('sess1', { type: 'permission', requestId: 'r1', decision: 'allow' });
    const [url, init] = (f.mock.calls as any)[0];
    expect(String(url)).toContain('/api/chat/sessions/sess1/input');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ type: 'permission', requestId: 'r1', decision: 'allow' });
  });

  it('chatInterrupt POSTs to /interrupt with an empty body', async () => {
    const f = captured();
    await api.chatInterrupt('sess1');
    const [url, init] = (f.mock.calls as any)[0];
    expect(String(url)).toContain('/api/chat/sessions/sess1/interrupt');
    expect(init.method).toBe('POST');
  });

  it('chatKill POSTs to /interrupt (preserves session history; does not hard-delete)', async () => {
    const f = captured();
    await api.chatKill('sess1');
    const [url, init] = (f.mock.calls as any)[0];
    expect(String(url)).toContain('/api/chat/sessions/sess1/interrupt');
    expect(init.method).toBe('POST');
  });

  it('chatTurn carries attachments in the body when supplied', async () => {
    const f = captured();
    await api.chatTurn('sess1', 'hello @a.ts', [{ path: 'a.ts', kind: 'file' }]);
    const [url, init] = (f.mock.calls as any)[0];
    expect(String(url)).toContain('/api/chat/sessions/sess1/turn');
    expect(JSON.parse(init.body)).toEqual({ message: 'hello @a.ts', attachments: [{ path: 'a.ts', kind: 'file' }] });
  });
});
