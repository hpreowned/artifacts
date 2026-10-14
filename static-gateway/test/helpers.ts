import { createServer, request as httpRequest, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { GatewayConfig } from '../src/config.js';
import { createHandler, type Clock } from '../src/handler.js';

export const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
export const ARTIFACT_ID = 'abc123def456';
export const OTHER_ID = 'zzz999yyy888';
export const DOMAIN = 'localhost:8081';
export const SHELL = 'http://localhost:8082';
export const NOW = 1_800_000_000;

export interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TestServer {
  config: GatewayConfig;
  serveRoot: string;
  request(opts: { method?: string; path?: string; host?: string; headers?: Record<string, string> }): Promise<Response>;
  close(): Promise<void>;
}

/** Writes a fixture artifact tree under a temp root and starts the gateway on an ephemeral port. */
export async function startGateway(overrides: Partial<GatewayConfig> = {}, clock: Clock = () => NOW): Promise<TestServer> {
  const serveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-'));
  const dir = path.join(serveRoot, ARTIFACT_ID);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>hello</h1>');
  await fs.writeFile(path.join(dir, 'app.js'), 'console.log(1)');
  await fs.writeFile(path.join(dir, 'assets', 'style.css'), 'body{}');
  await fs.writeFile(path.join(dir, 'notes.unknownext'), 'x');
  await fs.writeFile(path.join(serveRoot, 'outside.html'), 'OUTSIDE');
  await fs.symlink(path.join(serveRoot, 'outside.html'), path.join(dir, 'link.html'));

  const config: GatewayConfig = {
    serveRoot,
    artifactDomain: DOMAIN,
    shellOrigin: SHELL,
    viewTokenKey: KEY,
    devInsecureCookies: false,
    sessionTtlSeconds: 86_400,
    port: 0,
    ...overrides,
  };
  const server: Server = createServer((req, res) => {
    createHandler(config, clock)(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    config,
    serveRoot,
    request: ({ method = 'GET', path: p = '/', host = `${ARTIFACT_ID}.${DOMAIN}`, headers = {} }) =>
      new Promise<Response>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method, path: p, headers: { host, ...headers } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const flat: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join('\n') : String(v);
            resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', reject);
        req.end();
      }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(serveRoot, { recursive: true, force: true });
    },
  };
}
