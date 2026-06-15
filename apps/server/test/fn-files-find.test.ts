import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-files-find-'));

let app: any; let PORT: number; let repo: string; let sessionId: string;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-find-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'chatLive.ts'), '');
  writeFileSync(join(repo, 'src', 'commands.ts'), '');
  writeFileSync(join(repo, 'README.md'), '');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();

  // The workspace root is resolved from server-trusted session.cwd, NOT a free-form client cwd
  // (fix 10B — closes host-wide filename enumeration via `?cwd=/Users/x/.ssh`). Create a session
  // whose cwd is the test repo, then drive the picker by its sessionId.
  const created = await app.inject({
    method: 'POST', url: '/api/chat/sessions', headers: HOST(),
    payload: { cwd: repo },
  });
  sessionId = created.json().id;
});
afterAll(async () => { await app?.close(); });

const find = (q: string, sid = sessionId, limit = 20) =>
  app.inject({ method: 'GET', url: `/api/files/find?sessionId=${encodeURIComponent(sid)}&q=${encodeURIComponent(q)}&limit=${limit}`, headers: HOST() });

describe('GET /api/files/find', () => {
  it('fuzzy-matches tracked files and returns workspace-relative paths', async () => {
    const res = await find('chatlive');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const top = body[0];
    expect(top.path).toBe('src/chatLive.ts');
    expect(top.kind).toBe('file');
    expect(typeof top.score).toBe('number');
  });
  it('includes directories as kind:dir', async () => {
    const body = (await find('src')).json();
    expect(body.some((r: any) => r.path === 'src' && r.kind === 'dir')).toBe(true);
  });
  it('an empty q returns results (recents/all, capped by limit)', async () => {
    const body = (await find('', sessionId, 2)).json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(2);
  });
  it('400s when sessionId is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files/find?q=x', headers: HOST() });
    expect(res.statusCode).toBe(400);
  });
  it('400s when the sessionId is unknown (root is NOT taken from a free-form client cwd)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/find?sessionId=does-not-exist&q=passwd`,
      headers: HOST(),
    });
    expect(res.statusCode).toBe(400);
  });
  it('ignores a foreign client-supplied cwd — a session id pins the root server-side', async () => {
    // even if a caller smuggles a sensitive cwd, the route resolves the root from the session, so
    // results stay workspace-relative to the repo (never an enumeration of the foreign dir).
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/find?sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent('/etc')}&q=chatlive`,
      headers: HOST(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.some((r: any) => r.path === 'src/chatLive.ts')).toBe(true);
  });
  it('every returned path is containment-safe (no leading slash, no ..)', async () => {
    const body = (await find('a')).json();
    for (const r of body) {
      expect(r.path.startsWith('/')).toBe(false);
      expect(r.path.includes('..')).toBe(false);
    }
  });
});
