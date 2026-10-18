// Shared test plumbing: corpus zips, job records, a worker harness on memory backends, a fake gitleaks.
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyEvent, type JobRecord, type Manifest } from "../../../intake-api/src/job.js";
import { REPO_ROOT } from "../../../intake-api/src/repo-root.js";
import { LocalServingStore, MemoryBundleStore, MemoryJobStore, MemoryScanQueue } from "../../../intake-api/src/stores/memory.js";
import type { Stores } from "../../../intake-api/src/stores/types.js";
import { FakeDefenderReader } from "../defender.js";
import { FakePipelineTrigger } from "../pipeline.js";
import { processJob, type WorkerDeps, type WorkerOptions } from "../worker.js";
import { writeZip, type ZipInput } from "../zip-write.js";

export const CORPUS = resolve(REPO_ROOT, "tests", "corpus");
export const RUNTIME_MANIFEST = resolve(REPO_ROOT, "tests", "runtime-manifest.python-1.json");
export const IMPORTS_SCRIPT = resolve(REPO_ROOT, "scanner", "imports.py");

export const STATIC_MANIFEST: Manifest = {
  schemaVersion: 2, name: "test-static", tier: "static", runtime: null, entrypoint: "index.html",
  externalScripts: ["https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"], ttlDays: 14,
  generatedBy: { tool: "artifactctl", model: "test", session: "test" },
};
export const PYTHON_MANIFEST: Manifest = {
  schemaVersion: 2, name: "test-python", tier: "python", runtime: "python-1", entrypoint: "app.py",
  externalScripts: [], ttlDays: 14, generatedBy: { tool: "artifactctl", model: "test", session: "test" },
};
/**
 * `as unknown as Manifest`: intake-api/src/job.ts's `Tier`/`Manifest` types do not carry "node"/"node-20"/
 * "package.json" yet (not scanner's file to change; see the final report). The schema at
 * contracts/manifest.schema.json already validates this shape; only the local TS literal type lags.
 */
export const NODE_TIER_MANIFEST = {
  schemaVersion: 2, name: "test-prototype", tier: "node", runtime: "node-20", entrypoint: "package.json",
  externalScripts: [], ttlDays: 14, generatedBy: { tool: "artifactctl", model: "test", session: "test" },
} as unknown as Manifest;

/** Zips a directory as a bundle (relative posix paths, deflate). `expected.json` is test metadata, not bundle content. */
export async function zipDir(dir: string, skip: string[] = ["expected.json"]): Promise<Buffer> {
  const inputs: ZipInput[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of (await readdir(join(dir, rel))).sort()) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (skip.includes(relPath)) continue;
      const info = await stat(join(dir, relPath));
      if (info.isDirectory()) await walk(relPath);
      else inputs.push({ name: relPath, data: await readFile(join(dir, relPath)) });
    }
  };
  await walk("");
  return writeZip(inputs);
}

export function zipOf(files: Record<string, string | Buffer>): Buffer {
  return writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

let counter = 0;
export function makeJob(manifest: Manifest, overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date();
  const n = String(counter++).padStart(4, "0");
  return {
    jobId: `job_test${n}${"x".repeat(12)}`.slice(0, 24),
    artifactId: `art${n}xxxxx`.slice(0, 12),
    ownerOid: "owner-1", ownerUpn: "owner@example.test",
    manifest, tier: manifest.tier, state: "scanning",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + manifest.ttlDays * 86_400_000).toISOString(),
    uploadTokenHash: "", uploadTokenUses: 2,
    uploadExpiresAt: new Date(now.getTime() + 600_000).toISOString(),
    sha256: "0".repeat(64), findings: [],
    ...overrides,
  };
}

export interface Harness {
  stores: Stores;
  queue: MemoryScanQueue;
  defender: FakeDefenderReader;
  pipeline: FakePipelineTrigger;
  deps: WorkerDeps;
  serveRoot: string;
  workDir: string;
  cleanup(): Promise<void>;
}

/** Memory stores, fake Defender, a fake pipeline that plays the pipeline callbacks back into the job store. */
export async function harness(overrides: Partial<WorkerOptions> = {}): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), "scanner-test-"));
  const serveRoot = join(workDir, "serving");
  const queue = new MemoryScanQueue();
  const stores: Stores = { jobs: new MemoryJobStore(), bundles: new MemoryBundleStore(), serving: new LocalServingStore(serveRoot), queue };
  const defender = new FakeDefenderReader();
  const pipeline = new FakePipelineTrigger(async (jobId, runUrl, approval) => {
    const job = await stores.jobs.get(jobId);
    if (!job) return;
    // D16: the real pipeline posts awaiting_approval on the human path, deploying then live on the auto path.
    const states = approval === "auto" ? (["deploying", "live"] as const) : (["awaiting_approval"] as const);
    for (const state of states) if (applyEvent(job, { state, runUrl })) await stores.jobs.put(job);
  });
  const opts: WorkerOptions = {
    gitleaksBin: await fakeGitleaks(workDir), pythonBin: "python3", importsScript: IMPORTS_SCRIPT,
    runtimeManifestPath: RUNTIME_MANIFEST, shellOrigin: "http://localhost:8082", approverGroup: "artifacts-approvers",
    npmRegistryHost: "jfrog.corp.com", approvalPolicy: "policy", ...overrides,
  };
  return {
    stores, queue, defender, pipeline, serveRoot, workDir,
    deps: { stores, defender, pipeline, opts },
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

/** Stores the zip and job (state scanning), runs the worker once, waits for the fake pipeline, returns the job. */
export async function runBundle(h: Harness, zip: Buffer, manifest: Manifest, overrides: Partial<JobRecord> = {}): Promise<JobRecord> {
  const job = makeJob(manifest, overrides);
  await h.stores.jobs.create(job);
  await h.stores.bundles.put(job.jobId, zip);
  await processJob(job.jobId, h.deps);
  await h.pipeline.drain();
  return (await h.stores.jobs.get(job.jobId))!;
}

/**
 * A stand-in gitleaks: writes the JSON in $FAKE_GITLEAKS_REPORT (default `[]`) to --report-path, exits 0.
 * Lets tests cover the report parsing without the real binary; the built-in pack still runs alongside.
 */
export async function fakeGitleaks(dir: string): Promise<string> {
  const path = join(dir, "fake-gitleaks.sh");
  const script = [
    "#!/bin/sh", 'report=""',
    'while [ $# -gt 0 ]; do case "$1" in --report-path) report="$2"; shift;; esac; shift; done',
    'printf "%s" "${FAKE_GITLEAKS_REPORT:-[]}" > "$report"', "",
  ].join("\n");
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return path;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
