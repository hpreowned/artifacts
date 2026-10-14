import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import { fail, headerValue } from "./http.js";

export interface Publisher {
  oid: string;
  upn: string;
}

/**
 * APIM validates the Entra token and forwards the caller as X-Publisher-Oid / X-Publisher-Upn; intake trusts only
 * those headers. With DEV_AUTH=1 the headers are still honoured when present, and a fixed dev identity is used
 * when they are absent so artifactctl works against the local stack without any auth setup.
 */
export function publisher(req: IncomingMessage, cfg: Config): Publisher {
  const oid = headerValue(req, "x-publisher-oid")?.trim();
  const upn = headerValue(req, "x-publisher-upn")?.trim();
  if (oid && upn) return { oid, upn };
  if (cfg.devAuth) return { oid: cfg.devPublisherOid, upn: cfg.devPublisherUpn };
  return fail(401, "missing X-Publisher-Oid / X-Publisher-Upn (set by APIM)");
}
