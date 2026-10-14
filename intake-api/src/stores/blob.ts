// Azure Blob implementations. Containers: jobs (`<jobId>.json` + `by-artifact/<artifactId>`), intake (`<jobId>.zip`),
// serving (`<artifactId>/<file>`). Auth: DefaultAzureCredential (workload identity in-cluster, az login on a laptop).
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { join } from "node:path";
import type { JobRecord } from "../job.js";
import type { BundleStore, JobStore, ServingStore } from "./types.js";

export function blobService(accountUrl: string): BlobServiceClient {
  return new BlobServiceClient(accountUrl, new DefaultAzureCredential());
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404;
}

async function downloadOrUndefined(container: ContainerClient, name: string): Promise<Buffer | undefined> {
  try {
    return await container.getBlobClient(name).downloadToBuffer();
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export class BlobJobStore implements JobStore {
  constructor(private readonly container: ContainerClient) {}

  async create(job: JobRecord): Promise<void> {
    const body = JSON.stringify(job);
    await this.container.getBlockBlobClient(`${job.jobId}.json`).upload(body, Buffer.byteLength(body), {
      conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
    await this.container.getBlockBlobClient(`by-artifact/${job.artifactId}`).upload(job.jobId, job.jobId.length);
  }
  async get(jobId: string): Promise<JobRecord | undefined> {
    const data = await downloadOrUndefined(this.container, `${jobId}.json`);
    return data ? (JSON.parse(data.toString("utf8")) as JobRecord) : undefined;
  }
  async put(job: JobRecord): Promise<void> {
    const body = JSON.stringify(job);
    await this.container.getBlockBlobClient(`${job.jobId}.json`).upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  }
  async findByArtifactId(artifactId: string): Promise<JobRecord | undefined> {
    const ref = await downloadOrUndefined(this.container, `by-artifact/${artifactId}`);
    return ref ? this.get(ref.toString("utf8").trim()) : undefined;
  }
  async list(): Promise<JobRecord[]> {
    const jobs: JobRecord[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix: "job_" })) {
      const job = await this.get(blob.name.replace(/\.json$/, ""));
      if (job) jobs.push(job);
    }
    return jobs;
  }
}

export class BlobBundleStore implements BundleStore {
  constructor(private readonly container: ContainerClient) {}
  async put(jobId: string, data: Buffer): Promise<void> {
    // Defender for Storage scans on BlobCreated. Never set metadata in a second call (DESIGN §6.11).
    await this.container.getBlockBlobClient(`${jobId}.zip`).upload(data, data.length, {
      blobHTTPHeaders: { blobContentType: "application/zip" },
    });
  }
  async get(jobId: string): Promise<Buffer | undefined> {
    return downloadOrUndefined(this.container, `${jobId}.zip`);
  }
  async delete(jobId: string): Promise<void> {
    await this.container.getBlobClient(`${jobId}.zip`).deleteIfExists();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", woff2: "font/woff2", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", py: "text/x-python; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export class BlobServingStore implements ServingStore {
  constructor(private readonly container: ContainerClient) {}
  async publish(artifactId: string, dir: string, files: string[]): Promise<void> {
    await this.remove(artifactId);
    for (const file of files) {
      await this.container.getBlockBlobClient(`${artifactId}/${file}`).uploadFile(join(dir, file), {
        blobHTTPHeaders: { blobContentType: contentTypeFor(file), blobCacheControl: "private, no-store" },
      });
    }
  }
  async remove(artifactId: string): Promise<void> {
    for await (const blob of this.container.listBlobsFlat({ prefix: `${artifactId}/` })) {
      await this.container.getBlobClient(blob.name).deleteIfExists();
    }
  }
}
