'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Project, CreateProjectRequest, MergeMode } from '@fleet/shared';
import { Panel, Kicker, Field, Input, Select, Toggle, Btn, Empty } from '@/components/ui';

const API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

/** raw fetch helper that surfaces the server's {error} message (mirrors lib/api.ts j<T>). */
async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!r.ok) {
    let msg = r.statusText;
    let code: string | undefined;
    try {
      const body = await r.json();
      msg = body.error ?? msg;
      code = body.code; // e.g. 'not_a_git_repo' so callers can offer git-init (v2 #10)
    } catch {
      /* ignore */
    }
    const e = new Error(msg) as Error & { code?: string; status?: number };
    e.code = code;
    e.status = r.status;
    throw e;
  }
  // DELETE may return empty body
  if (r.status === 204) return undefined as unknown as T;
  return r.json() as Promise<T>;
}

/** the partial-settings PUT shape this page sends (server + lib/api.ts must match). */
interface UpdateProjectRequest {
  autoMerge?: boolean;
  wipLimit?: number;
  defaultValidationCommand?: string | null;
  budgetCeilingUsd?: number | null;
  paused?: boolean;
  // ── v2 #2: full remote git ──
  mergeMode?: MergeMode;
  remoteName?: string;
  pushEnabled?: boolean;
}

/** git/remote readiness response (GET /api/projects/:id/git/health, v2 #2). */
interface GitHealth {
  remoteUrl: string | null;
  remoteResolves: boolean;
  ghInstalled: boolean;
  ghAuthOk: boolean;
  pushEnabled: boolean;
}

const projectsApi = {
  list: () => j<Project[]>('/api/projects'),
  create: (b: CreateProjectRequest) => j<Project>('/api/projects', { method: 'POST', body: JSON.stringify(b) }),
  update: (id: string, b: UpdateProjectRequest) =>
    j<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  remove: (id: string) => j<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  gitHealth: (id: string) => j<GitHealth>(`/api/projects/${id}/git/health`),
};

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) {
      setErr('name required');
      return;
    }
    if (!rootDir.trim()) {
      setErr('root dir required');
      return;
    }
    setBusy(true);
    setErr(null);
    const payload: CreateProjectRequest = {
      name: name.trim(),
      rootDir: rootDir.trim(),
      defaultBranch: defaultBranch.trim() || 'main',
    };
    try {
      try {
        await projectsApi.create(payload);
      } catch (e: any) {
        // The dir exists but isn't a git repo — offer to initialize it and re-submit (v2 #10).
        if (
          e?.code === 'not_a_git_repo' &&
          confirm(`"${payload.rootDir}" is not a git repository.\n\nInitialize it as a git repo (git init on branch "${payload.defaultBranch}") and attach it?`)
        ) {
          await projectsApi.create({ ...payload, initGit: true });
        } else {
          throw e;
        }
      }
      setName('');
      setRootDir('');
      setDefaultBranch('main');
      onCreated();
    } catch (e: any) {
      setErr(e.message || 'failed to create project');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel ticked className="p-5 mb-6">
      <Kicker>attach a git repo</Kicker>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_140px] gap-4 mt-3">
        <Field label="name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Web" />
        </Field>
        <Field label="root dir" hint="absolute path · must be a git repo">
          <Input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="/Users/you/code/acme" />
        </Field>
        <Field label="default branch">
          <Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="main" />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Btn variant="solid" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : '＋ Create Project'}
        </Btn>
        {err && (
          <span className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>
            {err}
          </span>
        )}
      </div>
    </Panel>
  );
}

