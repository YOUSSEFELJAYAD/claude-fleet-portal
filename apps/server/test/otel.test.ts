import { describe, it, expect } from 'vitest';
import { ingestMetrics, ingestLogs, getOtel } from '../src/otel.js';

const metricsPayload = (sid: string) => ({
  resourceMetrics: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scopeMetrics: [
        {
          metrics: [
            {
              name: 'claude_code.cost.usage',
              sum: {
                aggregationTemporality: 1,
                dataPoints: [
                  { asDouble: 0.05, attributes: [{ key: 'session.id', value: { stringValue: sid } }, { key: 'model', value: { stringValue: 'claude-opus-4-8' } }, { key: 'query_source', value: { stringValue: 'main' } }] },
                  { asDouble: 0.02, attributes: [{ key: 'session.id', value: { stringValue: sid } }, { key: 'model', value: { stringValue: 'claude-haiku-4-5' } }, { key: 'query_source', value: { stringValue: 'subagent' } }] },
                ],
              },
            },
            {
              name: 'claude_code.token.usage',
              sum: {
                dataPoints: [
                  { asInt: '1000', attributes: [{ key: 'session.id', value: { stringValue: sid } }, { key: 'type', value: { stringValue: 'input' } }, { key: 'query_source', value: { stringValue: 'main' } }] },
                  { asInt: '200', attributes: [{ key: 'session.id', value: { stringValue: sid } }, { key: 'type', value: { stringValue: 'output' } }] },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

describe('OTLP receiver (H6)', () => {
  it('accumulates cost/tokens per session, source, and model', () => {
    ingestMetrics(metricsPayload('sess-otel-1'), 1000);
    const o = getOtel('sess-otel-1')!;
    expect(o.costUsd).toBeCloseTo(0.07, 6);
    expect(o.tokens.input).toBe(1000);
    expect(o.tokens.output).toBe(200);
    expect(o.bySource.main.costUsd).toBeCloseTo(0.05, 6);
    expect(o.bySource.subagent.costUsd).toBeCloseTo(0.02, 6);
    expect(Object.keys(o.byModel)).toContain('claude-opus-4-8');
  });

  it('delta temporality accumulates across repeated exports', () => {
    ingestMetrics(metricsPayload('sess-otel-2'), 1);
    ingestMetrics(metricsPayload('sess-otel-2'), 2);
    expect(getOtel('sess-otel-2')!.costUsd).toBeCloseTo(0.14, 6); // 0.07 × 2
  });

  it('parses tool_decision from logs (A12 data)', () => {
    ingestLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      { key: 'session.id', value: { stringValue: 'sess-otel-3' } },
                      { key: 'event.name', value: { stringValue: 'claude_code.tool_decision' } },
                      { key: 'tool_name', value: { stringValue: 'Bash' } },
                      { key: 'decision', value: { stringValue: 'accept' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      1,
    );
    expect(getOtel('sess-otel-3')!.toolDecisions[0]).toMatchObject({ tool: 'Bash', decision: 'accept' });
  });

  it('returns null for an unknown session', () => {
    expect(getOtel('nope')).toBeNull();
  });
});
