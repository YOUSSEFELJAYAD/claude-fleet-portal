import { defineConfig } from 'vitest/config';

// Much of this suite spawns REAL child processes (the claude mock, git, bash, engine bins, the
// compression proxy) and binds real TCP ports. Run fully parallel on a 10-core box, the spawn-heavy
// files starve each other — readiness probes and port teardown miss tight deadlines, and the 32 MiB
// stdout-DoS-guard tests blow past 5s. So: cap parallelism to keep per-test CPU healthy, and give
// generous default timeouts. (Pure/in-memory tests are unaffected — they finish in milliseconds.)
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: { forks: { maxForks: 6, minForks: 1 } },
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
