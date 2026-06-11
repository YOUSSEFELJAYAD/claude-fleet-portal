/**
 * §26 — thinking-level unit tests:
 *   1. thinkingEnv() mapping (pure, 5 cases)
 *   2. POST /api/agents validation: invalid level → 400 for claude
 *   3. POST /api/agents validation: invalid level for codex engine → 400
 *      (validation runs before the engine-disabled check — order matters)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate DB before any src module is imported.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-thinking-'));

import { thinkingEnv } from '../src/processManager.js';

// ── thinkingEnv unit tests ────────────────────────────────────────────────────

describe('thinkingEnv — mapping', () => {
  it('off → MAX_THINKING_TOKENS=0', () => {
    expect(thinkingEnv('off')).toEqual({ MAX_THINKING_TOKENS: '0' });
  });

  it('think → MAX_THINKING_TOKENS=4000', () => {
    expect(thinkingEnv('think')).toEqual({ MAX_THINKING_TOKENS: '4000' });
  });

  it('megathink → MAX_THINKING_TOKENS=10000', () => {
    expect(thinkingEnv('megathink')).toEqual({ MAX_THINKING_TOKENS: '10000' });
  });

  it('ultrathink → MAX_THINKING_TOKENS=31999', () => {
    expect(thinkingEnv('ultrathink')).toEqual({ MAX_THINKING_TOKENS: '31999' });
  });

  it('absent (undefined) → {} (adaptive default)', () => {
    expect(thinkingEnv(undefined)).toEqual({});
  });

  it('null → {} (adaptive default)', () => {
    expect(thinkingEnv(null)).toEqual({});
  });

  it('unknown level → {} (adaptive default, no crash)', () => {
    expect(thinkingEnv('banana')).toEqual({});
  });
});

// ── route validation via buildServer ─────────────────────────────────────────

let app: any;
let PORT: number;

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

const H = () => ({ host: `127.0.0.1:${PORT}` });

const BASE_PAYLOAD = {
  prompt: 'hello',
  cwd: '/tmp',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'default',
};

describe('POST /api/agents — thinkingLevel validation (claude)', () => {
  it('invalid thinkingLevel for claude → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: { ...BASE_PAYLOAD, thinkingLevel: 'banana' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error ?? body.message ?? '').toMatch(/thinkingLevel must be one of/i);
  });

  it('valid thinkingLevel for claude → not 400 (may be 400 for cwd, 409 for concurrency, etc.)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: { ...BASE_PAYLOAD, thinkingLevel: 'think' },
    });
    // 400 would mean our validation wrongly rejected a valid level
    expect(res.statusCode).not.toBe(400);
  });
});

describe('POST /api/agents — thinkingLevel validation (engine: codex)', () => {
  it('codex with claude-only thinkingLevel → 400 (validation before engine-disabled check)', async () => {
    // 'ultrathink' is valid for claude but invalid for codex → must fire our 400
    // even though codex is not enabled in this test environment.
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        ...BASE_PAYLOAD,
        engine: 'codex',
        thinkingLevel: 'ultrathink',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error ?? body.message ?? '').toMatch(/thinkingLevel for codex must be one of/i);
  });

  it('codex with valid thinkingLevel → not 400 (may be 409 engine-disabled)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H(),
      payload: {
        ...BASE_PAYLOAD,
        engine: 'codex',
        thinkingLevel: 'high',
      },
    });
    expect(res.statusCode).not.toBe(400);
  });
});
