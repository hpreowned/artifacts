// On-disk job and bundle stores for the single-process deployments: the laptop stack and the dev-cluster
// all-in-one pod. One JSON file per job, one zip per bundle, under DATA_ROOT; survives a pod restart, which
// memory does not. Writes are tmp-file + rename so a crash never leaves a half-written record. Not for the
// real platform, which is multi-process and uses Blob.
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JobRecord } from "../job.js";
import type { BundleStore, JobStore } from "./types.js";

const JOB_ID = /^job_[a-z0-9]{20}$/;

function checked(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error(`bad job id ${jobId}`);
  return jobId;
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export class DiskJobStore implements JobStore {
  private readonly dir: string;
  constructor(root: string) {
    this.dir = resolve(root, "jobs");
  }
  private path(jobId: string): string {
    return join(this.dir, `${checked(jobId)}.json`);
  }
  async create(job: JobRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (await this.get(job.jobId)) throw new Error(`job ${job.jobId} already exists`);
    await writeAtomic(this.path(job.jobId), JSON.stringify(job));
  }
  async get(jobId: string): Promise<JobRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(jobId), "utf8")) as JobRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
  async put(job: JobRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(this.path(job.jobId), JSON.stringify(job));
  }
  async findByArtifactId(artifactId: string): Promise<JobRecord | undefined> {
    return (await this.list()).find((j) => j.artifactId === artifactId);
  }
  async list(): Promise<JobRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const jobs: JobRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const job = await this.get(name.slice(0, -".json".length)).catch(() => undefined);
      if (job) jobs.push(job);
    }
    return jobs;
  }
}

export class DiskBundleStore implements BundleStore {
  private readonly dir: string;
  constructor(root: string) {
    this.dir = resolve(root, "bundles");
  }
  private path(jobId: string): string {
    return join(this.dir, `${checked(jobId)}.zip`);
  }
  async put(jobId: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(this.path(jobId), data);
  }
  async get(jobId: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(jobId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
  async delete(jobId: string): Promise<void> {
    await rm(this.path(jobId), { force: true });
  }
}
