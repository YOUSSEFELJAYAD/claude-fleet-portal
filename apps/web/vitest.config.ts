import { defineConfig } from 'vitest/config';
import path from 'path';

// Test harness for the pure + hook logic in apps/web/lib. jsdom gives the hooks a DOM +
// React render target; a fake EventSource (test/setup.ts) drives the SSE reducers for real.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // Exclude queueMicrotask and setImmediate from faked timers.
    // queueMicrotask: React 18 uses it for synchronous state flush (scheduleMicrotask →
    //   flushSyncCallbacks). Faking it defers React renders until the next clock tick.
    // setImmediate: React 18's scheduler uses it to batch/schedule concurrent work.
    //   Faking it causes an infinite loop inside act() when waitFor advances fake timers
    //   (React keeps pushing work into the act queue via scheduleCallback → actQueue.push).
    fakeTimers: {
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    },
  },
});
