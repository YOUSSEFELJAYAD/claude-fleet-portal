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
import { spawn } from 'node:child_process';

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
    return await new Promise<ValidationResult>((resolve) => {
      // Spawned `detached` (own process group) with a MANUAL timeout that signals the whole
      // group — execFile's built-in timeout only kills the bash wrapper, leaking grandchildren
      // (e.g. a hung `npm test`) that keep running in the worktree under the next fix run.
      const child = spawn('bash', ['-lc', cmd], { cwd: worktreeDir, detached: true });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let exited = false;
      let killed = false;
      let killTimer: NodeJS.Timeout | null = null;
      const killGroup = (sig: NodeJS.Signals) => {
        if (exited || child.pid == null) return;
        killed = true;
        try {
          process.kill(-child.pid, sig); // negative pid → whole group (pid === pgid, detached)
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already dead */
          }
        }
      };
      const timer = setTimeout(() => {
        killGroup('SIGTERM');
        // escalate if it ignores SIGTERM, like processManager.ts
        killTimer = setTimeout(() => killGroup('SIGKILL'), 3000);
        killTimer.unref();
      }, VALIDATION_TIMEOUT_MS);
      const onChunk = (sink: (s: string) => void) => (chunk: Buffer) => {
        bytes += chunk.length;
        sink(chunk.toString('utf8'));
        if (bytes > VALIDATION_MAX_BUFFER && !killed) killGroup('SIGTERM');
      };
      child.stdout?.on(
        'data',
        onChunk((s) => {
          stdout += s;
        }),
      );
      child.stderr?.on(
        'data',
        onChunk((s) => {
          stderr += s;
        }),
      );
      const finish = (result: ValidationResult) => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };
      child.on('error', (e: any) => {
        const code = e?.code === 'ENOENT' ? 127 : -1;
        finish({ ok: false, output: capOutput(stdout, stderr) || (e?.message ?? ''), code });
      });
      child.on('close', (exitCode, signal) => {
        let code: number;
        if (killed || signal) code = 124;
        else if (typeof exitCode === 'number') code = exitCode;
        else code = -1;
        const out =
          capOutput(stdout, stderr) ||
          (code === 0 ? '' : signal ? `killed by ${signal}` : `command failed (exit ${code})`);
        finish({ ok: code === 0, output: out, code });
      });
    });
  } catch (e: any) {
    return { ok: false, output: e?.message ?? '', code: -1 };
  }
}

export function capOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  return combined.length > VALIDATION_OUTPUT_CAP
    ? combined.slice(-VALIDATION_OUTPUT_CAP) // keep the TAIL (errors print last)
    : combined;
}
