// The scan worker: one job per queue message, stages in DESIGN §5 order, verdict from policy.ts, then either
// copy to the serving store (static) or trigger the deploy pipeline (python, and prototype per §6.13). Every exit
// writes a summary.
import { rm } from "node:fs/promises";
import type { Finding, JobRecord, Manifest, State } from "../../intake-api/src/job.js";
import type { Stores } from "../../intake-api/src/stores/types.js";
import { htmlChecks, pythonFileChecks } from "./checks.js";
import type { DefenderReader, DefenderResult } from "./defender.js";
import { extractBundle, type Extracted } from "./extract.js";
import { intakeChecks } from "./intake-checks.js";
import { jsChecks } from "./js-checks.js";
import type { PipelineTrigger } from "./pipeline.js";
import { decideApproval, type ApprovalPolicy } from "./approval-policy.js";
import { severityOf, verdict } from "./policy.js";
import { pythonChecks } from "./python-stage.js";
import { secretsScan } from "./secrets.js";
import { summarize } from "./summary.js";
import { ZipError } from "./zip-read.js";

export interface WorkerOptions {
  gitleaksBin: string;
  pythonBin: string;
  importsScript: string;
  runtimeManifestPath: string;
  shellOrigin: string;
  approverGroup: string;
  /** JS-002: the JFrog npm mirror host every lockfile `resolved` URL must match. */
  npmRegistryHost: string;
  /** D16: `policy` (clean scan → auto, warning → human), or forced either way via APPROVAL_MODE. */
  approvalPolicy: ApprovalPolicy;
}

export interface WorkerDeps {
  stores: Stores;
  defender: DefenderReader;
  pipeline: PipelineTrigger;
  opts: WorkerOptions;
  now?: () => Date;
}

interface ScanContext {
  findings: Finding[];
  extracted?: Extracted;
  manifest?: Manifest;
  /** Set when the job must end `failed` rather than `rejected`: the scan itself could not complete. */
  failure?: string;
}

const WHOLE_BUNDLE_RULES = new Set(["IN-001", "IN-002"]);

export function startWorker(deps: WorkerDeps): () => Promise<void> {
  return deps.stores.queue.subscribe((message) => processJob(message.jobId, deps));
}

export async function processJob(jobId: string, deps: WorkerDeps): Promise<void> {
  const job = await deps.stores.jobs.get(jobId);
  if (!job) {
    console.error(`[worker] ${jobId}: unknown job, dropping the message`);
    return;
  }
  if (job.state !== "scanning") {
    console.warn(`[worker] ${jobId}: state is ${job.state}, nothing to scan`);
    return;
  }
  // Defender scans the blob on upload; start waiting now so it overlaps the other stages (DESIGN §5).
  const defender = deps.defender.result(jobId).catch((err): DefenderResult => {
    console.error(`[worker] ${jobId}: defender reader failed`, err);
    return "Error";
  });
  const ctx: ScanContext = { findings: [] };
  try {
    const zip = await deps.stores.bundles.get(jobId);
    if (zip) await scan(zip, job, defender, deps.opts, ctx);
    else ctx.failure = "the uploaded bundle is missing from the intake store";
  } catch (err) {
    console.error(`[worker] ${jobId}: scan crashed`, err);
    ctx.failure = `scanner error: ${(err as Error).message}`;
  }
  try {
    await settle(job, ctx, deps);
  } finally {
    if (ctx.extracted) await rm(ctx.extracted.dir, { recursive: true, force: true });
  }
}

