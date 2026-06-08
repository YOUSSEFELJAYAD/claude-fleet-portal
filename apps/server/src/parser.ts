/**
 * Stream-json parser. Normalizes ONE raw Claude Code stream-json object (already
 * JSON.parsed from a stdout line) into zero-or-more `ParsedEvent`s carrying the
 * raw-level facts the TreeBuilder needs. Grounded in the verified CC 2.1.168
 * schema (DC.md F-1, F-7) — NOT the PRD's guesses.
 *
 * Hierarchy rule (F-7): the spawn tool is `Agent` (or legacy `Task`); a child
 * event's `parent_tool_use_id` equals the spawning tool_use id. We detect spawns
 * eagerly by tool name AND lazily by any child referencing an unknown parent, so
 * the tree builder is version-proof.
 */
import type { NormalizedEventType, Usage } from '@fleet/shared';
import { emptyUsage } from '@fleet/shared';

/** Tool names that, when invoked, spawn a child subagent. */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
export const isSpawnTool = (name: string | undefined): boolean => !!name && SPAWN_TOOLS.has(name);

export interface ParsedEvent {
  type: NormalizedEventType | 'noise';
  /** The raw `parent_tool_use_id` (null at root). Resolves to the owning node. */
  parentToolUseId: string | null;
  sessionId?: string;
  /** Present when this event spawns a subagent (assistant tool_use w/ a spawn tool). */
  spawn?: { id: string; name: string; label: string };
  /** Present when a tool_result reports a subagent finished (tool_use_id === a node id). */
  completedToolUseId?: string;
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: { forId: string; text: string };
  /** Usage attributed to the owning node (attach only once per raw event). */
  usage?: Usage;
  /** Authoritative run cost from the `result` event. */
  costUsd?: number;
  resultText?: string;
  /** structured output from `--json-schema` runs (object on result.structured_output, F-8). */
  structuredOutput?: unknown;
  isError?: boolean;
  permission?: { requestId: string; tool: string; input: unknown };
  /** original raw object, kept for the per-node raw event log (PRD §7.3). */
  raw: Record<string, unknown>;
}

