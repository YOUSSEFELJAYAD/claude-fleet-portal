import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-commands-route-'));

let app: any; let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe('GET /api/commands', () => {
  it('returns an array of wire CommandDefs (no run field)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/commands', headers: HOST() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((c: any) => c.name === 'kill')).toBe(true);
    for (const c of body) expect(c.run).toBeUndefined();
  });
});
