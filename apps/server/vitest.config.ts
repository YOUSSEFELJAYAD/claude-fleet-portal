import { defineConfig } from 'vitest/config';

// Much of this suite spawns REAL child processes (the claude mock, git, bash, engine bins, the
// compression proxy) and binds real TCP ports. Run fully parallel on a 10-core box, the spawn-heavy
// files starve each other — readiness probes and port teardown miss tight deadlines, and the 32 MiB
// stdout-DoS-guard tests blow past 5s. So: cap parallelism to keep per-test CPU healthy, and give
// generous default timeouts. (Pure/in-memory tests are unaffected — they finish in milliseconds.)
//
// CI runners (GitHub `ubuntu-latest` ≈ 4 cores) are far smaller than the 10-core dev box, so 6 forks
// oversubscribe and starve the event loop badly enough that even a sub-second localhost probe blows
// past 30s (see the flaky SearXNG json-disabled probe). Halve the fork count under CI to match.
const MAX_FORKS = process.env.CI ? 3 : 6;
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: { forks: { maxForks: MAX_FORKS, minForks: 1 } },
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
