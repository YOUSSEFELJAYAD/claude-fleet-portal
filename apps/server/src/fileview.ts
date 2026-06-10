/**
 * Read-only file + git viewer API (agent-PM / Kanban feature, SPEC §7).
 *
 * Strictly READ-ONLY: directory listing, single-file blob, working-tree status,
 * bounded unified diffs, commit log, commit drill-down. No write/edit surface —
 * `add`/`commit`/`checkout`/write are out of scope for v1 (SPEC §11.1).
 *
 * Trust model:
 *   - The project root is ALWAYS resolved server-side from the `projects` table
 *     (`projectsRepo.getProject(pid).rootDir`), NEVER from the client (SPEC §7).
 *   - Every client `path` goes through {@link safePath} (realpath-containment guard):
 *     traversal / symlink-escape / absolute / NUL → rejected (400).
 *   - `rev` / `branch` are positioned BEFORE the `--` separator (or embedded as
 *     `<rev>:<path>`), so a value like `--output=x` or `-n9` would be interpreted as
 *     a git FLAG, not data. Arg-arrays stop shell injection but NOT flag injection,
 *     so refs are validated by {@link isSafeRef} (reject leading '-', whitespace, NUL;
 *     allow a conservative ref charset). `hash` is validated inside `git.gitShow`.
 *
 * Failure policy (mirrors mcp.ts): a path/ref rejection is a 4xx, but a git command
 * FAILURE returns 200 with `error` in the body — the read helpers already carry an
 * optional `error` field, so the UI renders a message instead of breaking on non-2xx.
 *
 * This module owns NO tables and registers only GET routes; it sits behind the global
 * H3 Host-allowlist already installed in server.ts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { projectsRepo } from './projects.js';
import {
  safePath,
  lsTree,
  showFile,
  statusPorcelain,
  changedDiff,
  gitLog,
  gitShow,
  gitExec,
} from './git.js';

const execFileAsync = promisify(execFile);

// Caps for the locally-built proposed-merge diff (git.ts's capDiff/constants are not
// exported, so this route reimplements the same ~600-line / ~64KB bound — see manifest caveat).
const DIFF_LINE_CAP = 600;
const DIFF_BYTE_CAP = 64 * 1024;
const DIFF_MAX_BUFFER = 16 * 1024 * 1024; // 16MB (SPEC §7)
const IMAGE_MAX_BUFFER = 16 * 1024 * 1024;

/** Content-Type per image extension. SVG is served as image/svg+xml — NEVER text/html (SPEC §7). */
const IMAGE_CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const JSON_EXTS = new Set(['.json']);

/**
 * Validate a git revision / branch token used in a flag position (before `--`, or as
 * `<rev>:<path>`). Rejects empty, leading '-' (would become a flag), NUL/whitespace, and
 * anything outside a conservative ref charset. This is the flag-injection guard the
 * arg-array doesn't provide; `git.gitShow` already regex-validates its hash.
 */
function isSafeRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256) return false;
  if (ref.startsWith('-')) return false;
  if (/[\0\s]/.test(ref)) return false;
  // refs/branches/tags/short-hashes: letters, digits, and . _ / ~ ^ -  (no spaces, already excluded)
  return /^[A-Za-z0-9._/~^@-]+$/.test(ref);
}

/** The file-content type tag the client switches its renderer on (SPEC §7). */
type FileType = 'code' | 'markdown' | 'json' | 'image' | 'binary' | 'too-large';

/** Classify a text/binary blob descriptor into a renderer tag (image handled out-of-band). */
function classifyText(ext: string, binary: boolean, truncated: boolean): FileType {
  if (binary) return 'binary';
  if (truncated) return 'too-large';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (JSON_EXTS.has(ext)) return 'json';
  return 'code';
}

/** Cap a patch body at ~600 lines / ~64KB with a truncation marker (parity with git.ts capDiff). */
function capDiffLocal(raw: string): { diff: string; truncated: boolean } {
  let truncated = false;
  let body = raw;
  const lines = body.split('\n');
  if (lines.length > DIFF_LINE_CAP) {
    body = lines.slice(0, DIFF_LINE_CAP).join('\n');
    truncated = true;
  }
  if (Buffer.byteLength(body, 'utf8') > DIFF_BYTE_CAP) {
    body = body.slice(0, DIFF_BYTE_CAP);
    truncated = true;
  }
  if (truncated) body += '\n... [diff truncated]';
  return { diff: body, truncated };
}

