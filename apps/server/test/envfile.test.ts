import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync, existsSync, rmSync } from 'node:fs';
import { parseEnv, serializeEnv, readMap, upsert, del, load } from '../src/envfile.js';

const paths: string[] = [];
function tmp() { const p = join(tmpdir(), `fleet-env-${Math.floor(performance.now() * 1000)}-${paths.length}.env`); paths.push(p); return p; }
afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });

describe('envfile', () => {
  it('parses and serializes a round-trip, quoting values with spaces', () => {
    const map = { A: '1', B: 'has space', C: 'plain' };
    const text = serializeEnv(map);
    expect(text).toContain('A=1');
    expect(text).toContain('B="has space"');
    expect(parseEnv(text)).toEqual(map);
  });

  it('upsert preserves other keys; del removes one', () => {
    const p = tmp();
    upsert(p, 'X', 'one'); upsert(p, 'Y', 'two');
    expect(readMap(p)).toEqual({ X: 'one', Y: 'two' });
    upsert(p, 'X', 'changed');
    expect(readMap(p).X).toBe('changed');
    del(p, 'Y');
    expect(readMap(p)).toEqual({ X: 'changed' });
  });

  it('writes the file with 0600 permissions', () => {
    const p = tmp();
    upsert(p, 'SECRET', 'shh');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('readMap returns {} when the file is absent', () => {
    expect(readMap(tmp())).toEqual({});
  });

  it('load sets process.env without overriding an already-set var', () => {
    const p = tmp();
    upsert(p, 'FLEET_TEST_NEW', 'fromfile');
    upsert(p, 'FLEET_TEST_EXISTING', 'fromfile');
    process.env.FLEET_TEST_EXISTING = 'fromshell';
    delete process.env.FLEET_TEST_NEW;
    load(p);
    expect(process.env.FLEET_TEST_NEW).toBe('fromfile');
    expect(process.env.FLEET_TEST_EXISTING).toBe('fromshell'); // shell wins
    delete process.env.FLEET_TEST_NEW; delete process.env.FLEET_TEST_EXISTING;
  });
});
