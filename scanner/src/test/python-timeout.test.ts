import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { failTimedOutPythonJobs } from "../python-timeout.js";
import { CORPUS, PYTHON_MANIFEST, STATIC_MANIFEST, harness, runBundle, zipDir } from "./helpers.js";

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

test("a python job stuck in scanning past the timeout fails; a fresh one does not; static is untouched", async () => {
  const h = await harness();
  try {
    // runBundle's harness plays the fake pipeline's callback, landing a python-ok job in awaiting_approval
    // with `runUrl` set. In production the job sits in `scanning` with `runUrl` set until that callback
    // arrives (worker.ts settle()); simulate "it never arrived" by putting the state back to `scanning`.
    const old = await runBundle(h, await zipDir(join(CORPUS, "python-ok")), PYTHON_MANIFEST);
    old.state = "scanning";
    old.updatedAt = hoursAgo(25);
    await h.stores.jobs.put(old);

    const fresh = await runBundle(h, await zipDir(join(CORPUS, "python-ok")), PYTHON_MANIFEST);
    fresh.state = "scanning";
    fresh.updatedAt = hoursAgo(1);
    await h.stores.jobs.put(fresh);

    const staticJob = await runBundle(h, await zipDir(join(CORPUS, "static-ok")), STATIC_MANIFEST);
    staticJob.state = "scanning";
    staticJob.updatedAt = hoursAgo(25);
    await h.stores.jobs.put(staticJob);

    assert.ok((await h.stores.jobs.get(old.jobId))!.runUrl, "sanity: the old job carries a runUrl");

    const failedIds = await failTimedOutPythonJobs(h.stores, 24);
    assert.deepEqual(failedIds, [old.jobId]);

    const after = await h.stores.jobs.get(old.jobId);
    assert.equal(after!.state, "failed");
    assert.deepEqual(after!.findings, [], "finding-free: the pipeline timeout is not a scan rejection");
    assert.match(after!.summary ?? "", /never reported back/);
    assert.ok(after!.summary!.includes(after!.runUrl!), "summary names the run url");

    assert.equal((await h.stores.jobs.get(fresh.jobId))!.state, "scanning", "1h old: untouched");
    assert.equal((await h.stores.jobs.get(staticJob.jobId))!.state, "scanning", "static tier: untouched regardless of age");

    assert.deepEqual(await failTimedOutPythonJobs(h.stores, 24), [], "idempotent: already failed, not swept again");
  } finally {
    await h.cleanup();
  }
});

test("a python job in scanning without a runUrl yet is left alone, however old", async () => {
  const h = await harness();
  try {
    const job = await runBundle(h, await zipDir(join(CORPUS, "python-ok")), PYTHON_MANIFEST);
    job.state = "scanning";
    job.runUrl = undefined;
    job.updatedAt = hoursAgo(48);
    await h.stores.jobs.put(job);
    assert.deepEqual(await failTimedOutPythonJobs(h.stores, 24), []);
    assert.equal((await h.stores.jobs.get(job.jobId))!.state, "scanning");
  } finally {
    await h.cleanup();
  }
});
