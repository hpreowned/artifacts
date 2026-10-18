import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { expireStaticArtifacts } from "../gc.js";
import { CORPUS, PYTHON_MANIFEST, STATIC_MANIFEST, harness, runBundle, zipDir } from "./helpers.js";

test("GC expires live static artifacts past their TTL and removes their files; nothing else", async () => {
  const h = await harness();
  try {
    const zip = await zipDir(join(CORPUS, "static-ok"));
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const expired = await runBundle(h, zip, STATIC_MANIFEST, { expiresAt: past });
    const fresh = await runBundle(h, zip, STATIC_MANIFEST, { expiresAt: future });
    assert.equal(expired.state, "live");
    assert.equal(fresh.state, "live");
    const python = await runBundle(h, await zipDir(join(CORPUS, "python-ok")), PYTHON_MANIFEST, { expiresAt: past });
    assert.equal(python.state, "live", "D16 auto path: clean python bundle goes live via the fake pipeline");
    const rejected = await runBundle(h, await zipDir(join(CORPUS, "static-eval")), STATIC_MANIFEST, { expiresAt: past });
    assert.equal(rejected.state, "rejected");

    const ids = await expireStaticArtifacts(h.stores);
    assert.deepEqual(ids, [expired.jobId]);
    assert.equal((await h.stores.jobs.get(expired.jobId))!.state, "expired");
    assert.ok(!existsSync(join(h.serveRoot, expired.artifactId)), "files removed");
    assert.equal((await h.stores.jobs.get(fresh.jobId))!.state, "live");
    assert.ok(existsSync(join(h.serveRoot, fresh.artifactId, "index.html")));
    assert.equal((await h.stores.jobs.get(python.jobId))!.state, "live", "python expiry belongs to the gc pipeline");
    assert.equal((await h.stores.jobs.get(rejected.jobId))!.state, "rejected");
    assert.deepEqual(await expireStaticArtifacts(h.stores), [], "idempotent");
  } finally {
    await h.cleanup();
  }
});
