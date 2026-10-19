// Conformance against contracts/intake-openapi.yaml: one block per operation, plus the token and ownership rules.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { createEntraTokenVerifier } from "../entra-token.js";
import { REPO_ROOT } from "../repo-root.js";
import { verify } from "../signed-token.js";
import { PUBLISHER, STATIC_MANIFEST, call, declareLength, startApi, type Api } from "./api-helpers.js";
import { AUDIENCE, baseClaims, FakeDiscoverySource, makeKey, signToken, TENANT_ID } from "./entra-fixture.js";

let api: Api;
before(async () => {
  api = await startApi();
});
after(async () => {
  await api.stop();
});

// Any bytes will do here — but unique per test: jobs never leave `scanning` without a worker, and finalize
// refuses an identical in-flight bundle from the same publisher (409 duplicateOf).
let zipSeq = 0;
const freshZip = () => Buffer.from(`the API only hashes the bytes; the worker parses them #${++zipSeq}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const OTHER_PUBLISHER = { "x-publisher-oid": "oid-mallory", "x-publisher-upn": "mallory@example.test" };

async function begin(headers: Record<string, string> = PUBLISHER, manifest: unknown = STATIC_MANIFEST) {
  const r = await call(api.base, "POST", "/v1/publish", { headers, json: manifest });
  assert.equal(r.status, 201, r.text);
  return r.body as { jobId: string; uploadUrl: string; uploadToken: string; uploadExpiresAt: string; maxBytes: number };
}

test("beginPublish: 201 PublishBegin shape; 400 with IN-006 findings for a bad manifest; 401 without identity", async () => {
  const b = await begin();
  assert.match(b.jobId, /^job_[a-z0-9]{20}$/);
  assert.equal(b.uploadUrl, `https://mcp.example.test/artifacts/v1/publish/${b.jobId}/upload`);
  assert.ok(b.uploadToken.length >= 40, "256-bit token");
  assert.equal(b.maxBytes, 26214400);
  const ttl = Date.parse(b.uploadExpiresAt) - api.clock.now.getTime();
  assert.ok(ttl > 590_000 && ttl <= 600_000, `upload window is 10 minutes (${ttl})`);

  const badManifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "tests", "corpus", "static-bad-manifest", "manifest.json"), "utf8"));
  const bad = await call(api.base, "POST", "/v1/publish", { headers: PUBLISHER, json: badManifest });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, "string");
  assert.ok(bad.body.findings.length > 0 && bad.body.findings.every((f: { rule: string; severity: string }) => f.rule === "IN-006" && f.severity === "deny"));
  const mismatch = await call(api.base, "POST", "/v1/publish", { headers: PUBLISHER, json: { ...STATIC_MANIFEST, tier: "python" } });
  assert.equal(mismatch.status, 400, "schema allOf: python needs runtime and app.py");
  assert.equal((await call(api.base, "POST", "/v1/publish", { headers: PUBLISHER, body: Buffer.from("x") })).status, 400);

  // T18: without DEV_AUTH, X-Publisher-* headers are never read; only a verified Entra bearer identifies the caller.
  const key = makeKey("kid-1");
  const verifier = createEntraTokenVerifier({ tenantId: TENANT_ID, audience: AUDIENCE }, new FakeDiscoverySource([key]));
  const strict = await startApi({ DEV_AUTH: "", ENTRA_TENANT_ID: TENANT_ID, ENTRA_AUDIENCE: AUDIENCE }, verifier);
  try {
    assert.equal((await call(strict.base, "POST", "/v1/publish", { json: STATIC_MANIFEST })).status, 401, "no token at all");
    assert.equal(
      (await call(strict.base, "POST", "/v1/publish", { headers: PUBLISHER, json: STATIC_MANIFEST })).status,
      401,
      "X-Publisher-* headers alone are never enough, with or without DEV_AUTH",
    );
    const token = signToken(key, baseClaims(new Date(), { oid: "oid-real", preferred_username: "real@example.test" }));
    // A forged X-Publisher-Oid sent alongside a valid bearer must not change the identity: headers are ignored
    // even when present.
    const begun = await call(strict.base, "POST", "/v1/publish", {
      headers: { authorization: `Bearer ${token}`, "x-publisher-oid": "oid-mallory", "x-publisher-upn": "mallory@example.test" },
      json: STATIC_MANIFEST,
    });
    assert.equal(begun.status, 201, begun.text);
    const asTokenIdentity = await call(strict.base, "GET", `/v1/publish/${begun.body.jobId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(asTokenIdentity.status, 200, "owned by the token's oid, not the forged (and ignored) header");
    const badSig = await call(strict.base, "POST", "/v1/publish", { headers: auth(signToken(key, baseClaims(new Date()), { badSignature: true })), json: STATIC_MANIFEST });
    assert.equal(badSig.status, 401, "bad signature");
    const wrongAud = await call(strict.base, "POST", "/v1/publish", { headers: auth(signToken(key, baseClaims(new Date(), { aud: "nope" }))), json: STATIC_MANIFEST });
    assert.equal(wrongAud.status, 401, "wrong audience");
    const expired = await call(strict.base, "POST", "/v1/publish", { headers: auth(signToken(key, baseClaims(new Date(), { exp: Math.floor(Date.now() / 1000) - 3600 }))), json: STATIC_MANIFEST });
    assert.equal(expired.status, 401, "expired");
  } finally {
    await strict.stop();
  }
});

test("without DEV_AUTH, intake-api refuses to start when ENTRA_TENANT_ID or ENTRA_AUDIENCE is missing", async () => {
  await assert.rejects(() => startApi({ DEV_AUTH: "", ENTRA_TENANT_ID: "", ENTRA_AUDIENCE: "" }), /ENTRA_TENANT_ID and ENTRA_AUDIENCE are required/);
  await assert.rejects(() => startApi({ DEV_AUTH: "", ENTRA_TENANT_ID: TENANT_ID, ENTRA_AUDIENCE: "" }), /ENTRA_TENANT_ID and ENTRA_AUDIENCE are required/);
});

test("uploadBundle: 201 once; the token is single-use and job-bound; wrong token 401; unknown job 404; oversize 413", async () => {
  const zip = freshZip();
  const b = await begin();
  const path = `/v1/publish/${b.jobId}/upload`;
  assert.equal((await call(api.base, "PUT", path, { body: zip })).status, 401, "no token");
  assert.equal((await call(api.base, "PUT", path, { headers: auth("nope"), body: zip })).status, 401);
  assert.equal((await call(api.base, "PUT", path, { headers: auth(b.uploadToken), body: Buffer.alloc(0) })).status, 400);
  assert.equal((await call(api.base, "PUT", path, { headers: auth(b.uploadToken), body: zip })).status, 201);
  assert.equal((await call(api.base, "PUT", path, { headers: auth(b.uploadToken), body: zip })).status, 401, "second use is dead");
  assert.equal((await call(api.base, "PUT", "/v1/publish/job_00000000000000000000/upload", { headers: auth(b.uploadToken), body: zip })).status, 404);
  const other = await begin();
  assert.equal((await call(api.base, "PUT", `/v1/publish/${other.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 401, "token is bound to its job");
  assert.equal(await declareLength(api.base, `/v1/publish/${other.jobId}/upload`, auth(other.uploadToken), 26214401), 413);
});

