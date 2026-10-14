import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readCookie } from './cookies.js';
import { signToken, verifyToken } from './signed-token.js';

export type AuthOutcome = { kind: 'viewer'; oid: string } | { kind: 'redirect'; location: string };
export type CallbackOutcome = { kind: 'signed-in'; location: string; setCookie: string } | { kind: 'error'; status: number; message: string };

export interface Authenticator {
  /** Who is viewing, or where to send them to sign in. `returnTo` is the path to come back to. */
  authenticate(req: IncomingMessage, returnTo: string): Promise<AuthOutcome>;
  /** Handles `GET /auth/callback`. */
  callback(req: IncomingMessage, url: URL): Promise<CallbackOutcome>;
}

/** DEV_AUTH=1: no sign-in at all; every request is oid `dev-viewer`. Never deploy this. */
export class DevAuthenticator implements Authenticator {
  static readonly OID = 'dev-viewer';
  async authenticate(): Promise<AuthOutcome> {
    return { kind: 'viewer', oid: DevAuthenticator.OID };
  }
  async callback(): Promise<CallbackOutcome> {
    return { kind: 'error', status: 404, message: 'No sign-in callback in DEV_AUTH mode' };
  }
}

/** The slice of `ConfidentialClientApplication` the shell uses; `src/msal.ts` builds the real one, tests pass a fake. */
export interface AuthCodeClient {
  getAuthCodeUrl(req: { scopes: string[]; redirectUri: string; state?: string; nonce?: string }): Promise<string>;
  acquireTokenByCode(req: { scopes: string[]; redirectUri: string; code: string; nonce?: string }): Promise<{ uniqueId?: string; idTokenClaims?: object }>;
}

export interface MsalAuthenticatorOptions {
  redirectUri: string;
  sessionKey: Buffer;
  sessionTtlSeconds: number;
  devInsecureCookies: boolean;
  now?: () => number;
}

const SCOPES = ['openid', 'profile'];
const STATE_TTL_SECONDS = 600;
const RETURN_TO = /^\/view\/[a-z0-9]{12}$/;

/** Entra auth-code flow. Session = signed `{t:"shell",oid,exp}` in an HttpOnly cookie; OAuth state = signed `{t:"state",rt,n,exp}`. */
export class MsalAuthenticator implements Authenticator {
  readonly cookieName: string;
  private readonly now: () => number;

  constructor(private readonly client: AuthCodeClient, private readonly opts: MsalAuthenticatorOptions) {
    this.cookieName = opts.devInsecureCookies ? 'shell' : '__Host-shell';
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async authenticate(req: IncomingMessage, returnTo: string): Promise<AuthOutcome> {
    const raw = readCookie(req.headers.cookie, this.cookieName);
    const session = raw ? verifyToken(this.opts.sessionKey, raw, this.now()) : null;
    if (session && session['t'] === 'shell' && typeof session['oid'] === 'string' && session['oid']) {
      return { kind: 'viewer', oid: session['oid'] };
    }
    const nonce = randomBytes(16).toString('base64url');
    const rt = RETURN_TO.test(returnTo) ? returnTo : '/';
    const state = signToken(this.opts.sessionKey, { t: 'state', rt, n: nonce, exp: this.now() + STATE_TTL_SECONDS });
    const location = await this.client.getAuthCodeUrl({ scopes: SCOPES, redirectUri: this.opts.redirectUri, state, nonce });
    return { kind: 'redirect', location };
  }

  async callback(_req: IncomingMessage, url: URL): Promise<CallbackOutcome> {
    const error = url.searchParams.get('error');
    if (error) return { kind: 'error', status: 401, message: `Sign-in failed: ${error}` };
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return { kind: 'error', status: 400, message: 'Missing code or state' };
    const st = verifyToken(this.opts.sessionKey, state, this.now());
    if (!st || st['t'] !== 'state' || typeof st['rt'] !== 'string' || typeof st['n'] !== 'string') {
      return { kind: 'error', status: 400, message: 'Invalid or expired sign-in state' };
    }
    let oid: string | undefined;
    try {
      const result = await this.client.acquireTokenByCode({ scopes: SCOPES, redirectUri: this.opts.redirectUri, code, nonce: st['n'] });
      const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
      oid = typeof claims['oid'] === 'string' ? claims['oid'] : result.uniqueId;
    } catch (err) {
      return { kind: 'error', status: 401, message: `Sign-in failed: ${err instanceof Error ? err.message : 'token exchange error'}` };
    }
    if (!oid) return { kind: 'error', status: 401, message: 'Sign-in failed: no oid claim' };
    const token = signToken(this.opts.sessionKey, { t: 'shell', oid, exp: this.now() + this.opts.sessionTtlSeconds });
    const setCookie = this.opts.devInsecureCookies
      ? `${this.cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/`
      : `${this.cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/`;
    return { kind: 'signed-in', location: RETURN_TO.test(st['rt']) ? st['rt'] : '/', setCookie };
  }
}
