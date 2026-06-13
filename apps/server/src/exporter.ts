/**
 * Export surface (A9): download a single run as JSON or Markdown, and the
 * (optionally filtered) history as CSV. Read-only — reuses the existing repo,
 * no new tables. Routes set Content-Disposition so the browser saves a file.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { repo } from './db.js';
import type { Run, RunNode, NormalizedEvent } from '@fleet/shared';

// ── small formatting helpers (kept local; server has no web format.ts) ─────────
function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toISOString();
}

// ── Markdown report ────────────────────────────────────────────────────────────
function mdEscape(s: string): string {
  // neutralize pipes so freeform text never breaks a Markdown table cell
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function buildMarkdown(run: Run, nodes: RunNode[], events: NormalizedEvent[]): string {
  const duration = fmtDuration((run.endedAt ?? Date.now()) - run.startedAt);
  const lines: string[] = [];

  lines.push(`# ${run.task || '(untitled run)'}`);
  lines.push('');
  lines.push(`> Run \`${run.id}\` — exported ${new Date().toISOString()}`);
  lines.push('');

  // overview
  lines.push('## Overview');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Status | ${run.status} |`);
  lines.push(`| Model | ${run.model}${run.fastMode ? ' (fast)' : ''} |`);
  lines.push(`| Effort | ${run.effort} |`);
  lines.push(`| Cost | ${usd(run.costUsd)} |`);
  lines.push(`| Tokens in / out | ${fmtTokens(run.tokensIn)} / ${fmtTokens(run.tokensOut)} |`);
  lines.push(`| Duration | ${duration} |`);
  lines.push(`| Started | ${fmtTs(run.startedAt)} |`);
  lines.push(`| Ended | ${fmtTs(run.endedAt)} |`);
  lines.push(`| Working dir | \`${run.cwd}\` |`);
  lines.push(`| Permission mode | ${run.permissionMode} |`);
  if (run.budgetUsd != null) lines.push(`| Budget | ${usd(run.budgetUsd)} |`);
  if (run.exitCode != null) lines.push(`| Exit code | ${run.exitCode} |`);
  if (run.killReason) lines.push(`| Kill reason | ${run.killReason} |`);
  if (run.skills && run.skills.length) lines.push(`| Skills | ${run.skills.join(', ')} |`);
  lines.push('');

  // error (only when present)
  if (run.error) {
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(run.error);
    lines.push('```');
    lines.push('');
  }

  // result
  lines.push('## Result');
  lines.push('');
  if (run.resultText && run.resultText.trim()) {
    lines.push(run.resultText.trim());
  } else {
    lines.push('_No result text recorded._');
  }
  lines.push('');

  // structured output (only when present)
  if (run.structuredOutput != null) {
    lines.push('## Structured Output');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(run.structuredOutput, null, 2));
    lines.push('```');
    lines.push('');
  }

  // subtree / nodes
  if (nodes.length) {
    lines.push('## Subagent Tree');
    lines.push('');
    lines.push('| Depth | Type | Label | Status | Cost | Tokens out |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const n of nodes) {
      lines.push(
        `| ${n.depth} | ${n.nodeType} | ${mdEscape(n.label)} | ${n.status} | ${usd(n.costUsd)} | ${fmtTokens(n.tokensOut)} |`,
      );
    }
    lines.push('');
  }

  // event / tool summary — counts by type, plus the tools actually used
  lines.push('## Event Summary');
  lines.push('');
  lines.push(`Total events: ${events.length}`);
  lines.push('');
  if (events.length) {
    const byType = new Map<string, number>();
    const tools = new Map<string, number>();
    for (const e of events) {
      byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      const tool = (e.payload as any)?.toolName ?? (e.payload as any)?.tool ?? (e.payload as any)?.name;
      if (e.type === 'tool_use' && typeof tool === 'string') {
        tools.set(tool, (tools.get(tool) ?? 0) + 1);
      }
    }
    lines.push('| Event type | Count |');
    lines.push('| --- | --- |');
    for (const [t, c] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${mdEscape(t)} | ${c} |`);
    }
    lines.push('');
    if (tools.size) {
      lines.push('### Tools used');
      lines.push('');
      lines.push('| Tool | Calls |');
      lines.push('| --- | --- |');
      for (const [t, c] of [...tools.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${mdEscape(t)} | ${c} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── CSV ─────────────────────────────────────────────────────────────────────────
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // neutralize spreadsheet formula injection (CWE-1236)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(runs: Run[]): string {
  const header = ['id', 'task', 'model', 'effort', 'status', 'costUsd', 'tokensIn', 'tokensOut', 'startedAt', 'endedAt'];
  const rows = [header.join(',')];
  for (const r of runs) {
    rows.push(
      [
        csvCell(r.id),
        csvCell(r.task),
        csvCell(r.model),
        csvCell(r.effort),
        csvCell(r.status),
        csvCell(r.costUsd),
        csvCell(r.tokensIn),
        csvCell(r.tokensOut),
        csvCell(r.startedAt),
        csvCell(r.endedAt),
      ].join(','),
    );
  }
  // trailing newline so the file ends cleanly; \r\n for spreadsheet friendliness
  return rows.join('\r\n') + '\r\n';
}

function attach(reply: FastifyReply, contentType: string, filename: string) {
  reply.header('Content-Type', contentType);
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
}

export function registerExportRoutes(app: FastifyInstance) {
  // History CSV (optionally filtered). Registered before the param route below;
  // it is a distinct path depth (/api/agents/export.csv) so there is no collision.
  app.get('/api/agents/export.csv', async (req, reply) => {
    const q = req.query as any;
    // Uncapped — the UI list's 500-row cap would silently drop older runs from the export.
    // Include archived runs: a spend/usage reconciliation must span EVERY run, and the
    // accounting queries (spendSince, projectSpendStmt, …) count archived runs too, so the
    // CSV must as well or its SUM(cost_usd) diverges from the spend totals the UI shows.
    const runs = repo.listRunsForExport({ status: q?.status, effort: q?.effort, q: q?.q, archived: 'include' });
    attach(reply, 'text/csv; charset=utf-8', 'fleet-history.csv');
    return reply.send(buildCsv(runs));
  });

  // Single run → json | md
  app.get('/api/agents/:id/export', async (req, reply) => {
    const id = (req.params as any).id as string;
    const run = repo.getRun(id);
    if (!run) {
      reply.code(404);
      return { error: 'not found' };
    }

    const format = String((req.query as any)?.format ?? 'json').toLowerCase();
    const nodes = repo.getNodes(id);
    const events = repo.getEvents(id, -1, 100000);

    if (format === 'md' || format === 'markdown') {
      attach(reply, 'text/markdown; charset=utf-8', `run-${id}.md`);
      return reply.send(buildMarkdown(run, nodes, events));
    }

    if (format === 'json') {
      const bundle = { run, nodes, events };
      attach(reply, 'application/json; charset=utf-8', `run-${id}.json`);
      return reply.send(JSON.stringify(bundle, null, 2));
    }

    reply.code(400);
    return { error: 'format must be one of: json, md' };
  });
}
