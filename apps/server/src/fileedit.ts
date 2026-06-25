/**
 * In-browser file CRUD + commit surface (v2 SPEC §4 #1 + §10.2 locked decision).
 *
 * The READ side (fileview.ts) is strictly read-only by contract; this module owns the WRITE
 * surface as a SEPARATE registration so that contract stays intact. It exposes exactly two routes:
 *
 *   GET  /api/projects/:pid/files/edit?path=   → the current WORKING-TREE bytes of a single file
 *        (fs.readFile of the safePath-resolved abs — NOT a git blob at a rev, because the editor
 *        edits what is on disk), text-only, byte-capped. Returns {content,oid,editable,binary,tooLarge}.
 *   POST /api/projects/:pid/files/commit       → an ATOMIC create / update / delete + pathspec-scoped
 *        commit, run entirely under the PM's per-project lock so a PM merge never sees a half-written
 *        file (SPEC risk #4).
 *
 * Trust model (mirrors fileview.ts):
 *   - The project root is ALWAYS resolved server-side from the projects table, NEVER from the client.
 *   - Every client `path` goes through {@link safePath} (realpath-containment guard): traversal /
 *     symlink-escape / absolute / NUL → 400.
 *   - `safePath` PASSES for paths under `root/.claude/worktrees/` (active task worktrees live there),
 *     so BOTH routes additionally reject any path under `.claude/worktrees/**` with 409 — closing the
 *     edit-surface worktree hole (SPEC §4 keystone (c) / risk #4). The reject also covers #4's campaign
 *     worktrees (same dir).
 *
 * Atomicity + coexistence with the PM:
 *   - The whole write→add→commit (or rm→commit) critical section runs inside the PM's per-project lock.
 *     `pm.withProjectLock` is the intended public alias (added by the serial wiring phase); until then
 *     the live implementation is the private `withMergeLock`. We route through whichever exists (cast
 *     fallback) so we chain on the SAME `mergeLocks` map the PM merges use — a module-local mutex would
 *     serialize edits against each other but NOT against merges, which is the bug we must avoid.
 *   - The commit is PATHSPEC-SCOPED (`git add -- <rel>` / `git rm -- <rel>` then `git commit -- <rel>`),
 *     never `add -A`, so the main working tree is never left dirty by an unrelated change.
 *
 * Author identity (SPEC §4 keystone (e)): the commit is made as the AMBIENT human git identity — we
 * OMIT the `-c user.name/email` flags fleet-pm uses — UNLESS the project carries a
 * commitAuthorName + commitAuthorEmail override (then both are passed via `-c`).
 *
 * Failure policy: path/validation rejections are 4xx; a git command FAILURE returns 200 with `error`
 * in the body so the UI renders a message instead of breaking on a non-2xx (mirrors fileview.ts).
 *
 * This module owns NO tables and edits NO shared file: it imports gitExec/safePath/scrubCredentials
 * (read-only) from git.js, projectsRepo from projects.js, and the pm singleton from pm.js.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { projectsRepo } from './projects.js';
import { gitExec, safePath, scrubCredentials, gitErrText } from './git.js';
import { pm } from './pm.js';

// ── caps (parity with fileview.ts / git.ts read side) ─────────────────────────
const FILE_BYTE_CAP = 512 * 1024; // ~512KB editable cap (SPEC §7); larger files are read-only
const BINARY_SNIFF_BYTES = 8 * 1024; // first 8KB NUL-sniff (matches git.ts showFile)

/** Relative segment under the project root that holds active task worktrees (SPEC §6/§10). */
const WORKTREES_PREFIX = path.join('.claude', 'worktrees');

