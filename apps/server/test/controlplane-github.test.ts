import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cpgh-'));

// Synthetic issue list used by the read-path integration tests:
// item 100 = plain issue, item 200 = PR (has pull_request field, must be filtered)
const SYNTHETIC_ISSUES = [
  { number: 100, title: 'Plain issue', body: 'body', labels: [{ name: 'risk:low' }] },
  { number: 200, title: 'A pull request', body: 'pr body', labels: [], pull_request: { url: 'https://github.com/acme/widgets/pull/200' } },
  { number: 300, title: 'Agent-ready issue', body: '', labels: [{ name: 'risk:low' }, { name: 'agent:ready' }] },
  { number: 400, title: 'Untriaged issue', body: '', labels: [] },
];

// Mock gh.js so read-path integration tests don't spawn real gh processes.
vi.mock('../src/gh.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/gh.js')>();
  return {
    ...original,
    resolveRemote: vi.fn(async () => ({ url: 'https://github.com/acme/widgets.git', resolves: true })),
    ghExec: vi.fn(async (_root: string, args: string[]) => {
      // Respond to: gh api repos/<slug>/issues
      if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/')) {
        return { ok: true, stdout: JSON.stringify(SYNTHETIC_ISSUES), stderr: '', code: 0 };
      }
      return { ok: false, stdout: '', stderr: 'unhandled', code: 1 };
    }),
    // Keep write-back stubs so other tests don't get broken by a missing gh binary
    ghLabelAdd: vi.fn(async () => ({ ok: true })),
    ghLabelRemove: vi.fn(async () => ({ ok: true })),
    ghIssueComment: vi.fn(async () => ({ ok: true })),
  };
});

let cp: typeof import('../src/controlplane.js');

beforeAll(async () => {
  cp = await import('../src/controlplane.js');
});

describe('issueToWorkItem (pure mapper)', () => {
  it('maps a gh REST issue to a WorkItem, flattening labels[].name', () => {
    const item = cp.issueToWorkItem({
      number: 42,
      title: 'Crash on save',
      body: 'steps to repro',
      labels: [{ name: 'risk:low' }, { name: 'type:bug' }],
    });
    expect(item).toEqual({
      id: '42',
      title: 'Crash on save',
      body: 'steps to repro',
      labels: ['risk:low', 'type:bug'],
    });
  });

  it('tolerates a null body and string labels', () => {
    const item = cp.issueToWorkItem({ number: 7, title: 'T', body: null, labels: ['bug'] });
    expect(item).toEqual({ id: '7', title: 'T', body: '', labels: ['bug'] });
  });
});

describe('github adapter read filters (pure)', () => {
  const items = [
    { id: '1', title: 'untriaged', body: '', labels: [] },
    { id: '2', title: 'triaged-low', body: '', labels: ['risk:low', 'type:bug'] },
    { id: '3', title: 'ready', body: '', labels: ['risk:low', 'agent:ready'] },
    { id: '4', title: 'triaged-high', body: '', labels: ['risk:high', 'needs:human'] },
  ];

  it('backlog = items lacking any risk:* label', () => {
    expect(cp.selectBacklog(items).map((i) => i.id)).toEqual(['1']);
  });

  it('ready = items carrying agent:ready', () => {
    expect(cp.selectReady(items).map((i) => i.id)).toEqual(['3']);
  });
});

describe('fetchOpenIssues PR filter (defensive: /issues returns PRs too)', () => {
  // SYNTHETIC_ISSUES has items 100 (issue), 200 (PR with pull_request field), 300 (ready issue), 400 (untriaged).
  // The PR (item 200) must NEVER appear in listBacklog or listReady.
  const project: any = { id: 'p1', rootDir: '/tmp/proj', remoteName: 'origin' };
  const loop: any = { id: 'l1', projectId: 'p1', kind: 'manager', controlPlane: 'github', mode: 'apply', routableCeiling: 'low' };

  it('listBacklog excludes the PR item (pull_request field present)', async () => {
    const adapter = cp.githubControlPlane(loop, project);
    const backlog = await adapter.listBacklog();
    const ids = backlog.map((i) => i.id);
    // item 200 is a PR — must not appear
    expect(ids).not.toContain('200');
    // item 400 is untriaged (no risk:* label) — must appear
    expect(ids).toContain('400');
  });

  it('listReady excludes the PR item even if it had agent:ready', async () => {
    const adapter = cp.githubControlPlane(loop, project);
    const ready = await adapter.listReady();
    const ids = ready.map((i) => i.id);
    expect(ids).not.toContain('200');
    // item 300 has agent:ready — must appear
    expect(ids).toContain('300');
  });
});

describe('github adapter read-path integration (mocked resolveRemote + ghExec)', () => {
  // Full pipeline: githubControlPlane → fetchAll → resolveRemote + ghExec → issueToWorkItem → selectBacklog/selectReady
  const project: any = { id: 'p1', rootDir: '/tmp/proj', remoteName: 'origin' };
  const loop: any = { id: 'l1', projectId: 'p1', kind: 'manager', controlPlane: 'github', mode: 'apply', routableCeiling: 'low' };

  it('listBacklog returns items lacking risk:* (issues only, no PRs)', async () => {
    const adapter = cp.githubControlPlane(loop, project);
    const backlog = await adapter.listBacklog();
    // item 400 is untriaged (no risk label) and a real issue → in backlog
    expect(backlog.some((i) => i.id === '400')).toBe(true);
    // item 100 has risk:low → NOT in backlog
    expect(backlog.some((i) => i.id === '100')).toBe(false);
    // item 200 is a PR → NOT in backlog
    expect(backlog.some((i) => i.id === '200')).toBe(false);
  });

  it('listReady returns items carrying agent:ready (issues only, no PRs)', async () => {
    const adapter = cp.githubControlPlane(loop, project);
    const ready = await adapter.listReady();
    // item 300 has agent:ready → in ready
    expect(ready.some((i) => i.id === '300')).toBe(true);
    // item 200 is a PR → NOT in ready
    expect(ready.some((i) => i.id === '200')).toBe(false);
  });
});
