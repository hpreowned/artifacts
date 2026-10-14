// contracts/states.md: awaiting_upload → expired by intake-api after 10 minutes without finalize.
import type { JobRecord } from "./job.js";
import type { JobStore } from "./stores/types.js";

/** Mutates the job to `expired` when its upload window has passed. Returns true when it did. */
export function expireIfStale(job: JobRecord, now: Date): boolean {
  if (job.state !== "awaiting_upload" || Date.parse(job.uploadExpiresAt) > now.getTime()) return false;
  job.state = "expired";
  job.updatedAt = now.toISOString();
  job.summary = "The upload window (10 minutes) closed before finalize. Start a new publish.";
  return true;
}

export async function expireStaleUploads(jobs: JobStore, now: Date = new Date()): Promise<number> {
  let count = 0;
  for (const job of await jobs.list()) {
    if (expireIfStale(job, now)) {
      await jobs.put(job);
      count++;
    }
  }
  return count;
}

export function startExpirySweeper(jobs: JobStore, intervalSeconds: number): () => void {
  const timer = setInterval(() => {
    expireStaleUploads(jobs).catch((err) => console.error("[expiry] sweep failed", err));
  }, intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
