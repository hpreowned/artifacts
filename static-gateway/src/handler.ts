import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { artifactIdFromHost } from './artifact-host.js';
import type { GatewayConfig } from './config.js';
import { applySecurityHeaders } from './headers.js';
import { signToken, verifyToken } from './signed-token.js';
import { resolveArtifactFile } from './static-files.js';

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Unix seconds; injectable so tests can move the clock. */
export type Clock = () => number;

export function createHandler(config: GatewayConfig, now: Clock = () => Math.floor(Date.now() / 1000)): Handler {
  const cookieName = config.devInsecureCookies ? 'session' : '__Host-session';

  function sessionCookie(artifactId: string): string {
    const token = signToken(config.viewTokenKey, { t: 'session', aid: artifactId, exp: now() + config.sessionTtlSeconds });
    // Production: the cookie must travel with requests from inside the shell's cross-site iframe, so it is
    // SameSite=None and Partitioned (keyed to the shell as the top-level site). See README "Cookie".
    return config.devInsecureCookies
      ? `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/`
      : `${cookieName}=${token}; Secure; HttpOnly; SameSite=None; Path=/; Partitioned`;
  }

  function hasValidSession(req: IncomingMessage, artifactId: string): boolean {
    const raw = readCookie(req.headers.cookie, cookieName);
    if (!raw) return false;
    const payload = verifyToken(config.viewTokenKey, raw, now());
    return payload !== null && payload['t'] === 'session' && payload['aid'] === artifactId;
  }

  return async (req, res) => {
    // 0. The kubelet probe (deploy/platform/static-gateway.yaml) sends no artifact Host at all, so this
    // must answer before rule 1 parses one, with any Host header or none. Never falls through to the
    // file server below, even for a Host that resolves to a real, live artifact.
    if ((req.url ?? '/').split('?')[0] === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return void res.end(JSON.stringify({ ok: true }));
    }

    applySecurityHeaders(res, config.shellOrigin);

    // 1. Host → artifact id.
    const artifactId = artifactIdFromHost(req.headers.host, config.artifactDomain);
    if (!artifactId) return text(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return text(res, 405, 'Method not allowed');
    }

    const url = new URL(req.url ?? '/', 'http://placeholder');

    // 2. One-shot view token → session cookie → same path without `t`. This runs BEFORE the top-level
    // check: a browser sends Sec-Fetch-Dest: document for an iframe load too, so a token-bearing request
    // is the shell's frame doing exactly what it should, whatever the destination header says.
    const t = url.searchParams.get('t');
    if (t !== null) {
      const payload = verifyToken(config.viewTokenKey, t, now());
      if (payload && payload['t'] === 'view' && payload['aid'] === artifactId) {
        url.searchParams.delete('t');
        res.setHeader('Set-Cookie', sessionCookie(artifactId));
        return redirect(res, url.pathname + url.search);
      }
    }

    // 3. A real top-level load (address bar, pasted link) goes to the shell; the raw origin renders only
    // inside the shell's iframe. Sec-Fetch-Dest alone cannot tell the two apart — both say "document" —
    // so require Sec-Fetch-Site too: a frame load from the shell is cross-site, a typed URL is none.
    // Requests that carry a valid session cookie are already inside the frame and are left alone.
    const dest = String(req.headers['sec-fetch-dest'] ?? '').toLowerCase();
    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    const topLevel = dest === 'document' && (site === '' || site === 'none');
    if (topLevel && !hasValidSession(req, artifactId)) {
      return redirect(res, `${config.shellOrigin}/view/${artifactId}`);
    }

    // 4. Otherwise a valid session cookie for this artifact is required.
    if (!hasValidSession(req, artifactId)) {
      return html(res, 403, forbiddenPage(config.shellOrigin, artifactId));
    }

    // 5. Serve the file.
    const file = await resolveArtifactFile(config.serveRoot, artifactId, url.pathname);
    if (!file) return text(res, 404, 'Not found');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.statusCode = 200;
    if (req.method === 'HEAD') return void res.end();
    await new Promise<void>((resolve) => {
      const stream = createReadStream(file.absolutePath);
      stream.on('error', () => {
        if (!res.headersSent) res.statusCode = 500;
        res.destroy();
        resolve();
      });
      stream.on('close', resolve);
      stream.pipe(res);
    });
  };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Content-Length', '0');
  res.end();
}

function text(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function forbiddenPage(shellOrigin: string, artifactId: string): string {
  const link = `${shellOrigin}/view/${artifactId}`;
  return (
    '<!doctype html><meta charset="utf-8"><title>Open through the viewer</title>' +
    '<p>This artifact only renders inside the viewer shell. Open the link you were given: ' +
    `<a href="${link}">${link}</a></p>`
  );
}
