/** What intake-api's `POST /v1/view-token` returns (contracts/intake-openapi.yaml). `artifactExpiresAt` is optional: the artifact's TTL expiry, present whenever intake-api's job record has one. */
export interface ViewTokenGrant {
  token: string;
  expiresAt: string;
  artifactExpiresAt?: string;
}

export interface IntakeClient {
  /** Resolves null when intake answers 404 (artifact not live). Throws on any other failure. */
  createViewToken(artifactId: string, viewerOid: string): Promise<ViewTokenGrant | null>;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class HttpIntakeClient implements IntakeClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly sharedKey: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async createViewToken(artifactId: string, viewerOid: string): Promise<ViewTokenGrant | null> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/view-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Caller': this.sharedKey },
      body: JSON.stringify({ artifactId, viewerOid }),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`intake /v1/view-token returned ${res.status}`);
    const body = (await res.json()) as Partial<ViewTokenGrant>;
    if (typeof body.token !== 'string' || typeof body.expiresAt !== 'string') throw new Error('intake /v1/view-token: malformed body');
    const grant: ViewTokenGrant = { token: body.token, expiresAt: body.expiresAt };
    if (typeof body.artifactExpiresAt === 'string') grant.artifactExpiresAt = body.artifactExpiresAt;
    return grant;
  }
}

/** Test double: serves grants for known artifact ids, 404 for the rest, and records every call. */
export class FakeIntakeClient implements IntakeClient {
  readonly calls: Array<{ artifactId: string; viewerOid: string }> = [];
  constructor(private readonly grants: Record<string, ViewTokenGrant> = {}) {}

  async createViewToken(artifactId: string, viewerOid: string): Promise<ViewTokenGrant | null> {
    this.calls.push({ artifactId, viewerOid });
    return this.grants[artifactId] ?? null;
  }
}
