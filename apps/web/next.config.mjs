/** @type {import('next').NextConfig} */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLEET_API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@fleet/shared'],
  env: { NEXT_PUBLIC_FLEET_API: FLEET_API },
  // Desktop packaging only (FLEET_STANDALONE=1): emit the self-contained server bundle the
  // Electron shell forks. Conditional because `next start` (start.sh / pnpm start) does not
  // run with `output: 'standalone'`.
  ...(process.env.FLEET_STANDALONE
    ? { output: 'standalone', experimental: { outputFileTracingRoot: repoRoot } }
    : {}),
};

export default nextConfig;
