/**
 * TreeBuilder — assembles a run's orchestrator→subagent hierarchy from the
 * normalized event stream, keyed by `parent_tool_use_id` (DC.md F-7). Maintains
 * per-node token/cost rollups and the run-level totals.
 *
 * Routing rule: an event's owning node = its `parent_tool_use_id` (root === runId
 * when null). A subagent node is created eagerly on a spawn tool_use, and lazily
 * if a child references a never-seen parent (version-proof). A node finishes when
 * a tool_result's `tool_use_id` equals that node's id.
 */
import type { NormalizedEvent, RunNode, NodeType, Usage } from '@fleet/shared';
import type { ParsedEvent } from './parser.js';
import { estimateCost } from './parser.js';

export interface IngestResult {
  events: NormalizedEvent[];
  changedNodeIds: Set<string>;
  init: boolean;
  spawnedLive: boolean;
  finishedChild: boolean;
  permission: { requestId: string; tool: string; input: unknown } | null;
  result: { isError: boolean; text: string | null; costUsd: number; structuredOutput: unknown } | null;
}

export interface RunRollups {
  subagentCount: number;
  liveSubagents: number;
  maxDepth: number;
  tokensIn: number;
  tokensOut: number;
  /** cumulative across resumes (baseline + this invocation). */
  costUsd: number;
  /** this invocation only — what the budget guardrail compares against (review #2/#8). */
  portionCostUsd: number;
  lastActivity: number;
}

export class RunTree {
  readonly runId: string;
  sessionId: string;
  private rates: { inputPerM: number; outputPerM: number };
  nodes = new Map<string, RunNode>();
  seq = 0;
  liveCostEstimate = 0;
  authoritativeCost: number | null = null;
  authoritativeTokensIn: number | null = null;
  authoritativeTokensOut: number | null = null;
  resultText: string | null = null;
  resultIsError = false;
  lastActivity: number;
  /** carried-over totals from prior resume invocations (review #2). */
  private baseCost = 0;
  private baseTokIn = 0;
  private baseTokOut = 0;
  /**
   * message.ids already costed. CC 2.1.168 splits one logical assistant message
   * into multiple `assistant` objects sharing message.id, each repeating the
   * message-level usage — without this, cost/output would be counted N× and the
   * live estimate would trip the budget auto-kill early (H1).
   */
  private costedMessageIds = new Set<string>();

  constructor(
    runId: string,
    sessionId: string,
    rates: { inputPerM: number; outputPerM: number },
    startedAt: number,
    baseline?: { cost?: number; tokensIn?: number; tokensOut?: number },
  ) {
    this.runId = runId;
    this.sessionId = sessionId;
    this.rates = rates;
    this.lastActivity = startedAt;
    this.baseCost = baseline?.cost ?? 0;
    this.baseTokIn = baseline?.tokensIn ?? 0;
    this.baseTokOut = baseline?.tokensOut ?? 0;
    this.nodes.set(runId, {
      id: runId,
      runId,
      parentId: null,
      nodeType: 'root',
      label: 'session',
      status: 'running',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      startedAt,
      endedAt: null,
      depth: 0,
    });
  }

  private ensureNode(
    id: string,
    parentId: string,
    nodeType: NodeType,
    label: string,
    ts: number,
  ): RunNode {
    let node = this.nodes.get(id);
    if (node) return node;
    const parent = this.nodes.get(parentId);
    node = {
      id,
      runId: this.runId,
      parentId,
      nodeType,
      label,
      status: 'running',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      startedAt: ts,
      endedAt: null,
      depth: parent ? parent.depth + 1 : 1,
    };
    this.nodes.set(id, node);
    return node;
  }

  /** Resolve the node that OWNS an event from its parent_tool_use_id. */
  private ownerId(parentToolUseId: string | null, ts: number): string {
    if (!parentToolUseId) return this.runId;
    if (this.nodes.has(parentToolUseId)) return parentToolUseId;
    // lazy safety-net: a child referenced a parent we never saw spawn.
    this.ensureNode(parentToolUseId, this.runId, 'subagent', 'subagent', ts);
    return parentToolUseId;
  }

  private addUsage(node: RunNode, usage: Usage, messageId?: string) {
    // Count each assistant message's usage ONCE — CC repeats it across split
    // `assistant` objects sharing message.id (H1). id-less usage always accrues.
    if (messageId) {
      if (this.costedMessageIds.has(messageId)) return;
      this.costedMessageIds.add(messageId);
    }
    node.tokensOut += usage.outputTokens;
    // input/cache tokens are cumulative-per-message; track the representative
    // context size (max) rather than summing (DC.md token-accounting note).
    const ctx = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    node.tokensIn = Math.max(node.tokensIn, ctx);
    const c = estimateCost(usage, this.rates);
    node.costUsd += c;
    this.liveCostEstimate += c;
  }

