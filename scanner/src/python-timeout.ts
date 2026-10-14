// Python-tier pipeline timeout (contracts/states.md: scanning → failed, scanner worker, "python job: runUrl
// set but no /events callback within PIPELINE_TIMEOUT_HOURS"). Swept from the same periodic loop as the
// static-tier GC (gc.ts) so there is one maintenance timer, not two.
import type { Stores } from "../../intake-api/src/stores/types.js";

/**
 * Fails every python job stuck in `scanning` with a `runUrl` whose `updatedAt` is older than `timeoutHours`:
 * the deploy pipeline reached the approval check (or later) but never called back on `/events`. The job gets
 * no findings (the scan itself passed; this is an infrastructure timeout, not a policy rejection) — only a
 * plain-language summary naming the run URL, per T13.
 */
export async function failTimedOutPythonJobs(stores: Stores, timeoutHours: number, now: Date = new Date()): Promise<string[]> {
  const cutoff = now.getTime() - timeoutHours * 3_600_000;
  const failed: string[] = [];
  for (const job of await stores.jobs.list()) {
    if (job.state !== "scanning" || job.tier !== "python" || !job.runUrl) continue;
    if (Date.parse(job.updatedAt) > cutoff) continue;
    job.state = "failed";
    job.summary = `"${job.manifest.name}" could not be scanned: the deploy pipeline at ${job.runUrl} never reported back within ${timeoutHours}h. Nothing was published. Publish again; if it keeps failing, contact the platform team.`;
    job.updatedAt = now.toISOString();
    await stores.jobs.put(job);
    failed.push(job.jobId);
  }
  return failed;
}
