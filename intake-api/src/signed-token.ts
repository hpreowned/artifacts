// signed-token.ts — HMAC-SHA256 signed JSON tokens. Shared verbatim by intake-api (mints view tokens),
// static-gateway (verifies view tokens, mints and verifies session cookies) and viewer-shell.
//
// Format:  base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, base64url(payloadJson)))
// Key:     raw bytes. The env var VIEW_TOKEN_KEY carries them base64-encoded; see keyFromEnv().
// Payloads:
//   view token     {"t":"view","aid":"<artifactId>","oid":"<viewerOid>","exp":<unix seconds, now+300>}
//   session cookie {"t":"session","aid":"<artifactId>","exp":<unix seconds, now+86400>}
// Callers must check payload.t and payload.aid themselves; verify() only checks signature and expiry.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenPayload {
  t: string;
  aid: string;
  exp: number;
  [key: string]: unknown;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

export function sign(payload: TokenPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(body, key)}`;
}

export function verify(token: string, key: Buffer, nowMs: number = Date.now()): VerifyResult {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const expected = Buffer.from(hmac(body, key), "ascii");
  const actual = Buffer.from(token.slice(dot + 1), "ascii");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPayload(payload)) return { ok: false, reason: "malformed" };
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** Decodes the base64 key from the environment. Throws when missing or shorter than 32 bytes. */
export function keyFromEnv(name: string = "VIEW_TOKEN_KEY", env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length < 32) throw new Error(`${name} must decode to at least 32 bytes`);
  return key;
}

function hmac(body: string, key: Buffer): string {
  return createHmac("sha256", key).update(body, "ascii").digest("base64url");
}

function isPayload(value: unknown): value is TokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.t === "string" && typeof v.aid === "string" && typeof v.exp === "number" && Number.isFinite(v.exp);
}
