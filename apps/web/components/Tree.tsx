'use client';
import React from 'react';
import type { RunNode } from '@fleet/shared';
import { nodeStatusColor } from '@/lib/status';
import { usd, tokens } from '@/lib/format';
import { Dot } from './ui';

const glyph = (t: RunNode['nodeType']) => (t === 'root' ? '◉' : t === 'teammate' ? '⬡' : '⧉');

function NodeRow({
  node,
  selected,
  onSelect,
  depth,
  isLast,
}: {
  node: RunNode;
  selected: string;
  onSelect: (id: string) => void;
  depth: number;
  isLast: boolean;
}) {
  const live = node.status === 'running';
  const color = nodeStatusColor(node.status);
  const on = selected === node.id;
  return (
    <div>
      <div className={depth > 0 ? `branch ${isLast ? 'last' : ''}` : ''} style={{ marginLeft: depth > 0 ? 14 : 0 }}>
        <button
          onClick={() => onSelect(node.id)}
          className="w-full flex items-center gap-2.5 py-1.5 pr-2 pl-2 text-left transition-colors group"
          style={{
            background: on ? 'rgba(255,176,0,0.09)' : 'transparent',
            borderLeft: on ? '2px solid #ffb000' : '2px solid transparent',
          }}
        >
          <Dot color={color} live={live} size={7} />
          <span className="text-[12px]" style={{ color: node.nodeType === 'root' ? '#ffb000' : '#9aa1ab' }}>
            {glyph(node.nodeType)}
          </span>
          <span className="flex-1 min-w-0 truncate font-mono text-[12px]" style={{ color: on ? '#fff' : '#e9e7df' }}>
            {node.label}
          </span>
          <span className="font-mono tnum text-[10px] text-faint group-hover:text-dim shrink-0">
            {tokens(node.tokensOut)} · {usd(node.costUsd)}
          </span>
        </button>
      </div>
      {node.children && node.children.length > 0 && (
        <div style={{ marginLeft: depth > 0 ? 14 : 0 }}>
          {node.children.map((c, i) => (
            <NodeRow
              key={c.id}
              node={c}
              selected={selected}
              onSelect={onSelect}
              depth={depth + 1}
              isLast={i === node.children!.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Tree({
  root,
  selected,
  onSelect,
}: {
  root: RunNode | null;
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (!root) {
    return <div className="font-mono text-[12px] text-faint p-4">awaiting first events…</div>;
  }
  return (
    <div className="py-1">
      <NodeRow node={root} selected={selected} onSelect={onSelect} depth={0} isLast />
    </div>
  );
}