async function scan(zip: Buffer, job: JobRecord, defender: Promise<DefenderResult>, opts: WorkerOptions, ctx: ScanContext): Promise<void> {
  try {
    ctx.extracted = await extractBundle(zip, job.manifest.tier);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    ctx.findings.push({ rule: "IN-009", severity: "deny", message: `the upload is not a readable zip archive: ${err.message}` });
    return;
  }
  const { dir, files } = ctx.extracted;
  ctx.findings.push(...ctx.extracted.findings);
  if (ctx.findings.some((f) => WHOLE_BUNDLE_RULES.has(f.rule))) return;
  const intake = await intakeChecks(dir, files, job.manifest);
  ctx.findings.push(...intake.findings);
  // Structure problems must be fixed first; running later stages on a broken bundle would be noise.
  if (!intake.manifest || hasDeny(ctx.findings)) return;
  ctx.manifest = intake.manifest;
  ctx.findings.push(...(await secretsScan(dir, files, opts)));
  // Static, python and prototype (DESIGN §6.13) each get their own stage; prototype is whatever tier is neither of the
  // first two (the `Tier` type does not carry "node" yet, see the final report, so this stays an exclusion
  // rather than a literal === "node" check).
  if (ctx.manifest.tier === "static") {
    ctx.findings.push(...(await htmlChecks(dir, files, ctx.manifest)));
  } else if (ctx.manifest.tier === "python") {
    ctx.findings.push(...pythonFileChecks(files));
    ctx.findings.push(...(await pythonChecks(dir, opts)));
  } else {
    ctx.findings.push(...(await jsChecks(dir, files, { npmRegistryHost: opts.npmRegistryHost })));
  }
  const mal = await defender;
  if (mal === "Malicious") {
    ctx.findings.push({ rule: "MAL-001", severity: "deny", message: "Defender for Storage reported the bundle as Malicious" });
  } else if (mal !== "No threats found") {
    ctx.findings.push({ rule: "MAL-002", severity: "deny", message: `Defender for Storage result was "${mal}"; the malware scan did not complete. Resubmit.` });
    ctx.failure = `the malware scan result was "${mal}"`;
  }
}

async function settle(job: JobRecord, ctx: ScanContext, deps: WorkerDeps): Promise<void> {
  const { jobs, bundles, serving } = deps.stores;
  const now = deps.now ?? (() => new Date());
  const { findings, deny } = verdict(ctx.findings);
  job.findings = findings;
  const save = async (state: State, summary: string): Promise<void> => {
    job.state = state;
    job.summary = summary;
    job.updatedAt = now().toISOString();
    await jobs.put(job);
  };
  const dropBundle = () => bundles.delete(job.jobId).catch((err) => console.error(`[worker] ${job.jobId}: bundle delete failed`, err));

  if (ctx.failure) {
    await save("failed", summarize(job, "failed", { reason: ctx.failure }));
    return dropBundle();
  }
  if (deny) {
    await save("rejected", summarize(job, "rejected"));
    return dropBundle();
  }
  if (job.tier === "static") {
    if (!ctx.extracted) {
      await save("failed", summarize(job, "failed", { reason: "nothing was extracted" }));
      return dropBundle();
    }
    await save("deploying", "Scan passed; copying files to the serving store.");
    try {
      await serving.publish(job.artifactId, ctx.extracted.dir, ctx.extracted.files);
    } catch (err) {
      console.error(`[worker] ${job.jobId}: publish to serving failed`, err);
      await save("failed", summarize(job, "failed", { reason: `copying to the serving store failed: ${(err as Error).message}` }));
      return dropBundle();
    }
    job.url = `${deps.opts.shellOrigin}/view/${job.artifactId}`;
    await save("live", summarize(job, "live"));
    return dropBundle();
  }
  // Python and prototype: the job stays `scanning`; the pipeline moves it to awaiting_approval through /events
  // (contracts/states.md says prototype follows the python path verbatim). Same trigger call either way — which
  // Azure DevOps pipeline it reaches (artifact-python-deploy vs artifact-node-deploy) is a config concern for
  // whoever wires the real PipelineTrigger, not the worker (see the final report).
  // D16: decide who approves before the pipeline runs, so the run targets the right Azure DevOps environment.
  const approval = decideApproval(findings, deps.opts.approvalPolicy);
  job.approval = approval;
  await save("scanning", summarize(job, "triggering"));
  try {
    const { runUrl } = await deps.pipeline.triggerDeploy(job.jobId, job.tier === "node" ? "node" : "python", approval.mode);
    const fresh = (await jobs.get(job.jobId)) ?? job;
    fresh.runUrl = runUrl;
    fresh.approval = approval;
    fresh.summary = summarize(fresh, "triggered", { runUrl, group: deps.opts.approverGroup, approval });
    fresh.updatedAt = now().toISOString();
    await jobs.put(fresh);
  } catch (err) {
    console.error(`[worker] ${job.jobId}: pipeline trigger failed`, err);
    await save("failed", summarize(job, "failed", { reason: `the deploy pipeline could not be triggered: ${(err as Error).message}` }));
    await dropBundle();
  }
}

function hasDeny(findings: Finding[]): boolean {
  return findings.some((f) => severityOf(f.rule) === "deny");
}
