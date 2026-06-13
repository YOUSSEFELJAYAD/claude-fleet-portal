/**
 * Real test for web/lib/live.ts buildTree — the pure subtree assembler the UI uses to
 * turn a flat RunNode[] (parentId links) into a nested, startedAt-sorted tree WITHOUT
 * parsing raw CLI JSON. live.ts is a client module (React + ./api imports) but buildTree
 * itself is pure; importing the module in Node is safe (no top-level DOM access).
 */
import { describe, it, expect } from 'vitest';
import { buildTree } from '../../web/lib/live.js';

const node = (id: string, parentId: string | null, startedAt: number): any =>
  ({ id, parentId, startedAt, nodeType: 'subagent', status: 'running' });

describe('buildTree', () => {
  it('nests children under their parent and sorts siblings by startedAt', () => {
    const nodes = [
      node('r', null, 0),
      node('a', 'r', 20),
      node('b', 'r', 10),
      node('g', 'a', 5),
    ];
    const tree: any = buildTree(nodes, 'r')!;
    expect(tree.id).toBe('r');
    expect(tree.children.map((c: any) => c.id)).toEqual(['b', 'a']); // 10 before 20
    const a: any = tree.children.find((c: any) => c.id === 'a')!;
    expect(a.children.map((c: any) => c.id)).toEqual(['g']);
  });

  it('does not mutate the input nodes (operates on copies)', () => {
    const nodes = [node('r', null, 0), node('c', 'r', 1)];
    buildTree(nodes, 'r');
    expect((nodes[0] as any).children).toBeUndefined();
  });

  it('falls back to the parentId===null root when rootId is unknown', () => {
    const nodes = [node('root', null, 0), node('x', 'root', 1)];
    expect(buildTree(nodes, 'nope')!.id).toBe('root');
  });

  it('returns null when no root can be resolved', () => {
    const nodes = [node('x', 'y', 0)]; // no parentId===null, rootId missing
    expect(buildTree(nodes, 'z')).toBeNull();
  });
});
