import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A run whose child exits non-zero with stderr must surface that stderr as run.error (H5).
// Use a tiny stub "claude" that writes to stderr and exits 1 — faithfully simulates a real
// claude failure (bad flag/model) without spending tokens, and exercises MY onExit wiring.
const dataDir = mkdtempSync(join(tmpdir(), 'fleet-fail-'));
const stub = join(dataDir, 'fail-claude.mjs');
writeFileSync(stub, '#!/usr/bin/env node\nprocess.stderr.write("claude: error: unknown model \\"bogus\\"\\n");\nprocess.exit(1);\n');
chmodSync(stub, 0o755);
process.env.FLEET_DATA_DIR = dataDir;
process.env.CLAUDE_BIN = stub;

let registry: any;
beforeAll(async () => {
  ({ registry } = await import('../src/registry.js'));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('failed run surfaces stderr as run.error (H5 integration)', () => {
  it('captures the child stderr cause instead of a bare status=failed', async () => {
    const run = registry.launch({
      prompt: 'hi',
      cwd: dataDir,
      model: 'bogus',
      effort: 'medium',
      permissionMode: 'default',
    });

    let r: any;
    for (let i = 0; i < 80; i++) {
      await sleep(50);
      r = registry.getRun(run.id);
      if (r && ['failed', 'completed', 'killed'].includes(r.status)) break;
    }
    expect(r?.status).toBe('failed');
    expect(r?.error).toContain('unknown model');
  });
});
