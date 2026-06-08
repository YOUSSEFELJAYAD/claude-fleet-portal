import { buildServer } from './server.js';
import { HOST, PORT, CLAUDE_BIN, DB_PATH } from './config.js';

const app = buildServer();

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
