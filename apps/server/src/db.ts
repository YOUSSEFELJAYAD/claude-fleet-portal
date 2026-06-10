/**
 * Persistence (DC.md D-005): SQLite via better-sqlite3, schema mirroring PRD §9.3
 * (runs / run_nodes / events / teams / run_skills / config). Isolated behind this
 * repository so Postgres can swap in later. Durable + SQL-searchable → satisfies
 * §7.8 (history & search) with zero external infra.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { DB_PATH, DATA_DIR, DEFAULT_CONFIG } from './config.js';
import type {
  Run,
  RunNode,
  NormalizedEvent,
  PortalConfig,
  RunStatus,
  AgentTemplate,
  Campaign,
  CampaignTask,
  CampaignStatus,
} from '@fleet/shared';

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// H15 — under WAL, synchronous=NORMAL is crash-safe and avoids an fsync per commit
// (the hot path is one commit per streamed line); busy_timeout makes any second
// reader/writer wait rather than throwing SQLITE_BUSY.
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  fast_mode INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL,
  workflows_enabled INTEGER NOT NULL DEFAULT 1,
  ultracode INTEGER NOT NULL DEFAULT 0,
  team_id TEXT,
  campaign_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  exit_code INTEGER,
  budget_usd REAL,
  permission_mode TEXT NOT NULL,
  allowed_tools TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  subagent_profile TEXT,
  result_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_nodes (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  depth INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
-- H15 — the (run_id,seq) PRIMARY KEY already serves every events query; a separate
-- index on the same columns is pure write amplification. Drop it (incl. on old DBs).
DROP INDEX IF EXISTS idx_events_run;

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lead_session_id TEXT,
  task_dir TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_skills (
  run_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  PRIMARY KEY (run_id, skill_name)
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  fast_mode INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  permission_mode TEXT NOT NULL,
  budget_usd REAL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  orchestrator_template TEXT NOT NULL,
  worker_template TEXT NOT NULL,
  synthesizer_template TEXT,
  orchestrator_run_id TEXT,
  synthesizer_run_id TEXT,
  max_parallel INTEGER NOT NULL DEFAULT 4,
  auto_synthesize INTEGER NOT NULL DEFAULT 0,
  budget_per_worker_usd REAL,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  project_id TEXT,
  disallowed_tools TEXT,
  permission_mode TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_started ON campaigns(started_at DESC);

CREATE TABLE IF NOT EXISTS campaign_tasks (
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  template TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, id)
);
`);

// idempotent migrations for columns added after initial release
for (const ddl of [
  'ALTER TABLE runs ADD COLUMN campaign_id TEXT',
  'ALTER TABLE runs ADD COLUMN structured_output TEXT',
  'ALTER TABLE runs ADD COLUMN pid INTEGER',
  'ALTER TABLE runs ADD COLUMN kill_reason TEXT',
  'ALTER TABLE runs ADD COLUMN error TEXT',
  'ALTER TABLE runs ADD COLUMN project_id TEXT', // agent-PM feature
  'ALTER TABLE campaigns ADD COLUMN project_id TEXT',
  'CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)',
  // v2 #4 — campaign-per-card delegation: workers carry a deny-list + a non-interactive
  // permission mode so `interactive:false` workers don't stall. campaigns table is OWNED by db.ts,
  // so (per §3.1) these campaigns-only ALTERs go in the EXISTING db.ts loop (NOT a new one).
  'ALTER TABLE campaigns ADD COLUMN disallowed_tools TEXT',
  'ALTER TABLE campaigns ADD COLUMN permission_mode TEXT',
]) {
  try {
    db.exec(ddl);
  } catch (e: any) {
    // H15 — only swallow the idempotent "column already exists"; a real DDL failure
    // must surface here, not later as an opaque "no such column" at stmt-prepare time.
    if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
  }
}

// ── row mappers ──────────────────────────────────────────────────────────────
function runToRow(r: Run) {
  return {
    id: r.id,
    session_id: r.sessionId,
    task: r.task,
    cwd: r.cwd,
    model: r.model,
    fast_mode: r.fastMode ? 1 : 0,
    effort: r.effort,
    workflows_enabled: r.workflowsEnabled ? 1 : 0,
    ultracode: r.ultracode ? 1 : 0,
    team_id: r.teamId,
    campaign_id: r.campaignId,
    project_id: r.projectId ?? null,
    pid: r.pid ?? null,
    status: r.status,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    cost_usd: r.costUsd,
    exit_code: r.exitCode,
    kill_reason: r.killReason ?? null,
    error: r.error ?? null,
    budget_usd: r.budgetUsd,
    permission_mode: r.permissionMode,
    allowed_tools: r.allowedTools,
    skills: JSON.stringify(r.skills ?? []),
    subagent_profile: r.subagentProfile,
    result_text: r.resultText,
    structured_output: r.structuredOutput != null ? JSON.stringify(r.structuredOutput) : null,
  };
}

function rowToRun(row: any): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    task: row.task,
    cwd: row.cwd,
    model: row.model,
    fastMode: !!row.fast_mode,
    effort: row.effort,
    workflowsEnabled: !!row.workflows_enabled,
    ultracode: !!row.ultracode,
    teamId: row.team_id,
    campaignId: row.campaign_id ?? null,
    projectId: row.project_id ?? null,
    pid: row.pid ?? null,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    exitCode: row.exit_code,
    killReason: row.kill_reason ?? null,
    error: row.error ?? null,
    budgetUsd: row.budget_usd,
    permissionMode: row.permission_mode,
    allowedTools: row.allowed_tools,
    skills: JSON.parse(row.skills || '[]'),
    subagentProfile: row.subagent_profile,
    resultText: row.result_text,
    structuredOutput: row.structured_output ? safeJson(row.structured_output) : null,
    subagentCount: 0,
    liveSubagents: 0,
    maxDepth: 0,
    lastActivity: row.ended_at ?? row.started_at,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function rowToEvent(row: any): NormalizedEvent {
  return {
    sessionId: '',
    runId: row.run_id,
    nodeId: row.node_id,
    parentNodeId: null,
    nodeType: 'root',
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    payload: JSON.parse(row.payload),
  };
}

const upsertRunStmt = db.prepare(`
INSERT INTO runs (id, session_id, task, cwd, model, fast_mode, effort, workflows_enabled, ultracode,
  team_id, campaign_id, project_id, pid, status, started_at, ended_at, tokens_in, tokens_out, cost_usd, exit_code, kill_reason, error, budget_usd,
  permission_mode, allowed_tools, skills, subagent_profile, result_text, structured_output)
VALUES (@id, @session_id, @task, @cwd, @model, @fast_mode, @effort, @workflows_enabled, @ultracode,
  @team_id, @campaign_id, @project_id, @pid, @status, @started_at, @ended_at, @tokens_in, @tokens_out, @cost_usd, @exit_code, @kill_reason, @error, @budget_usd,
  @permission_mode, @allowed_tools, @skills, @subagent_profile, @result_text, @structured_output)
ON CONFLICT(id) DO UPDATE SET
  status=@status, ended_at=@ended_at, tokens_in=@tokens_in, tokens_out=@tokens_out, cost_usd=@cost_usd,
  exit_code=@exit_code, kill_reason=@kill_reason, error=@error, result_text=@result_text, structured_output=@structured_output, pid=@pid
`);

const upsertNodeStmt = db.prepare(`
INSERT INTO run_nodes (run_id, id, parent_id, node_type, label, status, tokens_in, tokens_out, cost_usd, started_at, ended_at, depth)
VALUES (@run_id, @id, @parent_id, @node_type, @label, @status, @tokens_in, @tokens_out, @cost_usd, @started_at, @ended_at, @depth)
ON CONFLICT(run_id, id) DO UPDATE SET
  status=@status, label=@label, tokens_in=@tokens_in, tokens_out=@tokens_out, cost_usd=@cost_usd, ended_at=@ended_at
`);

const insertEventStmt = db.prepare(`
INSERT OR IGNORE INTO events (run_id, node_id, seq, ts, type, payload)
VALUES (@run_id, @node_id, @seq, @ts, @type, @payload)
`);

const insertSkillStmt = db.prepare(
  `INSERT OR IGNORE INTO run_skills (run_id, skill_name, scope) VALUES (?, ?, ?)`,
);

function queryRuns(filter: { status?: string; effort?: string; q?: string } | undefined, limit: number | null): Run[] {
  let sql = 'SELECT * FROM runs';
  const where: string[] = [];
  const params: any[] = [];
  if (filter?.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.effort) {
    where.push('effort = ?');
    params.push(filter.effort);
  }
  if (filter?.q) {
    where.push('(task LIKE ? OR cwd LIKE ? OR result_text LIKE ?)');
    const like = `%${filter.q}%`;
    params.push(like, like, like);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY started_at DESC';
  if (limit != null) sql += ` LIMIT ${limit}`;
  return (db.prepare(sql).all(...params) as any[]).map(rowToRun);
}

export const repo = {
  /** H4 — fold the WAL back into the main db file (call on graceful shutdown). */
  checkpoint() {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }
  },
  /** H4 — checkpoint + close the sqlite handle on shutdown. */
  close() {
    this.checkpoint();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  },
  upsertRun(r: Run) {
    upsertRunStmt.run(runToRow(r));
  },

  /**
   * H16 — persist a batch of changed nodes + new events + the run row in ONE outer
   * transaction (one fsync) instead of a commit per streamed line. The inner per-method
   * transactions become savepoints (better-sqlite3 nests), so durability is preserved.
   */
  batchPersist(nodes: RunNode[], events: NormalizedEvent[], run: Run | null) {
    const tx = db.transaction(() => {
      if (nodes.length) this.upsertNodes(nodes);
      if (events.length) this.insertEvents(events);
      if (run) this.upsertRun(run);
    });
    tx();
  },

  saveSkills(runId: string, skills: string[]) {
    const tx = db.transaction((items: string[]) => {
      for (const s of items) insertSkillStmt.run(runId, s, 'user');
    });
    tx(skills);
  },

  upsertNodes(nodes: RunNode[]) {
    const tx = db.transaction((items: RunNode[]) => {
      for (const n of items) {
        upsertNodeStmt.run({
          run_id: n.runId,
          id: n.id,
          parent_id: n.parentId,
          node_type: n.nodeType,
          label: n.label,
          status: n.status,
          tokens_in: n.tokensIn,
          tokens_out: n.tokensOut,
          cost_usd: n.costUsd,
          started_at: n.startedAt,
          ended_at: n.endedAt,
          depth: n.depth,
        });
      }
    });
    tx(nodes);
  },

  insertEvents(events: NormalizedEvent[]) {
    const tx = db.transaction((items: NormalizedEvent[]) => {
      for (const e of items) {
        insertEventStmt.run({
          run_id: e.runId,
          node_id: e.nodeId,
          seq: e.seq,
          ts: e.ts,
          type: e.type,
          payload: JSON.stringify(e.payload),
        });
      }
    });
    tx(events);
  },

  getRun(id: string): Run | null {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? rowToRun(row) : null;
  },

  /** Permanently delete a run's record + its nodes/events/skills (cascade). */
  deleteRun(id: string) {
    const tx = db.transaction((runId: string) => {
      db.prepare('DELETE FROM events WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM run_nodes WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM run_skills WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    });
    tx(id);
  },

  listRuns(filter?: { status?: string; effort?: string; q?: string }): Run[] {
    return queryRuns(filter, 500);
  },

  /** UNCAPPED variant for the CSV exporter — a spend/usage reconciliation must span EVERY
   *  run, not the UI's 500 most-recent (same caveat as fleet.ts's accounting queries). */
  listRunsForExport(filter?: { status?: string; effort?: string; q?: string }): Run[] {
    return queryRuns(filter, null);
  },

  getNodes(runId: string): RunNode[] {
    const rows = db.prepare('SELECT * FROM run_nodes WHERE run_id = ? ORDER BY depth, started_at').all(runId) as any[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      parentId: row.parent_id,
      nodeType: row.node_type,
      label: row.label,
      status: row.status,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      depth: row.depth,
    }));
  },

  getEvents(runId: string, sinceSeq = -1, limit = 5000): NormalizedEvent[] {
    const rows = db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, sinceSeq, limit) as any[];
    return rows.map(rowToEvent);
  },

  /** Most-recent `limit` events (review #9): late subscribers to long runs keep continuity up to live. */
  getEventsTail(runId: string, limit = 5000): NormalizedEvent[] {
    const rows = db
      .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?')
      .all(runId, limit) as any[];
    return rows.reverse().map(rowToEvent);
  },

  /** Highest persisted event seq for a run, or -1 (review #4: seed resumed tree.seq past this). */
  maxEventSeq(runId: string): number {
    const row = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE run_id = ?').get(runId) as any;
    return row.m as number;
  },

  spendSince(sinceTs: number): number {
    const row = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM runs WHERE started_at >= ?').get(sinceTs) as any;
    return row.s as number;
  },

  countRunsSince(sinceTs: number): number {
    const row = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?').get(sinceTs) as any;
    return row.c as number;
  },

  /** PIDs of runs left non-terminal (their OS processes are now orphaned) — kill on boot. */
  nonTerminalPids(): number[] {
    const rows = db
      .prepare("SELECT pid FROM runs WHERE pid IS NOT NULL AND status NOT IN ('completed','failed','killed')")
      .all() as any[];
    return rows.map((r) => r.pid as number);
  },

  /** On boot, no live processes exist → any non-terminal run/campaign is orphaned. Mark them
   *  failed so the UI never shows a permanently-"starting" zombie (PRD §10 reliability). */
  reconcileOrphans(): number {
    const now = Date.now();
    const r = db
      .prepare("UPDATE runs SET status='failed', ended_at=? WHERE status NOT IN ('completed','failed','killed')")
      .run(now);
    db.prepare("UPDATE campaigns SET status='failed', ended_at=? WHERE status NOT IN ('completed','failed','killed')").run(now);
    db.prepare("UPDATE campaign_tasks SET status='failed' WHERE status NOT IN ('completed','failed','skipped')").run();
    return r.changes as number;
  },

  getConfig(): PortalConfig {
    const row = db.prepare('SELECT data FROM config WHERE id = 1').get() as any;
    if (!row) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.data) };
  },

  setConfig(cfg: PortalConfig) {
    db.prepare('INSERT INTO config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = ?')
      .run(JSON.stringify(cfg), JSON.stringify(cfg));
  },

  // ── agent templates (Orchestration Mode) ──────────────────────────────────
  listTemplates(): AgentTemplate[] {
    return (db.prepare('SELECT * FROM agent_templates ORDER BY is_builtin DESC, name').all() as any[]).map(rowToTemplate);
  },
  getTemplate(id: string): AgentTemplate | null {
    const row = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(id);
    return row ? rowToTemplate(row) : null;
  },
  getTemplateByName(name: string): AgentTemplate | null {
    const row = db.prepare('SELECT * FROM agent_templates WHERE name = ?').get(name);
    return row ? rowToTemplate(row) : null;
  },
  upsertTemplate(t: AgentTemplate) {
    db.prepare(`
      INSERT INTO agent_templates (id, name, role, description, system_prompt, model, fast_mode, effort,
        allowed_tools, skills, permission_mode, budget_usd, is_builtin, created_at)
      VALUES (@id,@name,@role,@description,@system_prompt,@model,@fast_mode,@effort,@allowed_tools,@skills,@permission_mode,@budget_usd,@is_builtin,@created_at)
      ON CONFLICT(id) DO UPDATE SET name=@name, role=@role, description=@description, system_prompt=@system_prompt,
        model=@model, fast_mode=@fast_mode, effort=@effort, allowed_tools=@allowed_tools, skills=@skills,
        permission_mode=@permission_mode, budget_usd=@budget_usd
    `).run({
      id: t.id, name: t.name, role: t.role, description: t.description, system_prompt: t.systemPrompt,
      model: t.model, fast_mode: t.fastMode ? 1 : 0, effort: t.effort,
      allowed_tools: JSON.stringify(t.allowedTools ?? []), skills: JSON.stringify(t.skills ?? []),
      permission_mode: t.permissionMode, budget_usd: t.budgetUsd, is_builtin: t.isBuiltin ? 1 : 0, created_at: t.createdAt,
    });
  },
  deleteTemplate(id: string) {
    db.prepare('DELETE FROM agent_templates WHERE id = ? AND is_builtin = 0').run(id);
  },

  // ── campaigns ──────────────────────────────────────────────────────────────
  upsertCampaign(c: Campaign) {
    db.prepare(`
      INSERT INTO campaigns (id, objective, cwd, status, orchestrator_template, worker_template, synthesizer_template,
        orchestrator_run_id, synthesizer_run_id, max_parallel, auto_synthesize, budget_per_worker_usd, model, started_at, ended_at, cost_usd,
        project_id, disallowed_tools, permission_mode)
      VALUES (@id,@objective,@cwd,@status,@orchestrator_template,@worker_template,@synthesizer_template,
        @orchestrator_run_id,@synthesizer_run_id,@max_parallel,@auto_synthesize,@budget_per_worker_usd,@model,@started_at,@ended_at,@cost_usd,
        @project_id,@disallowed_tools,@permission_mode)
      ON CONFLICT(id) DO UPDATE SET status=@status, orchestrator_run_id=@orchestrator_run_id,
        synthesizer_run_id=@synthesizer_run_id, ended_at=@ended_at, cost_usd=@cost_usd
    `).run({
      id: c.id, objective: c.objective, cwd: c.cwd, status: c.status,
      orchestrator_template: c.orchestratorTemplate, worker_template: c.workerTemplate, synthesizer_template: c.synthesizerTemplate,
      orchestrator_run_id: c.orchestratorRunId, synthesizer_run_id: c.synthesizerRunId, max_parallel: c.maxParallel,
      auto_synthesize: c.autoSynthesize ? 1 : 0, budget_per_worker_usd: c.budgetPerWorkerUsd, model: c.model,
      started_at: c.startedAt, ended_at: c.endedAt, cost_usd: c.costUsd,
      // v2 #4 — set at INSERT (campaign-per-card identity/launch knobs are immutable for a campaign's
      // life, so the ON CONFLICT update intentionally leaves them untouched).
      project_id: c.projectId ?? null,
      disallowed_tools: c.disallowedTools ? JSON.stringify(c.disallowedTools) : null,
      permission_mode: c.permissionMode ?? null,
    });
  },
  getCampaign(id: string): Campaign | null {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    return row ? rowToCampaign(row) : null;
  },
  listCampaigns(): Campaign[] {
    return (db.prepare('SELECT * FROM campaigns ORDER BY started_at DESC LIMIT 200').all() as any[]).map(rowToCampaign);
  },
  upsertTask(t: CampaignTask) {
    db.prepare(`
      INSERT INTO campaign_tasks (id, campaign_id, seq, title, prompt, template, depends_on, run_id, status, created_at)
      VALUES (@id,@campaign_id,@seq,@title,@prompt,@template,@depends_on,@run_id,@status,@created_at)
      ON CONFLICT(campaign_id, id) DO UPDATE SET status=@status, run_id=@run_id
    `).run({
      id: t.id, campaign_id: t.campaignId, seq: t.seq, title: t.title, prompt: t.prompt, template: t.template,
      depends_on: JSON.stringify(t.dependsOn ?? []), run_id: t.runId, status: t.status, created_at: t.createdAt,
    });
  },
  getTasks(campaignId: string): CampaignTask[] {
    return (db.prepare('SELECT * FROM campaign_tasks WHERE campaign_id = ? ORDER BY seq').all(campaignId) as any[]).map(rowToTask);
  },
};

