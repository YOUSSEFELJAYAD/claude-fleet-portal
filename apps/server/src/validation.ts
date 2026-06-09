/**
 * Shared validation primitive (v2 §3.2). Extracted from pm.ts so the port-broker (#5), the
 * campaign-per-card gate (#4), and the conflict-resolution agent (#9) can all run a card's
 * validation command WITHOUT importing pm.ts (which would create a pm.ts <-> portbroker.ts cycle).
 *
 * Behavior is IDENTICAL to the v1 pm.ts implementation: a pure-check command is run in the worktree
 * dir via `bash -lc <cmd>` (the spec allows a shell so a project can use `npm test && npm run
 * typecheck` etc.), the runner NEVER throws (it salvages stdout/stderr/exit-code into a result
 * object — exit 0 == pass), and the combined output is tail-capped for fix-prompt threading.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── tunables (moved verbatim from pm.ts) ────────────────────────────────────────
export const VALIDATION_TIMEOUT_MS = 10 * 60_000; // 10 min cap for a pure-check validation command
export const VALIDATION_MAX_BUFFER = 8 * 1024 * 1024; // 8MB stdout/stderr cap
export const VALIDATION_OUTPUT_CAP = 16 * 1024; // chars of (stdout+stderr) threaded into a fix prompt

// ── validation runner (pure checks, SPEC §5.4 / §11.5) ──────────────────────────
export interface ValidationResult {
  ok: boolean;
  /** Combined, capped stdout+stderr for evidence + fix-prompt threading. */
  output: string;
  code: number;
}

/**
 * Run a validation command in the worktree dir via `bash -lc <cmd>` (the spec allows a shell so a
 * project can use `npm test && npm run typecheck` etc.). NEVER throws — like mcp.ts / git.ts it
 * salvages stdout/stderr/exit-code into a result object. Exit 0 == pass.
 */
export async function runValidation(worktreeDir: string, cmd: string): Promise<ValidationResult> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', cmd], {
      cwd: worktreeDir,
      timeout: VALIDATION_TIMEOUT_MS,
      maxBuffer: VALIDATION_MAX_BUFFER,
      encoding: 'utf8',
    });
    return { ok: true, output: capOutput(stdout, stderr), code: 0 };
  } catch (e: any) {
    const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
    let code: number;
    if (typeof e?.code === 'number') code = e.code;
    else if (e?.code === 'ENOENT') code = 127;
    else if (e?.killed || e?.code === 'ETIMEDOUT' || e?.signal) code = 124;
    else code = -1;
    const out = capOutput(stdout, stderr) || (e?.message ?? '');
    return { ok: false, output: out, code };
  }
}

export function capOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  return combined.length > VALIDATION_OUTPUT_CAP
    ? combined.slice(-VALIDATION_OUTPUT_CAP) // keep the TAIL (errors print last)
    : combined;
}
