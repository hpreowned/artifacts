import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error ?? `HTTP ${status}`));
  }
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): never {
  throw new HttpError(status, { error, ...extra });
}

/** Reads the whole body, refusing anything above `maxBytes` with 413 before buffering it. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) fail(413, `body larger than ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) fail(413, `body larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, maxBytes: number = 64 * 1024): Promise<unknown> {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) fail(400, "empty body");
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return fail(400, "body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-length": 0 });
  res.end();
}

export function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  const match = value ? /^Bearer\s+(\S+)\s*$/i.exec(value) : null;
  return match?.[1];
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
