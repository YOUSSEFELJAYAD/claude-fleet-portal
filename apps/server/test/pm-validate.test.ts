import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB before any src module (→ config.js) loads.
process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-pmval-'));

let validateCard: any;
let brokerConfigFor: any;
const dirs: string[] = [];

function tmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `fleet-pmval-${label}-`));
  dirs.push(d);
  return d;
}

// Minimal Project / KanbanTask shapes — validateCard only reads validation/server fields.
function project(patch: Record<string, any> = {}): any {
  return { defaultValidationCommand: null, serverStartCommand: null, healthCheckUrl: null, healthCheckRegex: null, readinessTimeoutMs: null, portRangeStart: null, portRangeEnd: null, copyEnvFrom: null, ...patch };
}
function card(patch: Record<string, any> = {}): any {
  return { validationCommand: null, serverStartCommand: null, healthCheckUrl: null, healthCheckRegex: null, ...patch };
}

beforeAll(async () => {
  ({ validateCard, brokerConfigFor } = await import('../src/pm.js'));
});
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── pure (non-server) path — v1 behavior preserved ──────────────────────────────
describe('validateCard — pure checks (no server-start command)', () => {
  it('no validation command → pass (nothing to check)', async () => {
    const vr = await validateCard(tmp('a'), project(), card());
    expect(vr.ok).toBe(true);
  });
  it('a passing pure command (exit 0) → ok', async () => {
    const vr = await validateCard(tmp('b'), project(), card({ validationCommand: 'true' }));
    expect(vr.ok).toBe(true);
  });
  it('a failing pure command (exit 1) → not ok, output captured', async () => {
    const vr = await validateCard(tmp('c'), project(), card({ validationCommand: 'echo boom >&2; exit 1' }));
    expect(vr.ok).toBe(false);
    expect(vr.output ?? '').toContain('boom');
  });
});

// ── server path — routed through the port broker ────────────────────────────────
describe('validateCard — server-style validation via the port broker', () => {
  it('starts the server, default health probe passes, validation runs against the live port → ok', async () => {
    const wt = tmp('srv');
    const startCmd =
      'node -e "require(\'http\').createServer((q,r)=>{r.statusCode=200;r.end(\'ok\')}).listen(process.env.PORT)"';
    const vr = await validateCard(
      wt,
      project({ serverStartCommand: startCmd, readinessTimeoutMs: 8000 }),
      card({ validationCommand: 'true' }),
    );
    expect(vr.ok).toBe(true);
  }, 20000);

  it('per-card serverStartCommand overrides the project; failing check against the live server → not ok', async () => {
    const wt = tmp('srvfail');
    const startCmd =
      'node -e "require(\'http\').createServer((q,r)=>{r.statusCode=200;r.end(\'ok\')}).listen(process.env.PORT)"';
    const vr = await validateCard(
      wt,
      project({ serverStartCommand: 'exit 0' }), // project would not serve; card override wins
      card({ serverStartCommand: startCmd, validationCommand: 'exit 3' }),
    );
    expect(vr.ok).toBe(false);
  }, 20000);
});

// ── brokerConfigFor mapping — per-card overrides only the 3 card fields ──────────
describe('brokerConfigFor — merges card overrides over project defaults', () => {
  it('card overrides serverStartCommand/healthCheckUrl/healthCheckRegex; rest inherit from project', () => {
    const cfg = brokerConfigFor(
      card({ serverStartCommand: 'card-start', healthCheckUrl: 'http://card/health', healthCheckRegex: null }),
      project({
        serverStartCommand: 'proj-start',
        healthCheckUrl: 'http://proj/health',
        healthCheckRegex: 'ready',
        readinessTimeoutMs: 5000,
        portRangeStart: 4000,
        portRangeEnd: 4100,
        copyEnvFrom: '/tmp/.env',
      }),
      'pnpm test',
    );
    expect(cfg.serverStartCommand).toBe('card-start'); // card override
    expect(cfg.healthCheckUrl).toBe('http://card/health'); // card override
    expect(cfg.healthCheckRegex).toBe('ready'); // card null → inherit project
    expect(cfg.validationCommand).toBe('pnpm test');
    expect(cfg.readinessTimeoutMs).toBe(5000); // inherited
    expect(cfg.portRangeStart).toBe(4000);
    expect(cfg.portRangeEnd).toBe(4100);
    expect(cfg.copyEnvFrom).toBe('/tmp/.env');
  });
});
