import { createServer } from 'node:http';
import { DevAuthenticator, MsalAuthenticator, type Authenticator } from './auth.js';
import { configFromEnv } from './config.js';
import { createHandler } from './handler.js';
import { HttpIntakeClient } from './intake-client.js';
import { createMsalClient } from './msal.js';

const config = configFromEnv();

let auth: Authenticator;
if (config.devAuth) {
  process.stderr.write('WARNING: DEV_AUTH=1 — Entra sign-in is disabled; every viewer is "dev-viewer". Local development only.\n');
  auth = new DevAuthenticator();
} else {
  auth = new MsalAuthenticator(createMsalClient(config.entra!), {
    redirectUri: `${config.shellOrigin}/auth/callback`,
    sessionKey: config.sessionKey!,
    sessionTtlSeconds: config.sessionTtlSeconds,
    devInsecureCookies: config.devInsecureCookies,
  });
}

const handler = createHandler({
  config,
  intake: new HttpIntakeClient(config.intakeInternalUrl, config.internalSharedKey),
  auth,
  audit: (line) => process.stdout.write(line + '\n'),
});

const server = createServer((req, res) => {
  handler(req, res).catch((err: unknown) => {
    process.stderr.write(`request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('The viewer could not reach the artifact service. Try again shortly.');
    } else {
      res.destroy();
    }
  });
});

server.listen(config.port, process.env.HOST ?? "0.0.0.0", () => {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg: 'viewer-shell listening', port: config.port, devAuth: config.devAuth }) + '\n');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
