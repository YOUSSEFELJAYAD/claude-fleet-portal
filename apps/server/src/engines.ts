/**
 * Engine runner (§24) — pure builders + parser + spawner for the Codex and
 * OpenCode add-on CLIs.  Every exported function is side-effect-free except
 * `spawnEngine`, which mirrors spawnClaude's contract (detached, JSONL stdout,
 * process-group kill) but is simpler: no stdin protocol, no auth env from
 * addons, no --session-id.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { LaunchRequest, RunEngine } from '@fleet/shared';

// ── arg builders (pure, unit-testable) ──────────────────────────────────────

export interface CodexEngineConfig {
  defaultModel: string | null;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface OpencodeEngineConfig {
  defaultModel: string | null;
  skipPermissions: boolean;
}

export type EngineConfig = CodexEngineConfig | OpencodeEngineConfig;

/**
 * Build the argv for the given engine.  Pure — no I/O.
 * codex:     [global flags] exec --json --skip-git-repo-check <prompt>
 * opencode:  run --format json [--model ...] [--dangerously-skip-permissions] <prompt>
 */
export function buildEngineArgs(
  engine: RunEngine,
  req: Pick<LaunchRequest, 'prompt' | 'cwd' | 'engineModel' | 'thinkingLevel'>,
  cfg: EngineConfig,
): string[] {
  const model = req.engineModel ?? (cfg as any).defaultModel ?? null;

  if (engine === 'codex') {
    const ccfg = cfg as CodexEngineConfig;
    const args: string[] = [
      '--ask-for-approval',
      'never',
      '--sandbox',
      ccfg.sandbox,
    ];
    // §26 — reasoning effort is a GLOBAL flag placed before the subcommand ('exec').
    // execFile-style spawn passes argv directly (no shell), so no extra quoting needed.
    if (req.thinkingLevel) args.push('-c', `model_reasoning_effort=${req.thinkingLevel}`);
    if (model) args.push('--model', model);
    // `--` is REQUIRED before the positional prompt (same lesson as the claude path,
    // F-11): a prompt starting with '-' is otherwise parsed as a flag — empirically
    // reproduced ('- fix the login bug' → clap arg error, zero JSONL).
    args.push('--cd', req.cwd, 'exec', '--json', '--skip-git-repo-check', '--', req.prompt);
    return args;
  }

  if (engine === 'opencode') {
    const ocfg = cfg as OpencodeEngineConfig;
    const args: string[] = ['run', '--format', 'json'];
    if (model) args.push('--model', model);
    if (ocfg.skipPermissions) args.push('--dangerously-skip-permissions');
    // §26 — variant sets provider-specific reasoning effort; placed before the '--' separator.
    if (req.thinkingLevel) args.push('--variant', req.thinkingLevel);
    // `--` ends option parsing — without it a hyphen-leading prompt is read as a flag
    // (worst case: a prompt naming --dangerously-skip-permissions would ENABLE it)
    args.push('--', req.prompt);
    return args;
  }

  throw new Error(`unsupported engine: ${engine}`);
}

// ── normalized line fragment ─────────────────────────────────────────────────

export interface EngineLine {
  /** NormalizedEvent type to emit; null = no event (skip line). */
  type: 'assistant_text' | 'thinking' | 'tool_use' | 'result' | 'status' | null;
  payload?: Record<string, unknown>;
  /** Accumulated run token usage from this line; undefined if not present. */
  usage?: { tokensIn: number; tokensOut: number };
  /** The text to store as run.resultText; present on the last agent_message line. */
  resultText?: string;
  /** true when this line represents a failure (turn.failed, error type). */
  isError?: boolean;
}

/**
 * Map one parsed JSONL object to a normalized engine line.
 * Returns { type: null } when the line carries no UI-relevant info.
 * PURE — no I/O or state.
 */
