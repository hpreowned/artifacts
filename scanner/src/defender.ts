// Stage 3: malware. Defender for Storage scans intake/<jobId>.zip on upload and writes a blob index tag.
// The reader interface hides that; the fake is used by BACKEND=memory and by tests.
import type { ContainerClient } from "@azure/storage-blob";
import { setTimeout as sleep } from "node:timers/promises";

export type DefenderResult = "No threats found" | "Malicious" | "Error" | "Not scanned" | "Timeout";

export interface DefenderReader {
  /** Resolves with the scan result for `intake/<jobId>.zip`, waiting up to the configured timeout. Never throws. */
  result(jobId: string): Promise<DefenderResult>;
}

/** `No threats found` for everything except the configured malicious job ids (DEFENDER_FAKE_MALICIOUS) or forced results. */
export class FakeDefenderReader implements DefenderReader {
  private readonly forced = new Map<string, DefenderResult>();
  constructor(private readonly malicious: ReadonlySet<string> = new Set()) {}

  force(jobId: string, result: DefenderResult): void {
    this.forced.set(jobId, result);
  }
  async result(jobId: string): Promise<DefenderResult> {
    return this.forced.get(jobId) ?? (this.malicious.has(jobId) ? "Malicious" : "No threats found");
  }
}

/** The part of ContainerClient the poller uses; tests substitute a stub. */
export interface TagSource {
  getBlobClient(name: string): { getTags(): Promise<{ tags: Record<string, string> }> };
}

/**
 * Polls the index tag Defender writes (`Malware Scanning scan result`; any key ending in "scan result" is accepted)
 * every `pollSeconds` until `timeoutSeconds`. DESIGN §5 notes index tags are the POC mechanism; production should
 * consume the Event Grid event instead.
 */
export class BlobTagDefenderReader implements DefenderReader {
  constructor(
    private readonly container: TagSource | ContainerClient,
    private readonly timeoutSeconds: number,
    private readonly pollSeconds: number = 2,
  ) {}

  async result(jobId: string): Promise<DefenderResult> {
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    const blob = this.container.getBlobClient(`${jobId}.zip`);
    for (;;) {
      try {
        const { tags } = await blob.getTags();
        const value = scanResultTag(tags);
        if (value !== undefined) return normalizeResult(value);
      } catch (err) {
        console.error(`[defender] reading tags for ${jobId} failed`, err);
        return "Error";
      }
      if (Date.now() >= deadline) return "Timeout";
      await sleep(this.pollSeconds * 1000);
    }
  }
}

export function scanResultTag(tags: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(tags)) if (/scan result$/i.test(key.trim())) return value;
  return undefined;
}

/** Anything that is not literally a clean result is treated as an error: never auto-allow (contracts/states.md). */
export function normalizeResult(value: string): DefenderResult {
  const v = value.trim().toLowerCase();
  if (v === "no threats found") return "No threats found";
  if (v === "malicious") return "Malicious";
  if (v === "not scanned") return "Not scanned";
  return "Error";
}
