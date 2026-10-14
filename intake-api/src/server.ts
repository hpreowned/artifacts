import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { HttpError, sendJson } from "./http.js";
import { JOB_ID_RE } from "./ids.js";
import { createViewToken, postPublishEvent } from "./routes/internal.js";
import { beginPublish, getPublishStatus } from "./routes/publish.js";
import { finalizePublish, uploadBundle } from "./routes/upload.js";
import type { Stores } from "./stores/types.js";

export interface AppDeps {
  cfg: Config;
  stores: Stores;
  now: () => Date;
}

type Handler = (req: IncomingMessage, res: ServerResponse, deps: AppDeps, jobId: string) => Promise<void>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const JOB = "(job_[a-z0-9]{20})";
const ROUTES: Route[] = [
  { method: "POST", pattern: /^\/v1\/publish$/, handler: (req, res, deps) => beginPublish(req, res, deps) },
  { method: "PUT", pattern: new RegExp(`^/v1/publish/${JOB}/upload$`), handler: uploadBundle },
  { method: "POST", pattern: new RegExp(`^/v1/publish/${JOB}/finalize$`), handler: finalizePublish },
  { method: "POST", pattern: new RegExp(`^/v1/publish/${JOB}/events$`), handler: postPublishEvent },
  { method: "GET", pattern: new RegExp(`^/v1/publish/${JOB}$`), handler: getPublishStatus },
  { method: "POST", pattern: /^\/v1\/view-token$/, handler: (req, res, deps) => createViewToken(req, res, deps) },
  { method: "GET", pattern: /^\/healthz$/, handler: async (_req, res) => sendJson(res, 200, { ok: true }) },
];

export function createApp(deps: AppDeps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body);
      } else {
        console.error(`[http] ${req.method} ${req.url} failed`, err);
        sendJson(res, 500, { error: "internal error" });
      }
      // A refused body (413) may be unread; close the connection after the response has been flushed.
      if (!req.complete) res.once("finish", () => req.socket.destroy());
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const method = req.method ?? "GET";
  let pathMatched = false;
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const jobId = match[1] ?? "";
    if (jobId && !JOB_ID_RE.test(jobId)) throw new HttpError(404, { error: "unknown job" });
    await route.handler(req, res, deps, jobId);
    return;
  }
  throw new HttpError(pathMatched ? 405 : 404, { error: pathMatched ? "method not allowed" : "not found" });
}
