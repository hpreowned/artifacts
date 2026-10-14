// In-memory fake of contracts/intake-openapi.yaml for the client-facing operations. node:http only.
// Each job walks through a Scenario's states, one per GET; the last state repeats. Records every request.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Finding, State, Status } from "../src/client.js";

export interface Scenario {
  states: State[];
  findings?: Finding[];
  url?: string;
  expiresAt?: string;
  approval?: { group: string; runUrl: string };
  summary?: string;
}

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface Job {
  id: string;
  uploadToken: string;
  uploaded?: Buffer;
  finalized: boolean;
  polls: number;
  scenario: Scenario;
}

export const LIVE: Scenario = {
  states: ["scanning", "deploying", "live"],
  url: "https://x1y2z3a4b5c6.artifacts.corp.internal/",
  expiresAt: "2026-10-28T00:00:00Z",
  summary: "Static artifact is live.",
};

function jobId(): string {
  return "job_" + randomBytes(15).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 20);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export class FakeIntake {
  readonly jobs = new Map<string, Job>();
  readonly requests: Recorded[] = [];
  /** Scenario for the next jobs; tests set it before calling run(). */
  scenario: Scenario = LIVE;
  /** forbidden: every request answers 403 like a proxy in front of the API. */
  mode: "ok" | "forbidden" = "ok";
  /** When false the 400 for a bad manifest carries no findings array. */
  findingsOn400 = true;
  maxBytes = 26_214_400;
  baseUrl = "";
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const a = this.server.address();
        this.baseUrl = typeof a === "object" && a ? `http://127.0.0.1:${a.port}` : "";
        resolve(this.baseUrl);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private send(res: ServerResponse, code: number, body?: unknown): void {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private statusOf(job: Job): Status {
    const sc = job.scenario;
    const idx = Math.min(job.polls, sc.states.length) - 1;
    const state = sc.states[Math.max(idx, 0)] as State;
    const final = idx >= sc.states.length - 1;
    const s: Status = { jobId: job.id, state, updatedAt: "2026-10-14T12:00:00Z" };
    if (!final) return s;
    if (sc.findings) s.findings = sc.findings;
    if (sc.summary) s.summary = sc.summary;
    if (state === "live" && sc.url) {
      s.url = sc.url;
      if (sc.expiresAt) s.expiresAt = sc.expiresAt;
    }
    if (state === "awaiting_approval" && sc.approval) s.approval = sc.approval;
    return s;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", this.baseUrl);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, headers, body });
    if (this.mode === "forbidden") return this.send(res, 403, { error: "blocked by proxy" });
    const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
    const m = /^\/v1\/publish(?:\/(job_[a-z0-9]{20}))?(?:\/(upload|finalize))?$/.exec(url.pathname);
    if (!m) return this.send(res, 404, { error: "no such route" });
    const [, id, op] = m;

    if (req.method === "POST" && !id) {
      if (!bearer) return this.send(res, 401, { error: "no bearer" });
      const manifest = JSON.parse(body.toString("utf8")) as { schemaVersion?: unknown };
      if (manifest.schemaVersion !== 2) {
        const err: { error: string; findings?: Finding[] } = { error: "manifest invalid: schemaVersion must be 2" };
        if (this.findingsOn400) err.findings = [{ rule: "IN-006", severity: "deny", file: "manifest.json", line: 0, message: "schemaVersion must be 2" }];
        return this.send(res, 400, err);
      }
      const job: Job = { id: jobId(), uploadToken: randomBytes(16).toString("hex"), finalized: false, polls: 0, scenario: this.scenario };
      this.jobs.set(job.id, job);
      return this.send(res, 201, {
        jobId: job.id,
        uploadUrl: `${this.baseUrl}/v1/publish/${job.id}/upload?sig=abc`,
        uploadToken: job.uploadToken,
        uploadExpiresAt: "2026-10-14T12:10:00Z",
        maxBytes: this.maxBytes,
      });
    }
    const job = id ? this.jobs.get(id) : undefined;
    if (!job) return this.send(res, 404, { error: "unknown job" });

    if (req.method === "PUT" && op === "upload") {
      if (bearer !== job.uploadToken) return this.send(res, 401);
      if (headers["content-type"] !== "application/zip") return this.send(res, 400, { error: "content-type" });
      if (job.uploaded) return this.send(res, 409);
      if (body.length > this.maxBytes) return this.send(res, 413);
      job.uploaded = body;
      return this.send(res, 201);
    }
    if (req.method === "POST" && op === "finalize") {
      if (bearer !== job.uploadToken) return this.send(res, 401);
      if (!job.uploaded || job.finalized) return this.send(res, 409, { error: "not awaiting finalize" });
      const sha = (JSON.parse(body.toString("utf8")) as { sha256: string }).sha256;
      if (sha !== createHash("sha256").update(job.uploaded).digest("hex")) return this.send(res, 409, { error: "hash mismatch" });
      job.finalized = true;
      return this.send(res, 202, { jobId: job.id, state: "scanning", updatedAt: "2026-10-14T12:00:01Z" });
    }
    if (req.method === "GET" && !op) {
      if (!bearer) return this.send(res, 401, { error: "no bearer" });
      job.polls += 1;
      return this.send(res, 200, this.statusOf(job));
    }
    return this.send(res, 404, { error: "no such route" });
  }
}
