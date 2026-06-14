import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-files-find-'));

let app: any; let PORT: number; let repo: string;
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
});
afterAll(async () => { await app?.close(); });

const find = (q: string, cwd = repo, limit = 20) =>
  app.inject({ method: 'GET', url: `/api/files/find?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}&limit=${limit}`, headers: HOST() });

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
    const body = (await find('', repo, 2)).json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(2);
  });
  it('400s when cwd is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files/find?q=x', headers: HOST() });
    expect(res.statusCode).toBe(400);
  });
  it('every returned path is containment-safe (no leading slash, no ..)', async () => {
    const body = (await find('a')).json();
    for (const r of body) {
      expect(r.path.startsWith('/')).toBe(false);
      expect(r.path.includes('..')).toBe(false);
    }
  });
});
