/**
 * Shared git layer for the agent-PM / Kanban feature (SPEC §6 + §7).
 *
 * Two responsibilities, one home so the read (fileview.ts) and write (pm.ts)
 * sides share exactly one execFile-git wrapper, one path-safety guard, and one
 * set of NUL-parsers:
 *   - READ helpers (ls-tree / show / status / diff / log / show) — strictly
 *     read-only, byte/line-capped, behind the realpath-containment guard.
 *   - WRITE / merge automation (SPEC §6) — ensure-committed → conflict probe →
 *     integrate+revalidate → `merge --no-ff` with ORIG_HEAD rollback → cleanup.
 *     The CALLER holds a per-project async mutex; nothing here serializes.
 *
 * Every git invocation goes through {@link gitExec}, which (like mcp.ts) NEVER
 * throws — it salvages stdout/stderr/exit-code into a plain result object so a
 * failing git command surfaces as data, not an unhandled rejection.
 *
 * No DB dependency: `root` (a project's validated git working dir) and the
 * worktree dir are always threaded in by the caller, never read from a table here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** Dedicated PM commit identity for clear git attribution (SPEC §2, locked decision). */
export const FLEET_PM_AUTHOR = { name: 'fleet-pm', email: 'fleet-pm@local' } as const;

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024; // 16MB (SPEC §7)

const FILE_BYTE_CAP = 512 * 1024; // ~512KB show cap (SPEC §7)
const BINARY_SNIFF_BYTES = 8 * 1024; // first 8KB NUL-sniff
const DIFF_LINE_CAP = 600; // ~600 lines per-file diff cap (SPEC §7)
const DIFF_BYTE_CAP = 64 * 1024; // ~64KB per-file diff cap (SPEC §7)

/** Image extensions rendered inline by the viewer. SVG is image-by-ext but the route serves it
 * as image/svg+xml (never inline HTML) — that Content-Type decision lives in fileview.ts. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// ── core exec wrapper ─────────────────────────────────────────────────────────

export interface GitExecOpts {
  timeout?: number;
  maxBuffer?: number;
}

export interface GitExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Normalized exit code: real exit code on a clean run/nonzero exit; 127 for ENOENT (git
   * missing); 124 for timeout/maxBuffer kill; -1 for any other spawn error. */
  code: number;
}

/**
 * Run `git` with an argument ARRAY (never a shell string — no interpolation/injection) and
 * return a salvaged result. Mirrors mcp.ts: on a nonzero exit / timeout / missing binary the
 * promise rejects, and we recover whatever stdout/stderr git managed to emit (many git
 * commands print useful output on a nonzero exit). NEVER throws.
 */
export async function gitExec(cwd: string, args: string[], opts: GitExecOpts = {}): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      encoding: 'utf8',
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (e: any) {
    const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
    let code: number;
    if (typeof e?.code === 'number') {
      code = e.code; // real nonzero git exit code
    } else if (e?.code === 'ENOENT') {
      code = 127; // git binary not found
    } else if (e?.killed || e?.code === 'ETIMEDOUT' || e?.signal) {
      code = 124; // timeout / maxBuffer overflow kill
    } else {
      code = -1; // any other spawn failure
    }
    return { ok: false, stdout, stderr: stderr || (e?.message ?? ''), code };
  }
}

// ── path safety (SPEC §7 realpath-containment guard) ──────────────────────────

/**
 * Realpath-containment guard. The legacy substring `isSafeCwd` check is defeated by absolute
 * `rel` and by in-repo symlinks; this resolves and re-verifies after realpath.
 *
 * Steps (SPEC §7):
 *   1. reject NUL-byte or absolute `rel` outright.
 *   2. `abs = resolve(root, rel)`; require `abs === root` OR `abs` under `root + sep`
 *      (lexical containment, blocks `..` escape).
 *   3. realpath `root` and the nearest EXISTING ancestor of `abs` (abs itself may legitimately
 *      not exist on disk — e.g. a path that only exists in an old rev or was deleted from the
 *      working tree) and re-verify containment (blocks symlink escape).
 *
 * Returns the resolved absolute path (`abs`, NOT the realpath) on success so callers derive the
 * git pathspec as `relative(root, abs)`; returns `null` if unsafe. `root` MUST come from the
 * projects table, never the client.
 */
export async function safePath(root: string, rel: string): Promise<string | null> {
  if (typeof rel !== 'string' || typeof root !== 'string' || !root) return null;
  if (rel.includes('\0') || root.includes('\0')) return null;
  if (path.isAbsolute(rel)) return null;

  const sep = path.sep;
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return null;

  let realRoot: string;
  try {
    realRoot = await fs.realpath(absRoot);
  } catch {
    return null; // root must exist + be resolvable
  }

  // Realpath the deepest existing ancestor of `abs` (abs may not exist on disk).
  let probe = abs;
  let realProbe: string | null = null;
  // Bound the walk by the path depth (no infinite loop at filesystem root).
  while (true) {
    try {
      realProbe = await fs.realpath(probe);
      break;
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
        const parent = path.dirname(probe);
        if (parent === probe) {
          realProbe = null; // walked off the top without finding an existing ancestor
          break;
        }
        probe = parent;
        continue;
      }
      return null; // EACCES / ELOOP / etc. → unsafe
    }
  }
  if (realProbe === null) return null;

  // The realpath of the nearest existing ancestor must be the root or inside it.
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) return null;
  return abs;
}

