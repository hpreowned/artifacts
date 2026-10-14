// Configuration from environment variables. Documented in cli/README.md.

export class UsageError extends Error {}

export interface Config {
  /** Base URL of the intake API (through APIM in production, http://localhost:8080 in dev). */
  apiUrl: string;
  /** Bearer for beginPublish/getPublishStatus: an Entra token in production, any value in dev. */
  token: string;
  /** Dev only: intake accepts the caller identity from X-Publisher-Oid / X-Publisher-Upn. */
  devOid: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiUrl = (env.ARTIFACTS_API_URL || "http://localhost:8080").replace(/\/+$/, "");
  const devOid = env.ARTIFACTS_DEV_OID || undefined;
  let token = env.ARTIFACTS_TOKEN || undefined;
  if (!token) {
    if (devOid) token = "dev";
    else throw new UsageError("ARTIFACTS_TOKEN is not set (set ARTIFACTS_DEV_OID to use the local dev stack without one)");
  }
  return { apiUrl, token, devOid };
}
