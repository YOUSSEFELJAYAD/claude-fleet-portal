/**
 * fn-chat-resume-route — POST /api/chat/sessions/:id/resume: 404 unknown session,
 * 400 when the session has no backing run, and (run present) delegates to registry.resume
 * and returns the session. registry is stubbed via Object.create to preserve its prototype.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-chat-resume-'));

let app: any;
let chatRepo: any;
let registry: any;
let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });
const resumeSpy = vi.fn();

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const reg = await import('../src/registry.js');
  registry = reg.registry;
  // preserve prototype chain; override only resume
  resumeSpy.mockImplementation((runId: string) => ({ id: runId, status: 'starting' }));
  (registry as any).resume = resumeSpy;
  const chat = await import('../src/chat.js');
  chatRepo = chat.chatRepo;
  const { buildServer } = await import('../src/server.js');
  app = await buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

it('404s for an unknown session', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chat/sessions/nope/resume', headers: HOST() });
  expect(res.statusCode).toBe(404);
});

it('400s when the session has no backing run', async () => {
  const s = chatRepo.createSession({ cwd: process.cwd(), title: 'no-run' });
  const res = await app.inject({ method: 'POST', url: `/api/chat/sessions/${s.id}/resume`, headers: HOST() });
  expect(res.statusCode).toBe(400);
});

it('resumes a session that has a backing run and returns the session', async () => {
  const s = chatRepo.createSession({ cwd: process.cwd(), title: 'has-run' });
  chatRepo.setSessionRun(s.id, 'run-xyz');
  const res = await app.inject({ method: 'POST', url: `/api/chat/sessions/${s.id}/resume`, headers: HOST() });
  expect(res.statusCode).toBe(200);
  expect(resumeSpy).toHaveBeenCalledWith('run-xyz');
  const body = res.json();
  expect(body.id).toBe(s.id);
});