export function registerFileviewRoutes(app: FastifyInstance) {
  /**
   * GET /api/projects/:pid/files?path=<rel?>&rev=<rev?>
   *   - empty/absent path → root tree.
   *   - directory path → { kind:'tree', entries } (non-recursive, lazy-expand).
   *   - blob path → text: { kind:'file', type, content, ... }; image: RAW BYTES with Content-Type.
   * Dispatch is by `git cat-file -t <rev>:<rel>` (we're reading a REV, not the working tree, so a
   * disk stat would be wrong).
   */
  app.get('/api/projects/:pid/files', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const root = project.rootDir;
    const q = (req.query as any) ?? {};
    const rel = typeof q.path === 'string' ? q.path : '';
    const rev = typeof q.rev === 'string' && q.rev ? q.rev : 'HEAD';
    if (!isSafeRef(rev)) {
      reply.code(400);
      return { error: 'invalid rev' };
    }

    // Empty rel = repo root tree (skip the path guard, which forbids '').
    if (rel === '' || rel === '.') {
      const t = await lsTree(root, rev, '');
      return { kind: 'tree', path: '', rev, entries: t.entries, ...(t.error ? { error: t.error } : {}) };
    }

    const abs = await safePath(root, rel);
    if (!abs) {
      reply.code(400);
      return { error: 'invalid path' };
    }
    const relpath = path.relative(root, abs); // git pathspec derived from the resolved abs, not raw client input

    // Object-type dispatch: tree vs blob at this rev.
    const typeRes = await gitExec(root, ['-C', root, 'cat-file', '-t', `${rev}:${relpath}`]);
    if (!typeRes.ok) {
      // not found / bad rev / git failure → 200 with error-in-body (SPEC §7 policy)
      return { kind: 'error', path: relpath, rev, error: gitErrText(typeRes) };
    }
    const objType = typeRes.stdout.trim();

    if (objType === 'tree' || objType === 'commit') {
      const t = await lsTree(root, rev, relpath);
      return { kind: 'tree', path: relpath, rev, entries: t.entries, ...(t.error ? { error: t.error } : {}) };
    }

    // blob
    const ext = path.extname(relpath).toLowerCase();
    const isImage = ext in IMAGE_CONTENT_TYPE;
    if (isImage) {
      // Serve RAW BYTES — gitExec hardcodes utf8 and would corrupt binary, so read with a Buffer.
      try {
        const { stdout } = await execFileAsync('git', ['-C', root, 'show', `${rev}:${relpath}`], {
          encoding: 'buffer',
          maxBuffer: IMAGE_MAX_BUFFER,
        });
        reply.header('Content-Type', IMAGE_CONTENT_TYPE[ext]);
        reply.header('Cache-Control', 'no-store');
        return reply.send(stdout);
      } catch (e: any) {
        // git failure (missing blob / too large) → JSON error-in-body
        const msg =
          e?.code === 'ENOENT'
            ? 'git binary not found'
            : e?.killed || e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'image too large to render'
              : (typeof e?.stderr === 'string' && e.stderr.trim()) || e?.message || 'failed to read image';
        return { kind: 'file', path: relpath, rev, type: 'binary' as FileType, isImage: true, error: msg };
      }
    }

    const f = await showFile(root, rev, relpath);
    if (f.error) {
      return { kind: 'file', path: relpath, rev, type: 'binary' as FileType, error: f.error };
    }
    const type = classifyText(f.ext, f.binary, !f.binary && f.truncated);
    if (f.binary) {
      return { kind: 'file', path: relpath, rev, type, size: f.size, isImage: f.isImage, ext: f.ext };
    }
    return {
      kind: 'file',
      path: relpath,
      rev,
      type,
      content: f.content,
      truncated: f.truncated,
      size: f.size,
      ext: f.ext,
    };
  });

  /**
   * GET /api/projects/:pid/git/status → changed working-tree files (porcelain v2).
   */
  app.get('/api/projects/:pid/git/status', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const r = await statusPorcelain(project.rootDir);
    return { entries: r.entries, ...(r.error ? { error: r.error } : {}) };
  });

  /**
   * GET /api/projects/:pid/git/diff?path=<rel>&branch=<branch?>
   *   - working-tree mode (no branch): bounded unified diff for ONE file (path required).
   *   - branch mode: the exact proposed-merge diff `git diff <defaultBranch>...<branch>` (SPEC §7);
   *     `path` optional (whole proposed merge when absent). `branch` from the client is ref-validated;
   *     the base is the project's defaultBranch (server-side, never the client).
   */
  app.get('/api/projects/:pid/git/diff', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const root = project.rootDir;
    const q = (req.query as any) ?? {};
    const rawPath = typeof q.path === 'string' ? q.path : '';
    const branch = typeof q.branch === 'string' && q.branch ? q.branch : '';

    // Resolve an optional path through the guard.
    let relpath: string | null = null;
    if (rawPath) {
      const abs = await safePath(root, rawPath);
      if (!abs) {
        reply.code(400);
        return { error: 'invalid path' };
      }
      relpath = path.relative(root, abs);
    }

    if (branch) {
      // Proposed-merge diff: <base>...<branch> (three dots — diff vs. the merge base, SPEC §7).
      if (!isSafeRef(branch)) {
        reply.code(400);
        return { error: 'invalid branch' };
      }
      // Callers pass either the git branch or a card's WORKTREE name (`task-<id>` — the only
      // identifier the board carries; the branch git creates for it is `worktree-task-<id>`,
      // pm.ts branchNameFor). Resolve here so the naming convention stays server-side; fall
      // back to the merge-time backup ref so the diff still renders after branch cleanup.
      let ref = branch;
      for (const c of [branch, `worktree-${branch}`, `refs/fleet-backup/${branch}`, `refs/fleet-backup/worktree-${branch}`]) {
        const ok = await gitExec(root, ['-C', root, 'rev-parse', '--verify', '-q', `${c}^{commit}`]);
        if (ok.ok) {
          ref = c;
          break;
        }
      }
      const base = project.defaultBranch;
      const args = ['-C', root, 'diff', `${base}...${ref}`];
      if (relpath) args.push('--', relpath);
      const r = await gitExec(root, args, { maxBuffer: DIFF_MAX_BUFFER });
      if (!r.ok) return { diff: '', truncated: false, binary: false, error: gitErrText(r) };
      const raw = r.stdout;
      if (relpath && /^Binary files .* differ$/m.test(raw)) return { diff: '', truncated: false, binary: true };
      const capped = capDiffLocal(raw);
      return { diff: capped.diff, truncated: capped.truncated, binary: false };
    }

    // Working-tree mode: path is required.
    if (!relpath) {
      reply.code(400);
      return { error: 'path is required for a working-tree diff' };
    }
    const d = await changedDiff(root, relpath);
    return { diff: d.diff, truncated: d.truncated, binary: d.binary, ...(d.error ? { error: d.error } : {}) };
  });

  /**
   * GET /api/projects/:pid/git/log?branch=<?> → commit list (project-wide or branch-scoped).
   */
  app.get('/api/projects/:pid/git/log', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const q = (req.query as any) ?? {};
    const branch = typeof q.branch === 'string' && q.branch ? q.branch : undefined;
    if (branch !== undefined && !isSafeRef(branch)) {
      reply.code(400);
      return { error: 'invalid branch' };
    }
    const r = await gitLog(project.rootDir, branch ? { branch } : {});
    return { entries: r.entries, ...(r.error ? { error: r.error } : {}) };
  });

  /**
   * GET /api/projects/:pid/git/show?hash=<h> → full commit detail (patch + metadata).
   * Hash is regex-validated inside git.gitShow.
   */
  app.get('/api/projects/:pid/git/show', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const q = (req.query as any) ?? {};
    const hash = typeof q.hash === 'string' ? q.hash : '';
    const r = await gitShow(project.rootDir, hash);
    return { text: r.text, truncated: r.truncated, ...(r.error ? { error: r.error } : {}) };
  });
}

/** Stable error string from a failed gitExec result (stderr-first, mirrors git.ts/mcp.ts). */
function gitErrText(r: { code: number; stderr: string; stdout: string }): string {
  if (r.code === 127) return 'git binary not found';
  if (r.code === 124) return 'git command timed out';
  return r.stderr.trim() || r.stdout.trim() || `git failed (exit ${r.code})`;
}
