import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { searchWeb, buildResearchPrompt } from '../src/research.js';

// ── a fake SearXNG that returns canned JSON (or 403 when json is disabled) ──
let server: Server;
let baseUrl = '';
let mode: 'ok' | 'json-403' = 'ok';

beforeEach(async () => {
  mode = 'ok';
  server = createServer((req, res) => {
    if (mode === 'json-403') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html>json format disabled</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      query: 'q',
      results: [
        { title: 'A', url: 'https://a.example', content: 'snippet a', score: 1.5, engine: 'google' },
        { title: 'B', url: 'https://b.example', content: 'snippet b', engine: 'duckduckgo' },
      ],
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('searchWeb', () => {
  it('normalizes SearXNG JSON into WebResult[]', async () => {
    const out = await searchWeb({ searxngUrl: baseUrl, query: 'q', maxResults: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'A', url: 'https://a.example', snippet: 'snippet a', score: 1.5, engine: 'google' });
    // missing score → 0
    expect(out[1].score).toBe(0);
  });

  it('throws a 502 with json-disabled hint on a 403', async () => {
    mode = 'json-403';
    await expect(searchWeb({ searxngUrl: baseUrl, query: 'q' })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws a 502 when SearXNG is unreachable', async () => {
    await expect(searchWeb({ searxngUrl: 'http://127.0.0.1:1', query: 'q' })).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('buildResearchPrompt', () => {
  const results = [
    { title: 'A', url: 'https://a.example', snippet: 'alpha', score: 1, engine: 'google' },
    { title: 'B', url: 'https://b.example', snippet: 'beta', score: 0.5, engine: 'ddg' },
  ];

  it('embeds the topic and every source URL', () => {
    const p = buildResearchPrompt('quantum widgets', results);
    expect(p).toContain('quantum widgets');
    expect(p).toContain('https://a.example');
    expect(p).toContain('https://b.example');
  });

  it('caps the number of embedded sources at 20', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      title: `T${i}`, url: `https://e${i}.example`, snippet: 's', score: 0, engine: 'g',
    }));
    const p = buildResearchPrompt('t', many);
    expect(p).toContain('https://e19.example');
    expect(p).not.toContain('https://e20.example');
  });
});
