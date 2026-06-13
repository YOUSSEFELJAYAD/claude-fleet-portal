/**
 * Real coverage tests for mcp.ts — drives both the pure normalizeStatus branches
 * (via parseMcpList inputs) AND the two HTTP routes through buildServer().inject().
 *
 * The routes shell out to CLAUDE_REAL_BIN with `mcp list` / `mcp get <name>`. We point
 * CLAUDE_REAL_BIN at a real, fast fake `claude` (a node script) whose behavior is steered
 * per-spawn by the FAKE_CLAUDE_MODE env var — execFile inherits process.env on each call,
 * so flipping the var between requests changes which branch the handler takes. This lets
 * one binary exercise: list-success, list-salvage (stdout + nonzero exit), get-success,
 * and the stderr/message error fallbacks — all without a real claude and without a
 * multi-second timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-mcp-'));

// A fake `claude` binary. Steered by FAKE_CLAUDE_MODE (read fresh on every spawn).
const binDir = mkdtempSync(join(tmpdir(), 'fleet-fake-claude-mcp-'));
const FAKE_CLAUDE_BIN = join(binDir, 'claude');
writeFileSync(
  FAKE_CLAUDE_BIN,
  `#!/usr/bin/env node
const a = process.argv.slice(2);            // e.g. ['mcp','list'] or ['mcp','get','name']
const mode = process.env.FAKE_CLAUDE_MODE || '';
const LIST = ['memory: /path/to/server - \\u2713 Connected',
              'figma: cloud - ! Needs authentication',
              'broken: ./x - \\u2717 Failed to connect'].join('\\n');
if (a[0] === 'mcp' && a[1] === 'list') {
  if (mode === 'list_ok') { process.stdout.write(LIST + '\\n'); process.exit(0); }
  if (mode === 'list_salvage') { process.stdout.write(LIST + '\\n'); process.exit(7); } // stdout AND nonzero exit
  if (mode === 'list_stderr') { process.stderr.write('boom from claude\\n'); process.exit(3); }
  if (mode === 'list_empty_err') { process.exit(9); } // nonzero exit, no stdout, no stderr -> message fallback
  process.stdout.write('\\n'); process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'get') {
  const name = a[2] || '';
  if (mode === 'get_ok') { process.stdout.write('Server: ' + name + '\\nStatus: connected\\n'); process.exit(0); }
  if (mode === 'get_stderr') { process.stderr.write('no such server: ' + name + '\\n'); process.exit(4); }
  if (mode === 'get_stdout_err') { process.stdout.write('partial detail for ' + name + '\\n'); process.exit(5); }
  if (mode === 'get_empty_err') { process.exit(6); } // nonzero, no stdout/stderr -> message fallback
  process.stdout.write('ok ' + name + '\\n'); process.exit(0);
}
process.exit(0);
`,
);
chmodSync(FAKE_CLAUDE_BIN, 0o755);
process.env.CLAUDE_REAL_BIN = FAKE_CLAUDE_BIN;

let app: any;
let PORT: number;
let mcp: typeof import('../src/mcp.js');
const HOST = () => ({ host: `127.0.0.1:${PORT}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  mcp = await import('../src/mcp.js');
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

// ---------------------------------------------------------------------------
// normalizeStatus branches (lines 27-31), exercised through parseMcpList inputs.
// ---------------------------------------------------------------------------
describe('normalizeStatus — every classification branch (via parseMcpList)', () => {
  it('"token"/"login" status maps to needs-auth (auth-keyword branch, line 27)', () => {
    // "token" keyword (not "auth"/"login") — exercises the third disjunct of the auth branch.
    expect(mcp.parseMcpList('a: x - token expired')[0].status).toBe('needs-auth');
    // "login" keyword
    expect(mcp.parseMcpList('b: y - please login')[0].status).toBe('needs-auth');
  });

  it('"checking"/"starting"/"pending" map to pending (line 28)', () => {
    // NB: "connecting" contains "connect" so it short-circuits to 'connected' on line 24;
    // the pending branch is reached by checking/starting/pending (no connect/fail/auth match).
    expect(mcp.parseMcpList('d: z - checking health')[0].status).toBe('pending');
    expect(mcp.parseMcpList('e: z - starting up')[0].status).toBe('pending');
    // literal "pending" keyword too
    expect(mcp.parseMcpList('f: z - pending')[0].status).toBe('pending');
  });

  it('an empty/symbols-only status fragment falls back to pending (line 23)', () => {
    // status text is only the ✓ symbol, which is stripped → '' → 'pending'
    expect(mcp.parseMcpList('g (✓)')[0].status).toBe('pending');
  });

  it('a free-text status with no keyword collapses to a best-effort token (lines 29-31)', () => {
    // No connect/fail/auth/pending keyword → split on spaces, first 3 words, hyphen-joined.
    const row = mcp.parseMcpList('h: detail - waiting on remote handshake response')[0];
    // 'waiting on remote handshake response' → first 3 words → 'waiting-on-remote'
    expect(row.status).toBe('waiting-on-remote');
    expect(row.detail).toBe('detail');
  });

  it('best-effort token uses ALL words when fewer than 3 are present (lines 30-31)', () => {
    expect(mcp.parseMcpList('i (degraded)')[0].status).toBe('degraded');
    expect(mcp.parseMcpList('j: k - weird state')[0].status).toBe('weird-state');
  });

  it('"name: status" form with no " - " separator: whole rest is status, no detail (lines 76-78)', () => {
    const row = mcp.parseMcpList('context7: connected')[0];
    expect(row).toEqual({ name: 'context7', status: 'connected', detail: '' });
    // and a free-text rest with no separator collapses to a best-effort token too
    expect(mcp.parseMcpList('weird: some odd phrase here')[0]).toEqual({
      name: 'weird',
      status: 'some-odd-phrase',
      detail: '',
    });
  });

  it('connect-branch negation guards + fail keywords (lines 24-26)', () => {
    // "cannot connect" — connect branch is skipped (has 'not'); fail branch fires on 'cannot'.
    expect(mcp.parseMcpList('k: x - cannot connect')[0].status).toBe('failed');
    // "disconnected" — connect branch skipped (has 'disconnect'); fail branch fires on 'disconnect'.
    expect(mcp.parseMcpList('m: x - disconnected')[0].status).toBe('failed');
    // explicit failure / error / unreachable keywords
    expect(mcp.parseMcpList('n: x - ✗ Failed to start')[0].status).toBe('failed');
    expect(mcp.parseMcpList('o: x - internal error')[0].status).toBe('failed');
    expect(mcp.parseMcpList('p: x - host unreachable')[0].status).toBe('failed');
    // "not connected" hits NONE of the keyword branches → best-effort token (lines 30-31).
    expect(mcp.parseMcpList('l: x - not connected')[0].status).toBe('not-connected');
  });
});

// ---------------------------------------------------------------------------
// GET /api/mcp — success (line 90) + error-message fallbacks (lines 94-101).
// ---------------------------------------------------------------------------
describe('GET /api/mcp — success, salvage, and error branches', () => {
  it('parses a real listing on success (line 90)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'list_ok';
    const res = await get('/api/mcp');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.error).toBeUndefined();
    expect(b.servers.map((s: any) => s.name)).toEqual(['memory', 'figma', 'broken']);
    expect(b.servers.map((s: any) => s.status)).toEqual(['connected', 'needs-auth', 'failed']);
  });

  it('salvages stdout when claude exits nonzero but still printed the listing (lines 94-95)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'list_salvage';
    const res = await get('/api/mcp');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    // salvage path returns the parsed rows and NO error
    expect(b.error).toBeUndefined();
    expect(b.servers).toHaveLength(3);
    expect(b.servers[0].name).toBe('memory');
  });

  it('surfaces stderr text as the error when nothing salvageable (line 101 — stderr branch)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'list_stderr';
    const res = await get('/api/mcp');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.servers).toEqual([]);
    expect(b.error).toContain('boom from claude');
  });

  it('falls back to a generic message when there is no stdout/stderr (line 101 — message branch)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'list_empty_err';
    const res = await get('/api/mcp');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.servers).toEqual([]);
    expect(typeof b.error).toBe('string');
    expect(b.error.length).toBeGreaterThan(0); // execFile's own "Command failed" message
  });
});

// ---------------------------------------------------------------------------
// GET /api/mcp/:name — validation (lines 109-111) + success (114-115) + errors (117-124).
// ---------------------------------------------------------------------------
describe('GET /api/mcp/:name — drill-down route', () => {
  it('returns the raw text on success (lines 114-115)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'get_ok';
    const res = await get('/api/mcp/memory');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.name).toBe('memory');
    expect(b.error).toBeUndefined();
    expect(b.text).toContain('Server: memory');
    expect(b.text).toContain('Status: connected');
  });

  it('400s an over-long name via the handler guard (lines 109-111)', async () => {
    // 201 chars clears fastify's maxParamLength (256) and hits the handler's own >200 guard.
    const res = await get('/api/mcp/' + 'x'.repeat(201));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid server name' });
  });

  it('surfaces stderr as the error on a get failure (line 122 — stderr branch)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'get_stderr';
    const res = await get('/api/mcp/ghost');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.name).toBe('ghost');
    expect(b.text).toBe('');
    expect(b.error).toContain('no such server: ghost');
  });

  it('falls back to stdout text as the error when stderr is empty (line 122 — stdout branch)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'get_stdout_err';
    const res = await get('/api/mcp/partial');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.text).toBe('');
    expect(b.error).toContain('partial detail for partial');
  });

  it('falls back to a generic message when no stderr/stdout (line 122 — message branch)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'get_empty_err';
    const res = await get('/api/mcp/silent');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.text).toBe('');
    expect(typeof b.error).toBe('string');
    expect(b.error.length).toBeGreaterThan(0);
  });
});
