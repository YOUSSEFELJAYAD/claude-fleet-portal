import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// H16 — verify the coalesced (batched) DB writes still durably persist a run's events:
// drive a mock run to completion and confirm getEvents() returns them (flushed on terminal).
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-batch-'));
process.env.FLEET_DATA_DIR = dataDir;
process.env.CLAUDE_BIN = resolve(here, '..', '..', '..', 'tools', 'mock-claude.mjs');
process.env.MOCK_DELAY_MS = '0'; // replay fast

let registry: any;
let repo: any;
beforeAll(async () => {
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('batched DB writes persist events on terminal (H16)', () => {
  it('a completed mock run has its events durably in SQLite', async () => {
    const run = registry.launch({
      prompt: 'hi',
      cwd: dataDir,
      model: 'claude-haiku-4-5',
      effort: 'low',
      permissionMode: 'default',
    });

    let r: any;
    for (let i = 0; i < 100; i++) {
      await sleep(50);
      r = registry.getRun(run.id);
      if (r && ['completed', 'failed', 'killed'].includes(r.status)) break;
    }
    expect(['completed', 'failed', 'killed']).toContain(r?.status);
    // events were buffered during the run and flushed on terminal → durable in the DB
    const events = repo.getEvents(run.id, -1, 100000);
    expect(events.length).toBeGreaterThan(0);
  });
});
