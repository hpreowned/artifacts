// Unit tests for entra-token.ts against an in-test RSA key pair and a fake JWKS (no network, no real tenant).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEntraTokenVerifier } from "../entra-token.js";
import { AUDIENCE, baseClaims, FakeDiscoverySource, ISSUER, makeKey, signToken, TENANT_ID } from "./entra-fixture.js";

test("valid token: identity from claims, upn falls back to upn then oid", async () => {
  const key = makeKey("kid-1");
  const source = new FakeDiscoverySource([key]);
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, source);

  const now = new Date();
  const r1 = await verifier.verify(signToken(key, baseClaims(now)));
  assert.deepEqual(r1, { ok: true, oid: "oid-alice", upn: "alice@example.test" });

  const r2 = await verifier.verify(signToken(key, baseClaims(now, { preferred_username: undefined, upn: "alice@upn.test" })));
  assert.deepEqual(r2, { ok: true, oid: "oid-alice", upn: "alice@upn.test" });

  const r3 = await verifier.verify(signToken(key, baseClaims(now, { preferred_username: undefined, upn: undefined })));
  assert.deepEqual(r3, { ok: true, oid: "oid-alice", upn: "oid-alice" }, "falls all the way back to oid");
});

test("malformed: not three dot-separated base64url segments, or unparsable JSON", async () => {
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  assert.deepEqual(await verifier.verify("not-a-jwt"), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifier.verify("a.b"), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifier.verify("a.b.c.d"), { ok: false, reason: "malformed" });
  const bogusHeader = `${Buffer.from("not json").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`;
  assert.deepEqual(await verifier.verify(bogusHeader), { ok: false, reason: "malformed" });
});

test("alg must be RS256", async () => {
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  const token = signToken(key, baseClaims(new Date()), { header: { alg: "HS256" } });
  assert.deepEqual(await verifier.verify(token), { ok: false, reason: "alg" });
});

test("unknown kid: one refresh, at most once a minute", async () => {
  const keyA = makeKey("kid-a");
  const keyB = makeKey("kid-b");
  const source = new FakeDiscoverySource([keyA]);
  let now = new Date("2026-01-01T00:00:00Z");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, source, () => now);

  // Load the cache (kid-a only). This is the initial fetch, not yet a "refresh".
  assert.equal((await verifier.verify(signToken(keyA, baseClaims(now)))).ok, true);
  assert.equal(source.jwksCalls, 1);

  // Well past a minute later, kid-b is unknown: triggers exactly one refresh, after which it verifies.
  now = new Date(now.getTime() + 61_000);
  source.rotate([keyA, keyB]);
  const tokenB = signToken(keyB, baseClaims(now));
  assert.deepEqual(await verifier.verify(tokenB), { ok: true, oid: "oid-alice", upn: "alice@example.test" });
  assert.equal(source.jwksCalls, 2, "exactly one refresh for the unknown kid");

  // A third, still-unknown kid shortly after does not trigger another refresh (within 60s of the last one).
  source.rotate([keyA]); // kid-b "disappears" again; the point is the refresh budget, not the content
  const keyC = makeKey("kid-c");
  now = new Date(now.getTime() + 30_000);
  assert.deepEqual(await verifier.verify(signToken(keyC, baseClaims(now))), { ok: false, reason: "kid" });
  assert.equal(source.jwksCalls, 2, "no refresh within 60s of the last one");

  // Past the one-minute budget (since the refresh at jwksCalls=2), an unknown kid refreshes again.
  now = new Date(now.getTime() + 31_000); // 61s after that refresh
  source.rotate([keyA, keyC]);
  assert.equal((await verifier.verify(signToken(keyC, baseClaims(now)))).ok, true);
  assert.equal(source.jwksCalls, 3);
});

test("signature: tampered payload or wrong key fails", async () => {
  const key = makeKey("kid-1");
  const otherKey = makeKey("kid-1"); // same kid, different key pair: as if the cache held the wrong key
  const source = new FakeDiscoverySource([otherKey]);
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, source);
  const token = signToken(key, baseClaims(new Date()));
  assert.deepEqual(await verifier.verify(token), { ok: false, reason: "signature" });

  const verifierOk = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  const badSig = signToken(key, baseClaims(new Date()), { badSignature: true });
  assert.deepEqual(await verifierOk.verify(badSig), { ok: false, reason: "signature" });
});

test("issuer must equal the discovery document's issuer", async () => {
  const key = makeKey("kid-1");
  const source = new FakeDiscoverySource([key], "https://login.microsoftonline.com/some-other-tenant/v2.0");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, source);
  const token = signToken(key, baseClaims(new Date(), { iss: ISSUER }));
  assert.deepEqual(await verifier.verify(token), { ok: false, reason: "issuer" });
});

test("audience must equal ENTRA_AUDIENCE", async () => {
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  const token = signToken(key, baseClaims(new Date(), { aud: "some-other-client-id" }));
  assert.deepEqual(await verifier.verify(token), { ok: false, reason: "audience" });
});

test("expired and not-yet-valid, with a 60s skew allowance", async () => {
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  assert.deepEqual(await verifier.verify(signToken(key, baseClaims(now, { exp: nowSec - 120 }))), { ok: false, reason: "expired" });
  assert.equal((await verifier.verify(signToken(key, baseClaims(now, { exp: nowSec - 30 })))).ok, true, "within the 60s skew");

  assert.deepEqual(await verifier.verify(signToken(key, baseClaims(now, { nbf: nowSec + 120 }))), { ok: false, reason: "not_yet_valid" });
  assert.equal((await verifier.verify(signToken(key, baseClaims(now, { nbf: nowSec + 30 })))).ok, true, "within the 60s skew");
});

test("tid must equal the configured tenant", async () => {
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  const token = signToken(key, baseClaims(new Date(), { tid: "33333333-3333-3333-3333-333333333333" }));
  assert.deepEqual(await verifier.verify(token), { ok: false, reason: "tenant" });
});

test("required scope checked against the space-separated scp claim", async () => {
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier(
    { tenantId: TENANT_ID, audience: AUDIENCE, requiredScope: "artifacts.publish" },
    new FakeDiscoverySource([key]),
  );
  assert.equal((await verifier.verify(signToken(key, baseClaims(new Date(), { scp: "other.scope artifacts.publish" })))).ok, true);
  assert.deepEqual(await verifier.verify(signToken(key, baseClaims(new Date(), { scp: "other.scope" }))), { ok: false, reason: "scope" });
  assert.deepEqual(await verifier.verify(signToken(key, baseClaims(new Date(), { scp: undefined }))), { ok: false, reason: "scope" });
});
