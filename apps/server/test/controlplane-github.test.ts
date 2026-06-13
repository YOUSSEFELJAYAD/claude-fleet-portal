import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cpgh-'));

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
