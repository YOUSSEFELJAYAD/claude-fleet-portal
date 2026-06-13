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
  projectId: null, pid: null, status: 'completed', startedAt: 1, endedAt: 2, tokensIn: 0,
  tokensOut: 0, costUsd: 0, exitCode: 0, budgetUsd: 2, permissionMode: 'default',
  allowedTools: null, skills: [], subagentProfile: null, resultText: null,
  structuredOutput: null, killReason: null, error: null, subagentCount: 0, liveSubagents: 0,
  maxDepth: 0, lastActivity: 1, ...overrides,
});

const project = (patch: Record<string, any> = {}): any => ({ id: 'p1', rootDir: '/tmp/x', ...patch });
const card = (patch: Record<string, any> = {}): any => ({ id: 'c1', title: 'feat', worktreeName: 'task-c1', ...patch });

beforeAll(async () => {
  ({ launchReview } = await import('../src/review.js'));
  ({ registry } = await import('../src/registry.js'));
});

describe('review.launchReview — adversarial maker/checker (SPEC §9)', () => {
  it('launches the Reviewer read-only with REVIEW_JSON_SCHEMA + the diff, returns the parsed verdict', async () => {
    const calls: any[] = [];
    const real = registry.launch;
    registry.launch = (req: any) => {
      calls.push(req);
      return baseRun('review-run', { structuredOutput: { pass: true, findings: 'looks good' } });
    };
    try {
      const v = await launchReview(card(), project(), 'diff --git a/f b/f\n+x\n');
      expect(v).toEqual({ pass: true, findings: 'looks good' });
      expect(calls.length).toBe(1);
      const req = calls[0];
      // read-only Reviewer envelope: no Edit/Write, json-schema present, the diff threaded in.
      expect(req.jsonSchema).toBeTruthy();
      expect(req.allowedTools).not.toContain('Edit');
      expect(req.allowedTools).not.toContain('Write');
      expect(req.permissionMode).toBe('default');
      expect(req.interactive).toBe(false);
      expect(req.prompt).toContain('diff --git a/f b/f');
    } finally {
      registry.launch = real;
    }
  });

  it('a reject verdict is returned verbatim (pass:false + findings)', async () => {
    const real = registry.launch;
    registry.launch = () => baseRun('rev2', { structuredOutput: { pass: false, findings: 'null deref at f:12' } });
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('null deref');
    } finally {
      registry.launch = real;
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

  it('a missing/garbage structuredOutput → safe reject fallback', async () => {
    const real = registry.launch;
    registry.launch = () => baseRun('rev3', { status: 'completed', structuredOutput: null });
    try {
      const v = await launchReview(card(), project(), 'diff');
      expect(v.pass).toBe(false);
      expect(v.findings).toContain('review failed');
    } finally {
      registry.launch = real;
    }
  });
});
