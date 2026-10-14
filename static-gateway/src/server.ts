import { createServer } from 'node:http';
import { configFromEnv } from './config.js';
import { createHandler } from './handler.js';

const config = configFromEnv();
const handler = createHandler(config);

const server = createServer((req, res) => {
  handler(req, res).catch((err: unknown) => {
    process.stderr.write(`request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal error');
    } else {
      res.destroy();
    }
  });
});

server.listen(config.port, () => {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), msg: 'static-gateway listening', port: config.port, artifactDomain: config.artifactDomain }) + '\n',
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
