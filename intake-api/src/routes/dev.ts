// Dev-only: GET /dev/approval/{jobId}. The local stack has no Azure DevOps, so the fake pipeline's run URL
// points here instead of at a dead host. The page says what this is, where the job stands, and how to
// play the pipeline's remaining callbacks by hand. Served only under DEV_AUTH=1; a 404 otherwise.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fail } from "../http.js";
import type { AppDeps } from "../server.js";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function devApprovalPage(_req: IncomingMessage, res: ServerResponse, deps: AppDeps, jobId: string): Promise<void> {
  if (!deps.cfg.devAuth) fail(404, "not found");
  const job = await deps.stores.jobs.get(jobId);
  if (!job) fail(404, "unknown job");
  const events = `${deps.cfg.publicBaseUrl}/v1/publish/${jobId}/events`;
  const curl = (state: string) =>
    `curl -s -o /dev/null -w '%{http_code}\\n' -X POST ${events} \\\n  -H "Authorization: Bearer $PIPELINE_TOKEN" -H 'content-type: application/json' \\\n  -d '{"state":"${state}"}'`;
  const body = `<!doctype html><meta charset="utf-8"><title>Local approval — ${esc(jobId)}</title>
<style>body{font:15px/1.5 system-ui;max-width:52rem;margin:3rem auto;padding:0 1rem;color:#222}pre{background:#f4f4f4;padding:.8rem;overflow:auto}code{background:#f4f4f4;padding:0 .2rem}.s{display:inline-block;background:#fff3cd;padding:.1rem .5rem;border-radius:.3rem}</style>
<h1>Local stack — this is where the approval run would be</h1>
<p>In production this link is the Azure DevOps run waiting on the <strong>artifacts-approvers</strong> check.
The local stack has no Azure DevOps, so nothing happens here by itself.</p>
<p>Job <code>${esc(jobId)}</code> · tier <code>${esc(job.tier)}</code> · state <span class="s">${esc(job.state)}</span></p>
${job.approval ? `<p>Approval policy (D16): <strong>${job.approval.mode === "auto" ? "auto — the scan was clean, no human in the loop; the fake pipeline already played deploying → live" : "human — a warning sent this to the approver group"}</strong>${job.approval.reasons.length ? `<br>${job.approval.reasons.map(esc).join("<br>")}` : ""}</p>` : ""}
${deps.cfg.worker.pipelineTrigger === "manual" ? `<h2>This stack deploys nothing by itself (PIPELINE_TRIGGER=manual)</h2>
<p>From a laptop with Docker, kubectl and the pipeline token, run <code>scripts/play-node-pipeline.sh ${esc(jobId)}</code>:
it fetches this job's record and bundle from this API, builds the real image, installs the artifact chart on the
cluster and posts the same callbacks the Azure DevOps pipeline would.</p>` : ""}
<h2>Play the pipeline's callbacks by hand</h2>
<p>The token is <code>PIPELINE_TOKEN</code> in <code>.local/dev.env</code> (<code>source scripts/dev-env.sh</code> exports it).</p>
<p>Approve, then report the rollout healthy:</p>
<pre>${esc(curl("deploying"))}\n${esc(curl("live"))}</pre>
<p>Or decline:</p>
<pre>${esc(curl("rejected"))}</pre>
<p>Then ask <code>getPublishStatus</code> again (or <code>artifactctl status ${esc(jobId)}</code>).</p>
<h2>What "live" means locally</h2>
<p>For <code>python</code> and <code>node</code> the state machine goes live, but the local stack runs no server
runtime — the viewer URL will not render the app here. That part is the cluster's job (integration items
I1–I8). What this stack proves is everything up to and including the approval hand-off.</p>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
