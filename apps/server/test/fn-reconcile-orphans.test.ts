import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '@fleet/shared';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-orphans-'));

let repo: typeof import('../src/db.js').repo;

function run(overrides: Partial<Run> = {}): Run {
  const now = Date.now();
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    task: 'orphan me',
    cwd: process.cwd(),
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    workflowsEnabled: true,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'running',
    startedAt: now - 1000,
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    exitCode: null,
    killReason: null,
    error: null,
    budgetUsd: 5,
    permissionMode: 'bypassPermissions',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: null,
    structuredOutput: null,
    pid: null,
    retryOf: null,
    archivedAt: null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: now,
    ...overrides,
  };
}

beforeAll(async () => {
  const db = await import('../src/db.js');
  repo = db.repo;
});

describe('reconcileOrphans', () => {
  it('marks a live (running) run failed AND records a diagnostic error so a server restart is not a blank failure', () => {
    const orphan = run({ status: 'running', error: null, endedAt: null });
    repo.upsertRun(orphan);

    repo.reconcileOrphans();

    const after = repo.getRun(orphan.id)!;
    expect(after.status).toBe('failed');
    expect(after.endedAt).toEqual(expect.any(Number));
    // The whole point of the fix: a reconciled orphan must explain WHY, not show a null error.
    expect(after.error).toBeTruthy();
    expect(after.error!.toLowerCase()).toMatch(/orphan|restart|server/);
  });

  it('does not clobber an existing error on a run that was already failing', () => {
    const withErr = run({ status: 'running', error: 'real underlying cause' });
    repo.upsertRun(withErr);

    repo.reconcileOrphans();

    const after = repo.getRun(withErr.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('real underlying cause');
  });

  it('leaves terminal runs untouched', () => {
    const done = run({ status: 'completed', endedAt: Date.now(), error: null, exitCode: 0 });
    repo.upsertRun(done);

    repo.reconcileOrphans();

    const after = repo.getRun(done.id)!;
    expect(after.status).toBe('completed');
    expect(after.error).toBeNull();
  });
});
