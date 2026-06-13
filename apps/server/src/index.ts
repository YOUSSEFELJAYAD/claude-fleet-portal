import './envboot.js'; // §31 — load managed .env BEFORE config.ts freezes env at import
import { buildServer } from './server.js';
import { HOST, PORT, CLAUDE_BIN, DB_PATH } from './config.js';
import { registry } from './registry.js';
import { repo } from './db.js';

const app = buildServer();

// H4 — graceful shutdown: kill live claude child process groups (detached → would
// otherwise keep spending), stop accepting connections, then checkpoint + close sqlite.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[fleet] ${signal} received — shutting down…`);
  registry.shutdown();
  try {
    await app.close();
  } catch {
    /* ignore */
  }
  repo.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

app
  .listen({ host: HOST, port: PORT })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(
      `[fleet] control plane → http://${HOST}:${PORT}\n` +
        `[fleet] claude binary: ${CLAUDE_BIN}\n` +
        `[fleet] sqlite: ${DB_PATH}`,
    );
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[fleet] failed to start:', err);
    process.exit(1);
  });
