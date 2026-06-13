/**
 * Managed `.env` I/O for the settings panel (§31). Pure, path-parameterized (no config import,
 * so envboot can use it before config.ts evaluates). Values are written with 0600 perms.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const needsQuote = (v: string) => /[\s="#']/.test(v) || v === '';

export function parseEnv(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    map[key] = val;
  }
  return map;
}

export function serializeEnv(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${needsQuote(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v}`)
    .join('\n') + '\n';
}

export function readMap(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try { return parseEnv(readFileSync(path, 'utf8')); } catch { return {}; }
}

function write(path: string, map: Record<string, string>): void {
  writeFileSync(path, serializeEnv(map), { mode: 0o600 });
}

export function upsert(path: string, key: string, value: string): void {
  const map = readMap(path); map[key] = value; write(path, map);
}

export function del(path: string, key: string): void {
  const map = readMap(path); delete map[key]; write(path, map);
}

/** Load managed values into process.env WITHOUT overriding anything already set (shell wins). */
export function load(path: string): void {
  const map = readMap(path);
  for (const [k, v] of Object.entries(map)) if (process.env[k] === undefined) process.env[k] = v;
}
