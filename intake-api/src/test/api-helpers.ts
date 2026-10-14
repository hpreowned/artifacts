// Starts the API on an ephemeral port with memory stores; secrets are random per run.
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "../config.js";
import type { EntraTokenVerifier } from "../entra-token.js";
import type { Manifest } from "../job.js";
import { createApp } from "../server.js";
import { MemoryScanQueue } from "../stores/memory.js";
import { createStores } from "../stores/select.js";
import type { Stores } from "../stores/types.js";

export const STATIC_MANIFEST: Manifest = {
  schemaVersion: 2, name: "api-test", tier: "static", runtime: null, entrypoint: "index.html",
  externalScripts: [], ttlDays: 7, generatedBy: { tool: "artifactctl" },
};

export interface Api {
  cfg: Config;
  base: string;
  stores: Stores;
  queue: MemoryScanQueue;
  clock: { now: Date };
  secrets: { pipelineToken: string; internalKey: string; viewKey: Buffer };
  stop(): Promise<void>;
}

export async function startApi(env: Record<string, string> = {}, entraVerifier?: EntraTokenVerifier): Promise<Api> {
  const pipelineToken = randomBytes(24).toString("base64url");
  const internalKey = randomBytes(24).toString("base64url");
  const viewKey = randomBytes(32);
  const cfg = loadConfig({
    DEV_AUTH: "1", PIPELINE_TOKEN: pipelineToken, INTERNAL_SHARED_KEY: internalKey, VIEW_TOKEN_KEY: viewKey.toString("base64"),
    PUBLIC_BASE_URL: "https://mcp.example.test/artifacts", ...env,
  });
  const stores = createStores(cfg);
  const clock = { now: new Date() };
  const server = createApp({ cfg, stores, now: () => clock.now, entraVerifier });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    cfg, base: `http://127.0.0.1:${port}`, stores, queue: stores.queue as MemoryScanQueue, clock,
    secrets: { pipelineToken, internalKey, viewKey },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Reply {
  status: number;
  // The response body parsed as JSON; tests read it loosely on purpose.
  body: any;
  text: string;
}

export const PUBLISHER = { "x-publisher-oid": "oid-alice", "x-publisher-upn": "alice@example.test" };

export async function call(base: string, method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown; body?: Buffer } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.body) {
    headers["content-type"] = "application/zip";
    body = new Uint8Array(opts.body);
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
}

/** Sends only headers with a declared Content-Length, to observe the early 413 without streaming a body. */
export function declareLength(base: string, path: string, headers: Record<string, string>, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "PUT", headers: { ...headers, "content-length": String(length) } });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}
