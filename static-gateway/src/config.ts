import { keyFromEnv } from './signed-token.js';

export interface GatewayConfig {
  /** Directory holding one sub-directory per artifact id (local path or the Blob CSI mount). */
  serveRoot: string;
  /** Registrable domain the artifact origins hang off, with port in local dev (e.g. `localhost:8081`). */
  artifactDomain: string;
  /** Origin of the viewer shell, e.g. `https://artifacts.corp.com`. */
  shellOrigin: string;
  /** Raw HMAC key shared with intake-api. */
  viewTokenKey: Buffer;
  /** When true the session cookie is `session` without `Secure` (local http only). */
  devInsecureCookies: boolean;
  /** Session cookie lifetime in seconds. */
  sessionTtlSeconds: number;
  port: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const shellOrigin = required(env, 'SHELL_ORIGIN').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(shellOrigin)) throw new Error('SHELL_ORIGIN must be an origin (scheme://host[:port])');
  return {
    serveRoot: required(env, 'SERVE_ROOT'),
    artifactDomain: required(env, 'ARTIFACT_DOMAIN').toLowerCase(),
    shellOrigin,
    viewTokenKey: keyFromEnv('VIEW_TOKEN_KEY', env),
    devInsecureCookies: env['DEV_INSECURE_COOKIES'] === '1',
    sessionTtlSeconds: 86_400,
    port: Number(env['PORT'] ?? 8081),
  };
}
