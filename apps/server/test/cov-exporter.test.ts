/**
 * Real coverage tests for exporter.ts (A9 export surface).
 *
 * exporter.ts exports only registerExportRoutes — buildCsv / buildMarkdown / csvCell /
 * the usd/fmt* helpers are all module-private. So we drive them end-to-end through the
 * REAL fastify app (buildServer().inject()) against an isolated DB, seeding runs / nodes /
 * events via the real `repo` and asserting the exact bytes the route returns. The CSV
 * cell-escaping, Markdown table rendering, and per-format/404/400 branches are all
 * asserted on real output — nothing is called just to paint coverage.
 *
 * Target lines: 11-162 (usd/fmtTokens/fmtDuration/fmtTs/mdEscape/buildMarkdown/csvCell),
 * 168-182 (buildCsv rows), 220-231 (md/json/bad-format route branches).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, RunNode, NormalizedEvent } from '@fleet/shared';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-exporter-'));

let app: any;
let PORT: number;
let repo: typeof import('../src/db.js').repo;
const HOST = () => ({ host: `127.0.0.1:${PORT}` }); // satisfy the H3 host allowlist
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

// ── seed builders ──────────────────────────────────────────────────────────────
function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run-base',
    sessionId: 'sess-base',
    task: 'base task',
    cwd: '/work',
    model: 'claude-opus-4-8',
    fastMode: false,
    effort: 'high',
    workflowsEnabled: false,
    ultracode: false,
    teamId: null,
    campaignId: null,
    projectId: null,
    status: 'completed',
    startedAt: 1_000_000,
    endedAt: 1_065_000, // +65s
    tokensIn: 1234,
    tokensOut: 5678,
    costUsd: 0.42,
    exitCode: 0,
    killReason: null,
    error: null,
    budgetUsd: null,
    permissionMode: 'default',
    allowedTools: null,
    skills: [],
    subagentProfile: null,
    resultText: 'the result text',
    structuredOutput: null,
    pid: null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: 1_065_000,
    ...over,
  };
}

function makeNode(over: Partial<RunNode> = {}): RunNode {
  return {
    id: 'node-1',
    runId: 'run-base',
    parentId: null,
    nodeType: 'subagent',
    label: 'a | b\nc', // pipes + newline → exercises mdEscape
    status: 'completed',
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.005,
    startedAt: 1_000_000,
    endedAt: 1_001_000,
    depth: 1,
    ...over,
  };
}

function makeEvent(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sessionId: 'sess-base',
    runId: 'run-base',
    nodeId: 'run-base',
    parentNodeId: null,
    nodeType: 'root',
    seq: 0,
    ts: 1_000_000,
    type: 'init',
    payload: {},
    ...over,
  };
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ repo } = await import('../src/db.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try { rmSync(process.env.FLEET_DATA_DIR!, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV history export — buildCsv + csvCell escaping (lines 156-184, route 195-204)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/agents/export.csv — buildCsv + csvCell', () => {
  it('emits header + one CRLF-terminated row per run with the documented columns', async () => {
    repo.upsertRun(makeRun({ id: 'csv-plain', task: 'simple', model: 'm1', effort: 'low', status: 'completed', costUsd: 1.5, tokensIn: 100, tokensOut: 200, startedAt: 10, endedAt: 20 }));

    const res = await get('/api/agents/export.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('fleet-history.csv');

    const body = res.body as string;
    const lines = body.split('\r\n');
    expect(lines[0]).toBe('id,task,model,effort,status,costUsd,tokensIn,tokensOut,startedAt,endedAt');
    // \r\n line ending + trailing terminator → last element is the empty string
    expect(body.endsWith('\r\n')).toBe(true);
    expect(lines[lines.length - 1]).toBe('');

    const row = lines.find((l) => l.startsWith('csv-plain,'));
    expect(row).toBeDefined();
    expect(row).toBe('csv-plain,simple,m1,low,completed,1.5,100,200,10,20');
  });

  it('quotes cells containing comma / quote / newline and doubles embedded quotes', async () => {
    // task has a comma, a double-quote, and a newline → must be wrapped + quotes doubled
    repo.upsertRun(makeRun({ id: 'csv-quote', task: 'a,b "x"\nz' }));

    const res = await get('/api/agents/export.csv');
    const body = res.body as string;
    const line = body.split('\r\n').find((l) => l.startsWith('csv-quote,'))!;
    expect(line).toBeDefined();
    // csvCell: quotes the field, doubles the inner ", keeps the literal newline inside the quotes
    expect(line).toContain('"a,b ""x""');
    // the embedded newline lands inside the quoted field, so the *next* split segment is the tail
    const idx = body.indexOf('csv-quote,');
    const fragment = body.slice(idx, idx + 40);
    expect(fragment).toContain('"a,b ""x""\nz"');
  });

  it('prefixes a leading-formula cell to neutralize spreadsheet injection (CWE-1236)', async () => {
    repo.upsertRun(makeRun({ id: 'csv-inj', task: '=SUM(A1:A9)' }));

    const res = await get('/api/agents/export.csv');
    const body = res.body as string;
    const line = body.split('\r\n').find((l) => l.startsWith('csv-inj,'))!;
    expect(line).toBeDefined();
    // leading '=' → prefixed with ' → and because that ' makes no special char, NOT quoted
    expect(line).toBe("csv-inj,'=SUM(A1:A9),claude-opus-4-8,high,completed,0.42,1234,5678,1000000,1065000");
  });

  it("a formula cell that ALSO needs quoting (contains a comma) is both prefixed and quoted", async () => {
    repo.upsertRun(makeRun({ id: 'csv-inj2', task: '+1,2' }));
    const res = await get('/api/agents/export.csv');
    const line = (res.body as string).split('\r\n').find((l) => l.startsWith('csv-inj2,'))!;
    // '+' → prefix ' → value "'+1,2" still contains a comma → wrapped in quotes
    expect(line).toContain(`"'+1,2"`);
  });

  it('renders a null endedAt as an empty trailing cell (csvCell null → "")', async () => {
    // tokens_in/out & cost_usd are NOT NULL in the schema (default 0) → can't persist nulls there.
    // ended_at IS nullable, so this exercises csvCell(null) → "" for the final column.
    repo.upsertRun(makeRun({ id: 'csv-null', task: 'nulls', costUsd: 0, tokensIn: 0, tokensOut: 0, startedAt: 1000000, endedAt: null }));
    const res = await get('/api/agents/export.csv');
    const line = (res.body as string).split('\r\n').find((l) => l.startsWith('csv-null,'))!;
    expect(line).toBeDefined();
    // id,task,model,effort,status,cost,in,out,started,<empty ended>
    expect(line).toBe('csv-null,nulls,claude-opus-4-8,high,completed,0,0,0,1000000,');
  });

  it('honours the status / effort / q filters passed to listRunsForExport', async () => {
    repo.upsertRun(makeRun({ id: 'flt-fail', task: 'needle-unique-abc', status: 'failed', effort: 'max' }));
    // status filter
    const byStatus = (await get('/api/agents/export.csv?status=failed')).body as string;
    expect(byStatus).toContain('flt-fail,');
    expect(byStatus).not.toContain('csv-plain,');
    // q filter narrows to the matching task text
    const byQ = (await get('/api/agents/export.csv?q=needle-unique-abc')).body as string;
    const dataRows = byQ.split('\r\n').filter((l) => l && !l.startsWith('id,'));
    expect(dataRows.length).toBe(1);
    expect(dataRows[0]).toContain('flt-fail,');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-run export — json branch (lines 224-228)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/agents/:id/export?format=json', () => {
  beforeAll(() => {
    repo.upsertRun(makeRun({ id: 'json-run', task: 'json task' }));
    repo.upsertNodes([makeNode({ id: 'json-node', runId: 'json-run' })]);
    repo.insertEvents([makeEvent({ runId: 'json-run', nodeId: 'json-run', seq: 1, type: 'result' })]);
  });

  it('returns the {run,nodes,events} bundle as pretty JSON with the json attachment headers', async () => {
    const res = await get('/api/agents/json-run/export?format=json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('run-json-run.json');

    const bundle = JSON.parse(res.body as string);
    expect(bundle.run.id).toBe('json-run');
    expect(bundle.run.task).toBe('json task');
    expect(Array.isArray(bundle.nodes)).toBe(true);
    expect(bundle.nodes.map((n: any) => n.id)).toContain('json-node');
    expect(Array.isArray(bundle.events)).toBe(true);
    expect(bundle.events.some((e: any) => e.type === 'result')).toBe(true);
    // pretty-printed (2-space indent) → contains newline + indentation
    expect(res.body).toContain('\n  "run"');
  });

  it('defaults to json when no format query is supplied', async () => {
    const res = await get('/api/agents/json-run/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body as string).run.id).toBe('json-run');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-run export — markdown branch + buildMarkdown rendering (lines 45-153, 219-221)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/agents/:id/export?format=md — buildMarkdown', () => {
  it('renders a full report: overview table, error, structured output, node tree, event summary', async () => {
    repo.upsertRun(makeRun({
      id: 'md-full',
      task: 'My Big Run',
      model: 'claude-opus-4-8',
      fastMode: true,            // → "(fast)" suffix
      effort: 'xhigh',
      status: 'failed',
      costUsd: 0.42,
      tokensIn: 1234,
      tokensOut: 5678,
      startedAt: 1_000_000,
      endedAt: 1_065_000,        // duration 65s → "1m 5s"
      cwd: '/some/dir',
      permissionMode: 'plan',
      budgetUsd: 2,              // optional Budget row
      exitCode: 1,               // optional Exit code row
      killReason: 'budget',      // optional Kill reason row
      skills: ['skillA', 'skillB'], // optional Skills row
      error: 'boom failure',     // Error section
      resultText: '  trimmed result  ',
      structuredOutput: { ok: true, n: 3 }, // Structured Output section
    }));
    repo.upsertNodes([
      makeNode({ id: 'md-node-1', runId: 'md-full', label: 'has|pipe', depth: 1, status: 'completed', costUsd: 0.01, tokensOut: 99 }),
    ]);
    repo.insertEvents([
      makeEvent({ runId: 'md-full', nodeId: 'md-full', seq: 1, type: 'tool_use', payload: { toolName: 'Bash' } }),
      makeEvent({ runId: 'md-full', nodeId: 'md-full', seq: 2, type: 'tool_use', payload: { toolName: 'Bash' } }),
      makeEvent({ runId: 'md-full', nodeId: 'md-full', seq: 3, type: 'tool_use', payload: { name: 'Read' } }),
      makeEvent({ runId: 'md-full', nodeId: 'md-full', seq: 4, type: 'assistant_text', payload: { text: 'hi' } }),
    ]);

    const res = await get('/api/agents/md-full/export?format=md');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('run-md-full.md');

    const md = res.body as string;

    // title + run id line
    expect(md).toContain('# My Big Run');
    expect(md).toContain('> Run `md-full` — exported');

    // overview rows
    expect(md).toContain('| Status | failed |');
    expect(md).toContain('| Model | claude-opus-4-8 (fast) |'); // fastMode suffix
    expect(md).toContain('| Effort | xhigh |');
    expect(md).toContain('| Cost | $0.42 |');                   // usd(0.42)
    expect(md).toContain('| Tokens in / out | 1,234 / 5,678 |'); // fmtTokens (toLocaleString)
    expect(md).toContain('| Duration | 1m 5s |');               // fmtDuration 65000ms
    expect(md).toContain('| Started | 1970-01-01T00:16:40.000Z |'); // fmtTs(1_000_000)
    expect(md).toContain('| Working dir | `/some/dir` |');
    expect(md).toContain('| Permission mode | plan |');
    expect(md).toContain('| Budget | $2.00 |');                 // budgetUsd row
    expect(md).toContain('| Exit code | 1 |');                  // exitCode row
    expect(md).toContain('| Kill reason | budget |');           // killReason row
    expect(md).toContain('| Skills | skillA, skillB |');        // skills row

    // error section
    expect(md).toContain('## Error');
    expect(md).toContain('boom failure');

    // result section (trimmed)
    expect(md).toContain('## Result');
    expect(md).toContain('\ntrimmed result\n'); // .trim() applied

    // structured output section
    expect(md).toContain('## Structured Output');
    expect(md).toContain('```json');
    expect(md).toContain('"ok": true');
    expect(md).toContain('"n": 3');

    // subagent tree — pipe in the label is escaped by mdEscape
    expect(md).toContain('## Subagent Tree');
    expect(md).toContain('| Depth | Type | Label | Status | Cost | Tokens out |');
    expect(md).toContain('| 1 | subagent | has\\|pipe | completed | $0.01 | 99 |');

    // event summary — total + by-type counts (sorted desc), tools-used table
    expect(md).toContain('## Event Summary');
    expect(md).toContain('Total events: 4');
    expect(md).toContain('| Event type | Count |');
    expect(md).toContain('| tool_use | 3 |');        // 3 tool_use events, sorted first (highest count)
    expect(md).toContain('| assistant_text | 1 |');
    expect(md).toContain('### Tools used');
    expect(md).toContain('| Bash | 2 |');            // 2 Bash, sorted before Read
    expect(md).toContain('| Read | 1 |');

    // tool_use(3) sorts before assistant_text(1) in the by-type table
    const typeTableStart = md.indexOf('| Event type | Count |');
    expect(md.indexOf('| tool_use | 3 |')).toBeGreaterThan(typeTableStart);
    expect(md.indexOf('| tool_use | 3 |')).toBeLessThan(md.indexOf('| assistant_text | 1 |'));
  });

  it('accepts the "markdown" alias and falls back to placeholders for an empty/minimal run', async () => {
    // No nodes, no events, no result/error/structured/budget/exit/kill/skills → the "else" branches:
    // untitled title, "_No result text recorded._", no tree/error/structured sections, ongoing duration.
    repo.upsertRun(makeRun({
      id: 'md-min',
      task: '',              // → "# (untitled run)"
      endedAt: null,         // duration uses Date.now(); Ended row → fmtTs(null) → em dash
      costUsd: 0,            // usd(0) → "$0.00"
      tokensIn: 0,           // fmtTokens(0) → "0" (tokens_in is NOT NULL in schema)
      tokensOut: 0,
      resultText: '   ',     // whitespace-only → placeholder
      structuredOutput: null,
      skills: [],
    }));

    const res = await get('/api/agents/md-min/export?format=markdown');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');

    const md = res.body as string;
    expect(md).toContain('# (untitled run)');          // empty task fallback
    expect(md).toContain('| Cost | $0.00 |');          // usd(0)
    expect(md).toContain('| Tokens in / out | 0 / 0 |'); // fmtTokens(0)
    expect(md).toContain('| Ended | — |');             // fmtTs(null) → em dash
    expect(md).toContain('_No result text recorded._'); // whitespace result → placeholder
    expect(md).not.toContain('## Error');              // no error section
    expect(md).not.toContain('## Structured Output');  // none
    expect(md).not.toContain('## Subagent Tree');      // no nodes
    expect(md).toContain('Total events: 0');           // empty events → no by-type table
    expect(md).not.toContain('| Event type | Count |');
  });

  it('formats a sub-cent cost with 4 decimals and a multi-hour duration', async () => {
    repo.upsertRun(makeRun({
      id: 'md-fmt',
      task: 'fmt edges',
      costUsd: 0.0005,           // usd: < 0.01 → toFixed(4) → "$0.0005"
      startedAt: 0,
      endedAt: 2 * 3_600_000 + 5 * 60_000, // 2h 5m → fmtDuration "2h 5m"
    }));
    const md = (await get('/api/agents/md-fmt/export?format=md')).body as string;
    expect(md).toContain('| Cost | $0.0005 |');
    expect(md).toContain('| Duration | 2h 5m |');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error / edge route branches (lines 210-213, 230-231)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/agents/:id/export — 404 / 400 branches', () => {
  it('404s with {error:"not found"} for an unknown run', async () => {
    const res = await get('/api/agents/does-not-exist/export?format=json');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('400s with the allowed-format message for an unrecognized format', async () => {
    repo.upsertRun(makeRun({ id: 'bad-fmt', task: 'bad' }));
    const res = await get('/api/agents/bad-fmt/export?format=xml');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'format must be one of: json, md' });
  });

  it('treats the format query case-insensitively (MD → markdown branch)', async () => {
    repo.upsertRun(makeRun({ id: 'case-fmt', task: 'case' }));
    const res = await get('/api/agents/case-fmt/export?format=MD');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
  });
});
