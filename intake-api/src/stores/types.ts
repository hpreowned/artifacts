// Interfaces for every Azure dependency the API and the worker touch. Each has a real SDK implementation
// (stores/blob.ts, stores/servicebus.ts) and a memory or local-disk one (stores/memory.ts), chosen by BACKEND.
import type { JobRecord } from "../job.js";

export interface JobStore {
  create(job: JobRecord): Promise<void>;
  get(jobId: string): Promise<JobRecord | undefined>;
  put(job: JobRecord): Promise<void>;
  findByArtifactId(artifactId: string): Promise<JobRecord | undefined>;
  /** Every job. Fine for a POC-sized store; GC and expiry sweeps use it. */
  list(): Promise<JobRecord[]>;
}

export interface BundleStore {
  put(jobId: string, data: Buffer): Promise<void>;
  get(jobId: string): Promise<Buffer | undefined>;
  delete(jobId: string): Promise<void>;
}

export interface ServingStore {
  /** Copies `files` (relative posix paths under `dir`) to `<artifactId>/<file>`. Replaces any previous content. */
  publish(artifactId: string, dir: string, files: string[]): Promise<void>;
  remove(artifactId: string): Promise<void>;
}

export interface ScanMessage {
  jobId: string;
}

export interface ScanQueue {
  enqueue(message: ScanMessage): Promise<void>;
  /** Delivers one message at a time to `handler`; returns a function that stops consumption. */
  subscribe(handler: (message: ScanMessage) => Promise<void>): () => Promise<void>;
}

export interface Stores {
  jobs: JobStore;
  bundles: BundleStore;
  serving: ServingStore;
  queue: ScanQueue;
}
