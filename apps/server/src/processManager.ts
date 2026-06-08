/**
 * Process manager (PRD §8.1): one `claude -p` child per run. Owns spawn, newline-
 * buffered stdout parsing, stdin follow-up writes, and signal-based cascade kill.
 * Spawned `detached` so the whole process group can be killed together (§7.6).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { CLAUDE_BIN } from './config.js';
import type { LaunchRequest } from '@fleet/shared';

export interface ManagedProcess {
  pid: number | undefined;
  child: ChildProcess;
  writeUserMessage(text: string): void;
  closeStdin(): void;
  kill(): void;
}

/**
 * Kill a detached child's whole process GROUP by pid — works even after a server restart that lost
 * the ChildProcess handle (the run is spawned `detached`, so pid === pgid). Used by stop() for
 * not-in-memory runs and by boot-time orphan reconciliation (PRD §10).
 */
export function killProcessGroup(pid: number | null | undefined, hard = false) {
  if (!pid || pid <= 1) return;
  const sig: NodeJS.Signals = hard ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already dead */
    }
  }
  if (!hard) {
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 2500).unref();
  }
}

/**
 * Build the verified `claude -p` argv (DC.md F-4, D-006, D-007, D-008, D-014).
 * `sessionId` is pre-assigned via --session-id so runId === sessionId from t0.
 */
export function buildArgs(req: LaunchRequest, sessionId: string, interactive: boolean): string[] {
  const args: string[] = [
    '-p', // --print (headless); stream-json input "only works with --print"
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--session-id',
    sessionId,
    '--permission-mode',
    req.permissionMode,
    '--effort',
    req.effort,
  ];
  if (interactive) args.push('--input-format', 'stream-json');
  if (req.model) args.push('--model', req.model);
  if (req.budgetUsd && req.budgetUsd > 0) args.push('--max-budget-usd', String(req.budgetUsd));
  if (req.allowedTools && req.allowedTools.length) {
    args.push('--allowedTools', req.allowedTools.join(','));
  }
  if (req.cwd) args.push('--add-dir', req.cwd);
  if (req.subagentProfile) args.push('--agent', req.subagentProfile);
  if (req.appendSystemPrompt) args.push('--append-system-prompt', req.appendSystemPrompt);
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  // CRITICAL (verified vs real claude): in stream-json INPUT mode the positional `-p` prompt is
  // ignored — claude blocks waiting for a user message on stdin. So pass the prompt as a positional
  // ONLY for one-shot runs; interactive runs deliver the initial prompt via stdin after spawn.
  // The `--` separator is REQUIRED: `--add-dir` is variadic and would otherwise swallow the prompt
  // as a directory (→ "Input must be provided…" exit 1). Verified vs real claude (F-11).
  if (!interactive) args.push('--', req.prompt);
  return args;
}

/** Build argv for resuming a finished session (PRD §7.6): drop --session-id, add --resume. */
export function buildResumeArgs(req: LaunchRequest, sessionId: string, interactive: boolean): string[] {
  const args = buildArgs(req, sessionId, interactive);
  const idx = args.indexOf('--session-id');
  if (idx >= 0) args.splice(idx, 2); // remove flag + its value
  args.push('--resume', sessionId);
  return args;
}

export function spawnClaude(
  args: string[],
  cwd: string,
  handlers: {
    onLine: (obj: any) => void;
    onStderr: (chunk: string) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  },
  keepStdinOpen: boolean,
): ManagedProcess {
  const child = spawn(CLAUDE_BIN, args, {
    cwd: cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // new process group → cascade kill (§7.6)
    env: { ...process.env, CLAUDE_CODE_ENABLE_TELEMETRY: '1' }, // PRD §10 observability
  });

  let buf = '';
  let exited = false;
  let killTimer: NodeJS.Timeout | null = null;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue; // skip warnings / non-JSON noise
      try {
        handlers.onLine(JSON.parse(line));
      } catch {
        /* tolerate a partial/garbled line */
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => handlers.onStderr(c));

  child.on('exit', (code, signal) => {
    exited = true; // review #7: stop any pending SIGKILL escalation from hitting a reused PID
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (buf.trim().startsWith('{')) {
      try {
        handlers.onLine(JSON.parse(buf.trim()));
      } catch {
        /* ignore trailing */
      }
    }
    handlers.onExit(code, signal);
  });
  child.on('error', () => {
    exited = true;
    handlers.onExit(-1, null);
  });

  if (!keepStdinOpen) {
    // one-shot: signal EOF so the model runs the prompt once and exits cleanly.
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  }

  const killGroup = (sig: NodeJS.Signals) => {
    if (exited || child.pid == null) return; // never signal after the child is known dead (review #7)
    try {
      process.kill(-child.pid, sig); // negative pid → whole group
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already dead */
      }
    }
  };

  return {
    pid: child.pid,
    child,
    writeUserMessage(text: string) {
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      try {
        child.stdin?.write(msg + '\n');
      } catch {
        /* stdin closed */
      }
    },
    closeStdin() {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    },
    kill() {
      killGroup('SIGTERM');
      // escalate if it ignores SIGTERM; cleared on exit so it can't hit a reused PID (review #7)
      killTimer = setTimeout(() => killGroup('SIGKILL'), 3000);
      killTimer.unref();
    },
  };
}
