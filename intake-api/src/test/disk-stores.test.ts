import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobRecord } from "../job.js";
import { DiskBundleStore, DiskJobStore } from "../stores/disk.js";
import { loadConfig } from "../config.js";

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  jobId: id, artifactId: "abcdefghij12", ownerOid: "oid-1", ownerUpn: "a@x", tier: "static", state: "scanning",
  manifest: { schemaVersion: 2, name: "x", tier: "static", runtime: null, entrypoint: "index.html", externalScripts: [], ttlDays: 1, generatedBy: { tool: "artifactctl" } } as JobRecord["manifest"],
  createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-10-20T00:00:00.000Z",
  uploadTokenHash: "h", uploadTokenUses: 0, uploadExpiresAt: "2026-10-19T00:10:00.000Z", findings: [], ...over,
});

test("disk job store: create/get/put/find/list, persists across instances, refuses duplicates and bad ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "disk-store-"));
  try {
    const a = new DiskJobStore(root);
    assert.deepEqual(await a.list(), [], "empty before the directory exists");
    await a.create(job("job_aaaaaaaaaaaaaaaaaaaa"));
    await assert.rejects(a.create(job("job_aaaaaaaaaaaaaaaaaaaa")), /already exists/);
    await a.create(job("job_bbbbbbbbbbbbbbbbbbbb", { artifactId: "zzzzzzzzzzzz" }));
    const got = await a.get("job_aaaaaaaaaaaaaaaaaaaa");
    assert.equal(got?.state, "scanning");
    got!.state = "live";
    await a.put(got!);
    const b = new DiskJobStore(root);   // a "restart"
    assert.equal((await b.get("job_aaaaaaaaaaaaaaaaaaaa"))?.state, "live");
    assert.equal((await b.findByArtifactId("zzzzzzzzzzzz"))?.jobId, "job_bbbbbbbbbbbbbbbbbbbb");
    assert.equal((await b.list()).length, 2);
    assert.equal(await b.get("job_cccccccccccccccccccc"), undefined);
    await assert.rejects(b.get("../etc/passwd"), /bad job id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disk bundle store: put/get/delete round-trips bytes and survives a new instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "disk-bundle-"));
  try {
    const a = new DiskBundleStore(root);
    assert.equal(await a.get("job_aaaaaaaaaaaaaaaaaaaa"), undefined);
    await a.put("job_aaaaaaaaaaaaaaaaaaaa", Buffer.from("PK zip bytes"));
    const b = new DiskBundleStore(root);
    assert.equal((await b.get("job_aaaaaaaaaaaaaaaaaaaa"))?.toString(), "PK zip bytes");
    await b.delete("job_aaaaaaaaaaaaaaaaaaaa");
    await b.delete("job_aaaaaaaaaaaaaaaaaaaa");   // idempotent
    assert.equal(await a.get("job_aaaaaaaaaaaaaaaaaaaa"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config: BACKEND=disk and PIPELINE_TRIGGER=manual parse; DATA_ROOT defaults", () => {
  const cfg = loadConfig({ DEV_AUTH: "1", BACKEND: "disk", PIPELINE_TRIGGER: "manual", DATA_ROOT: "/data" });
  assert.equal(cfg.backend, "disk");
  assert.equal(cfg.dataRoot, "/data");
  assert.equal(cfg.worker.pipelineTrigger, "manual");
  assert.equal(loadConfig({ DEV_AUTH: "1" }).backend, "memory");
  assert.match(loadConfig({ DEV_AUTH: "1" }).dataRoot, /\.local\/data$/);
});
