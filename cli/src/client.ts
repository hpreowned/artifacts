// HTTP client for contracts/intake-openapi.yaml. Built-in fetch only.
import type { Config } from "./config.js";

export type State =
  | "awaiting_upload" | "scanning" | "rejected" | "awaiting_approval" | "deploying" | "live" | "failed" | "expired";

export const TERMINAL_STATES: ReadonlySet<State> = new Set<State>(["rejected", "awaiting_approval", "live", "failed", "expired"]);

export interface Finding {
  rule: string;
  severity: "deny" | "warn" | "info";
  file?: string;
  line?: number;
  message: string;
}

export interface Status {
  jobId: string;
  state: State;
  tier?: "static" | "python";
  updatedAt: string;
  url?: string;
  expiresAt?: string;
  findings?: Finding[];
  approval?: { group?: string; runUrl?: string };
  summary?: string;
}

export interface PublishBegin {
  jobId: string;
  uploadUrl: string;
  uploadToken: string;
  uploadExpiresAt: string;
  maxBytes: number;
}

/** Egress problem: DNS, connect, timeout, TLS, or an HTTP 403 from a proxy in front of the API. Exit 2. */
export class NetworkError extends Error {}

/** The API answered with a status the flow does not accept. */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly findings: Finding[] = []) {
    super(message);
  }
}

/** The finalize URL is the upload URL with its last path segment swapped, query string dropped. */
export function finalizeUrl(uploadUrl: string): string {
  const base = uploadUrl.split("?")[0] ?? uploadUrl;
  if (!base.endsWith("/upload")) throw new ApiError(`uploadUrl does not end with /upload: ${uploadUrl}`, 0);
  return `${base.slice(0, -"/upload".length)}/finalize`;
}

function describe(e: unknown): string {
  if (e && typeof e === "object") {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return cause.code;
    if (cause?.message) return cause.message;
    if ((e as { name?: string }).name === "TimeoutError") return "timed out";
    if ((e as { message?: string }).message) return (e as { message: string }).message;
  }
  return String(e);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(`${what}: response is not JSON: ${text.slice(0, 200)}`, 0);
  }
}

function findingsOf(body: unknown): Finding[] {
  const f = (body as { findings?: unknown })?.findings;
  return Array.isArray(f) ? (f as Finding[]) : [];
}

export class IntakeClient {
  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
  ) {}

  private callerHeaders(): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.cfg.token}` };
    if (this.cfg.devOid) {
      h["x-publisher-oid"] = this.cfg.devOid;
      h["x-publisher-upn"] = `${this.cfg.devOid}@dev`;
    }
    return h;
  }

  private async send(method: string, url: string, headers: Record<string, string>, body?: BodyInit): Promise<{ status: number; text: string }> {
    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) init.body = body;
      res = await this.fetchImpl(url, init);
    } catch (e) {
      throw new NetworkError(`cannot reach ${url}: ${describe(e)}`);
    }
    if (res.status === 403) throw new NetworkError(`HTTP 403 from a proxy or gateway in front of ${url}`);
    return { status: res.status, text: await res.text() };
  }

  async beginPublish(manifest: unknown): Promise<PublishBegin> {
    const url = `${this.cfg.apiUrl}/v1/publish`;
    const r = await this.send("POST", url, { ...this.callerHeaders(), "content-type": "application/json" }, JSON.stringify(manifest));
    if (r.status === 201) return parseJson(r.text, "beginPublish") as PublishBegin;
    const body = r.text ? parseJsonLenient(r.text) : undefined;
    const msg = (body as { error?: string })?.error ?? r.text.slice(0, 200);
    if (r.status === 400) throw new ApiError(`manifest rejected: ${msg}`, 400, findingsOf(body));
    if (r.status === 429) throw new ApiError("rate limited by the API; retry later", 429);
    throw new ApiError(`beginPublish returned HTTP ${r.status}: ${msg}`, r.status);
  }

  async upload(uploadUrl: string, uploadToken: string, zip: Buffer): Promise<void> {
    const r = await this.send("PUT", uploadUrl, { authorization: `Bearer ${uploadToken}`, "content-type": "application/zip" }, new Uint8Array(zip));
    if (r.status === 201) return;
    if (r.status === 401) throw new ApiError("upload token rejected (bad, expired or already used)", 401);
    if (r.status === 413) throw new ApiError("bundle larger than maxBytes", 413);
    if (r.status === 409) throw new ApiError("job is not awaiting upload", 409);
    throw new ApiError(`upload returned HTTP ${r.status}: ${r.text.slice(0, 200)}`, r.status);
  }

  async finalize(uploadUrl: string, uploadToken: string, sha256: string): Promise<Status> {
    const r = await this.send("POST", finalizeUrl(uploadUrl), { authorization: `Bearer ${uploadToken}`, "content-type": "application/json" }, JSON.stringify({ sha256 }));
    if (r.status === 202) return parseJson(r.text, "finalize") as Status;
    if (r.status === 401) throw new ApiError("finalize token rejected", 401);
    if (r.status === 409) throw new ApiError(`finalize rejected (hash mismatch or wrong state): ${r.text.slice(0, 200)}`, 409);
    throw new ApiError(`finalize returned HTTP ${r.status}: ${r.text.slice(0, 200)}`, r.status);
  }

  async status(jobId: string): Promise<Status> {
    const r = await this.send("GET", `${this.cfg.apiUrl}/v1/publish/${encodeURIComponent(jobId)}`, this.callerHeaders());
    if (r.status === 200) return parseJson(r.text, "getPublishStatus") as Status;
    if (r.status === 404) throw new ApiError(`job ${jobId} not found or not owned by the caller`, 404);
    throw new ApiError(`getPublishStatus returned HTTP ${r.status}: ${r.text.slice(0, 200)}`, r.status);
  }
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
