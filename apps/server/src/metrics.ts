/**
 * Aggregate metrics dashboard (Feature A2). Read-only roll-ups over the runs
 * table using the raw sqlite handle (GROUP BY). One optional time window (`since`,
 * epoch ms, matched on started_at like repo.spendSince) applies uniformly to every
 * aggregate so the whole dashboard reflects the same slice. Degrades to empty
 * arrays / zeroed totals when no rows match.
 */
import type { FastifyInstance } from 'fastify';
import db from './db.js';

// runs the rest of the codebase treats as terminal (cf. reconcileOrphans / nonTerminalPids)
const TERMINAL = "status IN ('completed','failed','killed') AND ended_at IS NOT NULL";

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.floor(p * (n - 1))];
}

export function registerMetricsRoutes(app: FastifyInstance) {
  app.get('/api/metrics', async (req) => {
    const raw = Number((req.query as any)?.since);
    const useSince = Number.isFinite(raw);
    const where = useSince ? 'WHERE started_at >= ?' : '';
    // params reused per-statement; only bound when the filter is active
    const p: any[] = useSince ? [raw] : [];

    // ── totals ──────────────────────────────────────────────────────────────
    const totalsRow = db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(cost_usd),0)   AS costUsd,
                COALESCE(SUM(tokens_in),0)  AS tokensIn,
                COALESCE(SUM(tokens_out),0) AS tokensOut
         FROM runs ${where}`,
      )
      .get(...p) as any;
    const totals = {
      runs: totalsRow.runs as number,
      costUsd: totalsRow.costUsd as number,
      tokensIn: totalsRow.tokensIn as number,
      tokensOut: totalsRow.tokensOut as number,
    };

    // ── by model ────────────────────────────────────────────────────────────
    const byModel = (
      db
        .prepare(
          `SELECT model,
                  COUNT(*) AS runs,
                  COALESCE(SUM(cost_usd),0)   AS costUsd,
                  COALESCE(SUM(tokens_in),0)  AS tokensIn,
                  COALESCE(SUM(tokens_out),0) AS tokensOut
           FROM runs ${where}
           GROUP BY model
           ORDER BY costUsd DESC`,
        )
        .all(...p) as any[]
    ).map((r) => ({
      model: r.model as string,
      runs: r.runs as number,
      costUsd: r.costUsd as number,
      tokensIn: r.tokensIn as number,
      tokensOut: r.tokensOut as number,
    }));

    // ── by effort ───────────────────────────────────────────────────────────
    const byEffort = (
      db
        .prepare(
          `SELECT effort,
                  COUNT(*) AS runs,
                  COALESCE(SUM(cost_usd),0) AS costUsd
           FROM runs ${where}
           GROUP BY effort
           ORDER BY costUsd DESC`,
        )
        .all(...p) as any[]
    ).map((r) => ({
      effort: r.effort as string,
      runs: r.runs as number,
      costUsd: r.costUsd as number,
    }));

    // ── status counts (open-ended map, not three fixed keys) ──────────────────
    const statusRows = db
      .prepare(`SELECT status, COUNT(*) AS c FROM runs ${where} GROUP BY status`)
      .all(...p) as any[];
    const statusCounts: Record<string, number> = {};
    for (const r of statusRows) statusCounts[r.status as string] = r.c as number;

    // ── durations p50/p95 over terminal runs (computed in JS) ─────────────────
    const durWhere = useSince ? `WHERE ${TERMINAL} AND started_at >= ?` : `WHERE ${TERMINAL}`;
    const durs = (
      db
        .prepare(`SELECT (ended_at - started_at) AS ms FROM runs ${durWhere}`)
        .all(...p) as any[]
    )
      .map((r) => r.ms as number)
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
      .sort((a, b) => a - b);
    const durations = { p50Ms: percentile(durs, 0.5), p95Ms: percentile(durs, 0.95) };

    // ── top cost (top 8) ──────────────────────────────────────────────────────
    const topCost = (
      db
        .prepare(
          `SELECT id, task, cost_usd AS costUsd FROM runs ${where} ORDER BY cost_usd DESC LIMIT 8`,
        )
        .all(...p) as any[]
    ).map((r) => ({ id: r.id as string, task: r.task as string, costUsd: r.costUsd as number }));

    // ── daily spend (day bucket computed in JS, local time, sorted oldest→newest)
    const dayRows = db
      .prepare(`SELECT started_at, cost_usd FROM runs ${where}`)
      .all(...p) as any[];
    const dayMap = new Map<string, { costUsd: number; runs: number }>();
    for (const r of dayRows) {
      const d = new Date(r.started_at as number);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
      const cur = dayMap.get(day) ?? { costUsd: 0, runs: 0 };
      cur.costUsd += (r.cost_usd as number) ?? 0;
      cur.runs += 1;
      dayMap.set(day, cur);
    }
    const dailySpend = [...dayMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([day, v]) => ({ day, costUsd: v.costUsd, runs: v.runs }));

    return { dailySpend, byModel, byEffort, statusCounts, durations, totals, topCost };
  });
}
