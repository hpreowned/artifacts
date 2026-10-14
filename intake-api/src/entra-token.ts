// Verifies an Entra ID (Azure AD) access token presented as `Authorization: Bearer <jwt>`, with zero
// dependencies beyond node:crypto and the built-in fetch (CLAUDE.md). DESIGN §6.10: the `artifacts-mcp`
// app registration sets `requestedAccessTokenVersion: 2`, so a valid token's `aud` claim is that app's
// client id, not its Application ID URI. T18: intake-api verifies this itself instead of trusting APIM's
// forwarded X-Publisher-* headers, which are never read again once this module is wired in.
import { createPublicKey, verify as verifySignature } from "node:crypto";

export interface JsonWebKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

export interface Discovery {
  issuer: string;
  jwksUri: string;
}

/** Behind an interface so tests inject a fake issuer instead of calling Microsoft for real. */
export interface DiscoverySource {
  fetchDiscovery(tenantId: string): Promise<Discovery>;
  fetchJwks(jwksUri: string): Promise<JsonWebKey[]>;
}

/** The real implementation. intake-api needs egress to login.microsoftonline.com (see README.md). */
export const httpDiscoverySource: DiscoverySource = {
  async fetchDiscovery(tenantId) {
    const url = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Entra discovery fetch failed: HTTP ${res.status} ${url}`);
    const doc = (await res.json()) as { issuer: string; jwks_uri: string };
    return { issuer: doc.issuer, jwksUri: doc.jwks_uri };
  },
  async fetchJwks(jwksUri) {
    const res = await fetch(jwksUri);
    if (!res.ok) throw new Error(`Entra JWKS fetch failed: HTTP ${res.status} ${jwksUri}`);
    const doc = (await res.json()) as { keys: JsonWebKey[] };
    return doc.keys;
  },
};

export type FailureReason =
  | "malformed"
  | "alg"
  | "kid"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "not_yet_valid"
  | "tenant"
  | "scope";

export type VerifyResult = { ok: true; oid: string; upn: string } | { ok: false; reason: FailureReason };

export interface EntraVerifierOptions {
  tenantId: string;
  audience: string;
  /** Checked against the space-separated `scp` claim when set. */
  requiredScope?: string;
}

const CLOCK_SKEW_SECONDS = 60;
const KID_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Fetches the tenant's discovery document and JWKS once, lazily, and refreshes them when a `kid` the cache
 * does not have arrives — at most once a minute, so a client cannot force unbounded refreshes.
 */
export class EntraTokenVerifier {
  private discovery: Discovery | undefined;
  private keys = new Map<string, JsonWebKey>();
  private lastRefresh = 0;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly opts: EntraVerifierOptions,
    private readonly source: DiscoverySource = httpDiscoverySource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const discovery = await this.source.fetchDiscovery(this.opts.tenantId);
      const keys = await this.source.fetchJwks(discovery.jwksUri);
      this.discovery = discovery;
      this.keys = new Map(keys.map((k) => [k.kid, k]));
      this.lastRefresh = this.now().getTime();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async keyForKid(kid: string): Promise<JsonWebKey | undefined> {
    if (!this.discovery) await this.load();
    if (this.keys.has(kid)) return this.keys.get(kid);
    if (this.now().getTime() - this.lastRefresh < KID_REFRESH_MIN_INTERVAL_MS) return undefined;
    await this.load();
    return this.keys.get(kid);
  }

  async verify(token: string): Promise<VerifyResult> {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (header.alg !== "RS256") return { ok: false, reason: "alg" };
    const kid = header.kid;
    if (typeof kid !== "string" || kid.length === 0) return { ok: false, reason: "kid" };
    const jwk = await this.keyForKid(kid);
    if (!jwk) return { ok: false, reason: "kid" };

    let signatureOk: boolean;
    try {
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      signatureOk = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
        publicKey,
        Buffer.from(signaturePart, "base64url"),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return { ok: false, reason: "signature" };

    if (!this.discovery || payload.iss !== this.discovery.issuer) return { ok: false, reason: "issuer" };

    const aud = payload.aud;
    const audienceOk = aud === this.opts.audience || (Array.isArray(aud) && aud.includes(this.opts.audience));
    if (!audienceOk) return { ok: false, reason: "audience" };

    const now = Math.floor(this.now().getTime() / 1000);
    if (typeof payload.exp !== "number" || now > payload.exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
    if (typeof payload.nbf === "number" && now < payload.nbf - CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
    if (payload.tid !== this.opts.tenantId) return { ok: false, reason: "tenant" };

    if (this.opts.requiredScope) {
      const scopes = typeof payload.scp === "string" ? payload.scp.split(/\s+/).filter(Boolean) : [];
      if (!scopes.includes(this.opts.requiredScope)) return { ok: false, reason: "scope" };
    }

    const oid = typeof payload.oid === "string" ? payload.oid : undefined;
    if (!oid) return { ok: false, reason: "malformed" };
    const upn =
      (typeof payload.preferred_username === "string" && payload.preferred_username) ||
      (typeof payload.upn === "string" && payload.upn) ||
      oid;
    return { ok: true, oid, upn };
  }
}

export function createEntraTokenVerifier(
  opts: EntraVerifierOptions,
  source: DiscoverySource = httpDiscoverySource,
  now: () => Date = () => new Date(),
): EntraTokenVerifier {
  return new EntraTokenVerifier(opts, source, now);
}
