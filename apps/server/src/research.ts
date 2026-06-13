/**
 * Web Research (§28) — open-source web search via a self-hosted SearXNG instance.
 * SearXNG exposes a JSON API (`?format=json`, AGPL, no API key). This module owns the
 * client, the synthesis-prompt builder, and the HTTP routes; the synthesis run is spawned
 * through the existing registry.launch path (no engine awareness needed).
 */
import type { FastifyInstance } from 'fastify';
import type { WebResult } from '@fleet/shared';
import { registry } from './registry.js';
import { researchConfig } from './addons.js';
import type {
  ResearchSearchRequest, ResearchSearchResponse,
  ResearchSynthesizeRequest, ResearchSynthesizeResponse,
  ResearchStatusResponse,
} from '@fleet/shared';

const SEARCH_TIMEOUT_MS = 15_000;

function httpErr(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** Query a SearXNG instance and normalize its JSON into WebResult[]. */
export async function searchWeb(opts: {
  searxngUrl: string;
  query: string;
  maxResults?: number;
  engines?: string;
  safeSearch?: number;
  language?: string;
}): Promise<WebResult[]> {
  const base = opts.searxngUrl.replace(/\/+$/, '');
  const u = new URL(`${base}/search`);
  u.searchParams.set('q', opts.query);
  u.searchParams.set('format', 'json');
  if (opts.engines) u.searchParams.set('engines', opts.engines);
  if (opts.language) u.searchParams.set('language', opts.language);
  if (opts.safeSearch != null) u.searchParams.set('safesearch', String(opts.safeSearch));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(u, { headers: { accept: 'application/json' }, signal: ctrl.signal });
  } catch {
    throw httpErr(502, `SearXNG unreachable at ${base} — check the Web Research add-on URL or install it`);
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 403) {
    throw httpErr(502, 'SearXNG returned 403 for format=json — enable `json` in its settings.yml `search.formats`');
  }
  if (!r.ok) throw httpErr(502, `SearXNG error ${r.status}`);

  let body: any;
  try {
    body = await r.json();
  } catch {
    throw httpErr(502, 'SearXNG returned a non-JSON body (is json format enabled?)');
  }
  const rows: any[] = Array.isArray(body?.results) ? body.results : [];
  const max = Math.max(1, Math.min(opts.maxResults ?? 10, 20));
  return rows.slice(0, max).map((x) => ({
    title: String(x?.title ?? ''),
    url: String(x?.url ?? ''),
    snippet: String(x?.content ?? ''),
    score: typeof x?.score === 'number' && Number.isFinite(x.score) ? x.score : 0,
    engine: String(x?.engine ?? (Array.isArray(x?.engines) ? x.engines.join(',') : '')),
  }));
}

const MAX_SOURCES = 20;
const MAX_SNIPPET = 500;

/** Build the synthesis prompt: the topic plus the (capped) selected sources. */
export function buildResearchPrompt(topic: string, results: WebResult[]): string {
  const sources = results.slice(0, MAX_SOURCES).map((r, i) => {
    const snippet = r.snippet.length > MAX_SNIPPET ? r.snippet.slice(0, MAX_SNIPPET) + '…' : r.snippet;
    return `[${i + 1}] ${r.title}\n    ${r.url}\n    ${snippet}`;
  }).join('\n\n');
  return [
    `RESEARCH TOPIC: ${topic}`,
    '',
    'You are given web search results below. Synthesize a tight, factual answer to the topic.',
    'Cite sources inline by their [n] number and URL. Cross-check load-bearing claims against a',
    'second source where possible. Distinguish FACT (with citation) from INFERENCE. If the sources',
    'are insufficient, you may use WebFetch/WebSearch to read further, then say what remains open.',
    '',
    'SOURCES:',
    sources || '(none provided)',
  ].join('\n');
}

const RESEARCHER_PROFILE =
  'You are a focused web-research agent. You NEVER modify files. Synthesize a tight, factual, ' +
  'cited answer from the provided sources; cross-check load-bearing claims; distinguish FACT ' +
  '(with citation) from INFERENCE; end with open questions.';

export function registerResearchRoutes(app: FastifyInstance) {
  // Live web search → results for the /research page.
  app.post('/api/research/search', async (req, reply) => {
    const b = (req.body ?? {}) as ResearchSearchRequest;
    if (typeof b.query !== 'string' || !b.query.trim()) {
      return reply.code(400).send({ error: 'query is required' });
    }
    const cfg = researchConfig();
    try {
      const results = await searchWeb({
        searxngUrl: cfg.searxngUrl, query: b.query.trim(),
        maxResults: b.maxResults ?? cfg.maxResults,
        engines: cfg.engines, safeSearch: cfg.safeSearch, language: cfg.language,
      });
      return { query: b.query.trim(), results } satisfies ResearchSearchResponse;
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 502).send({ error: e?.message ?? 'search failed' });
    }
  });

  // Hand selected results to a research agent → spawns a run, returns its id.
  app.post('/api/research/synthesize', async (req, reply) => {
    const b = (req.body ?? {}) as ResearchSynthesizeRequest;
    if (typeof b.topic !== 'string' || !b.topic.trim()) {
      return reply.code(400).send({ error: 'topic is required' });
    }
    const results = Array.isArray(b.results) ? b.results : [];
    const prompt = buildResearchPrompt(b.topic.trim(), results);
    try {
      const run = await registry.launch({
        prompt,
        cwd: b.cwd || process.cwd(),
        model: b.model ?? 'claude-opus-4-8',
        effort: 'high',
        permissionMode: 'default',
        allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        appendSystemPrompt: RESEARCHER_PROFILE,
      });
      return { runId: run.id } satisfies ResearchSynthesizeResponse;
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ error: e?.message ?? 'launch failed' });
    }
  });

  // SearXNG reachability for the page's settings strip.
  app.get('/api/research/status', async () => {
    const cfg = researchConfig();
    const base = cfg.searxngUrl.replace(/\/+$/, '');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const r = await fetch(`${base}/search?q=ping&format=json`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.status === 403) {
        return { ok: false, searxngUrl: base, state: 'json-disabled', detail: 'enable `json` in SearXNG `search.formats`' } satisfies ResearchStatusResponse;
      }
      if (!r.ok) return { ok: false, searxngUrl: base, state: 'unreachable', detail: `SearXNG returned ${r.status}` } satisfies ResearchStatusResponse;
      return { ok: true, searxngUrl: base, state: 'ok', detail: null } satisfies ResearchStatusResponse;
    } catch {
      return { ok: false, searxngUrl: base, state: 'unreachable', detail: `not reachable at ${base}` } satisfies ResearchStatusResponse;
    }
  });
}
