import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import type { EntraTokenVerifier } from "./entra-token.js";
import { bearer, fail, headerValue } from "./http.js";

export interface Publisher {
  oid: string;
  upn: string;
}

/**
 * With DEV_AUTH=1, trusts X-Publisher-Oid/-Upn when present and falls back to a fixed dev identity when
 * absent, accepting any bearer — exactly today's behaviour, for artifactctl against the local stack.
 *
 * Otherwise (T18), APIM is no longer a trust boundary intake-api relies on: X-Publisher-* headers are never
 * read, even when present, and the caller must present a real Entra access token in `Authorization: Bearer`,
 * which is verified against the tenant's JWKS (issuer, audience, expiry, tenant). The caller identity comes
 * from the token's own claims.
 */
export async function publisher(req: IncomingMessage, cfg: Config, entraVerifier: EntraTokenVerifier | undefined): Promise<Publisher> {
  if (cfg.devAuth) {
    const oid = headerValue(req, "x-publisher-oid")?.trim();
    const upn = headerValue(req, "x-publisher-upn")?.trim();
    if (oid && upn) return { oid, upn };
    return { oid: cfg.devPublisherOid, upn: cfg.devPublisherUpn };
  }
  const token = bearer(req);
  if (!token) fail(401, "missing bearer token (Authorization: Bearer <Entra access token>)");
  if (!entraVerifier) fail(401, "Entra verification is not configured");
  const result = await entraVerifier.verify(token);
  if (!result.ok) fail(401, `invalid token: ${result.reason}`);
  return { oid: result.oid, upn: result.upn };
}
