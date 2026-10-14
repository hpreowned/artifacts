// Shared fixture for entra-token.test.ts and the strict-mode checks in api.test.ts: an in-test RSA key
// pair, a fake discovery/JWKS source (DiscoverySource), and a JWT signer. No network, no real tenant.
import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto";
import type { Discovery, DiscoverySource, JsonWebKey } from "../entra-token.js";

export const TENANT_ID = "11111111-1111-1111-1111-111111111111";
export const AUDIENCE = "22222222-2222-2222-2222-222222222222";
export const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
export const JWKS_URI = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;

export interface FixtureKey {
  kid: string;
  jwk: JsonWebKey;
  privateKey: KeyObject;
}

export function makeKey(kid: string): FixtureKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  jwk.kid = kid;
  jwk.kty = "RSA";
  return { kid, jwk, privateKey };
}

/** A DiscoverySource backed by in-memory keys. `rotate` simulates the IdP publishing a new key. */
export class FakeDiscoverySource implements DiscoverySource {
  discoveryCalls = 0;
  jwksCalls = 0;

  constructor(private keys: FixtureKey[], private issuer: string = ISSUER) {}

  rotate(keys: FixtureKey[]): void {
    this.keys = keys;
  }

  async fetchDiscovery(_tenantId: string): Promise<Discovery> {
    this.discoveryCalls++;
    return { issuer: this.issuer, jwksUri: JWKS_URI };
  }

  async fetchJwks(_jwksUri: string): Promise<JsonWebKey[]> {
    this.jwksCalls++;
    return this.keys.map((k) => k.jwk);
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface SignOptions {
  header?: Record<string, unknown>;
  /** Produces a syntactically valid but cryptographically wrong signature. */
  badSignature?: boolean;
}

export function signToken(key: FixtureKey, claims: Record<string, unknown>, opts: SignOptions = {}): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...opts.header };
  const headerPart = b64url(JSON.stringify(header));
  const payloadPart = b64url(JSON.stringify(claims));
  const signingInput = `${headerPart}.${payloadPart}`;
  if (opts.badSignature) return `${signingInput}.${b64url("not-the-real-signature-0000000")}`;
  const signature = signData("RSA-SHA256", Buffer.from(signingInput, "utf8"), key.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

/** A valid claim set for TENANT_ID/AUDIENCE as of `now`; override individual claims as needed. */
export function baseClaims(now: Date, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(now.getTime() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    tid: TENANT_ID,
    oid: "oid-alice",
    preferred_username: "alice@example.test",
    scp: "artifacts.publish",
    iat: nowSec - 10,
    nbf: nowSec - 10,
    exp: nowSec + 3600,
    ...overrides,
  };
}