test("finalizePublish: 409 before upload and on hash mismatch; 202 scanning and enqueued; then dead", async () => {
  const zip = freshZip();
  const seen: string[] = [];
  const unsubscribe = api.queue.subscribe(async (m) => {
    seen.push(m.jobId);
  });
  try {
    const b = await begin();
    const path = `/v1/publish/${b.jobId}/finalize`;
    assert.equal((await call(api.base, "POST", path, { headers: auth(b.uploadToken), json: { sha256: sha(zip) } })).status, 409, "nothing uploaded yet");
    assert.equal((await call(api.base, "PUT", `/v1/publish/${b.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 201);
    assert.equal((await call(api.base, "POST", path, { headers: auth(b.uploadToken), json: { sha256: "0".repeat(64) } })).status, 409, "hash mismatch");
    assert.equal((await call(api.base, "POST", path, { headers: auth(b.uploadToken), json: { sha256: "xyz" } })).status, 400);
    assert.equal((await call(api.base, "POST", path, { headers: auth(b.uploadToken), json: { sha256: sha(zip), extra: 1 } })).status, 400);
    assert.equal((await call(api.base, "POST", path, { json: { sha256: sha(zip) } })).status, 401);
    const ok = await call(api.base, "POST", path, { headers: auth(b.uploadToken), json: { sha256: sha(zip) } });
    assert.equal(ok.status, 202, ok.text);
    assert.equal(ok.body.state, "scanning");
    assert.equal(ok.body.jobId, b.jobId);
    assert.equal(ok.body.tier, "static");
    assert.ok(Date.parse(ok.body.updatedAt) > 0);
    await api.queue.idle();
    assert.deepEqual(seen, [b.jobId], "{ jobId } enqueued");
    assert.equal((await call(api.base, "POST", path, { headers: auth(b.uploadToken), json: { sha256: sha(zip) } })).status, 401, "token dead after finalize");
    assert.equal((await call(api.base, "PUT", `/v1/publish/${b.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 401);
  } finally {
    await unsubscribe();
  }
});

test("the upload token expires after 10 minutes and the job becomes expired", async () => {
  const zip = freshZip();
  const b = await begin();
  const start = api.clock.now;
  api.clock.now = new Date(start.getTime() + 11 * 60_000);
  try {
    assert.equal((await call(api.base, "PUT", `/v1/publish/${b.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 401);
    const s = await call(api.base, "GET", `/v1/publish/${b.jobId}`, { headers: PUBLISHER });
    assert.equal(s.body.state, "expired");
    assert.match(s.body.summary, /upload window/);
  } finally {
    api.clock.now = start;
  }
});

test("getPublishStatus: Status shape; 404 for another caller, unknown or malformed ids; 405 and healthz", async () => {
  const zip = freshZip();
  const b = await begin();
  const s = await call(api.base, "GET", `/v1/publish/${b.jobId}`, { headers: PUBLISHER });
  assert.equal(s.status, 200);
  assert.deepEqual(Object.keys(s.body).sort(), ["jobId", "state", "tier", "updatedAt"], "awaiting_upload carries no artifact expiry yet");
  assert.equal(s.body.state, "awaiting_upload");
  assert.equal((await call(api.base, "PUT", `/v1/publish/${b.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 201);
  assert.equal((await call(api.base, "POST", `/v1/publish/${b.jobId}/finalize`, { headers: auth(b.uploadToken), json: { sha256: sha(zip) } })).status, 202);
  const scanning = await call(api.base, "GET", `/v1/publish/${b.jobId}`, { headers: PUBLISHER });
  assert.deepEqual(Object.keys(scanning.body).sort(), ["expiresAt", "jobId", "state", "tier", "updatedAt"]);
  assert.equal(scanning.body.state, "scanning");
  assert.ok(Math.abs(Date.parse(scanning.body.expiresAt) - api.clock.now.getTime() - 7 * 86_400_000) < 1000, "expiresAt = createdAt + ttlDays");
  assert.equal((await call(api.base, "GET", `/v1/publish/${b.jobId}`, { headers: OTHER_PUBLISHER })).status, 404, "not owned by the caller");
  assert.equal((await call(api.base, "GET", "/v1/publish/job_00000000000000000000", { headers: PUBLISHER })).status, 404);
  assert.equal((await call(api.base, "GET", "/v1/publish/not-a-job", { headers: PUBLISHER })).status, 404);
  assert.equal((await call(api.base, "DELETE", `/v1/publish/${b.jobId}`, { headers: PUBLISHER })).status, 405);
  assert.equal((await call(api.base, "GET", "/v1/nothing")).status, 404);
  assert.equal((await call(api.base, "GET", "/healthz")).status, 200);
});

test("postPublishEvent: pipeline token required; transitions per contracts/states.md; illegal → 409", async () => {
  const zip = freshZip();
  const b = await begin(PUBLISHER, { ...STATIC_MANIFEST, tier: "python", runtime: "python-1", entrypoint: "app.py" });
  const events = `/v1/publish/${b.jobId}/events`;
  const post = (json: unknown, token = api.secrets.pipelineToken) => call(api.base, "POST", events, { headers: auth(token), json });
  assert.equal((await post({ state: "live" }, "wrong")).status, 401);
  assert.equal((await call(api.base, "POST", events, { json: { state: "live" } })).status, 401);
  assert.equal((await post({ state: "live" })).status, 409, "awaiting_upload is never moved by the pipeline");
  // Move to scanning through the real path.
  assert.equal((await call(api.base, "PUT", `/v1/publish/${b.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 201);
  assert.equal((await call(api.base, "POST", `/v1/publish/${b.jobId}/finalize`, { headers: auth(b.uploadToken), json: { sha256: sha(zip) } })).status, 202);
  assert.equal((await post({ state: "live" })).status, 409, "scanning → live is illegal");
  assert.equal((await post({ state: "bogus" })).status, 400);
  assert.equal((await post({ state: "deploying", runUrl: "ftp://x" })).status, 400);
  assert.equal((await post({ state: "deploying", nope: 1 })).status, 400);
  assert.equal((await post({ state: "awaiting_approval", runUrl: "https://dev.azure.com/o/p/_build/results?buildId=1" })).status, 204);
  let s = await call(api.base, "GET", `/v1/publish/${b.jobId}`, { headers: PUBLISHER });
  assert.equal(s.body.state, "awaiting_approval");
  assert.deepEqual(s.body.approval, { group: "artifacts-approvers", runUrl: "https://dev.azure.com/o/p/_build/results?buildId=1" });
  assert.equal((await post({ state: "deploying" })).status, 204);
  assert.equal((await post({ state: "live", message: "rollout healthy" })).status, 204);
  s = await call(api.base, "GET", `/v1/publish/${b.jobId}`, { headers: PUBLISHER });
  assert.equal(s.body.state, "live");
  assert.equal(s.body.summary, "rollout healthy");
  assert.equal((await post({ state: "deploying" })).status, 409);
  assert.equal((await post({ state: "expired" })).status, 204);
  assert.equal((await post({ state: "live" })).status, 409, "terminal");
  assert.equal((await call(api.base, "POST", "/v1/publish/job_00000000000000000000/events", { headers: auth(api.secrets.pipelineToken), json: { state: "live" } })).status, 404);
});

test("createViewToken: internal key required; 404 unless live; token verifies with VIEW_TOKEN_KEY", async () => {
  const b = await begin();
  const job = (await api.stores.jobs.get(b.jobId))!;
  const headers = { "x-internal-caller": api.secrets.internalKey };
  const body = { artifactId: job.artifactId, viewerOid: "viewer-7" };
  assert.equal((await call(api.base, "POST", "/v1/view-token", { json: body })).status, 401);
  assert.equal((await call(api.base, "POST", "/v1/view-token", { headers: { "x-internal-caller": "nope" }, json: body })).status, 401);
  assert.equal((await call(api.base, "POST", "/v1/view-token", { headers, json: body })).status, 404, "awaiting_upload is not live");
  assert.equal((await call(api.base, "POST", "/v1/view-token", { headers, json: { artifactId: "bad", viewerOid: "v" } })).status, 400);
  assert.equal((await call(api.base, "POST", "/v1/view-token", { headers, json: { artifactId: "zzzzzzzzzzzz", viewerOid: "v" } })).status, 404);
  job.state = "live";
  job.url = "http://localhost:8082/view/" + job.artifactId;
  await api.stores.jobs.put(job);
  const r = await call(api.base, "POST", "/v1/view-token", { headers, json: body });
  assert.equal(r.status, 200, r.text);
  const v = verify(r.body.token, api.secrets.viewKey, api.clock.now.getTime());
  assert.ok(v.ok, "token verifies with the shared key");
  assert.equal(v.payload.t, "view");
  assert.equal(v.payload.aid, job.artifactId);
  assert.equal(v.payload.oid, "viewer-7");
  assert.equal(v.payload.exp, Math.floor(api.clock.now.getTime() / 1000) + 300);
  assert.equal(Date.parse(r.body.expiresAt), v.payload.exp * 1000);
  assert.equal(r.body.artifactExpiresAt, job.expiresAt, "artifactExpiresAt is the job's TTL expiry, not the token's");
  job.expiresAt = new Date(api.clock.now.getTime() - 1).toISOString();
  await api.stores.jobs.put(job);
  assert.equal((await call(api.base, "POST", "/v1/view-token", { headers, json: body })).status, 404, "past TTL is not live");
});

test("finalizePublish: an identical bundle from the same publisher still in flight → 409 duplicateOf, the new job is left awaiting_upload", async () => {
  const zip = freshZip();
  const first = await begin();
  const path = (id: string) => `/v1/publish/${id}`;
  assert.equal((await call(api.base, "PUT", `${path(first.jobId)}/upload`, { headers: auth(first.uploadToken), body: zip })).status, 201);
  assert.equal((await call(api.base, "POST", `${path(first.jobId)}/finalize`, { headers: auth(first.uploadToken), json: { sha256: sha(zip) } })).status, 202);
  const second = await begin();
  assert.equal((await call(api.base, "PUT", `${path(second.jobId)}/upload`, { headers: auth(second.uploadToken), body: zip })).status, 201);
  const r = await call(api.base, "POST", `${path(second.jobId)}/finalize`, { headers: auth(second.uploadToken), json: { sha256: sha(zip) } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.duplicateOf, first.jobId);
  assert.equal(r.body.duplicateState, "scanning");
  assert.equal((await call(api.base, "GET", path(second.jobId), { headers: PUBLISHER })).body.state, "awaiting_upload");
  // another publisher with the very same bytes is not a duplicate of someone else's job
  const theirs = await begin(OTHER_PUBLISHER);
  assert.equal((await call(api.base, "PUT", `${path(theirs.jobId)}/upload`, { headers: auth(theirs.uploadToken), body: zip })).status, 201);
  assert.equal((await call(api.base, "POST", `${path(theirs.jobId)}/finalize`, { headers: auth(theirs.uploadToken), json: { sha256: sha(zip) } })).status, 202);
});

test("pipeline fetch: GET record and bundle need the pipeline token; 404 for unknown jobs; bytes round-trip; no token hash leaks", async () => {
  const zip = freshZip();
  const b = await begin();
  assert.equal((await call(api.base, "PUT", `/v1/publish/${b.jobId}/upload`, { headers: auth(b.uploadToken), body: zip })).status, 201);
  assert.equal((await call(api.base, "POST", `/v1/publish/${b.jobId}/finalize`, { headers: auth(b.uploadToken), json: { sha256: sha(zip) } })).status, 202);
  const tok = auth(api.secrets.pipelineToken);
  assert.equal((await call(api.base, "GET", `/v1/publish/${b.jobId}/record`, { headers: PUBLISHER })).status, 401, "publisher identity is not the pipeline");
  assert.equal((await call(api.base, "GET", `/v1/publish/${b.jobId}/bundle`, {})).status, 401);
  const rec = await call(api.base, "GET", `/v1/publish/${b.jobId}/record`, { headers: tok });
  assert.equal(rec.status, 200, rec.text);
  assert.equal(rec.body.jobId, b.jobId);
  assert.equal(rec.body.state, "scanning");
  assert.ok(rec.body.artifactId && rec.body.manifest && rec.body.expiresAt);
  assert.equal(rec.body.uploadTokenHash, undefined, "the token hash never leaves the store");
  const bundle = await call(api.base, "GET", `/v1/publish/${b.jobId}/bundle`, { headers: tok });
  assert.equal(bundle.status, 200);
  assert.equal(bundle.text, zip.toString());
  assert.equal((await call(api.base, "GET", "/v1/publish/job_00000000000000000000/record", { headers: tok })).status, 404);
  assert.equal((await call(api.base, "GET", "/v1/publish/job_00000000000000000000/bundle", { headers: tok })).status, 404);
});

