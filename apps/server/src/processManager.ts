/**
 * Process manager (PRD §8.1): one `claude -p` child per run. Owns spawn, newline-
 * buffered stdout parsing, stdin follow-up writes, and signal-based cascade kill.
 * Spawned `detached` so the whole process group can be killed together (§7.6).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { CLAUDE_BIN, OTEL_ENABLED, OTLP_ENDPOINT } from './config.js';
import { addonRunEnv } from './addons.js';
import type { LaunchRequest } from '@fleet/shared';

/**
 * H6 — telemetry env pointing claude's OTLP exporter at the control plane's own /v1/* receiver.
 * JSON-encoded (no protobuf dep); NEVER the console exporter (it corrupts the stream-json stdout).
 */
const otelEnv = (): Record<string, string> =>
  OTEL_ENABLED
    ? {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT,
        OTEL_METRIC_EXPORT_INTERVAL: '5000',
        OTEL_LOGS_EXPORT_INTERVAL: '5000',
      }
    : {};

/**
 * H13 — best-effort: is `pid` a LIVE process that looks like one WE spawned? A persisted
 * pid read on boot/after-restart could have been recycled by the OS onto an unrelated
 * process group; signalling it blindly could SIGKILL an innocent process. We confirm via
 * `ps` that the command line references claude (or the mock) before killing.
 */
export function looksLikeClaudePid(pid: number | null | undefined): boolean {
  if (!pid || pid <= 1) return false;
  try {
    const out = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    if (out.status !== 0 || !out.stdout) return false; // not alive / can't confirm → don't kill
    const cmd = out.stdout.toLowerCase();
    return (
      cmd.includes('claude') ||
      cmd.includes('mock-claude') ||
      cmd.includes('--output-format') ||
      cmd.includes('--session-id') ||
      // §24 — engine add-on runs persist their pid too; the boot orphan sweep and
      // not-in-memory stop must recognize them or restarted servers leak engine children
      cmd.includes('codex') ||
      cmd.includes('opencode')
    );
  } catch {
    return false;
  }
}

/**
 * §26 — map a thinkingLevel string to the MAX_THINKING_TOKENS env var for claude.
 * Levels: off→0, think→4000, megathink→10000, ultrathink→31999.
 * Absent/null/unrecognised → {} (let the model use its adaptive default).
 */
export function thinkingEnv(level: string | null | undefined): Record<string, string> {
  switch (level) {
    case 'off':        return { MAX_THINKING_TOKENS: '0' };
    case 'think':      return { MAX_THINKING_TOKENS: '4000' };
    case 'megathink':  return { MAX_THINKING_TOKENS: '10000' };
    case 'ultrathink': return { MAX_THINKING_TOKENS: '31999' };
    default:           return {};
  }
}

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
  // H13 — this path only runs for pids read from persisted state (boot orphan sweep +
  // not-in-memory stop). Verify identity first so a recycled PID can't get an innocent
  // process group SIGKILLed. (Live in-memory runs are killed via the ChildProcess handle.)
  if (!looksLikeClaudePid(pid)) return;
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
      if (!looksLikeClaudePid(pid)) return;
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
  // Selected skills are made REAL here: claude has no --skills flag, so without this block
  // they were write-only run metadata. The agent invokes them itself via its Skill tool.
  // A run whose prompt STARTS ON a slash-command already gets that command's instructions
  // auto-loaded by claude — injecting the same name as a skill would double-load it.
  const promptCommand = (req.prompt ?? '').trim().match(/^\/([A-Za-z0-9_:-]+)/)?.[1];
  const noteSkills = (req.skills ?? []).filter((s) => s !== promptCommand);
  const skillsNote = noteSkills.length
    ? 'SKILLS: the operator pre-selected these skills for this task: ' +
      noteSkills.join(', ') +
      '. Before starting work, invoke the Skill tool for each one that matches the task at hand ' +
      'and follow the loaded skill instructions over your defaults. If a listed skill is ' +
      'unavailable, proceed without it and note that in your final report.'
    : '';
  const appendSys = [req.appendSystemPrompt, skillsNote].filter(Boolean).join('\n\n');
  if (appendSys) args.push('--append-system-prompt', appendSys);
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  // H10 — worktree isolation + inline agents + tool deny-list. `--disallowedTools` is variadic
  // (like --add-dir), and `--worktree` takes an optional value — both are safe here because the
  // one-shot prompt is always emitted last after the `--` separator below (F-11).
  if (req.worktree) args.push('--worktree', req.worktree);
  if (req.disallowedTools && req.disallowedTools.length) args.push('--disallowedTools', req.disallowedTools.join(','));
  if (req.agentsJson) args.push('--agents', JSON.stringify(req.agentsJson));
  if (req.brief) args.push('--brief'); // H22 — enable agent→user SendUserMessage tool
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
  const dd = args.indexOf('--');
  if (dd >= 0) args.splice(dd, 0, '--resume', sessionId);
  else args.push('--resume', sessionId);
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
  extraEnv?: Record<string, string>,
): ManagedProcess {
  const child = spawn(CLAUDE_BIN, args, {
    cwd: cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // new process group → cascade kill (§7.6)
    // H6 — real OTLP exporter env; §22 — addonRunEnv routes the run through the compression
    // proxy (ANTHROPIC_BASE_URL) when that add-on is enabled AND its proxy is verified healthy.
    // §26 — extraEnv (e.g. MAX_THINKING_TOKENS) is last so it wins over all earlier layers.
    env: { ...process.env, ...otelEnv(), ...addonRunEnv(), ...extraEnv },
  });
  child.stdin?.on('error', () => {
    /* EPIPE from a dying child — swallowed so it can't crash the server */
  });

  let buf = '';
  let exited = false;
  let killTimer: NodeJS.Timeout | null = null;
  // H17 — cap the partial-line buffer. A child emitting a very large line with no newline
  // (a tool result echoing a huge file, or a never-terminated stream) would otherwise grow
  // `buf` without bound and stall the event loop on JSON.parse. Set well above the largest
  // real claude result line (structured_output / result.result are comfortably < this).
  const MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
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
    // after draining complete lines, `buf` holds the trailing partial; if it has grown
    // pathologically large with no newline, drop it (memory-exhaustion / DoS guard).
    if (buf.length > MAX_PARTIAL_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(`[fleet] dropping oversized stdout partial (${buf.length} bytes, no newline)`);
      buf = '';
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
