/**
 * MCP server health (read-only). Shells out to the `claude` binary's `mcp list`
 * subcommand and parses its human-readable output into structured rows. This never
 * spawns a claude SESSION — it only invokes the management subcommand, with a hard
 * timeout, so a hung/missing MCP server can't block the control plane.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_REAL_BIN } from './config.js';

const execFileAsync = promisify(execFile);

export interface McpServer {
  name: string;
  status: string; // connected | needs-auth | failed | pending | <best-effort>
  detail: string;
}

/** Normalize a free-text status fragment into a stable token the UI keys colors off. */
function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase().replace(/[✓✗✔✘!~•·\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'pending';
  if (s.includes('connect') && !s.includes('fail') && !s.includes('not') && !s.includes('disconnect')) return 'connected';
  if (s.includes('fail') || s.includes('error') || s.includes('cannot') || s.includes('unreachable') || s.includes('disconnect'))
    return 'failed';
  if (s.includes('auth') || s.includes('login') || s.includes('token')) return 'needs-auth';
  if (s.includes('pending') || s.includes('connecting') || s.includes('checking') || s.includes('starting')) return 'pending';
  // collapse a short free-text phrase into a single best-effort token
  return s.split(' ').slice(0, 3).join('-');
}

/**
 * Parse `claude mcp list` stdout. Handles the common shapes best-effort:
 *   "name: detail - ✓ Connected"
 *   "name: detail - ! Needs authentication"
 *   "name (status)"
 *   "name: status"
 * Names may themselves contain colons (e.g. plugin:foo:bar); we split on the first
 * ": " (colon + space), since intra-name colons aren't space-separated.
 */
export function parseMcpList(stdout: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // skip headers / preamble (no name:detail structure, ends with … or :)
    if (/^(checking|no mcp|mcp server|available|configured)/i.test(line)) continue;
    if (line.endsWith('…') || line.endsWith('...')) continue;

    let name = '';
    let rest = '';
    const colon = line.indexOf(': ');
    if (colon > 0) {
      name = line.slice(0, colon).trim();
      rest = line.slice(colon + 2).trim();
    } else {
      // "name (status)" form
      const m = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (m) {
        servers.push({ name: m[1].trim(), status: normalizeStatus(m[2]), detail: '' });
      }
      continue;
    }
    if (!name) continue;

    // split detail from trailing status on the LAST " - " (detail/URLs may contain dashes)
    let detail = rest;
    let statusText = '';
    const sep = rest.lastIndexOf(' - ');
    if (sep >= 0) {
      detail = rest.slice(0, sep).trim();
      statusText = rest.slice(sep + 3).trim();
    } else {
      // "name: status" form — the whole rest is the status, no detail
      statusText = rest;
      detail = '';
    }
    servers.push({ name, status: normalizeStatus(statusText), detail });
  }
  return servers;
}

export function registerMcpRoutes(app: FastifyInstance) {
  // GET /api/mcp → { servers, error? }. Always 200; surface failures in the body so the
  // panel can render an error string instead of breaking on a non-2xx.
  app.get('/api/mcp', async () => {
    try {
      const { stdout } = await execFileAsync(CLAUDE_REAL_BIN, ['mcp', 'list'], { timeout: 30000 });
      return { servers: parseMcpList(stdout) };
    } catch (e: any) {
      // execFile rejects on nonzero exit / missing binary / timeout. Some claude builds
      // print the listing to stdout even on a nonzero exit — salvage it if present.
      const salvaged = typeof e?.stdout === 'string' ? parseMcpList(e.stdout) : [];
      if (salvaged.length) return { servers: salvaged };
      const msg =
        e?.code === 'ENOENT'
          ? `claude binary not found (${CLAUDE_REAL_BIN})`
          : e?.killed
            ? 'claude mcp list timed out'
            : (e?.stderr?.toString().trim() || e?.message || 'failed to list MCP servers');
      return { servers: [] as McpServer[], error: msg };
    }
  });

  // GET /api/mcp/:name → raw `claude mcp get <name>` text (detail drill-down).
  app.get('/api/mcp/:name', async (req, reply) => {
    const name = (req.params as any).name as string;
    if (typeof name !== 'string' || !name.trim() || name.length > 200) {
      reply.code(400);
      return { error: 'invalid server name' };
    }
    try {
      const { stdout } = await execFileAsync(CLAUDE_REAL_BIN, ['mcp', 'get', name], { timeout: 15000 });
      return { name, text: stdout };
    } catch (e: any) {
      const msg =
        e?.code === 'ENOENT'
          ? `claude binary not found (${CLAUDE_REAL_BIN})`
          : e?.killed
            ? 'claude mcp get timed out'
            : (e?.stderr?.toString().trim() || e?.stdout?.toString().trim() || e?.message || 'failed to get MCP server');
      return { name, text: '', error: msg };
    }
  });
}
