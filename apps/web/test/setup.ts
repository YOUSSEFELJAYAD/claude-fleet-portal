/**
 * Web test harness setup. jsdom has no EventSource, so we install a controllable fake on the
 * global. It is NOT a behavioral mock of the hooks — it's the transport. Tests feed it real
 * server-shaped JSON frames and assert the hooks' actual reducer logic (state transitions).
 */
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0; // CONNECTING
  closed = false;
  onopen: ((e?: any) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e?: any) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; this.readyState = 2; }

  // ── test drivers ──────────────────────────────────────────────────────────
  emitOpen() { this.readyState = 1; this.onopen?.({}); }
  emit(data: unknown) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  emitError() { this.onerror?.({}); }

  static last(): FakeEventSource { return FakeEventSource.instances[FakeEventSource.instances.length - 1]; }
  static reset() { FakeEventSource.instances = []; }
}

(globalThis as any).EventSource = FakeEventSource;

beforeEach(() => FakeEventSource.reset());
afterEach(() => cleanup());
