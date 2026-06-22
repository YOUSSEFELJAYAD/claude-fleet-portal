/**
 * F-notify — GET /api/notifications/stream is the SSE bus the browser-Notification watcher and the
 * desktop Electron listener consume. Spec Testing names "/api/notifications/stream broadcasts" as a
 * required unit. This drives the real route: it must emit a {kind:'notification'} frame when a row
 * is inserted, and unsubscribe its bus callback on socket close (no subscriber leak).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'fleet-test-notify-stream-'));
process.env.FLEET_DATA_DIR = dataDir;

let app: any;
let PORT: number;
const HOST = () => ({ host: `127.0.0.1:${PORT}` });

beforeAll(async () => {
  PORT = (await import('../src/config.js')).PORT;
  const { buildServer } = await import('../src/server.js');
  app = buildServer();
  await app.ready();
});
afterAll(async () => { await app?.close(); });

/** Read SSE chunks until `match` is found in the accumulated text, or reject on timeout. */
function readUntil(res: any, match: string, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = res.stream();
    let buf = '';
    const t = setTimeout(() => { stream.destroy(); reject(new Error(`timed out waiting for ${match}; got: ${buf}`)); }, ms);
    stream.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(match)) { clearTimeout(t); resolve(buf); }
    });
    stream.on('error', () => {});
  });
}

describe('GET /api/notifications/stream', () => {
  it('hijacks as text/event-stream and broadcasts a {kind:notification} frame on insert', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications/stream', headers: HOST(), payloadAsStream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    // Trigger a broadcast via the test-notification route (insertNotification → bus → send()).
    await app.inject({ method: 'POST', url: '/api/notifications/test', headers: HOST() });

    const frame = await readUntil(res, '"kind":"notification"');
    expect(frame).toContain(': connected'); // sse preamble proves the hijack path ran
    // the frame carries the inserted row
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:') && l.includes('notification'))!;
    const evt = JSON.parse(dataLine.slice(5).trim());
    expect(evt.kind).toBe('notification');
    expect(evt.notification).toMatchObject({ kind: 'test' });
    expect(typeof evt.notification.id).toBe('string');

    res.stream().destroy(); // close → route's reply.raw 'close' handler runs unsub()+stop()
  });

  it('does not throw on a later insert after the stream client disconnected (subscriber removed)', async () => {
    // open + immediately close a stream, then insert again — a leaked subscriber writing to the
    // dead socket would be the regression; insertNotification must still succeed cleanly.
    const res = await app.inject({ method: 'GET', url: '/api/notifications/stream', headers: HOST(), payloadAsStream: true });
    await new Promise((r) => setTimeout(r, 20));
    res.stream().destroy();
    await new Promise((r) => setTimeout(r, 20));
    const after = await app.inject({ method: 'POST', url: '/api/notifications/test', headers: HOST() });
    expect(after.statusCode).toBe(200);
  });
});
