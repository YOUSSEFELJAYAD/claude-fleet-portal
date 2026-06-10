/**
 * H6 — local OTLP/HTTP-JSON receiver. Resolves the long-deferred OpenTelemetry item by making
 * the portal a RECEIVER (not just exporter): on spawn we point claude's OTLP exporter at the
 * control plane itself (OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:PORT, protocol http/json),
 * and these routes ingest claude_code.* metrics + logs, correlated by session.id (== runId).
 *
 * This surfaces what stream-json CANNOT: cost/token usage split by query_source (main/subagent/
 * auxiliary) + model, plus tool_decision (accept/reject) events for the A12 overlay.
 *
 * CRITICAL: never select the `console` exporter (it writes to stdout and would corrupt the
 * stream-json channel the parser reads). We use OTLP only, JSON-encoded (no protobuf dep).
 */
import type { FastifyInstance } from 'fastify';

export interface ToolDecision {
  tool: string;
  decision: string; // accept | reject | ...
  source: string; // config | user | ...
  ts: number;
}

export interface SessionOtel {
  sessionId: string;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** per query_source (main | subagent | auxiliary) rollup the single-rate estimate can't produce. */
  bySource: Record<string, { costUsd: number; tokens: number }>;
  byModel: Record<string, { costUsd: number; tokens: number }>;
  linesAdded: number;
  linesRemoved: number;
  toolDecisions: ToolDecision[];
  lastUpdate: number;
}

const store = new Map<string, SessionOtel>();

/** Evict sessions idle this long — the run page stops polling once a run leaves the live set. */
const EVICT_IDLE_MS = 60 * 60 * 1000;
/** Per-session cap on retained decisions (the UI only renders the most recent ones). */
const MAX_TOOL_DECISIONS = 200;

function sweep(now: number) {
  for (const [sid, s] of store) {
    if (now - s.lastUpdate > EVICT_IDLE_MS) store.delete(sid);
  }
}

function blank(sessionId: string): SessionOtel {
  return {
    sessionId,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    bySource: {},
    byModel: {},
    linesAdded: 0,
    linesRemoved: 0,
    toolDecisions: [],
    lastUpdate: 0,
  };
}
function getOrInit(sessionId: string): SessionOtel {
  let s = store.get(sessionId);
  if (!s) {
    s = blank(sessionId);
    store.set(sessionId, s);
  }
  return s;
}

export function getOtel(sessionId: string): SessionOtel | null {
  return store.get(sessionId) ?? null;
}

/** Read an OTLP KeyValue list into a plain {key: value} map (string/int/double/bool). */
function attrsToMap(attributes: any[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const a of attributes ?? []) {
    if (!a || typeof a.key !== 'string') continue;
    const v = a.value ?? {};
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
  }
  return out;
}
const dpNum = (dp: any): number =>
  dp?.asDouble !== undefined ? Number(dp.asDouble) : dp?.asInt !== undefined ? Number(dp.asInt) : 0;
const tokenBucket = (type: string): keyof SessionOtel['tokens'] | null => {
  const t = (type || '').toLowerCase();
  if (t === 'input') return 'input';
  if (t === 'output') return 'output';
  if (t.includes('cacheread') || t === 'cache_read') return 'cacheRead';
  if (t.includes('cachecreation') || t === 'cache_creation') return 'cacheCreation';
  return null;
};

/**
 * Ingest an OTLP/JSON ExportMetricsServiceRequest. Delta temporality assumed (claude exports
 * delta), so values ACCUMULATE. Correlates each datapoint by its session.id attribute.
 * Returns the set of session ids touched. Defensive: tolerates partial/unknown shapes.
 */
export function ingestMetrics(body: any, now: number): Set<string> {
  sweep(now);
  const touched = new Set<string>();
  for (const rm of body?.resourceMetrics ?? []) {
    const resAttrs = attrsToMap(rm?.resource?.attributes ?? []);
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const metric of sm?.metrics ?? []) {
        const name: string = metric?.name ?? '';
        const dps: any[] = metric?.sum?.dataPoints ?? metric?.gauge?.dataPoints ?? [];
        for (const dp of dps) {
          const attrs = { ...resAttrs, ...attrsToMap(dp?.attributes ?? []) };
          const sid = String(attrs['session.id'] ?? attrs['session_id'] ?? resAttrs['session.id'] ?? '');
          if (!sid) continue;
          const s = getOrInit(sid);
          const val = dpNum(dp);
          const source = String(attrs['query_source'] ?? attrs['source'] ?? 'main');
          const model = String(attrs['model'] ?? 'unknown');
          if (name === 'claude_code.cost.usage') {
            s.costUsd += val;
            (s.bySource[source] ??= { costUsd: 0, tokens: 0 }).costUsd += val;
            (s.byModel[model] ??= { costUsd: 0, tokens: 0 }).costUsd += val;
          } else if (name === 'claude_code.token.usage') {
            const bucket = tokenBucket(String(attrs['type'] ?? ''));
            if (bucket) s.tokens[bucket] += val;
            (s.bySource[source] ??= { costUsd: 0, tokens: 0 }).tokens += val;
            (s.byModel[model] ??= { costUsd: 0, tokens: 0 }).tokens += val;
          } else if (name === 'claude_code.lines_of_code.count') {
            const t = String(attrs['type'] ?? '');
            if (t === 'added') s.linesAdded += val;
            else if (t === 'removed') s.linesRemoved += val;
          }
          s.lastUpdate = now;
          touched.add(sid);
        }
      }
    }
  }
  return touched;
}

/** Ingest OTLP/JSON logs — claude emits tool_decision (and api_error) as log records. */
export function ingestLogs(body: any, now: number): Set<string> {
  sweep(now);
  const touched = new Set<string>();
  for (const rl of body?.resourceLogs ?? []) {
    const resAttrs = attrsToMap(rl?.resource?.attributes ?? []);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const attrs = { ...resAttrs, ...attrsToMap(rec?.attributes ?? []) };
        const sid = String(attrs['session.id'] ?? attrs['session_id'] ?? '');
        if (!sid) continue;
        const eventName = String(attrs['event.name'] ?? rec?.body?.stringValue ?? '');
        if (eventName.includes('tool_decision')) {
          const s = getOrInit(sid);
          s.toolDecisions.push({
            tool: String(attrs['tool_name'] ?? 'unknown'),
            decision: String(attrs['decision'] ?? 'unknown'),
            source: String(attrs['source'] ?? ''),
            ts: now,
          });
          if (s.toolDecisions.length > MAX_TOOL_DECISIONS) s.toolDecisions.shift();
          s.lastUpdate = now;
          touched.add(sid);
        }
      }
    }
  }
  return touched;
}

export function registerOtelRoutes(app: FastifyInstance) {
  // OTLP/HTTP-JSON ingest endpoints (claude's exporter POSTs here). Always 200 OK with the
  // OTLP partial-success empty body so the exporter doesn't treat it as a failure + retry-storm.
  app.post('/v1/metrics', async (req, reply) => {
    try {
      ingestMetrics(req.body, Date.now());
    } catch {
      /* tolerate malformed payloads */
    }
    reply.header('content-type', 'application/json');
    return {};
  });
  app.post('/v1/logs', async (req, reply) => {
    try {
      ingestLogs(req.body, Date.now());
    } catch {
      /* ignore */
    }
    reply.header('content-type', 'application/json');
    return {};
  });

  // Read the accumulated telemetry for a run (session.id === runId).
  app.get('/api/agents/:id/otel', async (req) => {
    const id = (req.params as any).id;
    return getOtel(id) ?? { sessionId: id, empty: true };
  });
}
