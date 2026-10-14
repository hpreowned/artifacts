import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { publisher } from "../auth.js";
import { MAX_BYTES, UPLOAD_TTL_SECONDS } from "../config.js";
import { expireIfStale } from "../expiry.js";
import { fail, readJson, sendJson } from "../http.js";
import { newArtifactId, newJobId } from "../ids.js";
import { toStatus, type Finding, type JobRecord, type Manifest } from "../job.js";
import { manifestValidator } from "../manifest-validator.js";
import type { AppDeps } from "../server.js";

export function manifestFindings(manifest: unknown): Finding[] {
  return manifestValidator()
    .validate(manifest)
    .map((message) => ({ rule: "IN-006", severity: "deny", file: "manifest.json", message }));
}

/** POST /v1/publish → 201 PublishBegin. Invalid manifest → 400 { error, findings[IN-006] }. */
export async function beginPublish(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const who = publisher(req, deps.cfg);
  const body = await readJson(req);
  const findings = manifestFindings(body);
  if (findings.length > 0) fail(400, "manifest invalid", { findings });
  const manifest = body as Manifest;

  const now = deps.now();
  const token = randomBytes(32).toString("base64url");
  const job: JobRecord = {
    jobId: newJobId(),
    artifactId: newArtifactId(),
    ownerOid: who.oid,
    ownerUpn: who.upn,
    manifest,
    tier: manifest.tier,
    state: "awaiting_upload",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + manifest.ttlDays * 86_400_000).toISOString(),
    uploadTokenHash: hashToken(token),
    uploadTokenUses: 0,
    uploadExpiresAt: new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    findings: [],
  };
  await deps.stores.jobs.create(job);
  sendJson(res, 201, {
    jobId: job.jobId,
    uploadUrl: `${deps.cfg.publicBaseUrl}/v1/publish/${job.jobId}/upload`,
    uploadToken: token,
    uploadExpiresAt: job.uploadExpiresAt,
    maxBytes: MAX_BYTES,
  });
}

/** GET /v1/publish/{jobId} → 200 Status; 404 when unknown or owned by someone else. */
export async function getPublishStatus(req: IncomingMessage, res: ServerResponse, deps: AppDeps, jobId: string): Promise<void> {
  const who = publisher(req, deps.cfg);
  const job = await deps.stores.jobs.get(jobId);
  if (!job || job.ownerOid !== who.oid) fail(404, "unknown job");
  if (expireIfStale(job, deps.now())) await deps.stores.jobs.put(job);
  sendJson(res, 200, toStatus(job, deps.cfg.approverGroup));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
