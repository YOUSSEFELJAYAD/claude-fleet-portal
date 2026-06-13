/**
 * Web Research (§28) — open-source web search via a self-hosted SearXNG instance.
 * SearXNG exposes a JSON API (`?format=json`, AGPL, no API key). This module owns the
 * client, the synthesis-prompt builder, and the HTTP routes; the synthesis run is spawned
 * through the existing registry.launch path (no engine awareness needed).
 */
import type { FastifyInstance } from 'fastify';
import type { WebResult } from '@fleet/shared';

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
