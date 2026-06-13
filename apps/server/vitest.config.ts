import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Make placeholder module exports (Slices 03/05/06) writable so loops-core.test.ts can
    // property-reassign stubs on their namespaces (vite-node defines them as getter-only by
    // default; configurable:true lets us redefine them as writable values in a setup file).
    setupFiles: ['./test/setup-loop-stubs.ts'],
  },
});
