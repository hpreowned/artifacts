import { keyFromEnv } from './signed-token.js';

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface ShellConfig {
  port: number;
  /** This app's own origin, e.g. `https://artifacts.corp.com`; the share URL is `<SHELL_ORIGIN>/view/<id>`. */
  shellOrigin: string;
  /** Registrable domain of artifact origins, e.g. `corp-artifacts.net` or `localhost:8081`. */
  artifactDomain: string;
  /** `https` in production, `http` for the local dev stack. */
  artifactScheme: 'https' | 'http';
  /** In-cluster base URL of intake-api, e.g. `http://intake.artifacts-system.svc:8080`. */
  intakeInternalUrl: string;
  /** Value sent as `X-Internal-Caller` to intake-api. */
  internalSharedKey: string;
  /** `DEV_AUTH=1`: no Entra; every viewer is oid `dev-viewer`. */
  devAuth: boolean;
  /** Present only when devAuth is false. */
  entra: EntraConfig | null;
  /** Raw key signing the shell's own session cookie and OAuth state. Present only when devAuth is false. */
  sessionKey: Buffer | null;
  /** When true the session cookie is `shell` without `Secure` (local http only). */
  devInsecureCookies: boolean;
  sessionTtlSeconds: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ShellConfig {
  const shellOrigin = required(env, 'SHELL_ORIGIN').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(shellOrigin)) throw new Error('SHELL_ORIGIN must be an origin (scheme://host[:port])');
  const scheme = env['ARTIFACT_SCHEME'] ?? 'https';
  if (scheme !== 'https' && scheme !== 'http') throw new Error('ARTIFACT_SCHEME must be https or http');
  const devAuth = env['DEV_AUTH'] === '1';
  return {
    port: Number(env['PORT'] ?? 8082),
    shellOrigin,
    artifactDomain: required(env, 'ARTIFACT_DOMAIN').toLowerCase(),
    artifactScheme: scheme,
    intakeInternalUrl: required(env, 'INTAKE_INTERNAL_URL').replace(/\/+$/, ''),
    internalSharedKey: required(env, 'INTERNAL_SHARED_KEY'),
    devAuth,
    entra: devAuth
      ? null
      : { tenantId: required(env, 'ENTRA_TENANT_ID'), clientId: required(env, 'ENTRA_CLIENT_ID'), clientSecret: required(env, 'ENTRA_CLIENT_SECRET') },
    sessionKey: devAuth ? null : keyFromEnv('SHELL_SESSION_KEY', env),
    devInsecureCookies: env['DEV_INSECURE_COOKIES'] === '1',
    sessionTtlSeconds: 8 * 3600,
  };
}
