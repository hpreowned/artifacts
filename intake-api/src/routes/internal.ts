// Internal routes, never published through APIM: pipeline callbacks and view-token minting.
import type { IncomingMessage, ServerResponse } from "node:http";
import { VIEW_TOKEN_TTL_SECONDS } from "../config.js";
import { bearer, fail, headerValue, isRecord, readJson, safeEqual, sendEmpty, sendJson } from "../http.js";
import { ARTIFACT_ID_RE } from "../ids.js";
import { applyEvent, type EventIn } from "../job.js";
import type { AppDeps } from "../server.js";
import { sign } from "../signed-token.js";

const EVENT_STATES = new Set(["awaiting_approval", "deploying", "live", "failed", "rejected", "expired"]);

export function parseEvent(body: unknown): EventIn {
  if (!isRecord(body) || typeof body.state !== "string" || !EVENT_STATES.has(body.state)) fail(400, "state must be one of " + [...EVENT_STATES].join(", "));
  for (const key of Object.keys(body)) if (!["state", "runUrl", "message"].includes(key)) fail(400, `unexpected property "${key}"`);
  if (body.runUrl !== undefined && (typeof body.runUrl !== "string" || !/^https?:\/\//.test(body.runUrl))) fail(400, "runUrl must be an http(s) URL");
  if (body.message !== undefined && typeof body.message !== "string") fail(400, "message must be a string");
  const event: EventIn = { state: body.state as EventIn["state"] };
  if (typeof body.runUrl === "string") event.runUrl = body.runUrl;
  if (typeof body.message === "string") event.message = body.message.slice(0, 2000);
  return event;
}

/** POST /v1/publish/{jobId}/events (bearer = PIPELINE_TOKEN) → 204; illegal transition → 409. */
export async function postPublishEvent(req: IncomingMessage, res: ServerResponse, deps: AppDeps, jobId: string): Promise<void> {
  if (!deps.cfg.pipelineToken || !safeEqual(bearer(req), deps.cfg.pipelineToken)) fail(401, "bad pipeline token");
  const event = parseEvent(await readJson(req));
  const job = await deps.stores.jobs.get(jobId);
  if (!job) fail(404, "unknown job");
  if (!applyEvent(job, event, deps.now())) fail(409, `illegal transition ${job.state} → ${event.state}`);
  // Static artifacts get their URL from the worker; pipeline-deployed ones get it here, the moment they go live.
  if (job.state === "live" && !job.url) job.url = `${deps.cfg.shellOrigin}/view/${job.artifactId}`;
  await deps.stores.jobs.put(job);
  sendEmpty(res, 204);
}

/** POST /v1/view-token (X-Internal-Caller = INTERNAL_SHARED_KEY) → { token, expiresAt }; not live → 404. */
export async function createViewToken(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  if (!deps.cfg.internalSharedKey || !safeEqual(headerValue(req, "x-internal-caller"), deps.cfg.internalSharedKey)) {
    fail(401, "bad internal caller key");
  }
  const body = await readJson(req);
  if (!isRecord(body) || typeof body.artifactId !== "string" || !ARTIFACT_ID_RE.test(body.artifactId)) fail(400, "artifactId must match ^[a-z0-9]{12}$");
  if (typeof body.viewerOid !== "string" || body.viewerOid.length === 0 || body.viewerOid.length > 200) fail(400, "viewerOid required");
  for (const key of Object.keys(body)) if (key !== "artifactId" && key !== "viewerOid") fail(400, `unexpected property "${key}"`);
  const now = deps.now();
  const job = await deps.stores.jobs.findByArtifactId(body.artifactId);
  if (!job || job.state !== "live" || Date.parse(job.expiresAt) <= now.getTime()) fail(404, "artifact not live");
  const exp = Math.floor(now.getTime() / 1000) + VIEW_TOKEN_TTL_SECONDS;
  const token = sign({ t: "view", aid: job.artifactId, oid: body.viewerOid, exp }, deps.cfg.viewTokenKey);
  sendJson(res, 200, { token, expiresAt: new Date(exp * 1000).toISOString(), artifactExpiresAt: job.expiresAt });
}
