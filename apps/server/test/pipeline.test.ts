import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, isSpawnTool, estimateCost } from '../src/parser.js';
import { buildArgs } from '../src/processManager.js';
import { RunTree } from '../src/tree.js';
import type { NormalizedEvent, OrchestratorPlan } from '@fleet/shared';
import { PLAN_JSON_SCHEMA } from '@fleet/shared';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadFixture(name: string): any[] {
  const raw = readFileSync(join(repoRoot, 'fixtures', name), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

function build(name: string) {
  const raws = loadFixture(name);
  const tree = new RunTree('run-1', 'sess-1', { inputPerM: 5, outputPerM: 25 }, 0);
  let ts = 1;
  const normalized: NormalizedEvent[] = [];
  for (const raw of raws) {
    for (const p of normalize(raw)) {
      const r = tree.ingest(p, ts++);
      normalized.push(...r.events);
    }
  }
  return { tree, normalized };
}

describe('parser', () => {
  it('detects the Agent/Task spawn tools, version-proof', () => {
    expect(isSpawnTool('Agent')).toBe(true);
    expect(isSpawnTool('Task')).toBe(true);
    expect(isSpawnTool('Bash')).toBe(false);
    expect(isSpawnTool(undefined)).toBe(false);
  });

  it('normalizes an assistant Agent tool_use into a subagent_spawned event', () => {
    const raw = {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 's',
      message: {
        content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_X', input: { description: 'explore backend' } }],
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    const [p] = normalize(raw);
    expect(p.type).toBe('subagent_spawned');
    expect(p.spawn).toMatchObject({ id: 'toolu_X', name: 'Agent', label: 'explore backend' });
  });

  it('normalizes token deltas (--include-partial-messages) into assistant_partial', () => {
    const raw = {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'po' } },
    };
    const [p] = normalize(raw);
    expect(p.type).toBe('assistant_partial');
    expect(p.text).toBe('po');
  });

  it('estimateCost is conservative and monotonic in tokens', () => {
    const rates = { inputPerM: 5, outputPerM: 25 };
    const a = estimateCost({ inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, rates);
    const b = estimateCost({ inputTokens: 2000, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, rates);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeCloseTo(1000 * 5e-6 + 100 * 25e-6, 9);
  });
});

describe('tree builder — REAL subagent trace (fixtures/real-subagent.jsonl)', () => {
  const { tree } = build('real-subagent.jsonl');

  it('builds exactly one subagent node, child of root, completed', () => {
    const subs = tree.flatNodes().filter((n) => n.nodeType === 'subagent');
    expect(subs).toHaveLength(1);
    expect(subs[0].parentId).toBe('run-1');
    expect(subs[0].status).toBe('completed');
  });

  it('routes the subagent\'s inner Bash tool_use under the subagent node, not root', () => {
    // The real Agent id from the capture:
    const subId = 'toolu_01AtwvmRzhXamZubhW4FX3Nh';
    const sub = tree.nodes.get(subId);
    expect(sub).toBeDefined();
    // its inner work accrued output tokens on the subagent node
    expect(sub!.tokensOut).toBeGreaterThan(0);
  });

  it('reconciles run cost to the authoritative result.total_cost_usd', () => {
    expect(tree.authoritativeCost).toBeCloseTo(0.3233155, 6);
  });
});

describe('processManager.buildArgs — interactive stdin-prompt fix', () => {
  const base: any = { prompt: 'do the thing', cwd: '/tmp', model: 'claude-haiku-4-5', effort: 'medium', permissionMode: 'default' };

  it('one-shot: passes the prompt after a `--` separator (so variadic --add-dir cannot swallow it)', () => {
    const args = buildArgs({ ...base, cwd: '/some/dir' }, 'sid-1', false);
    expect(args).not.toContain('--input-format');
    expect(args[args.length - 1]).toBe('do the thing'); // prompt last
    expect(args[args.length - 2]).toBe('--'); // immediately preceded by the -- separator (F-11)
    // and the prompt must NOT directly follow --add-dir's value (the bug we fixed)
    const addDirIdx = args.indexOf('--add-dir');
    if (addDirIdx >= 0) expect(args[addDirIdx + 2]).not.toBe('do the thing');
    expect(args).toContain('--session-id');
  });

  it('interactive: NEVER passes the prompt as a positional (delivered via stdin) and adds --input-format', () => {
    const args = buildArgs(base, 'sid-2', true);
    // the prompt must NOT appear as an argv token — in stream-json input mode it is ignored and the
    // process would block forever (the real-claude bug that left runs stuck at "starting").
    expect(args).not.toContain('do the thing');
    expect(args).toContain('--input-format');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args).toContain('-p'); // still headless/--print
  });
});

describe('orchestration — plan contract (Campaigns)', () => {
  it('PLAN_JSON_SCHEMA requires tasks[] with id/title/prompt (the --json-schema contract)', () => {
    const s: any = PLAN_JSON_SCHEMA;
    expect(s.type).toBe('object');
    expect(s.required).toContain('tasks');
    const item = s.properties.tasks.items;
    expect(item.required).toEqual(expect.arrayContaining(['id', 'title', 'prompt']));
  });

  it('parser surfaces structured_output (F-8) and it is a valid dependency DAG', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const raw = fs.readFileSync(path.join(repoRoot, 'fixtures', 'orchestrator-plan.jsonl'), 'utf8');
    const result = raw.split('\n').map((l: string) => l.trim()).filter((l: string) => l.startsWith('{')).map((l: string) => JSON.parse(l)).find((o: any) => o.type === 'result');
    // the plan is in structured_output (an object), NOT result.result (prose) — the real shape
    expect(typeof result.result).toBe('string');
    const [p] = normalize(result);
    expect(p.structuredOutput).toBeTruthy();
    const plan = p.structuredOutput as OrchestratorPlan;
    expect(plan.tasks.length).toBe(3);
    const ids = new Set(plan.tasks.map((t) => t.id));
    // every dependsOn references a real task id (no dangling deps)
    for (const t of plan.tasks) for (const d of t.dependsOn ?? []) expect(ids.has(d)).toBe(true);
    // there is at least one root task and one dependent task (a real DAG, not a flat list)
    expect(plan.tasks.some((t) => (t.dependsOn ?? []).length === 0)).toBe(true);
    expect(plan.tasks.some((t) => (t.dependsOn ?? []).length > 0)).toBe(true);
  });
});

describe('tree builder — failure & accounting (review fixes)', () => {
  function feed(raws: any[]) {
    const tree = new RunTree('run-1', 'sess-1', { inputPerM: 5, outputPerM: 25 }, 0);
    let ts = 1;
    for (const raw of raws) for (const p of normalize(raw)) tree.ingest(p, ts++);
    return tree;
  }

  it('marks a subagent FAILED when its tool_result carries is_error:true (review #1)', () => {
    const tree = feed([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        message: { content: [{ type: 'tool_use', name: 'Agent', id: 'AGX', input: { description: 'do work' } }], usage: { input_tokens: 100, output_tokens: 10 } },
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'AGX', is_error: true, content: 'subagent crashed' }] },
      },
    ]);
    expect(tree.nodes.get('AGX')!.status).toBe('failed');
  });

  it('still marks success when is_error is absent/false', () => {
    const tree = feed([
      { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'AGY', input: {} }] } },
      { type: 'user', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'AGY', content: 'ok' }] } },
    ]);
    expect(tree.nodes.get('AGY')!.status).toBe('completed');
  });

  it('runaway fixture drives portionCost past a $0.50 budget BEFORE the result event (guardrail trigger)', () => {
    const raws = (() => {
      const fs = require('node:fs');
      const path = require('node:path');
      const p = path.join(repoRoot, 'fixtures', 'runaway.jsonl');
      return fs.readFileSync(p, 'utf8').split('\n').filter((l: string) => l.trim().startsWith('{')).map((l: string) => JSON.parse(l));
    })();
    const tree = new RunTree('r', 's', { inputPerM: 5, outputPerM: 25 }, 0);
    let ts = 1;
    let crossedBeforeResult = false;
    let sawResult = false;
    for (const raw of raws) {
      for (const p of normalize(raw)) {
        if (p.type === 'result') sawResult = true;
        tree.ingest(p, ts++);
        if (!sawResult && tree.rollups().portionCostUsd >= 0.5) crossedBeforeResult = true;
      }
    }
    expect(crossedBeforeResult).toBe(true); // guardrail would fire mid-stream, before completion
  });

  it('baseline carries cumulative cost while portionCost tracks this invocation (review #2)', () => {
    const tree = new RunTree('r', 's', { inputPerM: 5, outputPerM: 25 }, 0, { cost: 1.5, tokensOut: 1000 });
    tree.ingest({ type: 'assistant_text', parentToolUseId: null, text: 'hi', usage: { inputTokens: 0, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, raw: {} } as any, 1);
    const r = tree.rollups();
    expect(r.costUsd).toBeGreaterThan(1.5); // cumulative includes baseline
    expect(r.portionCostUsd).toBeLessThan(r.costUsd); // this-invocation only
    expect(r.tokensOut).toBe(1400); // 1000 baseline + 400 this invocation
  });
});

