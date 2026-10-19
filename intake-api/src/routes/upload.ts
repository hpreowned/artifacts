import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BYTES } from "../config.js";
import { expireIfStale } from "../expiry.js";
import { bearer, fail, isRecord, readBody, readJson, safeEqual, sendEmpty, sendJson } from "../http.js";
import { toStatus, type JobRecord } from "../job.js";
import type { AppDeps } from "../server.js";
import { hashToken } from "./publish.js";

/** The one-time token: 10 minutes, bound to the job, one use for upload and one more for finalize. */
async function jobForToken(req: IncomingMessage, deps: AppDeps, jobId: string, expectedUses: number): Promise<JobRecord> {
  const token = bearer(req);
  if (!token) fail(401, "missing upload token");
  const job = await deps.stores.jobs.get(jobId);
  if (!job) fail(404, "unknown job");
  if (!safeEqual(hashToken(token), job.uploadTokenHash)) fail(401, "bad upload token");
  if (expireIfStale(job, deps.now())) {
    await deps.stores.jobs.put(job);
    fail(401, "upload token expired");
  }
  if (job.uploadTokenUses > expectedUses) fail(401, "upload token already used");
  if (job.state !== "awaiting_upload") fail(409, `job is ${job.state}, not awaiting upload`);
  if (job.uploadTokenUses < expectedUses) fail(409, "nothing uploaded yet");
  return job;
}

/** PUT /v1/publish/{jobId}/upload (bearer = upload token, body = zip) → 201. */
export async function uploadBundle(req: IncomingMessage, res: ServerResponse, deps: AppDeps, jobId: string): Promise<void> {
  const job = await jobForToken(req, deps, jobId, 0);
  const data = await readBody(req, MAX_BYTES);
  if (data.length === 0) fail(400, "empty upload");
  await deps.stores.bundles.put(jobId, data);
  job.sha256 = createHash("sha256").update(data).digest("hex");
  job.uploadTokenUses = 1;
  job.updatedAt = deps.now().toISOString();
  await deps.stores.jobs.put(job);
  sendEmpty(res, 201);
}

const IN_FLIGHT = new Set(["scanning", "awaiting_approval", "deploying"]);

/** POST /v1/publish/{jobId}/finalize { sha256 } → 202 Status (scanning). Mismatch or in-flight duplicate → 409. */
export async function finalizePublish(req: IncomingMessage, res: ServerResponse, deps: AppDeps, jobId: string): Promise<void> {
  const job = await jobForToken(req, deps, jobId, 1);
  const body = await readJson(req);
  if (!isRecord(body) || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256) || Object.keys(body).length !== 1) {
    fail(400, "body must be { sha256: <64 hex chars> }");
  }
  if (!safeEqual(body.sha256, job.sha256)) fail(409, "sha256 does not match the uploaded bundle");
  // An identical bundle from the same publisher that is still in flight is a duplicate, not a new publish:
  // refusing it keeps approvers from seeing the same artifact three times. Republishing content that is
  // already live stays allowed — that is how a TTL gets refreshed. The job stays awaiting_upload and expires.
  const duplicate = (await deps.stores.jobs.list()).find(
    (j) => j.jobId !== job.jobId && j.ownerOid === job.ownerOid && j.sha256 === job.sha256 && IN_FLIGHT.has(j.state),
  );
  if (duplicate) {
    await deps.stores.bundles.delete(job.jobId).catch(() => undefined);
    fail(409, `an identical bundle from you is already in flight as ${duplicate.jobId} (${duplicate.state}); follow that job instead of publishing again`, {
      duplicateOf: duplicate.jobId,
      duplicateState: duplicate.state,
    });
  }
  job.uploadTokenUses = 2;
  job.state = "scanning";
  job.updatedAt = deps.now().toISOString();
  await deps.stores.jobs.put(job);
  try {
    await deps.stores.queue.enqueue({ jobId });
  } catch (err) {
    job.state = "failed";
    job.summary = "Could not queue the scan. Resubmit; if it persists the scan queue is down.";
    job.updatedAt = deps.now().toISOString();
    await deps.stores.jobs.put(job);
    console.error(`[finalize] enqueue failed for ${jobId}`, err);
    fail(500, "could not queue the scan");
  }
  sendJson(res, 202, toStatus(job, deps.cfg.approverGroup));
}
