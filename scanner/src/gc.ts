// Static-tier garbage collection (contracts/states.md: live → expired by the scanner worker GC for static).
// Python artifacts are expired by the artifact-gc pipeline through /events, not here.
import type { Stores } from "../../intake-api/src/stores/types.js";

export async function expireStaticArtifacts(stores: Stores, now: Date = new Date()): Promise<string[]> {
  const expired: string[] = [];
  for (const job of await stores.jobs.list()) {
    if (job.state !== "live" || job.tier !== "static" || Date.parse(job.expiresAt) > now.getTime()) continue;
    try {
      await stores.serving.remove(job.artifactId);
    } catch (err) {
      console.error(`[gc] ${job.jobId}: removing ${job.artifactId} from serving failed; will retry`, err);
      continue;
    }
    job.state = "expired";
    job.summary = `"${job.manifest.name}" reached its TTL on ${job.expiresAt.slice(0, 10)} and was removed. Publish again to get a new link.`;
    job.updatedAt = now.toISOString();
    await stores.jobs.put(job);
    expired.push(job.jobId);
  }
  return expired;
}

export function startGc(stores: Stores, intervalSeconds: number): () => void {
  const tick = () => {
    expireStaticArtifacts(stores)
      .then((ids) => ids.length && console.log(`[gc] expired ${ids.length} static artifact(s): ${ids.join(", ")}`))
      .catch((err) => console.error("[gc] sweep failed", err));
  };
  const timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
