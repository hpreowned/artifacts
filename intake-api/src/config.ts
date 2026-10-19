// Every environment variable the API, the worker and the dev stack read. Documented in README.md.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "./repo-root.js";

export const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB, contracts/findings.md IN-001 and PublishBegin.maxBytes
export const UPLOAD_TTL_SECONDS = 600; // one-time upload token lifetime
export const VIEW_TOKEN_TTL_SECONDS = 300;

export interface WorkerConfig {
  gitleaksBin: string;
  pythonBin: string;
  importsScript: string;
  runtimeManifestPath: string;
  defenderTimeoutSeconds: number;
  defenderPollSeconds: number;
  defenderFakeMalicious: Set<string>;
  gcIntervalSeconds: number;
  /** `manual`: nothing deploys by itself; an operator plays the pipeline (scripts/play-node-pipeline.sh). */
  pipelineTrigger: "fake" | "ado" | "manual";
  /** `pipelineId` is the python-tier run; `nodePipelineId` (`ADO_NODE_PIPELINE_ID`) is `artifact-node-deploy`'s.
   *  Static jobs never trigger a pipeline, so neither is read for them. Tier-based selection between the two
   *  happens inside the trigger implementation (scanner/src/pipeline.ts), not here. */
  ado: { org: string | undefined; project: string | undefined; pipelineId: string | undefined; nodePipelineId: string | undefined };
  /** Where the fake pipeline posts its awaiting_approval callback. */
  intakeInternalUrl: string;
  /** D16 approval policy: `policy` | `always-human` | `always-auto` (env APPROVAL_MODE). */
  approvalPolicy: "policy" | "always-human" | "always-auto";
}

export interface Config {
  port: number;
  publicBaseUrl: string;
  shellOrigin: string;
  devAuth: boolean;
  devPublisherOid: string;
  devPublisherUpn: string;
  /** Required when devAuth is false; beginPublish/getPublishStatus verify the caller's Entra token against these. */
  entraTenantId: string | undefined;
  entraAudience: string | undefined;
  entraRequiredScope: string | undefined;
  pipelineToken: string | undefined;
  internalSharedKey: string | undefined;
  viewTokenKey: Buffer;
  backend: "memory" | "disk" | "azure";
  serveRoot: string;
  /** BACKEND=disk: where job records and bundles live (one process, survives restarts). */
  dataRoot: string;
  approverGroup: string;
  uploadExpirySweepSeconds: number;
  storageAccountUrl: string | undefined;
  containers: { jobs: string; intake: string; serving: string };
  serviceBusFqdn: string | undefined;
  scanQueue: string;
  worker: WorkerConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backend = env.BACKEND === "azure" ? "azure" : env.BACKEND === "disk" ? "disk" : "memory";
  const key = env.VIEW_TOKEN_KEY ? Buffer.from(env.VIEW_TOKEN_KEY, "base64") : randomBytes(32);
  if (key.length < 32) throw new Error("VIEW_TOKEN_KEY must decode to at least 32 bytes");
  if (backend === "azure" && !env.STORAGE_ACCOUNT_URL) throw new Error("BACKEND=azure requires STORAGE_ACCOUNT_URL");
  if (backend === "azure" && !env.SERVICEBUS_FQDN) throw new Error("BACKEND=azure requires SERVICEBUS_FQDN");
  const devAuth = env.DEV_AUTH === "1";
  const entraTenantId = env.ENTRA_TENANT_ID || undefined;
  const entraAudience = env.ENTRA_AUDIENCE || undefined;
  // T18: without DEV_AUTH, beginPublish/getPublishStatus verify a real Entra bearer; both are required to do that.
  if (!devAuth && (!entraTenantId || !entraAudience)) {
    throw new Error("ENTRA_TENANT_ID and ENTRA_AUDIENCE are required when DEV_AUTH is unset (intake-api verifies the caller's Entra token itself)");
  }
  const port = int(env.PORT, 8080);
  const pipelineTrigger: "fake" | "ado" | "manual" = env.PIPELINE_TRIGGER === "manual" ? "manual"
    : env.PIPELINE_TRIGGER === "ado" || (env.PIPELINE_TRIGGER === undefined && backend === "azure") ? "ado" : "fake";
  const ado = { org: env.ADO_ORG, project: env.ADO_PROJECT, pipelineId: env.ADO_PIPELINE_ID, nodePipelineId: env.ADO_NODE_PIPELINE_ID };
  if (pipelineTrigger === "ado" && (!ado.org || !ado.project || !ado.pipelineId || !ado.nodePipelineId)) {
    throw new Error("PIPELINE_TRIGGER=ado requires ADO_ORG, ADO_PROJECT, ADO_PIPELINE_ID and ADO_NODE_PIPELINE_ID");
  }
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, ""),
    shellOrigin: (env.SHELL_ORIGIN ?? "http://localhost:8082").replace(/\/+$/, ""),
    devAuth,
    devPublisherOid: env.DEV_PUBLISHER_OID ?? "dev-oid",
    devPublisherUpn: env.DEV_PUBLISHER_UPN ?? "dev@localhost",
    entraTenantId,
    entraAudience,
    // Unset → enforced with the default scope; "" → scope check disabled; anything else → that scope.
    entraRequiredScope: env.ENTRA_REQUIRED_SCOPE === undefined ? "artifacts.publish" : env.ENTRA_REQUIRED_SCOPE || undefined,
    pipelineToken: env.PIPELINE_TOKEN || undefined,
    internalSharedKey: env.INTERNAL_SHARED_KEY || undefined,
    viewTokenKey: key,
    backend,
    serveRoot: resolve(env.SERVE_ROOT ?? "./.local/serving"),
    dataRoot: resolve(env.DATA_ROOT ?? "./.local/data"),
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
    worker: {
      gitleaksBin: env.GITLEAKS_BIN ?? "gitleaks",
      pythonBin: env.PYTHON_BIN ?? "python3",
      importsScript: env.IMPORTS_SCRIPT ?? resolve(REPO_ROOT, "scanner", "imports.py"),
      runtimeManifestPath: env.RUNTIME_MANIFEST ?? resolve(REPO_ROOT, "tests", "runtime-manifest.python-1.json"),
      defenderTimeoutSeconds: int(env.DEFENDER_TIMEOUT_SECONDS, 60),
      defenderPollSeconds: int(env.DEFENDER_POLL_SECONDS, 2),
      defenderFakeMalicious: new Set((env.DEFENDER_FAKE_MALICIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
      gcIntervalSeconds: int(env.GC_INTERVAL_SECONDS, 600),
      pipelineTrigger,
      ado,
      intakeInternalUrl: (env.INTAKE_INTERNAL_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
      approvalPolicy: approvalPolicy(env.APPROVAL_MODE),
    },
  };
}

export function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function approvalPolicy(value: string | undefined): "policy" | "always-human" | "always-auto" {
  if (value === undefined || value === "" || value === "policy") return "policy";
  if (value === "always-human" || value === "always-auto") return value;
  throw new Error(`APPROVAL_MODE must be policy, always-human or always-auto (got "${value}")`);
}
