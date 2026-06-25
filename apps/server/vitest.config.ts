import { defineConfig } from 'vitest/config';
import os from 'node:os';

// Much of this suite spawns REAL child processes (the claude mock, git, bash, engine bins, the
// compression proxy) and binds real TCP ports. When forks oversubscribe cores, the spawn-heavy
// files starve each other — readiness probes and port teardown miss tight deadlines, and tests
// using fixed delays flake. Measured on a 10-core box: maxForks 6 starved them (≈9 failures/run)
// and even cores/3 still flaked under load, so use ~cores/4 for real headroom — scaled to the host
// (and down to CI runners with fewer cores), with generous default timeouts. (Pure/in-memory tests
// finish in milliseconds, unaffected.)
const maxForks = Math.max(2, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 4));
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: { forks: { maxForks, minForks: 1 } },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // index.ts is the process entry point (binds the port, installs signal handlers, calls
      // listen()); its logic runs through buildServer(), which the integration tests exercise.
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