function ProjectRow({ p, onChanged, onDeleted }: { p: Project; onChanged: (p: Project) => void; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  // local settings draft
  const [autoMerge, setAutoMerge] = useState(p.autoMerge);
  const [wipLimit, setWipLimit] = useState(String(p.wipLimit));
  const [validationCmd, setValidationCmd] = useState(p.defaultValidationCommand ?? '');
  const [budget, setBudget] = useState(p.budgetCeilingUsd != null ? String(p.budgetCeilingUsd) : '');
  // ── v2 #2: remote-git settings draft ──
  const [mergeMode, setMergeMode] = useState<MergeMode>(p.mergeMode);
  const [remoteName, setRemoteName] = useState(p.remoteName);
  const [pushEnabled, setPushEnabled] = useState(p.pushEnabled);
  const [health, setHealth] = useState<GitHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function checkHealth() {
    setHealthBusy(true);
    try {
      setHealth(await projectsApi.gitHealth(p.id));
    } catch {
      setHealth(null);
    } finally {
      setHealthBusy(false);
    }
  }

  async function patch(body: Parameters<typeof projectsApi.update>[1], opt?: { silent?: boolean }) {
    setBusy(true);
    setErr(null);
    try {
      const next = await projectsApi.update(p.id, body);
      onChanged(next);
      if (!opt?.silent) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
      return next;
    } catch (e: any) {
      setErr(e.message || 'failed to update');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    await patch({
      autoMerge,
      wipLimit: Number(wipLimit) || 1,
      defaultValidationCommand: validationCmd.trim() || null,
      budgetCeilingUsd: budget.trim() ? Number(budget) : null,
      mergeMode,
      remoteName: remoteName.trim() || 'origin',
      pushEnabled,
    });
  }

  async function togglePause() {
    try {
      await patch({ paused: !p.paused }, { silent: true });
    } catch {
      /* error surfaced via err */
    }
  }

  async function del() {
    if (!confirm(`Delete project "${p.name}"? Its kanban board and task history will be removed. This cannot be undone.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await projectsApi.remove(p.id);
      onDeleted();
    } catch (e: any) {
      setErr(e.message || 'failed to delete');
      setBusy(false);
    }
  }

  return (
    <Panel className="p-4" style={{ borderLeft: `2px solid ${p.paused ? '#ff7a45' : '#54e08a'}` }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Link href={`/projects/${p.id}`} className="font-display text-[14px] tracking-wide text-ink hover:text-amber">
              {p.name}
            </Link>
            {p.paused && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: '#ff7a45', borderColor: '#ff7a4550' }}>
                paused
              </span>
            )}
            {p.autoMerge && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: '#ff5d5d', borderColor: '#ff5d5d50' }}>
                full-auto
              </span>
            )}
          </div>
          <div className="font-mono text-[11px] text-faint mt-1 truncate">{p.rootDir}</div>
          <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px]">
            <span className="text-dim border border-line px-1.5 py-0.5">branch {p.defaultBranch}</span>
            <span className="text-dim border border-line px-1.5 py-0.5">wip {p.wipLimit}</span>
            <span className="text-dim border border-line px-1.5 py-0.5">
              ceiling {p.budgetCeilingUsd != null ? `$${p.budgetCeilingUsd}` : '∞'}
            </span>
            {p.defaultValidationCommand && (
              <span className="text-dim border border-line px-1.5 py-0.5 truncate max-w-[260px]">✓ {p.defaultValidationCommand}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/projects/${p.id}/board`}
            className="font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5 inline-flex items-center"
          >
            Board →
          </Link>
          <Btn variant={p.paused ? 'amber' : 'ghost'} onClick={togglePause} disabled={busy}>
            {p.paused ? '▶ Resume' : '⏸ Pause'}
          </Btn>
          <Btn variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : '⚙ Settings'}
          </Btn>
        </div>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t hairline">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Kicker>auto-merge</Kicker>
              <div className="mt-2">
                <Toggle on={autoMerge} onChange={setAutoMerge} label={autoMerge ? 'full-auto' : 'human approve'} />
              </div>
              {autoMerge && (
                <div
                  className="mt-2 font-mono text-[10px] leading-snug border px-2 py-1.5"
                  style={{ color: '#ff5d5d', borderColor: '#ff5d5d40', background: 'rgba(255,93,93,0.06)' }}
                >
                  ⚠ trusted full-auto: the PM merges into <span className="text-ink">{p.defaultBranch}</span> with no human
                  review. Checks still run, but no one approves the diff. Default off.
                </div>
              )}
            </div>
            <Field label="wip limit" hint="max concurrent builds">
              <Input type="number" min="1" step="1" value={wipLimit} onChange={(e) => setWipLimit(e.target.value)} />
            </Field>
            <Field label="budget ceiling USD" hint="blank = unbounded">
              <Input type="number" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="∞" />
            </Field>
            <div className="md:col-span-3">
              <Field label="default validation command" hint="run in each worktree · exit 0 = pass">
                <Input
                  value={validationCmd}
                  onChange={(e) => setValidationCmd(e.target.value)}
                  placeholder="npm test"
                />
              </Field>
            </div>
          </div>

          {/* ── v2 #2: remote git (push / GitHub PR) ── */}
          <div className="mt-5 pt-4 border-t hairline">
            <Kicker>remote git</Kicker>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
              <Field label="merge mode" hint="local merge --no-ff · or push + open a GitHub PR">
                <Select value={mergeMode} onChange={(e) => setMergeMode(e.target.value as MergeMode)}>
                  <option value="local">local (merge into {p.defaultBranch})</option>
                  <option value="pr">pr (push + open PR)</option>
                </Select>
              </Field>
              <Field label="remote name" hint="git remote to push / open the PR against">
                <Input value={remoteName} onChange={(e) => setRemoteName(e.target.value)} placeholder="origin" />
              </Field>
              <div>
                <Kicker>push enabled</Kicker>
                <div className="mt-2">
                  <Toggle on={pushEnabled} onChange={setPushEnabled} label={pushEnabled ? 'PM may push' : 'no push'} />
                </div>
              </div>
            </div>
            {mergeMode === 'pr' && !pushEnabled && (
              <div
                className="mt-2 font-mono text-[10px] leading-snug border px-2 py-1.5"
                style={{ color: '#ff7a45', borderColor: '#ff7a4540', background: 'rgba(255,122,69,0.06)' }}
              >
                ⚠ PR mode requires push to be enabled — turn on “push enabled” before saving.
              </div>
            )}
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <Btn variant="ghost" onClick={checkHealth} disabled={healthBusy}>
                {healthBusy ? 'Checking…' : '⟳ Check git readiness'}
              </Btn>
              {health && (
                <span className="font-mono text-[10px]" style={{ color: health.remoteResolves && health.ghInstalled && health.ghAuthOk ? '#54e08a' : '#ff7a45' }}>
                  remote {health.remoteResolves ? `✓ ${health.remoteUrl ?? 'resolves'}` : '✕ unresolved'} ·{' '}
                  gh {health.ghInstalled ? '✓ installed' : '✕ missing'} ·{' '}
                  auth {health.ghAuthOk ? '✓ ok' : '✕ not authenticated'} ·{' '}
                  push {health.pushEnabled ? 'on' : 'off'}
                </span>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Btn variant="solid" onClick={saveSettings} disabled={busy}>
              Save Settings
            </Btn>
            <Btn variant="danger" onClick={del} disabled={busy}>
              ✕ Delete Project
            </Btn>
            {saved && (
              <span className="font-mono text-[11px]" style={{ color: '#54e08a' }}>
                saved
              </span>
            )}
            {err && (
              <span className="font-mono text-[11px]" style={{ color: '#ff5d5d' }}>
                {err}
              </span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(null);
    projectsApi
      .list()
      .then(setProjects)
      .catch((e) => setError(e.message || 'failed to load projects'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  return (
    <div>
      <div className="mb-5">
        <Kicker>workspaces</Kicker>
        <h1 className="font-display text-[26px] tracking-wide text-ink mt-1">Projects</h1>
        <p className="font-mono text-[11px] text-faint mt-1">
          A project scopes a git repo to a Kanban board executed by the autonomous PM — build → validate → local
          merge.
        </p>
      </div>

      <CreateForm onCreated={reload} />

      {error ? (
        <div className="font-mono text-[12px] border px-3 py-2" style={{ color: '#ff5d5d', borderColor: '#ff5d5d30', background: 'rgba(255,93,93,0.05)' }}>
          {error} ·{' '}
          <button onClick={reload} className="underline">
            retry
          </button>
        </div>
      ) : loading ? (
        <div className="font-mono text-faint text-[12px]">loading projects…</div>
      ) : projects.length === 0 ? (
        <Empty>No projects yet. Attach a git repo above to get started.</Empty>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              p={p}
              onChanged={(next) => setProjects((prev) => prev.map((x) => (x.id === next.id ? next : x)))}
              onDeleted={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}
