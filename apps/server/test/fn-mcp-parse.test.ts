/**
 * Real tests for mcp.ts parseMcpList — the pure parser that turns `claude mcp list`
 * human output into structured rows. No spawning; exercises every documented shape.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-mcp-'));

let mcp: typeof import('../src/mcp.js');
beforeAll(async () => { mcp = await import('../src/mcp.js'); });

describe('parseMcpList', () => {
  it('parses "name: detail - ✓ Connected"', () => {
    const [row] = mcp.parseMcpList('memory: /path/to/server - ✓ Connected');
    expect(row).toEqual({ name: 'memory', status: 'connected', detail: '/path/to/server' });
  });

  it('maps "Needs authentication" → needs-auth', () => {
    const [row] = mcp.parseMcpList('figma: cloud - ! Needs authentication');
    expect(row.name).toBe('figma');
    expect(row.status).toBe('needs-auth');
  });

  it('maps a failed/error status → failed', () => {
    const [row] = mcp.parseMcpList('broken: ./x - ✗ Failed to connect');
    expect(row.status).toBe('failed');
  });

  it('handles the "name (status)" parenthetical form', () => {
    const [row] = mcp.parseMcpList('slack (connected)');
    expect(row).toEqual({ name: 'slack', status: 'connected', detail: '' });
  });

  it('handles the "name: status" form (no detail, no separator)', () => {
    const [row] = mcp.parseMcpList('context7: pending');
    expect(row).toEqual({ name: 'context7', status: 'pending', detail: '' });
  });

  it('keeps colons inside a plugin name (splits on the FIRST ": ")', () => {
    const [row] = mcp.parseMcpList('plugin:foo:bar: http://localhost:9 - ✓ Connected');
    expect(row.name).toBe('plugin:foo:bar');
    expect(row.status).toBe('connected');
    expect(row.detail).toBe('http://localhost:9');
  });

  it('keeps dashes in the detail (splits status on the LAST " - ")', () => {
    const [row] = mcp.parseMcpList('srv: https://a-b-c.example.com/x - ✓ Connected');
    expect(row.detail).toBe('https://a-b-c.example.com/x');
    expect(row.status).toBe('connected');
  });

  it('skips preamble/header and blank lines', () => {
    const out = mcp.parseMcpList(
      ['Checking MCP server health…', '', 'No MCP servers configured', 'real: ok - ✓ Connected'].join('\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('real');
  });

  it('returns [] on empty input', () => {
    expect(mcp.parseMcpList('')).toEqual([]);
    expect(mcp.parseMcpList('\n  \n')).toEqual([]);
  });

  it('parses a multi-line listing into multiple rows', () => {
    const rows = mcp.parseMcpList(
      ['a: x - ✓ Connected', 'b: y - ! Needs authentication', 'c: z - ✗ Failed'].join('\n'),
    );
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.status)).toEqual(['connected', 'needs-auth', 'failed']);
  });
});
