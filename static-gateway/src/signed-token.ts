// Signed token scheme shared with intake-api and viewer-shell. Keep the three copies identical.
// token = base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, base64url(payloadJson)))
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  t: string;
  exp: number; // unix seconds
  [key: string]: unknown;
}

export function keyFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[name];
  if (!raw) throw new Error(`${name} is required (base64)`);
  const key = Buffer.from(raw, 'base64');
  if (key.length < 16) throw new Error(`${name} must decode to at least 16 bytes`);
  return key;
}

function mac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signToken(key: Buffer, payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(key, body).toString('base64url')}`;
}

/** Returns the payload when the signature is valid and `exp` is in the future; otherwise null. */
export function verifyToken(key: Buffer, token: string, nowSeconds = Math.floor(Date.now() / 1000)): TokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['t'] !== 'string' || typeof p['exp'] !== 'number' || !Number.isFinite(p['exp'])) return null;
  if (p['exp'] <= nowSeconds) return null;
  return p as TokenPayload;
}
