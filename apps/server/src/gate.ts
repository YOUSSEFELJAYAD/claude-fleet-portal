import { randomUUID } from 'node:crypto';
import { GATE_TTL_MS } from './config.js';

export interface GateAnswer { selection: string[]; text?: string }
export interface PendingGate {
  id: string;
  sessionId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  createdAt: number;
  answer: Promise<GateAnswer>;
}
interface GateInternal extends PendingGate {
  resolve: (a: GateAnswer) => void;
  reject: (e: Error) => void;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

const gates = new Map<string, GateInternal>();
const MAX_GATES = 64; // runaway guard, mirrors inbox pendingApprovals

export function enqueueGate(input: {
  sessionId: string; question: string; options: string[]; multiSelect: boolean; allowFreeText: boolean;
}): PendingGate {
  let resolve!: (a: GateAnswer) => void;
  let reject!: (e: Error) => void;
  const answer = new Promise<GateAnswer>((res, rej) => { resolve = res; reject = rej; });
  const g: GateInternal = {
    id: randomUUID(), createdAt: Date.now(), answer, resolve, reject,
    sessionId: input.sessionId, question: input.question, options: input.options,
    multiSelect: input.multiSelect, allowFreeText: input.allowFreeText,
  };
  answer.catch(() => {}); // avoid unhandled-rejection if no one awaits before a reject
  gates.set(g.id, g);
  if (gates.size > MAX_GATES) {
    const oldest = [...gates.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) { clearTimeout(oldest.ttlTimer); oldest.reject(new Error('gate evicted (queue full)')); gates.delete(oldest.id); }
  }
  const ttlTimer = setTimeout(() => resolveGate(g.id, { selection: [] }), GATE_TTL_MS);
  ttlTimer.unref?.();
  g.ttlTimer = ttlTimer;
  return g;
}

export function listGates(): PendingGate[] { return [...gates.values()]; }

export function resolveGate(id: string, answer: GateAnswer): void {
  const g = gates.get(id);
  if (!g) return;
  clearTimeout(g.ttlTimer);
  gates.delete(id);
  g.resolve(answer);
}

export function rejectGatesForSession(sessionId: string, reason: string): void {
  for (const g of [...gates.values()]) {
    if (g.sessionId === sessionId) { clearTimeout(g.ttlTimer); gates.delete(g.id); g.reject(new Error(reason)); }
  }
}

export function __clearGatesForTests(): void {
  for (const g of gates.values()) { clearTimeout(g.ttlTimer); g.reject(new Error('cleared')); }
  gates.clear();
}