function toUsage(u: any): Usage {
  if (!u) return emptyUsage();
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

function blockText(content: any[]): string {
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function spawnLabel(input: any, name: string): string {
  if (input && typeof input === 'object') {
    const desc = input.description || input.subagent_type || input.prompt;
    if (typeof desc === 'string' && desc.trim()) {
      return desc.length > 60 ? desc.slice(0, 57) + '…' : desc;
    }
  }
  return name;
}

/**
 * Normalize a raw stream-json object. Returns an array because one raw assistant
 * message can contain text + multiple tool_use blocks. Usage is attached to the
 * first emitted event only, to avoid double-counting.
 */
export function normalize(raw: any): ParsedEvent[] {
  const parentToolUseId: string | null = raw?.parent_tool_use_id ?? null;
  const sessionId: string | undefined = raw?.session_id;
  const base = { parentToolUseId, sessionId, raw: raw as Record<string, unknown> };
  const out: ParsedEvent[] = [];

  switch (raw?.type) {
    case 'system': {
      if (raw.subtype === 'init') {
        out.push({ ...base, type: 'init' });
      } else if (raw.subtype === 'status') {
        out.push({ ...base, type: 'status' });
      } else if (raw.subtype === 'permission_request' || raw.subtype === 'can_use_tool') {
        // Best-effort: the headless permission control protocol is not fully verified on
        // this CC version (DC.md open items / review #5). Wire the path defensively so a
        // permission event, if/when emitted, surfaces as awaiting-permission.
        out.push({
          ...base,
          type: 'permission_request',
          permission: {
            requestId: raw.request_id ?? raw.requestId ?? raw.id ?? 'pending',
            tool: raw.tool_name ?? raw.request?.tool_name ?? 'unknown',
            input: raw.input ?? raw.request?.input ?? null,
          },
        });
      }
      // hook_*, task_*, thinking_tokens: soft hints, not needed for the tree.
      return out;
    }

    case 'control_request': {
      // SDK-style permission control request (best-effort, review #5).
      out.push({
        ...base,
        type: 'permission_request',
        permission: {
          requestId: raw.request_id ?? 'pending',
          tool: raw.request?.tool_name ?? raw.request?.subtype ?? 'unknown',
          input: raw.request?.input ?? null,
        },
      });
      return out;
    }

    case 'stream_event': {
      const ev = raw.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        out.push({ ...base, type: 'assistant_partial', text: ev.delta.text ?? '' });
      } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
        out.push({ ...base, type: 'thinking', text: ev.delta.thinking ?? '' });
      }
      // message_start/stop, content_block_start/stop, message_delta: usage taken
      // from the full `assistant` event instead (avoids double counting).
      return out;
    }

    case 'assistant': {
      const content: any[] = raw.message?.content ?? [];
      const usage = toUsage(raw.message?.usage);
      let usageAttached = false;
      const attachUsage = () => {
        if (usageAttached) return undefined;
        usageAttached = true;
        return usage;
      };
      const text = blockText(content);
      if (text) out.push({ ...base, type: 'assistant_text', text, usage: attachUsage() });
      for (const b of content) {
        if (b?.type === 'tool_use') {
          if (isSpawnTool(b.name)) {
            out.push({
              ...base,
              type: 'subagent_spawned',
              spawn: { id: b.id, name: b.name, label: spawnLabel(b.input, b.name) },
              toolUse: { id: b.id, name: b.name, input: b.input },
              usage: attachUsage(),
            });
          } else {
            out.push({
              ...base,
              type: 'tool_use',
              toolUse: { id: b.id, name: b.name, input: b.input },
              usage: attachUsage(),
            });
          }
        }
      }
      if (out.length === 0 && usage) {
        // usage-only assistant message (rare) — still account for it.
        out.push({ ...base, type: 'status', usage });
      }
      return out;
    }

    case 'user': {
      const content: any[] = raw.message?.content ?? [];
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const txt =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: any) => c?.text ?? '').join('')
                : '';
          out.push({
            ...base,
            type: 'tool_result',
            toolResult: { forId: b.tool_use_id, text: txt },
            completedToolUseId: b.tool_use_id, // may resolve to a subagent node → done
            isError: !!b.is_error, // F-7: tool_result carries is_error → subagent failure (review #1)
          });
        }
        // user plain-text (subagent injected prompt) → not surfaced on the timeline.
      }
      return out;
    }

    case 'result': {
      out.push({
        ...base,
        type: 'result',
        costUsd: raw.total_cost_usd ?? 0,
        usage: toUsage(raw.usage),
        resultText: typeof raw.result === 'string' ? raw.result : undefined,
        structuredOutput: raw.structured_output ?? undefined, // F-8: --json-schema output
        isError: !!raw.is_error,
      });
      return out;
    }

    case 'rate_limit_event': {
      out.push({ ...base, type: 'rate_limit' });
      return out;
    }

    default:
      return out;
  }
}

/**
 * Conservative per-message cost estimate (USD). Intentionally an UPPER-ish bound
 * during a live run (input_tokens is cumulative-per-message, so summing over-counts)
 * — the safe direction for a budget guardrail. Reconciled to the authoritative
 * `result.total_cost_usd` at completion. (DC.md D-008.)
 */
export function estimateCost(
  u: Usage,
  rates: { inputPerM: number; outputPerM: number },
): number {
  const inM = rates.inputPerM / 1_000_000;
  const outM = rates.outputPerM / 1_000_000;
  return (
    u.inputTokens * inM +
    u.cacheCreationInputTokens * inM * 1.25 +
    u.cacheReadInputTokens * inM * 0.1 +
    u.outputTokens * outM
  );
}
