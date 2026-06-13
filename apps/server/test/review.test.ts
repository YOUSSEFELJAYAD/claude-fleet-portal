import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB isolation BEFORE any src module loads (config.js reads FLEET_DATA_DIR at import).
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-review-'));

let launchReview: any;
let registry: any;

const baseRun = (id: string, overrides: Record<string, any> = {}): any => ({
  id, sessionId: id, task: 't', cwd: '/tmp', model: 'claude-opus-4-8', fastMode: false,
  effort: 'high', workflowsEnabled: true, ultracode: false, teamId: null, campaignId: null,
  projectId: null, pid: null, status: 'running', startedAt: 1, endedAt: null, tokensIn: 0,
  tokensOut: 0, costUsd: 0, exitCode: null, budgetUsd: 2, permissionMode: 'default',
  allowedTools: null, skills: [], subagentProfile: null, resultText: null,
  structuredOutput: null, killReason: null, error: null, subagentCount: 0, liveSubagents: 0,
  maxDepth: 0, lastActivity: 1, ...overrides,
});

const project = (patch: Record<string, any> = {}): any => ({ id: 'p1', rootDir: '/tmp/x', ...patch });
const card = (patch: Record<string, any> = {}): any => ({ id: 'c1', title: 'feat', worktreeName: 'task-c1', ...patch });

/**
 * Model the REAL async contract: `registry.launch` returns a still-RUNNING run (structuredOutput
 * null), and the verdict only lands later via the onRunTerminal stream. The helper stubs launch to
 * return a running run, captures the awaitTerminal subscriber that launchReview registers, and fires
 * it on the next tick with the supplied terminal run. (A test that returned an already-completed run
 * from launch would NOT catch a launchReview that reads run.structuredOutput at launch time.)
 */
function stubAsyncReview(terminal: (id: string) => any): {
  calls: any[];
  restore: () => void;
} {
  const calls: any[] = [];
  const realLaunch = registry.launch;
  const realOnTerminal = registry.onRunTerminal;
  const subs = new Set<(run: any) => void>();
  registry.onRunTerminal = (cb: (run: any) => void) => {
    subs.add(cb);
    return () => subs.delete(cb);
  };
  registry.launch = (req: any) => {
    calls.push(req);
    const id = `review-run-${calls.length}`;
    const running = baseRun(id, { status: 'running', structuredOutput: null });
    // fire terminal asynchronously after launchReview has subscribed via awaitTerminal.
    setTimeout(() => {
      const done = terminal(id);
      for (const cb of [...subs]) cb(done);
    }, 0);
    return running;
  };
  return {
    calls,
    restore: () => {
      registry.launch = realLaunch;
      registry.onRunTerminal = realOnTerminal;
    },
  };
}

beforeAll(async () => {
  ({ launchReview } = await import('../src/review.js'));
  ({ registry } = await import('../src/registry.js'));
});

describe('review.launchReview — adversarial maker/checker (SPEC §9)', () => {
  it('launches the Reviewer read-only with REVIEW_JSON_SCHEMA + the diff, returns the parsed verdict (after terminal)', async () => {
    const stub = stubAsyncReview((id) =>
      baseRun(id, { status: 'completed', endedAt: 2, structuredOutput: { pass: true, findings: 'looks good' } }),
    );
    try {
      const v = await launchReview(card(), project(), 'diff --git a/f b/f\n+x\n');
      expect(v).toEqual({ pass: true, findings: 'looks good' });
      expect(stub.calls.length).toBe(1);
      const req = stub.calls[0];
      // read-only Reviewer envelope: no Edit/Write, json-schema present, the diff threaded in.
      expect(req.jsonSchema).toBeTruthy();
      expect(req.allowedTools).not.toContain('Edit');
      expect(req.allowedTools).not.toContain('Write');
      expect(req.permissionMode).toBe('default');
      expect(req.interactive).toBe(false);
      expect(req.prompt).toContain('diff --git a/f b/f');
    } finally {
      stub.restore();
    }
  });

  it('a reject verdict is returned verbatim (pass:false + findings) once the run terminates', async () => {
    const stub = stubAsyncReview((id) =>
      baseRun(id, { status: 'completed', endedAt: 2, structuredOutput: { pass: false, findings: 'null deref at f:12' } }),
    );
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('null deref');
    } finally {
      stub.restore();
    }
  });

  it('a launch throw → safe reject fallback {pass:false, findings:"review failed: ..."}', async () => {
    const real = registry.launch;
    registry.launch = () => { throw new Error('boom'); };
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('review failed');
      expect(v.findings).toContain('boom');
    } finally {
      registry.launch = real;
    }
  });

  it('a completed run with missing/garbage structuredOutput → safe reject fallback', async () => {
    const stub = stubAsyncReview((id) => baseRun(id, { status: 'completed', endedAt: 2, structuredOutput: null }));
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('review failed');
    } finally {
      stub.restore();
    }
  });

  it('a non-completed terminal status (failed/killed) → safe reject fallback (never passes)', async () => {
    const stub = stubAsyncReview((id) => baseRun(id, { status: 'failed', endedAt: 2, structuredOutput: { pass: true, findings: 'ignored' } }));
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('review failed');
    } finally {
      stub.restore();
    }
  });
});
