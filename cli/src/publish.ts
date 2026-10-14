// The publish flow: bundle → beginPublish → upload → finalize → optionally poll until the job settles.
import { readBundle } from "./bundle.js";
import { ApiError, IntakeClient, TERMINAL_STATES, type Finding, type Status } from "./client.js";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called on every state change, including the first observed state. */
  onState?: (s: Status) => void;
}

export interface PollResult {
  status: Status;
  /** True when timeoutMs elapsed before a terminal state or awaiting_approval. */
  timedOut: boolean;
}

/** GET /v1/publish/{jobId} every intervalMs until rejected, awaiting_approval, live, failed, expired, or timeout. */
export async function pollUntilSettled(client: IntakeClient, jobId: string, opts: PollOptions): Promise<PollResult> {
  const start = opts.now();
  let last: Status | undefined;
  for (;;) {
    const s = await client.status(jobId);
    if (!last || last.state !== s.state) opts.onState?.(s);
    last = s;
    if (TERMINAL_STATES.has(s.state)) return { status: s, timedOut: false };
    if (opts.now() - start >= opts.timeoutMs) return { status: s, timedOut: true };
    await opts.sleep(opts.intervalMs);
  }
}

/**
 * A 400 from beginPublish means the manifest failed stage 1 before a job existed. Report it the way the
 * scanner would: state rejected, the server's findings, or IN-006 (contracts/findings.md) when it sent none.
 */
export function manifestRejected(e: ApiError, now: () => number): Status {
  const findings: Finding[] =
    e.findings.length > 0
      ? e.findings
      : [{ rule: "IN-006", severity: "deny", file: "manifest.json", line: 0, message: e.message }];
  return { jobId: "", state: "rejected", updatedAt: new Date(now()).toISOString(), findings, summary: e.message };
}

export interface PublishOptions extends PollOptions {
  wait: boolean;
  log: (line: string) => void;
}

export async function publish(client: IntakeClient, dir: string, opts: PublishOptions): Promise<PollResult> {
  const bundle = readBundle(dir);
  opts.log(`bundle: ${bundle.files.length} files, ${bundle.zip.length} bytes, sha256 ${bundle.sha256}`);
  let begin;
  try {
    begin = await client.beginPublish(bundle.manifest);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) return { status: manifestRejected(e, opts.now), timedOut: false };
    throw e;
  }
  if (bundle.zip.length > begin.maxBytes) {
    throw new ApiError(`bundle is ${bundle.zip.length} bytes; the API allows ${begin.maxBytes} (rule IN-001)`, 413);
  }
  opts.log(`job ${begin.jobId}: uploading (token expires ${begin.uploadExpiresAt})`);
  await client.upload(begin.uploadUrl, begin.uploadToken, bundle.zip);
  const queued = await client.finalize(begin.uploadUrl, begin.uploadToken, bundle.sha256);
  opts.log(`job ${begin.jobId}: ${queued.state}`);
  if (!opts.wait) return { status: queued, timedOut: false };
  return pollUntilSettled(client, begin.jobId, {
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
    sleep: opts.sleep,
    now: opts.now,
    onState: (s) => {
      if (s.state !== queued.state) opts.log(`job ${s.jobId}: ${s.state}`);
    },
  });
}
