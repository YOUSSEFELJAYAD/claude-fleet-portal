'use client';
import React, { useMemo } from 'react';
import { statusMeta } from '@/lib/status';
import { usd, tokens } from '@/lib/format';
import { Dot, Empty } from '@/components/ui';

/**
 * FlowGraph — layered node-graph view over the run tree.
 *
 * Builds columns by depth from the parentId topology and draws SVG edges
 * parent→child. Useful for WIDE fan-out where the indented tree is hard to scan.
 * Dependency-free: absolute-positioned boxes + a hand-rolled SVG edge layer.
 *
 * `nodes` is the flat RunNode[] list (id, parentId, depth, nodeType, label,
 * status, tokensOut, costUsd) — typed loosely per the alternate-view contract.
 */

interface GNode {
  id: string;
  parentId: string | null;
  nodeType: string;
  label: string;
  status: string;
  tokensOut: number;
  costUsd: number;
  depth: number;
  /** subtree roll-ups: own value + all descendants. */
  rollupCost: number;
  rollupTokens: number;
  /** absolute layout (px). */
  x: number;
  y: number;
}

// box geometry (px)
const BOX_W = 184;
const BOX_H = 56;
const COL_GAP = 64; // horizontal gap between depth columns
const ROW_GAP = 18; // vertical gap between stacked nodes
const PAD = 8; // canvas padding

const glyph = (t: string) => (t === 'root' ? '◉' : t === 'teammate' ? '⬡' : t === 'workflow' ? '◇' : '⧉');