/**
 * Run `fn` while holding the project's PM lock, chaining on the SAME `mergeLocks` map the PM uses for
 * merges-to-main, so a PM merge never sees a half-written file (SPEC risk #4). The public
 * `pm.withProjectLock` alias is added by the serial wiring phase; until then the live implementation
 * is the private `withMergeLock`. We route through whichever exists via a cast so this module:
 *   (1) stays green TODAY (a bare `pm.withProjectLock(...)` would be `undefined` → "not a function"),
 *   (2) survives the later cross-file typecheck (a bare member reference to a not-yet-declared method
 *       fails TS; the `as any` cast does not), and
 *   (3) auto-upgrades to the public alias once wiring lands it — without a fileedit.ts change.
 */
function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const p = pm as any;
  const lock = p.withProjectLock ?? p.withMergeLock;
  return lock.call(pm, projectId, fn) as Promise<T>;
}

/**
 * True iff `abs` is the worktrees dir itself or anything under it. `abs` is the safePath-resolved
 * absolute path; the relative form (`relative(root, abs)`) starts with `.claude/worktrees` for any
 * such path (and never with `..`, since safePath already guaranteed containment).
 */
function isUnderWorktrees(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === WORKTREES_PREFIX || rel.startsWith(WORKTREES_PREFIX + path.sep);
}

/**
 * Compute the git blob OID of a WORKING-TREE file (`git hash-object -- <abs>`) — the SAME oid git
 * would record on `add` of these exact bytes, so it matches a committed blob's oid byte-for-byte
 * (verified). Returns null when the file does not exist on disk (a brand-new path) or git fails.
 * Using the working-tree hash on BOTH the GET (baseline) and the commit precheck (current) keeps the
 * stale-oid comparison consistent — comparing a HEAD-blob oid against a working-tree hash would 409
 * on every edit.
 */