describe('tree builder — synthetic fan-out (fixtures/workflow-fanout.jsonl)', () => {
  const { tree } = build('workflow-fanout.jsonl');
  const r = tree.rollups();

  it('captures 3 subagents (2 concurrent + 1 nested) with correct depth', () => {
    expect(r.subagentCount).toBe(3);
    expect(r.maxDepth).toBe(2);
  });

  it('nests AG3 under AG1, and AG1/AG2 under root', () => {
    expect(tree.nodes.get('AG1')!.parentId).toBe('run-1');
    expect(tree.nodes.get('AG2')!.parentId).toBe('run-1');
    expect(tree.nodes.get('AG3')!.parentId).toBe('AG1');
    expect(tree.nodes.get('AG3')!.depth).toBe(2);
  });

  it('marks every subagent completed and none live after result', () => {
    expect(r.liveSubagents).toBe(0);
    for (const id of ['AG1', 'AG2', 'AG3']) {
      expect(tree.nodes.get(id)!.status).toBe('completed');
    }
  });

  it('assembles a nested tree the UI can render', () => {
    const root = tree.assembleTree();
    expect(root.nodeType).toBe('root');
    const childIds = root.children!.map((c) => c.id).sort();
    expect(childIds).toEqual(['AG1', 'AG2']);
    const ag1 = root.children!.find((c) => c.id === 'AG1')!;
    expect(ag1.children!.map((c) => c.id)).toEqual(['AG3']);
  });

  it('reports the authoritative run cost from the result event', () => {
    expect(r.costUsd).toBeCloseTo(1.8423, 4);
  });
});