export function parseEngineLine(engine: RunEngine, obj: unknown): EngineLine {
  if (!obj || typeof obj !== 'object') return { type: null };
  const o = obj as Record<string, unknown>;

  if (engine === 'codex') {
    const t = o.type as string | undefined;

    if (t === 'item.completed') {
      const item = o.item as Record<string, unknown> | undefined;
      const itemType = item?.type as string | undefined;

      if (itemType === 'agent_message') {
        const text = item?.text as string | undefined ?? '';
        return {
          type: 'assistant_text',
          payload: { text },
          resultText: text,
        };
      }
      if (itemType === 'reasoning') {
        const text =
          (item?.content as string | undefined) ??
          (item?.text as string | undefined) ??
          '';
        return { type: 'thinking', payload: { text } };
      }
      if (
        itemType === 'command_execution' ||
        itemType === 'mcp_tool_call' ||
        itemType === 'web_search' ||
        itemType === 'file_changes'
      ) {
        // Summarise the tool invocation into a brief input string.
        let inputSummary: string;
        if (itemType === 'command_execution') {
          const cmd = (item?.command as string | undefined) ?? '';
          inputSummary = cmd ? `command: ${cmd.slice(0, 120)}` : 'command';
        } else if (itemType === 'mcp_tool_call') {
          const name = (item?.tool_name as string | undefined) ?? 'mcp_tool';
          inputSummary = name;
        } else if (itemType === 'web_search') {
          const q = (item?.query as string | undefined) ?? '';
          inputSummary = q ? `search: ${q.slice(0, 120)}` : 'web search';
        } else {
          inputSummary = 'file changes';
        }
        return {
          type: 'tool_use',
          payload: {
            name: itemType,
            id: (item?.id as string | undefined) ?? itemType,
            input: inputSummary,
          },
        };
      }
      // Other item types (plan_update etc.) → no event
      return { type: null };
    }

    if (t === 'turn.completed') {
      const usage = o.usage as Record<string, unknown> | undefined;
      if (!usage) return { type: null };
      return {
        type: null, // usage-only, no visible event
        usage: {
          tokensIn: (usage.input_tokens as number | undefined) ?? 0,
          tokensOut: (usage.output_tokens as number | undefined) ?? 0,
        },
      };
    }

    if (t === 'turn.failed' || t === 'error') {
      // real codex nests the message: {type:'turn.failed', error:{message:'…'}} —
      // unwrap defensively; a TS cast alone would let the object flow into the UI
      const candidates = [(o.error as any)?.message, o.message, o.error];
      const found = candidates.find((c) => typeof c === 'string' && c);
      const msg = (found as string | undefined) ?? (o.error ? JSON.stringify(o.error) : t);
      // Timeline renders result events from payload.result (not .text)
      return {
        type: 'result',
        payload: { isError: true, result: msg },
        isError: true,
      };
    }

    // thread.started, turn.started, item.started — no event
    return { type: null };
  }

  if (engine === 'opencode') {
    const t = o.type as string | undefined;
    const part = o.part as Record<string, unknown> | undefined;

    if (t === 'text') {
      const text = (part?.text as string | undefined) ?? '';
      return {
        type: 'assistant_text',
        payload: { text },
        resultText: text,
      };
    }

    if (t === 'reasoning') {
      const text = (part?.text as string | undefined) ?? '';
      return { type: 'thinking', payload: { text } };
    }

    if (t === 'tool_use') {
      const name = (part?.tool as string | undefined) ?? (part?.name as string | undefined) ?? 'tool';
      const input = (part?.input as unknown) ?? {};
      return {
        type: 'tool_use',
        payload: {
          name,
          id: (part?.id as string | undefined) ?? name,
          input,
        },
      };
    }

    if (t === 'step_finish') {
      // Defensively parse tokens — opencode docs say they MAY be present.
      const tokens = (part?.tokens ?? part?.usage ?? null) as Record<string, unknown> | null;
      if (!tokens) return { type: null };
      const tokensIn = (tokens.input as number | undefined) ?? 0;
      const tokensOut = (tokens.output as number | undefined) ?? 0;
      if (!tokensIn && !tokensOut) return { type: null };
      return {
        type: null, // usage-only
        usage: { tokensIn, tokensOut },
      };
    }

    if (t === 'error') {
      const raw = (part?.message ?? o.error) as unknown;
      const msg = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : 'error';
      // Timeline renders result events from payload.result (not .text)
      return {
        type: 'result',
        payload: { isError: true, result: msg },
        isError: true,
      };
    }

    // step_start and unknown types → no event
    return { type: null };
  }

  return { type: null };
}

// ── spawner ──────────────────────────────────────────────────────────────────

export interface EngineHandlers {
  onLine: (obj: unknown) => void;
  onStderr: (chunk: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ManagedEngineProcess {
  pid: number | undefined;
  child: ChildProcess;
  kill(): void;
}

const MAX_PARTIAL_BYTES = 32 * 1024 * 1024;

/**
 * Spawn a headless engine CLI.  Mirrors spawnClaude's contract (detached,
 * JSONL stdout newline-buffered, process-group kill, SIGTERM→SIGKILL cascade)
 * but simpler: stdin is closed immediately (no protocol), and there is no
 * auth/addon env injection (engines manage their own credentials).
 */
export function spawnEngine(
  engine: RunEngine,
  bin: string,
  args: string[],
  cwd: string,
  handlers: EngineHandlers,
): ManagedEngineProcess {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (engine === 'opencode') {
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  }

  const child = spawn(bin, args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env,
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
      if (!line.startsWith('{')) continue;
      try {
        handlers.onLine(JSON.parse(line));
      } catch {
        /* tolerate garbled line */
      }
    }
    if (buf.length > MAX_PARTIAL_BYTES) {
      console.warn(`[fleet/engine:${engine}] dropping oversized stdout partial (${buf.length} bytes)`);
      buf = '';
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => handlers.onStderr(c));

  child.on('exit', (code, signal) => {
    exited = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    // drain any trailing partial
    if (buf.trim().startsWith('{')) {
      try {
        handlers.onLine(JSON.parse(buf.trim()));
      } catch {
        /* ignore */
      }
    }
    handlers.onExit(code, signal);
  });

  child.on('error', () => {
    exited = true;
    handlers.onExit(-1, null);
  });

  const killGroup = (sig: NodeJS.Signals) => {
    if (exited || child.pid == null) return;
    try {
      process.kill(-child.pid, sig);
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
    kill() {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 3000);
      if (killTimer) killTimer.unref();
    },
  };
}
