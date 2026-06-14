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
  },
});
