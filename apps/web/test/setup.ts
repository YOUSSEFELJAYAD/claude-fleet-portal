/**
 * Web test harness setup. jsdom has no EventSource, so we install a controllable fake on the
 * global. It is NOT a behavioral mock of the hooks — it's the transport. Tests feed it real
 * server-shaped JSON frames and assert the hooks' actual reducer logic (state transitions).
 */
import { afterEach, beforeEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// waitFor compatibility fixes for vitest + React 18 + fake timers:
//
// Problem 1 — asyncWrapper drain phase hangs:
//   @testing-library/react's asyncWrapper creates a fake setTimeout(0) after
//   waitFor resolves and only fires it via jest.advanceTimersByTime(0). vitest
//   does not expose a `jest` global, so jestFakeTimersAreEnabled() returns false
//   and the drain timer never fires, hanging the test.
//
// Problem 2 — act() in advanceTimersWrapper causes an infinite loop:
//   When fake timers are "detected" (via jest global), the advanceTimersWrapper
//   wraps each jest.advanceTimersByTime call in React's act(). act() then loops
//   over ReactCurrentActQueue with real setImmediate callbacks, which conflicts
//   with React 18's scheduler and never terminates.
//
// Fix: override both asyncWrapper and unstable_advanceTimersWrapper:
//   - asyncWrapper skips the problematic drain phase entirely; IS_REACT_ACT_ENVIRONMENT
//     is still set to false so React updates can flow without act() complaints.
//   - unstable_advanceTimersWrapper calls the callback directly (no act wrapping).
//
// React DOM mutations still reach MutationObserver callbacks (microtasks) via the
// real setImmediate that React's scheduler captured at module-load time, so waitFor
// correctly sees the updated DOM on the next poll cycle.
configure({
  asyncWrapper: async (cb: () => Promise<unknown>) => {
    const prevEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      return await cb();
    } finally {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevEnv;
    }
  },
  unstable_advanceTimersWrapper: (cb: () => unknown) => cb(),
});

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