async function workingTreeOid(root: string, rel: string): Promise<string | null> {
  // `--` separates the (validated) flagless pathspec; -- <rel> is safe even for an odd filename.
  const r = await gitExec(root, ['-C', root, 'hash-object', '--', rel]);
  if (!r.ok) return null;
  const oid = r.stdout.trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

export function registerFileeditRoutes(app: FastifyInstance) {
  /**
   * GET /api/projects/:pid/files/edit?path=<rel>
   *
   * Read the current WORKING-TREE bytes of ONE file from disk (NOT a git rev — the editor edits the
   * file as it currently is). Text-only + byte-capped; flags binary / too-large so the UI can render a
   * read-only notice. `oid` is the working-tree blob hash for the optimistic-concurrency baseline; it
   * is null for a missing file (the editor treats a 404-equivalent as a NEW path).
   *
   * `editable` = editing toggled ON for the project AND the blob is text AND within the cap.
   */
  app.get('/api/projects/:pid/files/edit', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const root = project.rootDir;
    const q = (req.query as any) ?? {};
    const rel = typeof q.path === 'string' ? q.path : '';
    if (!rel) {
      reply.code(400);
      return { error: 'path is required' };
    }

    const abs = await safePath(root, rel);
    if (!abs) {
      reply.code(400);
      return { error: 'invalid path' };
    }
    if (isUnderWorktrees(root, abs)) {
      reply.code(409);
      return { error: 'editing files under .claude/worktrees is not allowed' };
    }
    const relpath = path.relative(root, abs); // pathspec derived from the resolved abs, not raw input

    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'EISDIR' || e?.code === 'ENOTDIR') {
        // Missing (or a directory) → treat as a not-yet-created path: empty, editable, oid null.
        return {
          path: relpath,
          content: '',
          oid: null,
          editable: project.editingEnabled,
          binary: false,
          tooLarge: false,
          exists: false,
        };
      }
      reply.code(400);
      return { error: 'invalid path' };
    }

    const size = buf.length;
    const head = buf.subarray(0, BINARY_SNIFF_BYTES);
    const binary = head.includes(0);
    const tooLarge = size > FILE_BYTE_CAP;
    const oid = await workingTreeOid(root, relpath);

    // Text + within cap → return content; binary/too-large → descriptor only (no bytes), not editable.
    const editable = project.editingEnabled && !binary && !tooLarge;
    if (binary || tooLarge) {
      return { path: relpath, content: null, oid, editable, binary, tooLarge, size, exists: true };
    }
    return {
      path: relpath,
      content: buf.toString('utf8'),
      oid,
      editable,
      binary: false,
      tooLarge: false,
      size,
      exists: true,
    };
  });

  /**
   * POST /api/projects/:pid/files/commit
   * Body: { path, content?, delete?, message, baseOid? }
   *
   * ATOMIC create / update / delete + pathspec-scoped commit, run under the PM's per-project lock.
   * Order of guards (cheap → expensive, side-effect-free → side-effecting):
   *   1. project exists (404).
   *   2. editingEnabled (403) — the per-project gate, default OFF.
   *   3. body shape: non-empty `message`; `content` required (string) for a write (404-equivalent input
   *      check is a 400). (400)
   *   4. safePath (400).
   *   5. `.claude/worktrees/**` reject (409).
   *   6. stale-oid (409): compare the CURRENT working-tree oid against `baseOid`. An absent/null
   *      baseOid is allowed ONLY for a brand-new path (no file on disk). A delete REQUIRES the path to
   *      exist (delete-of-missing → 409).
   *   7. apply under the lock: delete → `git rm -- <rel>`; write → mkdir -p + writeFile + `git add -- <rel>`.
   *   8. `git commit -- <rel>` as the ambient identity (or the configured author via -c).
   * git failures inside 7/8 → 200 with `error` in the body (no half state left: the commit is
   * pathspec-scoped and the lock prevents a concurrent merge).
   */
  app.post('/api/projects/:pid/files/commit', async (req, reply) => {
    const pid = (req.params as any).pid as string;
    const project = projectsRepo.getProject(pid);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (!project.editingEnabled) {
      reply.code(403);
      return { error: 'editing is not enabled for this project' };
    }

    const body = (req.body as any) ?? {};
    const rel = typeof body.path === 'string' ? body.path : '';
    const isDelete = body.delete === true;
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const baseOid =
      typeof body.baseOid === 'string' && body.baseOid ? body.baseOid : null;

    if (!rel) {
      reply.code(400);
      return { error: 'path is required' };
    }
    if (!message) {
      reply.code(400);
      return { error: 'message is required' };
    }
    let content: string | null = null;
    if (!isDelete) {
      if (typeof body.content !== 'string') {
        reply.code(400);
        return { error: 'content (string) is required unless delete:true' };
      }
      content = body.content;
    }

    const root = project.rootDir;
    const abs = await safePath(root, rel);
    if (!abs) {
      reply.code(400);
      return { error: 'invalid path' };
    }
    if (isUnderWorktrees(root, abs)) {
      reply.code(409);
      return { error: 'editing files under .claude/worktrees is not allowed' };
    }
    const relpath = path.relative(root, abs); // pathspec from the resolved abs

    // The whole stale-check → apply → commit critical section serializes on the project's PM lock so a
    // PM merge can never observe a half-written tree (SPEC risk #4). We re-read the current oid INSIDE
    // the lock so a racing edit/merge between request arrival and lock acquisition is caught.
    return withProjectLock(pid, async () => {
      // Does the file currently exist on disk? (a directory is NOT a committable file)
      let exists = false;
      try {
        const st = await fs.stat(abs);
        exists = st.isFile();
      } catch {
        exists = false;
      }

      // ── stale-oid / existence gate ────────────────────────────────────────────
      if (isDelete) {
        if (!exists) {
          reply.code(409);
          return { error: 'cannot delete: path does not exist' };
        }
      }
      const currentOid = exists ? await workingTreeOid(root, relpath) : null;
      if (baseOid !== null) {
        // The caller claims to have edited a specific version; it must still be current.
        if (currentOid !== baseOid) {
          reply.code(409);
          return { error: 'stale edit: the file changed since it was read', currentOid };
        }
      } else {
        // No baseOid → only allowed for a brand-new write path. A write over an EXISTING file with no
        // baseOid is an unguarded overwrite → reject (advisory lost-update guard, SPEC keystone (f)).
        if (!isDelete && exists) {
          reply.code(409);
          return { error: 'stale edit: baseOid is required to overwrite an existing file', currentOid };
        }
      }

      // ── apply (stage) ───────────────────────────────────────────────────────────
      if (isDelete) {
        // The user explicitly confirmed deletion and the stale-oid gate above already ran,
        // so an UNTRACKED file is just unlinked (git rm exits 128 for it, and there is
        // nothing staged to commit) …
        const tracked = await gitExec(root, ['-C', root, 'ls-files', '--error-unmatch', '--', relpath]);
        if (!tracked.ok) {
          try {
            await fs.unlink(abs);
          } catch (e: any) {
            return { ok: false, error: `failed to delete file: ${scrubCredentials(String(e?.message ?? e))}` };
          }
          const head = await gitExec(root, ['-C', root, 'rev-parse', 'HEAD']);
          return { ok: true, sha: head.ok ? head.stdout.trim() : '', author: resolveAuthor(project) ?? 'ambient' };
        }
        // … and a tracked file is removed with -f: plain `git rm` refuses any file whose
        // working tree differs from the index (exactly the files agents/humans just edited).
        const rm = await gitExec(root, ['-C', root, 'rm', '-f', '--', relpath]);
        if (!rm.ok) return { ok: false, error: gitErrText(rm, { scrub: true }) };
      } else {
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content as string, 'utf8');
        } catch (e: any) {
          return { ok: false, error: `failed to write file: ${scrubCredentials(String(e?.message ?? e))}` };
        }
        const add = await gitExec(root, ['-C', root, 'add', '--', relpath]);
        if (!add.ok) return { ok: false, error: gitErrText(add, { scrub: true }) };
      }

      // ── commit (pathspec-scoped, ambient OR configured author) ───────────────────
      const author = resolveAuthor(project);
      const args = ['-C', root];
      if (author) {
        args.push('-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`);
      }
      // Never sign in this surface (a global commit.gpgsign could otherwise wedge an unattended commit).
      args.push('-c', 'commit.gpgsign=false', 'commit', '-m', message, '--', relpath);
      const commit = await gitExec(root, args);
      if (!commit.ok) {
        // Roll back so a failed commit never leaves the main tree dirty (a dirty main worktree makes
        // the PM merge refuse — git.ts mergeBranch's clean-check). Pathspec-scoped, never touches
        // anything else: unstage, then restore-from-HEAD if the path is tracked there, ELSE unlink the
        // leftover — `checkout` cannot delete a brand-NEW path (it has no HEAD version), so an
        // unconditional reset+checkout would leave a new file untracked-on-disk and wedge the merge.
        await gitExec(root, ['-C', root, 'reset', '--', relpath]);
        const inHead = await gitExec(root, ['-C', root, 'cat-file', '-e', `HEAD:${relpath}`]);
        if (inHead.ok) {
          await gitExec(root, ['-C', root, 'checkout', '--', relpath]); // restore committed content
        } else {
          try {
            await fs.unlink(abs); // brand-new path → no HEAD version; remove the leftover
          } catch {
            /* already gone */
          }
        }
        return { ok: false, error: gitErrText(commit, { scrub: true }) };
      }

      const head = await gitExec(root, ['-C', root, 'rev-parse', 'HEAD']);
      const sha = head.ok ? head.stdout.trim() : '';
      return { ok: true, sha, author: author ?? 'ambient' };
    });
  });
}

/**
 * The commit author identity. Returns null → omit `-c user.name/email` so git uses the AMBIENT
 * identity (the human's configured git user — SPEC §4 keystone (e)). Returns {name,email} ONLY when
 * BOTH project overrides are set (a half-set override falls back to ambient rather than committing
 * with a bogus half-identity).
 */
function resolveAuthor(project: {
  commitAuthorName?: string | null;
  commitAuthorEmail?: string | null;
}): { name: string; email: string } | null {
  const name = project.commitAuthorName?.trim();
  const email = project.commitAuthorEmail?.trim();
  if (name && email) return { name, email };
  return null;
}
