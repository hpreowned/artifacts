import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { JobRecord } from "../job.js";
import type { BundleStore, JobStore, ScanMessage, ScanQueue, ServingStore } from "./types.js";

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  async create(job: JobRecord): Promise<void> {
    if (this.jobs.has(job.jobId)) throw new Error(`job ${job.jobId} already exists`);
    this.jobs.set(job.jobId, structuredClone(job));
  }
  async get(jobId: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }
  async put(job: JobRecord): Promise<void> {
    this.jobs.set(job.jobId, structuredClone(job));
  }
  async findByArtifactId(artifactId: string): Promise<JobRecord | undefined> {
    for (const job of this.jobs.values()) if (job.artifactId === artifactId) return structuredClone(job);
    return undefined;
  }
  async list(): Promise<JobRecord[]> {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }
}

export class MemoryBundleStore implements BundleStore {
  private readonly bundles = new Map<string, Buffer>();
  async put(jobId: string, data: Buffer): Promise<void> {
    this.bundles.set(jobId, Buffer.from(data));
  }
  async get(jobId: string): Promise<Buffer | undefined> {
    return this.bundles.get(jobId);
  }
  async delete(jobId: string): Promise<void> {
    this.bundles.delete(jobId);
  }
}

/** Serves from `<root>/<artifactId>/<files>`; the static gateway reads the same layout in dev. */
export class LocalServingStore implements ServingStore {
  constructor(private readonly root: string) {}

  async publish(artifactId: string, dir: string, files: string[]): Promise<void> {
    const target = this.dirFor(artifactId);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const file of files) {
      const dest = resolve(target, file);
      if (!dest.startsWith(target + sep)) throw new Error(`refusing to publish outside the artifact directory: ${file}`);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(dir, file), dest, { dereference: false });
    }
  }
  async remove(artifactId: string): Promise<void> {
    await rm(this.dirFor(artifactId), { recursive: true, force: true });
  }
  private dirFor(artifactId: string): string {
    if (!/^[a-z0-9]{12}$/.test(artifactId)) throw new Error(`bad artifact id ${artifactId}`);
    return resolve(this.root, artifactId);
  }
}

/** In-process queue for the dev stack and tests. Messages are handled one at a time, in order. */
export class MemoryScanQueue implements ScanQueue {
  private readonly pending: ScanMessage[] = [];
  private handler: ((m: ScanMessage) => Promise<void>) | undefined;
  private draining = false;

  async enqueue(message: ScanMessage): Promise<void> {
    this.pending.push({ ...message });
    this.drain();
  }
  subscribe(handler: (message: ScanMessage) => Promise<void>): () => Promise<void> {
    this.handler = handler;
    this.drain();
    return async () => {
      this.handler = undefined;
    };
  }
  /** Resolves once every queued message has been handled. Tests use it instead of polling. */
  async idle(): Promise<void> {
    while (this.draining || (this.pending.length > 0 && this.handler)) await new Promise((r) => setTimeout(r, 5));
  }
  private drain(): void {
    if (this.draining || !this.handler) return;
    this.draining = true;
    setImmediate(async () => {
      try {
        while (this.handler && this.pending.length > 0) {
          const message = this.pending.shift()!;
          try {
            await this.handler(message);
          } catch (err) {
            console.error(`[queue] handler failed for ${message.jobId}:`, err);
          }
        }
      } finally {
        this.draining = false;
      }
    });
  }
}
