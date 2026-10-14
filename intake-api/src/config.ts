// Every environment variable the API and the dev stack read. Documented in README.md.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB, contracts/findings.md IN-001 and PublishBegin.maxBytes
export const UPLOAD_TTL_SECONDS = 600; // one-time upload token lifetime
export const VIEW_TOKEN_TTL_SECONDS = 300;

export interface Config {
  port: number;
  publicBaseUrl: string;
  shellOrigin: string;
  devAuth: boolean;
  devPublisherOid: string;
  devPublisherUpn: string;
  pipelineToken: string | undefined;
  internalSharedKey: string | undefined;
  viewTokenKey: Buffer;
  backend: "memory" | "azure";
  serveRoot: string;
  approverGroup: string;
  uploadExpirySweepSeconds: number;
  storageAccountUrl: string | undefined;
  containers: { jobs: string; intake: string; serving: string };
  serviceBusFqdn: string | undefined;
  scanQueue: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backend = env.BACKEND === "azure" ? "azure" : "memory";
  const key = env.VIEW_TOKEN_KEY ? Buffer.from(env.VIEW_TOKEN_KEY, "base64") : randomBytes(32);
  if (key.length < 32) throw new Error("VIEW_TOKEN_KEY must decode to at least 32 bytes");
  if (backend === "azure" && !env.STORAGE_ACCOUNT_URL) throw new Error("BACKEND=azure requires STORAGE_ACCOUNT_URL");
  if (backend === "azure" && !env.SERVICEBUS_FQDN) throw new Error("BACKEND=azure requires SERVICEBUS_FQDN");
  return {
    port: int(env.PORT, 8080),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, ""),
    shellOrigin: (env.SHELL_ORIGIN ?? "http://localhost:8082").replace(/\/+$/, ""),
    devAuth: env.DEV_AUTH === "1",
    devPublisherOid: env.DEV_PUBLISHER_OID ?? "dev-oid",
    devPublisherUpn: env.DEV_PUBLISHER_UPN ?? "dev@localhost",
    pipelineToken: env.PIPELINE_TOKEN || undefined,
    internalSharedKey: env.INTERNAL_SHARED_KEY || undefined,
    viewTokenKey: key,
    backend,
    serveRoot: resolve(env.SERVE_ROOT ?? "./.local/serving"),
    approverGroup: env.APPROVER_GROUP ?? "artifacts-approvers",
    uploadExpirySweepSeconds: int(env.UPLOAD_EXPIRY_SWEEP_SECONDS, 60),
    storageAccountUrl: env.STORAGE_ACCOUNT_URL,
    containers: {
      jobs: env.STORAGE_CONTAINER_JOBS ?? "jobs",
      intake: env.STORAGE_CONTAINER_INTAKE ?? "intake",
      serving: env.STORAGE_CONTAINER_SERVING ?? "serving",
    },
    serviceBusFqdn: env.SERVICEBUS_FQDN,
    scanQueue: env.SCAN_QUEUE ?? "scan",
  };
}

export function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