function rowToTemplate(row: any): AgentTemplate {
  return {
    id: row.id, name: row.name, role: row.role, description: row.description, systemPrompt: row.system_prompt,
    model: row.model, fastMode: !!row.fast_mode, effort: row.effort,
    allowedTools: JSON.parse(row.allowed_tools || '[]'), skills: JSON.parse(row.skills || '[]'),
    permissionMode: row.permission_mode, budgetUsd: row.budget_usd, isBuiltin: !!row.is_builtin, createdAt: row.created_at,
  };
}
function rowToCampaign(row: any): Campaign {
  return {
    id: row.id, objective: row.objective, cwd: row.cwd, status: row.status as CampaignStatus,
    orchestratorTemplate: row.orchestrator_template, workerTemplate: row.worker_template, synthesizerTemplate: row.synthesizer_template,
    orchestratorRunId: row.orchestrator_run_id, synthesizerRunId: row.synthesizer_run_id, maxParallel: row.max_parallel,
    autoSynthesize: !!row.auto_synthesize, budgetPerWorkerUsd: row.budget_per_worker_usd, model: row.model,
    startedAt: row.started_at, endedAt: row.ended_at, costUsd: row.cost_usd,
    // ── v2 #4 columns ──
    projectId: row.project_id ?? null,
    disallowedTools: row.disallowed_tools ? safeStrArray(row.disallowed_tools) : null,
    permissionMode: (row.permission_mode ?? null) as Campaign['permissionMode'],
  };
}

/** Parse a JSON string[] column; null/garbage → null (preserve "unset" vs an empty list). */
function safeStrArray(s: unknown): string[] | null {
  try {
    const v = JSON.parse(String(s));
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}
function rowToTask(row: any): CampaignTask {
  return {
    id: row.id, campaignId: row.campaign_id, seq: row.seq, title: row.title, prompt: row.prompt, template: row.template,
    dependsOn: JSON.parse(row.depends_on || '[]'), runId: row.run_id, status: row.status, createdAt: row.created_at,
  };
}

export default db;