export function FlowGraph({ nodes }: { nodes: any[] }) {
  const { laid, width, height } = useMemo(() => buildLayout(nodes ?? []), [nodes]);

  if (laid.length === 0) {
    return <Empty>No graph yet — awaiting first nodes.</Empty>;
  }

  const byId = new Map(laid.map((n) => [n.id, n]));

  return (
    <div className="overflow-auto max-h-[560px]">
      <div className="relative" style={{ width, height }}>
        {/* edge layer */}
        <svg
          width={width}
          height={height}
          className="absolute inset-0 pointer-events-none"
          style={{ overflow: 'visible' }}
        >
          {laid.map((n) => {
            if (!n.parentId) return null;
            const p = byId.get(n.parentId);
            if (!p) return null;
            const x1 = p.x + BOX_W;
            const y1 = p.y + BOX_H / 2;
            const x2 = n.x;
            const y2 = n.y + BOX_H / 2;
            const mx = (x1 + x2) / 2;
            const live = n.status === 'running';
            const color = statusMeta(n.status as any).color;
            return (
              <path
                key={n.id}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={color}
                strokeOpacity={live ? 0.65 : 0.32}
                strokeWidth={1.25}
                strokeDasharray={live ? '4 3' : undefined}
              />
            );
          })}
        </svg>

        {/* node layer */}
        {laid.map((n) => {
          const m = statusMeta(n.status as any);
          const live = n.status === 'running';
          const isRoot = n.nodeType === 'root';
          return (
            <div
              key={n.id}
              className="absolute font-mono"
              style={{
                left: n.x,
                top: n.y,
                width: BOX_W,
                height: BOX_H,
                border: `1px solid ${m.color}${live ? '' : '66'}`,
                background: `${m.color}0d`,
                boxShadow: live ? `0 0 12px -4px ${m.color}` : 'none',
                padding: '7px 9px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
              title={`${n.nodeType} · ${n.label}\n${tokens(n.rollupTokens)} tok · ${usd(n.rollupCost)} (subtree)`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Dot color={m.color} live={live} size={6} />
                <span className="text-[11px] shrink-0" style={{ color: isRoot ? '#ffb000' : '#9aa1ab' }}>
                  {glyph(n.nodeType)}
                </span>
                <span
                  className="flex-1 min-w-0 truncate text-[11.5px]"
                  style={{ color: isRoot ? '#ffb000' : '#e9e7df' }}
                >
                  {n.label}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span
                  className="text-[8.5px] uppercase tracking-wider font-display"
                  style={{ color: m.color, letterSpacing: '0.1em' }}
                >
                  {m.label}
                </span>
                <span className="tnum text-[9.5px] text-faint">
                  {tokens(n.rollupTokens)} · {usd(n.rollupCost)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Build a depth-layered layout from parentId topology, with subtree roll-ups. */
function buildLayout(raw: any[]): { laid: GNode[]; width: number; height: number } {
  if (!raw || raw.length === 0) return { laid: [], width: 0, height: 0 };

  const map = new Map<string, GNode>();
  for (const r of raw) {
    map.set(r.id, {
      id: r.id,
      parentId: r.parentId ?? null,
      nodeType: r.nodeType ?? 'subagent',
      label: r.label ?? r.id,
      status: r.status ?? 'running',
      tokensOut: Number(r.tokensOut) || 0,
      costUsd: Number(r.costUsd) || 0,
      depth: 0,
      rollupCost: Number(r.costUsd) || 0,
      rollupTokens: Number(r.tokensOut) || 0,
      x: 0,
      y: 0,
    });
  }

  // children index (only edges whose parent is present)
  const childrenOf = new Map<string, GNode[]>();
  const roots: GNode[] = [];
  for (const n of map.values()) {
    if (n.parentId && map.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    } else {
      roots.push(n);
    }
  }

  // derive depth from topology (robust to missing/stale depth fields)
  const stack = roots.map((r) => ({ node: r, d: 0 }));
  const seen = new Set<string>();
  while (stack.length) {
    const { node, d } = stack.pop()!;
    if (seen.has(node.id)) continue; // guard against cycles
    seen.add(node.id);
    node.depth = d;
    for (const c of childrenOf.get(node.id) ?? []) stack.push({ node: c, d: d + 1 });
  }
  // any orphans never reached (cycle remnants) get depth 0 fallback
  for (const n of map.values()) if (!seen.has(n.id)) n.depth = 0;

  // subtree roll-ups (post-order over the reachable forest)
  const rollup = (n: GNode, guard: Set<string>): void => {
    if (guard.has(n.id)) return;
    guard.add(n.id);
    let cost = n.costUsd;
    let toks = n.tokensOut;
    for (const c of childrenOf.get(n.id) ?? []) {
      rollup(c, guard);
      cost += c.rollupCost;
      toks += c.rollupTokens;
    }
    n.rollupCost = cost;
    n.rollupTokens = toks;
  };
  for (const r of roots) rollup(r, new Set());

  // group by depth, preserving a stable parent-grouped order
  const order: GNode[] = [];
  const visit = (n: GNode, g: Set<string>) => {
    if (g.has(n.id)) return;
    g.add(n.id);
    order.push(n);
    for (const c of childrenOf.get(n.id) ?? []) visit(c, g);
  };
  const og = new Set<string>();
  for (const r of roots) visit(r, og);
  for (const n of map.values()) if (!og.has(n.id)) order.push(n); // include unreachable

  const cols = new Map<number, GNode[]>();
  let maxDepth = 0;
  for (const n of order) {
    const arr = cols.get(n.depth) ?? [];
    arr.push(n);
    cols.set(n.depth, arr);
    if (n.depth > maxDepth) maxDepth = n.depth;
  }

  // position: depth → column (x), stacked siblings → row (y)
  let maxRows = 0;
  for (let d = 0; d <= maxDepth; d++) {
    const arr = cols.get(d) ?? [];
    arr.forEach((n, i) => {
      n.x = PAD + d * (BOX_W + COL_GAP);
      n.y = PAD + i * (BOX_H + ROW_GAP);
    });
    if (arr.length > maxRows) maxRows = arr.length;
  }

  const width = PAD * 2 + (maxDepth + 1) * BOX_W + maxDepth * COL_GAP;
  const height = PAD * 2 + maxRows * BOX_H + Math.max(0, maxRows - 1) * ROW_GAP;

  return { laid: order, width, height };
}