// ── startup guardrail: gitignore the worktrees dir (SPEC §6 / §10) ────────────

/**
 * Ensure `.claude/worktrees/` is gitignored in `root` so the merge engine's pathspec-scoped
 * `add -A` (run inside a sibling worktree) can never stage another worktree's internals. Idempotent:
 * appends only if no equivalent rule is already present. Never throws (best-effort guardrail).
 */
export async function ensureWorktreeIgnored(root: string): Promise<void> {
  const wanted = '.claude/worktrees/';
  const gi = path.join(root, '.gitignore');
  try {
    let content = '';
    let exists = true;
    try {
      content = await fs.readFile(gi, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') exists = false;
      else return; // unreadable for another reason → leave it alone
    }
    const present = content
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
      .some((l) => l === '.claude/worktrees' || l === '.claude/worktrees/**');
    if (present) return;
    const prefix = !exists || content === '' || content.endsWith('\n') ? '' : '\n';
    await fs.appendFile(gi, `${prefix}${wanted}\n`, 'utf8');
    // Commit JUST .gitignore (pathspec-scoped, as fleet-pm) so this precheck doesn't leave the
    // main worktree dirty — a dirty main worktree makes mergeBranch refuse (found by the live E2E).
    // gpgsign off + --no-verify (as initRepo) so a signing setup / failing hook can't break it; if
    // the commit still fails, roll the edit back so the main worktree is left clean.
    const add = await gitExec(root, ['add', '--', '.gitignore']);
    const commit = !add.ok
      ? add
      : await gitExec(root, [
          '-c', `user.name=${FLEET_PM_AUTHOR.name}`,
          '-c', `user.email=${FLEET_PM_AUTHOR.email}`,
          '-c', 'commit.gpgsign=false',
          'commit', '--no-verify', '-m', 'chore: ignore agent worktrees (.claude/worktrees)', '--', '.gitignore',
        ]);
    if (!commit.ok) {
      if (exists) await fs.writeFile(gi, content, 'utf8');
      else await fs.unlink(gi);
      await gitExec(root, ['reset', '--', '.gitignore']);
    }
  } catch {
    /* best-effort; a missing ignore is caught again by pathspec-scoped staging */
  }
}

// ── git init on attach (SPEC v2 §4 item #10) ──────────────────────────────────

export interface InitRepoResult {
  ok: boolean;
  error?: string;
}

/**
 * Initialize `dir` as a git work tree so a non-git directory can be attached as a project
 * (v2 item #10): `git init -b <branch>`, seed a minimal `.gitignore` (just the agent-worktrees
 * rule, so the merge engine's pathspec-scoped staging can never reach a sibling worktree), and
 * make ONE initial commit so the repo has a base for worktrees/merges (a repo with no commits
 * has no HEAD to branch worktrees from).
 *
 * Commit identity is FLEET_PM_AUTHOR via `-c user.name/email` (NOT ambient) — mirrors
 * ensureWorktreeIgnored / ensureCommitted, and is required because a brand-new environment may
 * have no configured git identity (the test harness skips commits for exactly this reason). We do
 * NOT delegate to ensureWorktreeIgnored: that helper is best-effort and swallows commit failures,
 * but item #10 requires an init failure to surface (→ 500) and the initial commit to be guaranteed.
 *
 * Idempotent / safe: if `dir` is ALREADY a work tree this is a no-op (no re-init, no clobbering an
 * existing .gitignore, no extra commit). Returns `{ ok, error? }` like mergeBranch; the caller maps
 * `!ok` to a 500.
 */
export async function initRepo(dir: string, branch: string): Promise<InitRepoResult> {
  // Belt-and-braces idempotency: never touch a dir that is already a work tree.
  const probe = await gitExec(dir, ['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  if (probe.ok && probe.stdout.trim() === 'true') return { ok: true };

  const init = await gitExec(dir, ['-C', dir, 'init', '-b', branch]);
  if (!init.ok) return { ok: false, error: gitErr(init) };

  // Seed a minimal .gitignore (only the worktrees rule). Don't clobber an existing file.
  const gi = path.join(dir, '.gitignore');
  try {
    let exists = true;
    try {
      await fs.access(gi);
    } catch {
      exists = false;
    }
    if (!exists) await fs.writeFile(gi, '.claude/worktrees/\n', 'utf8');
  } catch (e: any) {
    return { ok: false, error: `init: could not write .gitignore: ${e?.message ?? e}` };
  }

  // Stage ALL existing contents (not just .gitignore) so attaching a NON-empty dir produces an
  // initial commit containing the user's files. Staging only .gitignore would leave source files
  // untracked → a PM worktree would branch from an effectively empty tree AND the untracked files
  // would keep the main worktree perpetually dirty, so mergeBranch would refuse every merge.
  // The .gitignore (written above) is already in place, so `add -A` correctly excludes .claude/worktrees/.
  const add = await gitExec(dir, ['-C', dir, 'add', '-A']);
  if (!add.ok) return { ok: false, error: gitErr(add) };

  const commit = await gitExec(dir, [
    '-C',
    dir,
    '-c',
    `user.name=${FLEET_PM_AUTHOR.name}`,
    '-c',
    `user.email=${FLEET_PM_AUTHOR.email}`,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    'chore: initialize repository (fleet attach)',
  ]);
  if (!commit.ok) return { ok: false, error: gitErr(commit) };

  return { ok: true };
}

// ── read helpers (READ-ONLY) ──────────────────────────────────────────────────

export interface LsTreeEntry {
  mode: string;
  /** 'blob' | 'tree' | 'commit' (submodule). */
  type: string;
  oid: string;
  /** Blob byte size, or null for trees / when `-l` reports `-`. */
  size: number | null;
  /** Path relative to the repo root (as git emits it). */
  path: string;
  /** Basename of `path` (convenience for the tree UI). */
  name: string;
}

/**
 * Non-recursive tree listing for lazy-expand. `dir` is a repo-relative directory ('' = root).
 * Uses `-l` (long form → blob size for the cap) and `-z` (NUL-terminated records). Each record is
 * `<mode> SP <type> SP <oid> SP* <size> TAB <path>\0`.
 */
export async function lsTree(root: string, rev: string, dir: string): Promise<{ entries: LsTreeEntry[]; error?: string }> {
  // Unborn HEAD (attached repo with zero commits): an empty tree, not a raw git fatal
  // that would wedge the Files panel until someone makes a first commit out-of-band.
  if (rev === 'HEAD') {
    const head = await gitExec(root, ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD']);
    if (!head.ok) return { entries: [] };
  }
  const spec = dir && dir !== '.' ? dir.replace(/\/+$/, '') + '/' : '';
  const args = ['-C', root, 'ls-tree', '-l', '-z', rev];
  args.push('--');
  if (spec) args.push(spec);
  const r = await gitExec(root, args);
  if (!r.ok) return { entries: [], error: gitErr(r) };
  const entries: LsTreeEntry[] = [];
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab);
    const p = rec.slice(tab + 1);
    // meta: `<mode> <type> <oid>   <size>` (size right-justified with spaces, '-' for trees)
    const m = meta.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
    if (!m) continue;
    const sizeRaw = m[4];
    entries.push({
      mode: m[1],
      type: m[2],
      oid: m[3],
      size: sizeRaw === '-' ? null : Number(sizeRaw),
      path: p,
      name: p.replace(/\/+$/, '').split('/').pop() ?? p,
    });
  }
  // dirs first, then files; both alphabetical (stable tree UI ordering)
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : b.type === 'tree' ? 1 : 0;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

/**
 * Git toplevel for an arbitrary directory (the `@`-mention workspace resolver, SPEC §6.1).
 * Returns the absolute repo root, or null when `dir` is not inside a git work tree. Never throws.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await gitExec(dir, ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!r.ok) return null;
  const top = r.stdout.trim();
  return top ? top : null;
}

/**
 * Tracked files of a repo, repo-root-relative, '/'-separated (the fast `@`-mention path source).
 * Uses `ls-files -z` so paths with spaces/newlines survive. Never throws; [] on failure.
 */
export async function lsFiles(root: string): Promise<string[]> {
  const r = await gitExec(root, ['-C', root, 'ls-files', '-z']);
  if (!r.ok) return [];
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

export type ShowFileResult =
  | { binary: true; content?: undefined; truncated?: undefined; size: number | null; isImage: boolean; ext: string; error?: string }
  | { binary: false; content: string; truncated: boolean; size: number; isImage: false; ext: string; error?: string };

/**
 * Read a single file's blob at `rev` (`git show <rev>:<relpath>`). Caps at ~512KB; sniffs the
 * first 8KB for a NUL byte to flag binary; flags image extensions for inline rendering by the route.
 *
 * NOTE (v1 tradeoff, per advisor): gitExec returns a utf8 STRING, so the NUL-sniff + byte cap are
 * computed on the decoded string's UTF-8 byte length, not a raw Buffer. This is acceptable because
 * binary content is discarded (we only return a descriptor), and the cap is a safety bound, not a
 * byte-exact contract. A future buffered read can tighten this if exact bytes are ever needed.
 */
export async function showFile(root: string, rev: string, relpath: string): Promise<ShowFileResult> {
  const ext = path.extname(relpath).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const r = await gitExec(root, ['-C', root, 'show', `${rev}:${relpath}`]);
  if (!r.ok) {
    return { binary: false, content: '', truncated: false, size: 0, isImage: false, ext, error: gitErr(r) };
  }
  const content = r.stdout;
  const byteLen = Buffer.byteLength(content, 'utf8');
  // binary sniff on the first 8KB of the decoded string
  const head = content.slice(0, BINARY_SNIFF_BYTES);
  const hasNul = head.includes('\0');
  if (hasNul || isImage) {
    return { binary: true, size: byteLen, isImage, ext };
  }
  if (byteLen > FILE_BYTE_CAP) {
    // truncate to roughly the cap (string-slice; byte-exact not required for v1)
    return { binary: false, content: content.slice(0, FILE_BYTE_CAP), truncated: true, size: byteLen, isImage: false, ext };
  }
  return { binary: false, content, truncated: false, size: byteLen, isImage: false, ext };
}

export interface StatusEntry {
  /** Two-char XY code (porcelain v2 mapped to a v1-style short code: e.g. 'M ', ' M', '??', 'R '). */
  code: string;
  path: string;
  /** Original path for renames/copies, else null. */
  origPath: string | null;
}

/**
 * Working-tree status via `status --porcelain=v2 -z`. The v2 -z stream is a TOKEN stream, not one
 * entry per NUL field: ordinary ('1') and untracked ('?') / ignored ('!') records are a single
 * token, but rename/copy ('2') records carry the ORIGINAL path as a SECOND NUL-separated token for
 * the SAME entry — so we consume that extra token rather than splitting blindly.
 */
export async function statusPorcelain(root: string): Promise<{ entries: StatusEntry[]; error?: string }> {
  const r = await gitExec(root, ['-C', root, 'status', '--porcelain=v2', '-z']);
  if (!r.ok) return { entries: [], error: gitErr(r) };
  const toks = r.stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const kind = t[0];
    if (kind === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const sp = nthSpace(t, 8);
      entries.push({ code: t.slice(2, 4), path: t.slice(sp + 1), origPath: null });
    } else if (kind === '2') {
      // 2 <XY> ... <Xscore> <path>\0<origPath>
      const sp = nthSpace(t, 9);
      const newPath = t.slice(sp + 1);
      const origPath = toks[i + 1] ?? null;
      i++; // consume the orig-path token that belongs to THIS entry
      entries.push({ code: t.slice(2, 4), path: newPath, origPath });
    } else if (kind === '?' || kind === '!') {
      // ? <path>   /   ! <path>
      entries.push({ code: kind === '?' ? '??' : '!!', path: t.slice(2), origPath: null });
    }
    // 'u' (unmerged) records are not expected on a clean read-only working tree; skipped.
  }
  return { entries };
}

export interface ChangedDiff {
  diff: string;
  truncated: boolean;
  binary: boolean;
  error?: string;
}

/**
 * Unified diff vs HEAD for a single file (covers both staged and unstaged changes), with an
 * all-additions fallback for untracked files, capped at ~600 lines / ~64KB with a truncation
 * marker. Short-circuits to `{ binary:true }` when git reports "Binary files ... differ".
 */
export async function changedDiff(root: string, relpath: string): Promise<ChangedDiff> {
  // `diff HEAD` sees staged + unstaged changes in one pass; fall back to a plain working-tree
  // diff when HEAD is unborn (fresh repo with no commits yet).
  let r = await gitExec(root, ['-C', root, 'diff', 'HEAD', '--', relpath]);
  if (!r.ok) r = await gitExec(root, ['-C', root, 'diff', '--', relpath]);
  if (!r.ok) return { diff: '', truncated: false, binary: false, error: gitErr(r) };
  let raw = r.stdout;
  if (!raw.trim()) {
    // Neither HEAD nor the index knows the file — untracked entries ('??') need an
    // all-additions diff synthesized via --no-index, which exits 1 when the files differ.
    const tracked = await gitExec(root, ['-C', root, 'ls-files', '--error-unmatch', '--', relpath]);
    if (!tracked.ok) {
      // Status collapses an untracked DIRECTORY to one '?? dir/' entry; --no-index can't
      // diff a directory (fs.stat follows symlinks, matching --no-index's behavior).
      try {
        const st = await fs.stat(path.join(root, relpath));
        if (st.isDirectory()) {
          return { diff: '', truncated: false, binary: false, error: 'untracked directory — open individual files inside it to see their diffs' };
        }
      } catch {
        /* path gone — fall through to --no-index, whose error is surfaced below */
      }
      const nx = await gitExec(root, ['-C', root, 'diff', '--no-index', '--', '/dev/null', relpath]);
      if (nx.stdout) raw = nx.stdout;
      else if (!nx.ok) return { diff: '', truncated: false, binary: false, error: gitErr(nx) };
    }
  }
  if (/^Binary files .* differ$/m.test(raw)) {
    return { diff: '', truncated: false, binary: true };
  }
  return capDiff(raw);
}

export interface GitLogEntry {
  hash: string;
  author: string;
  /** Author time in epoch SECONDS (as git `%at` emits). */
  time: number;
  subject: string;
  isMerge: boolean;
}

/**
 * Commit log, project-wide or scoped to a branch. Fields are NUL-delimited inside a record and
 * records are newline-delimited: `--format=%H%x00%an%x00%at%x00%P%x00%s`. (Per advisor: NOT `-z`,
 * whose interaction with a custom --format is git-version-dependent; %s never contains a newline and
 * no field contains NUL, so line-then-NUL parsing is unambiguous.) `isMerge` = parent count > 1.
 */
export async function gitLog(root: string, opts: { branch?: string; max?: number } = {}): Promise<{ entries: GitLogEntry[]; error?: string }> {
  const max = Number.isInteger(opts.max) && (opts.max as number) > 0 ? Math.min(opts.max as number, 2000) : 200;
  // Unborn HEAD (zero commits): an empty log, not a raw git fatal in the History panel.
  if (!opts.branch) {
    const head = await gitExec(root, ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD']);
    if (!head.ok) return { entries: [] };
  }
  // Trailing `--` disambiguates the revision from a same-named file in the work tree
  // ("fatal: ambiguous argument ...: both revision and filename" otherwise).
  const args = ['-C', root, 'log', `--max-count=${max}`, '--format=%H%x00%an%x00%at%x00%P%x00%s'];
  if (opts.branch) args.push(opts.branch);
  args.push('--');
  const r = await gitExec(root, args);
  if (!r.ok) return { entries: [], error: gitErr(r) };
  const entries: GitLogEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const f = line.split('\0');
    if (f.length < 5) continue;
    const parents = f[3].trim() ? f[3].trim().split(/\s+/) : [];
    entries.push({
      hash: f[0],
      author: f[1],
      time: Number(f[2]) || 0,
      subject: f[4],
      isMerge: parents.length > 1,
    });
  }
  return { entries };
}

export interface GitShowResult {
  text: string;
  truncated: boolean;
  error?: string;
}

/**
 * Full `git show <hash>` (patch + metadata) for a commit drill-down. Hash is validated by regex
 * (`/^[0-9a-f]{7,40}$/`) so an arbitrary client string can never become a git revision/flag. Output
 * is capped like a diff.
 */
export async function gitShow(root: string, hash: string): Promise<GitShowResult> {
  if (typeof hash !== 'string' || !/^[0-9a-f]{7,40}$/.test(hash)) {
    return { text: '', truncated: false, error: 'invalid commit hash' };
  }
  const r = await gitExec(root, ['-C', root, 'show', hash, '--']);
  if (!r.ok) return { text: '', truncated: false, error: gitErr(r) };
  const capped = capDiff(r.stdout);
  return { text: capped.diff, truncated: capped.truncated };
}

// ── merge automation (WRITE side, SPEC §6) ────────────────────────────────────
// The CALLER holds a per-project async mutex across the gate→merge window. These functions
// throw an "engine error" (a plain Error) only for unexpected git states the caller cannot
// recover from; expected outcomes (dirty/clean/conflict) are returned as data.

export interface EnsureCommittedResult {
  sha: string;
}

/**
 * Commit any uncommitted work in a worktree as `fleet-pm`, so the conflict probe / merge see real
 * commits (an uncommitted worktree → empty diff → silent no-op merge; SPEC §6.1, guardrail §10).
 *
 * - Dirty check: `status --porcelain` (v1; empty == clean).
 * - Staging is PATHSPEC-SCOPED to the worktree dir (`add -A -- <wt>`) so it can never reach a
 *   sibling worktree's internals (belt-and-braces with the gitignore precheck).
 * - Identity via `-c user.name=… -c user.email=…` (the -c flags precede the subcommand).
 *
 * Returns the resulting HEAD sha of the worktree branch (whether it committed or was already clean).
 */
export async function ensureCommitted(worktreeDir: string): Promise<EnsureCommittedResult> {
  const st = await gitExec(worktreeDir, ['-C', worktreeDir, 'status', '--porcelain']);
  if (!st.ok) throw engineErr('ensureCommitted: status failed', st);
  if (st.stdout.trim() !== '') {
    const add = await gitExec(worktreeDir, ['-C', worktreeDir, 'add', '-A', '--', worktreeDir]);
    if (!add.ok) throw engineErr('ensureCommitted: add failed', add);
    const commit = await gitExec(worktreeDir, [
      '-C',
      worktreeDir,
      '-c',
      `user.name=${FLEET_PM_AUTHOR.name}`,
      '-c',
      `user.email=${FLEET_PM_AUTHOR.email}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'fleet-pm: commit work for validation',
    ]);
    if (!commit.ok) throw engineErr('ensureCommitted: commit failed', commit);
  }
  const head = await gitExec(worktreeDir, ['-C', worktreeDir, 'rev-parse', 'HEAD']);
  if (!head.ok) throw engineErr('ensureCommitted: rev-parse failed', head);
  return { sha: head.stdout.trim() };
}

export interface ConflictProbeResult {
  clean: boolean;
  conflicts: string[];
}

/**
 * Zero-side-effect pre-merge conflict probe via `merge-tree --write-tree -z --name-only` (SPEC §6.2).
 *
 * Per advisor: the SPEC's `--quiet` would emit exit-status ONLY (no file list), so we DROP it and
 * use `-z --name-only` instead. Output shape (verified against git 2.52):
 *   - exit 0  → clean; output is just the merged tree OID (single NUL field).
 *   - exit 1  → conflict; output is `<tree-oid>\0<path1>\0…\0\0<info messages>` — the conflicted
 *               paths are the NUL fields after the tree OID up to the FIRST EMPTY field (the blank
 *               field separates the file list from the human-readable conflict messages).
 *   - other   → engine error (never merge on an ambiguous probe).
 */
export async function conflictProbe(root: string, baseBranch: string, branch: string): Promise<ConflictProbeResult> {
  const r = await gitExec(root, ['-C', root, 'merge-tree', '--write-tree', '-z', '--name-only', baseBranch, branch]);
  if (r.code === 0) return { clean: true, conflicts: [] };
  if (r.code === 1) {
    const fields = r.stdout.split('\0');
    // fields[0] = merged tree OID; collect paths until the first EMPTY field (start of info section)
    const conflicts: string[] = [];
    for (let i = 1; i < fields.length; i++) {
      if (fields[i] === '') break;
      conflicts.push(fields[i]);
    }
    return { clean: false, conflicts };
  }
  throw engineErr(`conflictProbe: merge-tree exited ${r.code}`, r);
}

export interface IntegrateResult {
  conflict: boolean;
}

/**
 * If the base branch has advanced past the branch's merge base, merge baseBranch INTO the branch
 * (inside the worktree) so the caller can RE-VALIDATE the tree it will actually ship — catching
 * semantic conflicts a clean textual merge-tree misses (SPEC §6.4). Commits the integration merge as
 * `fleet-pm`. On a textual conflict: `merge --abort` (leave the worktree clean) and report
 * `conflict:true`; the caller parks the card in Review. No-op (returns `{conflict:false}`) when the
 * branch already contains base.
 */
export async function integrateAndReport(worktreeDir: string, baseBranch: string): Promise<IntegrateResult> {
  // Does the worktree branch already contain baseBranch's tip? (--is-ancestor: exit 0 = yes)
  const anc = await gitExec(worktreeDir, ['-C', worktreeDir, 'merge-base', '--is-ancestor', baseBranch, 'HEAD']);
  if (anc.code === 0) return { conflict: false }; // base already integrated → nothing to do
  if (anc.code !== 1) throw engineErr('integrate: ancestor check failed', anc);

  const merge = await gitExec(worktreeDir, [
    '-C',
    worktreeDir,
    '-c',
    `user.name=${FLEET_PM_AUTHOR.name}`,
    '-c',
    `user.email=${FLEET_PM_AUTHOR.email}`,
    '-c',
    'commit.gpgsign=false',
    'merge',
    '--no-verify',
    '--no-edit',
    baseBranch,
  ]);
  if (merge.ok) return { conflict: false };
  // Conflict (or other failure) → restore the worktree to a clean state, report conflict.
  await gitExec(worktreeDir, ['-C', worktreeDir, 'merge', '--abort']);
  return { conflict: true };
}

// ── conflict resolution (v2 #9) ────────────────────────────────────────────────

export interface StartResolveMergeResult {
  /** true when the integration merge produced conflict markers the resolve agent must reconcile. */
  conflict: boolean;
  /** the conflicted file paths (empty when conflict:false). */
  conflicts: string[];
}

/**
 * v2 #9 — START the integration merge of `baseBranch` INTO the task branch and, unlike
 * {@link integrateAndReport}, LEAVE the conflict markers + MERGE_HEAD in place so a resolve agent
 * can edit the files. Does NOT abort, does NOT commit. The caller (pm.ts) launches the resolve
 * agent into this half-merged worktree, then on the agent's terminal commits / re-validates / merges
 * — or aborts (see {@link mergeAbort}). Identity stays `fleet-pm` so a clean-after-resolve commit is
 * attributed correctly.
 *
 * Returns `{conflict:false, conflicts:[]}` when the merge applied cleanly (the base was already
 * integrated, or it merged with no textual conflict — in that rare case the merge auto-commits and
 * the caller can re-validate directly). Returns `{conflict:true, conflicts:[…]}` with the unmerged
 * paths when markers were left for the agent.
 */
export async function startResolveMerge(worktreeDir: string, baseBranch: string): Promise<StartResolveMergeResult> {
  // already integrated? (--is-ancestor exit 0 = base tip is reachable from HEAD) → nothing to do.
  const anc = await gitExec(worktreeDir, ['-C', worktreeDir, 'merge-base', '--is-ancestor', baseBranch, 'HEAD']);
  if (anc.code === 0) return { conflict: false, conflicts: [] };
  if (anc.code !== 1) throw engineErr('startResolveMerge: ancestor check failed', anc);

  const merge = await gitExec(worktreeDir, [
    '-C',
    worktreeDir,
    '-c',
    `user.name=${FLEET_PM_AUTHOR.name}`,
    '-c',
    `user.email=${FLEET_PM_AUTHOR.email}`,
    '-c',
    'commit.gpgsign=false',
    'merge',
    '--no-verify',
    '--no-edit',
    baseBranch,
  ]);
  if (merge.ok) return { conflict: false, conflicts: [] }; // merged cleanly (auto-committed)
  // Conflict → DO NOT abort; leave the markers + MERGE_HEAD for the resolve agent. Report the
  // unmerged paths. (A non-conflict failure also lands here, but the conflicted-file probe below
  // returns [] for it, and the caller's later MERGE_HEAD check + re-validate catches a bad state.)
  const conflicts = await conflictedFiles(worktreeDir);
  return { conflict: true, conflicts };
}

/**
 * v2 #9 — list the worktree's currently-unmerged (conflicted) paths via
 * `diff --name-only --diff-filter=U`. Empty when no merge is in progress / nothing conflicts.
 * Never throws (salvages []).
 */
export async function conflictedFiles(worktreeDir: string): Promise<string[]> {
  const r = await gitExec(worktreeDir, ['-C', worktreeDir, 'diff', '--name-only', '--diff-filter=U', '-z']);
  if (!r.ok) return [];
  return r.stdout.split('\0').filter((p) => p !== '');
}

/**
 * v2 #9 — true when an in-progress merge exists in the worktree (MERGE_HEAD is set). Used by
 * reconcile to detect a crash-mid-resolve worktree (and to assert a resolve attempt actually left
 * markers). Reads `rev-parse --verify -q MERGE_HEAD` (exit 0 = present). Never throws.
 */
export async function isMergeInProgress(worktreeDir: string): Promise<boolean> {
  const r = await gitExec(worktreeDir, ['-C', worktreeDir, 'rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  return r.code === 0 && r.stdout.trim() !== '';
}

/**
 * v2 #9 — true when leftover conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) remain in the
 * WORKING TREE. Uses `git diff HEAD --check`, which reports leftover conflict markers and exits
 * non-zero when any are present (exit 0 = clean). This is the authoritative "did the resolve agent
 * finish?" check: unlike the index unmerged-paths probe ({@link conflictedFiles}), it reflects the
 * agent's on-disk edits whether or not the agent ran `git add` (diffing against HEAD covers both
 * staged and unstaged markers). Never throws.
 */
export async function hasConflictMarkers(worktreeDir: string): Promise<boolean> {
  const r = await gitExec(worktreeDir, ['-C', worktreeDir, 'diff', 'HEAD', '--check']);
  // diff HEAD --check: exit 0 = no markers/whitespace issues; non-zero (typically 2) = issues reported
  // on stdout. We only care about the conflict-marker lines git emits ("leftover conflict marker").
  if (r.code === 0) return false;
  return /leftover conflict marker/.test(r.stdout) || /leftover conflict marker/.test(r.stderr);
}

/**
 * v2 #9 — abort an in-progress merge in the worktree (`merge --abort`), restoring it to the
 * pre-merge state (no half-merged tree, no conflict markers, MERGE_HEAD cleared). Best-effort +
 * idempotent — a `merge --abort` with no merge in progress is a harmless no-op here. Never throws.
 */
export async function mergeAbort(worktreeDir: string): Promise<void> {
  await gitExec(worktreeDir, ['-C', worktreeDir, 'merge', '--abort']);
}

export interface MergeResult {
  ok: boolean;
  sha?: string;
  error?: string;
}

/**
 * Final `merge --no-ff <branch>` into the main worktree's current branch (SPEC §6.5). Safety:
 *   1. assert the MAIN worktree is clean (`status --porcelain` empty) — merge --abort/reset require it.
 *   2. capture the pre-merge HEAD ourselves (ORIG_HEAD via rev-parse, not git's volatile ORIG_HEAD).
 *   3. save a backup ref `refs/fleet-backup/<branch>` pointing at the branch tip.
 *   4. `merge --no-ff` as `fleet-pm`; on ANY failure `reset --hard <captured pre-merge HEAD>` so
 *      main is byte-for-byte restored, and return the error.
 * Returns the new merge commit sha on success.
 */
export async function mergeBranch(root: string, branch: string, expectedBase?: string): Promise<MergeResult> {
  // `git merge` lands on whatever is checked out in the root — the human's own working
  // copy. If they switched branches (or detached HEAD), refuse rather than silently merge
  // the task branch into the wrong place.
  if (expectedBase) {
    const cur = await gitExec(root, ['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']);
    const curBranch = cur.ok ? cur.stdout.trim() : '';
    if (!curBranch || curBranch !== expectedBase) {
      return {
        ok: false,
        error: `root has '${curBranch || 'detached HEAD'}' checked out, expected '${expectedBase}'; refusing to merge`,
      };
    }
  }
  const st = await gitExec(root, ['-C', root, 'status', '--porcelain']);
  if (!st.ok) return { ok: false, error: gitErr(st) };
  if (st.stdout.trim() !== '') return { ok: false, error: 'main worktree is not clean; refusing to merge' };

  const pre = await gitExec(root, ['-C', root, 'rev-parse', 'HEAD']);
  if (!pre.ok) return { ok: false, error: gitErr(pre) };
  const origHead = pre.stdout.trim();

  // Backup ref for manual recovery (refs/fleet-backup/<branch>) — point at the branch we merge.
  await gitExec(root, ['-C', root, 'update-ref', `refs/fleet-backup/${branch}`, branch]);

  const merge = await gitExec(root, [
    '-C',
    root,
    '-c',
    `user.name=${FLEET_PM_AUTHOR.name}`,
    '-c',
    `user.email=${FLEET_PM_AUTHOR.email}`,
    '-c',
    'commit.gpgsign=false',
    'merge',
    '--no-verify',
    '--no-ff',
    '--no-edit',
    branch,
  ]);
  if (!merge.ok) {
    // roll main back to exactly the pre-merge state (clears any in-progress merge state too)
    await gitExec(root, ['-C', root, 'merge', '--abort']);
    await gitExec(root, ['-C', root, 'reset', '--hard', origHead]);
    return { ok: false, error: gitErr(merge) };
  }

  const post = await gitExec(root, ['-C', root, 'rev-parse', 'HEAD']);
  if (!post.ok) {
    await gitExec(root, ['-C', root, 'reset', '--hard', origHead]);
    return { ok: false, error: 'merge: could not read post-merge HEAD' };
  }
  const mergeSha = post.stdout.trim();
  // Guard against a phantom no-op (HEAD unchanged means nothing was merged).
  if (mergeSha === origHead) {
    return { ok: false, error: 'merge produced no new commit (nothing to merge?)' };
  }
  return { ok: true, sha: mergeSha };
}

/**
 * v2 #4 — create the isolated worktree for a card up front: `git worktree add
 * .claude/worktrees/<name> -b <branch>`. A SINGLE-mode build relies on `claude --worktree` to
 * create this on launch, but a campaign-per-card spawns its orchestrator/workers via the campaign
 * engine (which uses `cwd`, NOT `--worktree`), so the PM must create the worktree itself and point
 * the campaign's cwd at it. Idempotent: if the worktree dir already registers as a worktree, this is
 * a no-op success. Returns `{ ok, dir, error? }`; the caller maps `!ok` to a parked card.
 */
export interface CreateWorktreeResult {
  ok: boolean;
  dir: string;
  error?: string;
}
export async function createWorktree(root: string, worktreeName: string, branch: string): Promise<CreateWorktreeResult> {
  const wtPath = path.join(root, '.claude', 'worktrees', worktreeName);
  // already a registered worktree? (re-launch / retry) → reuse it. `worktree list --porcelain`
  // prints REALPATH'd locations, so compare against the realpath of wtPath too (root may contain
  // a symlink component, e.g. /tmp → /private/tmp).
  const list = await gitExec(root, ['-C', root, 'worktree', 'list', '--porcelain']);
  if (list.ok) {
    let realWtPath = wtPath;
    try {
      realWtPath = await fs.realpath(wtPath);
    } catch {
      /* not on disk yet → no match possible via realpath */
    }
    if (list.stdout.split(/\r?\n/).some((l) => l === `worktree ${wtPath}` || l === `worktree ${realWtPath}`)) {
      return { ok: true, dir: wtPath };
    }
  }
  const add = await gitExec(root, ['-C', root, 'worktree', 'add', wtPath, '-b', branch]);
  if (!add.ok) {
    // branch may already exist from a prior partial run → retry without -b (check out the branch).
    const retry = await gitExec(root, ['-C', root, 'worktree', 'add', wtPath, branch]);
    if (!retry.ok) return { ok: false, dir: wtPath, error: (retry.stderr || add.stderr || 'worktree add failed').trim() };
  }
  return { ok: true, dir: wtPath };
}

/**
 * Tear down a finished task's worktree + branch (SPEC §6.6): `worktree remove --force` (tolerate an
 * unclean tree), `branch -d` (then `-D` fallback if it was never merged, e.g. a cancel/cleanup path),
 * `worktree prune`. Best-effort and idempotent — never throws.
 */
export async function cleanupWorktree(root: string, worktreeName: string, branch: string): Promise<void> {
  const wtPath = path.join(root, '.claude', 'worktrees', worktreeName);
  await gitExec(root, ['-C', root, 'worktree', 'remove', '--force', wtPath]);
  const del = await gitExec(root, ['-C', root, 'branch', '-d', branch]);
  if (!del.ok) await gitExec(root, ['-C', root, 'branch', '-D', branch]);
  await gitExec(root, ['-C', root, 'worktree', 'prune']);
}

// ── internal helpers ──────────────────────────────────────────────────────────

/** Cap a diff/patch body at ~600 lines / ~64KB and append a truncation marker when cut. */
function capDiff(raw: string): ChangedDiff {
  let truncated = false;
  let body = raw;
  const lines = body.split('\n');
  if (lines.length > DIFF_LINE_CAP) {
    body = lines.slice(0, DIFF_LINE_CAP).join('\n');
    truncated = true;
  }
  if (Buffer.byteLength(body, 'utf8') > DIFF_BYTE_CAP) {
    // byte-cap via string slice (approximate; safety bound, not byte-exact)
    body = body.slice(0, DIFF_BYTE_CAP);
    truncated = true;
  }
  if (truncated) body += '\n... [diff truncated]';
  return { diff: body, truncated, binary: false };
}

/** Index of the n-th (1-based) space character in a string, or -1. Used to find the path field. */
function nthSpace(s: string, n: number): number {
  let idx = -1;
  for (let k = 0; k < n; k++) {
    idx = s.indexOf(' ', idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}

/**
 * Strip embedded credentials from a string before it reaches `lastError`, the DB, or an SSE
 * broadcast (v2 §3.5 / risk #1). Redacts the userinfo of any `scheme://user:pass@host` URL — the
 * two leakage shapes are GitHub's `https://x-access-token:<TOKEN>@github.com/...` and a generic
 * `https://user:pass@host/...`. The host + path are preserved so the message stays useful. Applied
 * at every site that surfaces git/gh stderr (#2 wires the call sites; the helper lands here now).
 */
export function scrubCredentials(s: string): string {
  if (!s) return s;
  // Match the userinfo portion (user[:pass]@) following a URL scheme, and replace it with a redaction.
  // [^\s/@:]+ for the user, optional :[^\s/@]* for the password — bounded so it never crosses a
  // whitespace/path boundary and can't run past the '@'.
  return s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/g, '$1***@');
}

/** Compose a stable error string from a failed gitExec result (stderr-first, like mcp.ts). */
function gitErr(r: GitExecResult): string {
  if (r.code === 127) return 'git binary not found';
  if (r.code === 124) return 'git command timed out';
  return r.stderr.trim() || r.stdout.trim() || `git failed (exit ${r.code})`;
}

/** Build an engine Error from an unexpected git result (caller treats as non-recoverable). */
function engineErr(msg: string, r: GitExecResult): Error {
  return new Error(`${msg}: ${gitErr(r)}`);
}
