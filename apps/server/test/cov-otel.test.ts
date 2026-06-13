/**
 * Coverage test for src/otel.ts targeting the uncovered branches:
 *   - attrsToMap intValue / doubleValue / boolValue paths (lines 81-83)
 *   - tokenBucket cacheRead / cacheCreation / null paths (lines 93-96)
 *   - claude_code.lines_of_code.count added/removed (lines 130-133)
 *   - registerOtelRoutes POST /v1/metrics, POST /v1/logs, GET /api/agents/:id/otel (lines 177-198)
 *
 * Pure-function tests import otel directly. The HTTP route tests drive the REAL fastify app via
 * buildServer().inject() against an isolated DB (FLEET_DATA_DIR set BEFORE importing any src module).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLEET_DATA_DIR = mkdtempSync(join(tmpdir(), 'fleet-test-cov-otel-'));
process.env.CLAUDE_REAL_BIN = '/nonexistent/fleet-fake-claude-otel';

import { ingestMetrics, ingestLogs, getOtel } from '../src/otel.js';

describe('attrsToMap value-type branches (lines 80-83)', () => {
  it('reads intValue, doubleValue, boolValue, and stringValue from resource attributes', () => {
    // session.id arrives as a resource-level attribute; type-coded data point attrs cover the
    // intValue (-> Number), doubleValue, and boolValue branches that stringValue alone never hit.
    const sid = 'cov-attrs-1';
    const touched = ingestMetrics(
      {
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: 'session.id', value: { stringValue: sid } },
                // boolValue branch (carried into attrs map but not consumed downstream — still exercises line 83)
                { key: 'telemetry.sdk.enabled', value: { boolValue: true } },
                // attribute with no recognised value variant -> skipped (no out[key])
                { key: 'empty.attr', value: {} },
                // malformed entries: null, and key that isn't a string -> `continue` (line 78)
                null,
                { key: 42, value: { stringValue: 'x' } },
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.cost.usage',
                    sum: {
                      dataPoints: [
                        {
                          // doubleValue branch on a data-point attribute (line 82)
                          attributes: [{ key: 'rate', value: { doubleValue: 1.5 } }],
                          asDouble: 0.25,
                        },
                      ],
                    },
                  },
                  {
                    name: 'claude_code.token.usage',
                    sum: {
                      dataPoints: [
                        {
                          // intValue branch: Number('5000') === 5000 (line 81)
                          attributes: [
                            { key: 'count_hint', value: { intValue: '5000' } },
                            { key: 'type', value: { stringValue: 'input' } },
                          ],
                          asInt: '300',
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      5_000,
    );
    expect(touched.has(sid)).toBe(true);
    const o = getOtel(sid)!;
    // cost from the doubleValue-attr datapoint, tokens from the intValue-attr datapoint
    expect(o.costUsd).toBeCloseTo(0.25, 6);
    expect(o.tokens.input).toBe(300);
  });
});

describe('tokenBucket cacheRead / cacheCreation / unknown (lines 93-96)', () => {
  const sid = 'cov-buckets-1';
  it('routes cacheRead, cache_read, cacheCreation, cache_creation, and ignores unknown type', () => {
    const tokenMetric = (type: string, asInt: string) => ({
      name: 'claude_code.token.usage',
      sum: {
        dataPoints: [
          {
            asInt,
            attributes: [
              { key: 'session.id', value: { stringValue: sid } },
              { key: 'type', value: { stringValue: type } },
            ],
          },
        ],
      },
    });
    ingestMetrics(
      {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  tokenMetric('cacheRead', '11'), // t.includes('cacheread') -> cacheRead (line 93)
                  tokenMetric('cache_read', '7'), // t === 'cache_read' -> cacheRead (line 93)
                  tokenMetric('cacheCreation', '13'), // includes('cachecreation') -> cacheCreation (line 94)
                  tokenMetric('cache_creation', '4'), // t === 'cache_creation' -> cacheCreation (line 94)
                  tokenMetric('totallyUnknownType', '999'), // -> null bucket (line 95), not counted in any tokens.* field
                ],
              },
            ],
          },
        ],
      },
      6_000,
    );
    const o = getOtel(sid)!;
    expect(o.tokens.cacheRead).toBe(18); // 11 + 7
    expect(o.tokens.cacheCreation).toBe(17); // 13 + 4
    // unknown type contributes nothing to the typed buckets...
    expect(o.tokens.input).toBe(0);
    expect(o.tokens.output).toBe(0);
    // ...but the per-source rollup still added every datapoint's value (5 datapoints, default 'main')
    expect(o.bySource.main.tokens).toBe(11 + 7 + 13 + 4 + 999);
  });
});

describe('claude_code.lines_of_code.count added/removed (lines 129-133)', () => {
  const sid = 'cov-loc-1';
  it('accumulates linesAdded for type=added and linesRemoved for type=removed; ignores other types', () => {
    const loc = (type: string, asInt: string) => ({
      name: 'claude_code.lines_of_code.count',
      sum: {
        dataPoints: [
          {
            asInt,
            attributes: [
              { key: 'session.id', value: { stringValue: sid } },
              { key: 'type', value: { stringValue: type } },
            ],
          },
        ],
      },
    });
    ingestMetrics(
      {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  loc('added', '40'),
                  loc('added', '2'),
                  loc('removed', '9'),
                  loc('modified', '500'), // neither branch -> no-op (covers the else-not-taken path)
                ],
              },
            ],
          },
        ],
      },
      7_000,
    );
    const o = getOtel(sid)!;
    expect(o.linesAdded).toBe(42); // 40 + 2
    expect(o.linesRemoved).toBe(9);
  });
});

describe('ingest correlation edge cases', () => {
  it('skips datapoints with no resolvable session id', () => {
    const touched = ingestMetrics(
      {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.cost.usage',
                    sum: { dataPoints: [{ asDouble: 9.99, attributes: [] }] },
                  },
                ],
              },
            ],
          },
        ],
      },
      8_000,
    );
    expect(touched.size).toBe(0);
  });

  it('reads session id from gauge dataPoints and the session_id alias', () => {
    const sid = 'cov-gauge-1';
    ingestMetrics(
      {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.cost.usage',
                    gauge: {
                      dataPoints: [
                        { asDouble: 0.5, attributes: [{ key: 'session_id', value: { stringValue: sid } }] },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      8_500,
    );
    expect(getOtel(sid)!.costUsd).toBeCloseTo(0.5, 6);
  });
});

describe('ingestLogs edge cases', () => {
  it('reads event name from rec.body.stringValue and skips non-tool_decision records', () => {
    const sid = 'cov-logs-1';
    ingestLogs(
      {
        resourceLogs: [
          {
            resource: { attributes: [{ key: 'session.id', value: { stringValue: sid } }] },
            scopeLogs: [
              {
                logRecords: [
                  // event name carried in the record body, not an attribute
                  { body: { stringValue: 'claude_code.tool_decision' }, attributes: [
                    { key: 'tool_name', value: { stringValue: 'Edit' } },
                    { key: 'decision', value: { stringValue: 'reject' } },
                    { key: 'source', value: { stringValue: 'user' } },
                  ] },
                  // api_error log -> ignored (not a tool_decision)
                  { attributes: [{ key: 'event.name', value: { stringValue: 'claude_code.api_error' } }] },
                  // no session id resolvable AND no event -> skipped
                  { attributes: [] },
                ],
              },
            ],
          },
        ],
      },
      9_000,
    );
    const o = getOtel(sid)!;
    expect(o.toolDecisions).toHaveLength(1);
    expect(o.toolDecisions[0]).toMatchObject({ tool: 'Edit', decision: 'reject', source: 'user', ts: 9_000 });
  });
});

// ---- HTTP route tests via the REAL fastify app (lines 176-199) ----

let app: any;
let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, headers: HOST(), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST() });

beforeAll(async () => {
  const cfg = await import('../src/config.js');
  PORT = cfg.PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

describe('registerOtelRoutes — POST /v1/metrics (lines 176-184)', () => {
  it('ingests a metrics body, returns 200 + {} JSON, and the data is readable via GET', async () => {
    const sid = 'route-metrics-1';
    const res = await post('/v1/metrics', {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: sid } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.cost.usage',
                  sum: { dataPoints: [{ asDouble: 0.33, attributes: [{ key: 'model', value: { stringValue: 'claude-opus-4-8' } }] }] },
                },
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [
                      { asInt: '1500', attributes: [{ key: 'type', value: { stringValue: 'input' } }] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({});

    const read = await get(`/api/agents/${sid}/otel`);
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.sessionId).toBe(sid);
    expect(body.costUsd).toBeCloseTo(0.33, 6);
    expect(body.tokens.input).toBe(1500);
    expect(body.byModel['claude-opus-4-8'].costUsd).toBeCloseTo(0.33, 6);
  });

  it('tolerates a malformed metrics body (caught), still 200 + {}', async () => {
    // resourceMetrics is a non-iterable scalar; the for..of loop throws and the route catch swallows it.
    const res = await post('/v1/metrics', { resourceMetrics: 12345 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
});

describe('registerOtelRoutes — POST /v1/logs (lines 185-193)', () => {
  it('ingests a tool_decision log and surfaces it via GET /api/agents/:id/otel', async () => {
    const sid = 'route-logs-1';
    const res = await post('/v1/logs', {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: sid } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'claude_code.tool_decision' } },
                    { key: 'tool_name', value: { stringValue: 'Bash' } },
                    { key: 'decision', value: { stringValue: 'accept' } },
                    { key: 'source', value: { stringValue: 'config' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({});

    const read = await get(`/api/agents/${sid}/otel`);
    const body = read.json();
    expect(body.toolDecisions).toHaveLength(1);
    expect(body.toolDecisions[0]).toMatchObject({ tool: 'Bash', decision: 'accept', source: 'config' });
  });

  it('tolerates a malformed logs body (caught), still 200 + {}', async () => {
    // resourceLogs is a non-iterable scalar; the for..of loop throws -> route catch swallows it (line 189-190).
    const res = await post('/v1/logs', { resourceLogs: 99999 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
});

describe('registerOtelRoutes — GET /api/agents/:id/otel (lines 196-198)', () => {
  it('returns the empty sentinel for a session that has no telemetry', async () => {
    const res = await get('/api/agents/never-seen-session/otel');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 'never-seen-session', empty: true });
  });
});
