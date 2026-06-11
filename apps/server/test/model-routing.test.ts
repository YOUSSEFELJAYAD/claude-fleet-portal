import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CLAUDE_MODELS, engineForModel, MODELS } from '@fleet/shared';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-model-routing-'));
process.env.FLEET_DATA_DIR = DATA_DIR;

const binDir = mkdtempSync(join(tmpdir(), 'fleet-fake-opencode-routing-'));
const FAKE_OPENCODE_BIN = join(binDir, 'opencode');
writeFileSync(
  FAKE_OPENCODE_BIN,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('opencode 0.6.0'); process.exit(0); }
process.stdout.write(JSON.stringify({ type: 'text', part: { text: process.cwd() } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 2 } } }) + '\\n');
process.exit(0);
`,
);
chmodSync(FAKE_OPENCODE_BIN, 0o755);
process.env.OPENCODE_BIN = FAKE_OPENCODE_BIN;

let app: any;
let PORT: number;
let registry: typeof import('../src/registry.js').registry;
let repo: typeof import('../src/db.js').repo;

const H = () => ({ host: `127.0.0.1:${PORT}` });

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'fleet-engine-worktree-repo-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fleet@test.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fleet Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function waitTerminal(runId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = registry.getRun(runId) ?? repo.getRun(runId);
    if (run && ['completed', 'failed', 'killed'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not become terminal`);
}

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  ({ registry } = await import('../src/registry.js'));
  ({ repo } = await import('../src/db.js'));
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
  const enabled = await app.inject({ method: 'POST', url: '/api/addons/opencode/enable', headers: H() });
  expect(enabled.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  delete process.env.OPENCODE_BIN;
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('shared model catalog helpers', () => {
  it('maps catalog model ids to their execution engine', () => {
    expect(engineForModel('claude-opus-4-8')).toBe('claude');
    expect(engineForModel('gpt-5-codex')).toBe('codex');
    expect(engineForModel('anthropic/claude-sonnet-4-5')).toBe('opencode');
    expect(engineForModel('unknown-model-id')).toBe('claude');
  });

  it('CLAUDE_MODELS excludes engine add-on models', () => {
    expect(CLAUDE_MODELS.every((m) => !m.engine || m.engine === 'claude')).toBe(true);
    expect(CLAUDE_MODELS.some((m) => m.id === 'gpt-5-codex')).toBe(false);
    expect(MODELS.some((m) => m.engine === 'codex')).toBe(true);
    expect(MODELS.some((m) => m.engine === 'opencode')).toBe(true);
  });
});

describe('registry model routing', () => {
  it('auto-routes an opencode catalog model and creates the requested worktree for the engine cwd', async () => {
    const root = makeGitRepo();
    const wtName = 'agent-engine-wt';
    const run = await registry.launch({
      prompt: 'run in worktree',
      cwd: root,
      worktree: wtName,
      model: 'anthropic/claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'default',
      interactive: false,
    });
    const final = await waitTerminal(run.id);
    const wtDir = join(root, '.claude', 'worktrees', wtName);

    expect(final.status).toBe('completed');
    expect(final.engine).toBe('opencode');
    expect(final.model).toBe('anthropic/claude-sonnet-4-5');
    expect(final.cwd).toBe(wtDir);
    expect(final.resultText).toBe(realpathSync(wtDir));
    expect(existsSync(wtDir)).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});