  ingest(parsed: ParsedEvent, ts: number): IngestResult {
    this.lastActivity = ts;
    const res: IngestResult = {
      events: [],
      changedNodeIds: new Set(),
      init: false,
      spawnedLive: false,
      finishedChild: false,
      permission: null,
      result: null,
    };
    if (parsed.type === 'noise') return res;

    const ownerId = this.ownerId(parsed.parentToolUseId, ts);
    const owner = this.nodes.get(ownerId)!;
    let emitNodeId = ownerId;
    let emitType = parsed.type as NormalizedEvent['type'];
    let payload: Record<string, unknown> = {};

    switch (parsed.type) {
      case 'init':
        res.init = true;
        payload = { raw: parsed.raw };
        break;

      case 'subagent_spawned': {
        const child = this.ensureNode(parsed.spawn!.id, ownerId, 'subagent', parsed.spawn!.label, ts);
        res.changedNodeIds.add(child.id);
        res.spawnedLive = true;
        emitNodeId = child.id; // surface the spawn on the new child node
        payload = { childId: child.id, label: child.label, parentId: ownerId, tool: parsed.spawn!.name };
        if (parsed.usage) this.addUsage(owner, parsed.usage, parsed.messageId); // usage belongs to the emitter (owner)
        break;
      }

      case 'tool_result': {
        const target = this.nodes.get(parsed.completedToolUseId!);
        if (target && target.nodeType === 'subagent') {
          // a subagent finished and returned its result (review #1: honor is_error).
          target.status = parsed.isError ? 'failed' : 'completed';
          target.endedAt = ts;
          res.changedNodeIds.add(target.id);
          res.finishedChild = true;
          emitNodeId = target.id;
          emitType = 'subagent_done';
          payload = { result: parsed.toolResult?.text ?? '', isError: !!parsed.isError };
        } else {
          // ordinary tool result (Bash/Read/…) on the owner node.
          payload = { forId: parsed.toolResult?.forId, text: parsed.toolResult?.text ?? '' };
        }
        break;
      }

      case 'tool_use':
        payload = { id: parsed.toolUse?.id, name: parsed.toolUse?.name, input: parsed.toolUse?.input };
        if (parsed.usage) this.addUsage(owner, parsed.usage, parsed.messageId);
        break;

      case 'assistant_text':
      case 'assistant_partial':
      case 'thinking':
      case 'agent_message': // H22
        payload = { text: parsed.text ?? '' };
        if (parsed.usage) this.addUsage(owner, parsed.usage, parsed.messageId);
        break;

      case 'permission_request':
        res.permission = parsed.permission ?? null;
        payload = { ...(parsed.permission ?? {}) };
        break;

      case 'result': {
        this.authoritativeCost = parsed.costUsd ?? this.liveCostEstimate;
        if (parsed.usage) {
          this.authoritativeTokensIn = parsed.usage.inputTokens + parsed.usage.cacheReadInputTokens + parsed.usage.cacheCreationInputTokens;
          this.authoritativeTokensOut = parsed.usage.outputTokens;
        }
        this.resultText = parsed.resultText ?? null;
        this.resultIsError = !!parsed.isError;
        const root = this.nodes.get(this.runId)!;
        root.status = parsed.isError ? 'failed' : 'completed';
        root.endedAt = ts;
        root.costUsd = this.authoritativeCost;
        res.changedNodeIds.add(root.id);
        res.result = { isError: this.resultIsError, text: this.resultText, costUsd: this.authoritativeCost, structuredOutput: parsed.structuredOutput ?? null };
        payload = { costUsd: this.authoritativeCost, result: this.resultText, isError: this.resultIsError };
        break;
      }

      case 'status':
        if (parsed.usage) this.addUsage(owner, parsed.usage, parsed.messageId);
        emitType = 'status';
        break;

      case 'rate_limit':
        emitType = 'rate_limit';
        break;

      default:
        break;
    }

    res.changedNodeIds.add(emitNodeId);
    const node = this.nodes.get(emitNodeId)!;
    res.events.push({
      sessionId: this.sessionId,
      runId: this.runId,
      nodeId: emitNodeId,
      parentNodeId: node.parentId,
      nodeType: node.nodeType,
      seq: this.seq++,
      ts,
      type: emitType,
      payload: { ...payload, raw: parsed.raw },
    });
    return res;
  }

  rollups(): RunRollups {
    let subagentCount = 0;
    let liveSubagents = 0;
    let maxDepth = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const n of this.nodes.values()) {
      if (n.nodeType === 'subagent' || n.nodeType === 'teammate') {
        subagentCount++;
        if (n.status === 'running') liveSubagents++;
      }
      maxDepth = Math.max(maxDepth, n.depth);
      tokensIn += n.tokensIn;
      tokensOut += n.tokensOut;
    }
    const portionCost = this.authoritativeCost ?? this.liveCostEstimate;
    return {
      subagentCount,
      liveSubagents,
      maxDepth,
      tokensIn: this.baseTokIn + (this.authoritativeTokensIn ?? tokensIn),
      tokensOut: this.baseTokOut + (this.authoritativeTokensOut ?? tokensOut),
      costUsd: this.baseCost + portionCost,
      portionCostUsd: portionCost,
      lastActivity: this.lastActivity,
    };
  }

  /** Flat node list (for persistence). */
  flatNodes(): RunNode[] {
    return [...this.nodes.values()];
  }

  /** Assemble the nested tree rooted at the run's root node (for the UI). */
  assembleTree(): RunNode {
    const byParent = new Map<string | null, RunNode[]>();
    for (const n of this.nodes.values()) {
      const list = byParent.get(n.parentId) ?? [];
      list.push({ ...n, children: [] });
      byParent.set(n.parentId, list);
    }
    const attach = (node: RunNode): RunNode => {
      const kids = byParent.get(node.id) ?? [];
      node.children = kids.map(attach).sort((a, b) => a.startedAt - b.startedAt);
      return node;
    };
    const root = this.nodes.get(this.runId)!;
    return attach({ ...root, children: [] });
  }

  /** Mark the whole subtree killed (cascade stop, PRD §7.6). */
  killAll(ts: number) {
    for (const n of this.nodes.values()) {
      if (n.status === 'running') {
        n.status = 'killed';
        n.endedAt = ts;
      }
    }
  }
}
