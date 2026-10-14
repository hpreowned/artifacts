import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Authenticator } from '../src/auth.js';
import { DevAuthenticator } from '../src/auth.js';
import type { ShellConfig } from '../src/config.js';
import { createHandler } from '../src/handler.js';
import { FakeIntakeClient, type ViewTokenGrant } from '../src/intake-client.js';

export const ARTIFACT_ID = 'abc123def456';
export const SESSION_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
export const NOW = 1_800_000_000;
export const GRANT: ViewTokenGrant = { token: 'eyJ0IjoidmlldyJ9.c2ln', expiresAt: '2027-01-01T00:05:00.000Z' };

export const baseConfig: ShellConfig = {
  port: 0,
  shellOrigin: 'http://localhost:8082',
  artifactDomain: 'localhost:8081',
  artifactScheme: 'http',
  intakeInternalUrl: 'http://localhost:8080',
  internalSharedKey: 'test-shared-key',
  devAuth: true,
  entra: null,
  sessionKey: null,
  devInsecureCookies: false,
  sessionTtlSeconds: 8 * 3600,
};

export interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TestShell {
  intake: FakeIntakeClient;
  audit: string[];
  request(opts: { method?: string; path?: string; headers?: Record<string, string> }): Promise<Response>;
  close(): Promise<void>;
}

export async function startShell(opts: { config?: Partial<ShellConfig>; auth?: Authenticator; grants?: Record<string, ViewTokenGrant> } = {}): Promise<TestShell> {
  const config = { ...baseConfig, ...opts.config };
  const intake = new FakeIntakeClient(opts.grants ?? { [ARTIFACT_ID]: GRANT });
  const audit: string[] = [];
  const handler = createHandler({ config, intake, auth: opts.auth ?? new DevAuthenticator(), audit: (l) => audit.push(l), now: () => new Date(NOW * 1000) });
  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    intake,
    audit,
    request: ({ method = 'GET', path = '/', headers = {} }) => rawRequest(port, method, path, headers),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function rawRequest(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join('\n') : String(v);
        resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
