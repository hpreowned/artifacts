import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authenticator } from './auth.js';
import type { ShellConfig } from './config.js';
import type { IntakeClient } from './intake-client.js';
import { renderMessagePage, renderViewerPage, shellHeaders } from './page.js';

export interface HandlerDeps {
  config: ShellConfig;
  intake: IntakeClient;
  auth: Authenticator;
  /** Receives one JSON line per view; production writes it to stdout. */
  audit: (line: string) => void;
  now?: () => Date;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const VIEW_PATH = /^\/view\/([a-z0-9]{12})$/;

export function createHandler(deps: HandlerDeps): Handler {
  const { config, intake, auth, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const headers = shellHeaders(config);

  function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.end(body);
  }

  function redirect(res: ServerResponse, location: string, setCookie?: string): void {
    res.statusCode = 302;
    res.setHeader('Location', location);
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    res.setHeader('Content-Length', '0');
    res.end();
  }

  return async (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    const url = new URL(req.url ?? '/', 'http://placeholder');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');

    if (url.pathname === '/auth/callback') {
      const outcome = await auth.callback(req, url);
      if (outcome.kind === 'signed-in') return redirect(res, outcome.location, outcome.setCookie);
      return send(res, outcome.status, renderMessagePage('Sign-in problem', outcome.message));
    }

    const match = VIEW_PATH.exec(url.pathname);
    if (!match) return send(res, 404, renderMessagePage('Not found', 'There is nothing at this address.'));
    const artifactId = match[1] as string;

    const who = await auth.authenticate(req, url.pathname);
    if (who.kind === 'redirect') return redirect(res, who.location);

    const grant = await intake.createViewToken(artifactId, who.oid);
    if (!grant) return send(res, 404, renderMessagePage('Artifact not available', 'This artifact is not live. It may have expired, been rejected, or never existed.'));

    audit(JSON.stringify({ ts: now().toISOString(), viewerOid: who.oid, artifactId, userAgent: String(req.headers['user-agent'] ?? '') }));

    const iframeSrc = `${config.artifactScheme}://${artifactId}.${config.artifactDomain}/?t=${encodeURIComponent(grant.token)}`;
    const page = renderViewerPage(grant.artifactExpiresAt ? { artifactId, iframeSrc, expiresAt: grant.artifactExpiresAt } : { artifactId, iframeSrc });
    return send(res, 200, page);
  };
}
