// Server-tier hand-off (python and node, contracts/states.md): trigger the Azure DevOps pipeline behind an
// interface; the ADO implementation picks the pipeline id by tier and passes the approval decision (D16) as a
// run parameter. The fake answers with a local run URL and, when given a callback, plays the pipeline's
// callbacks: awaiting_approval on the human path, deploying then live on the auto path.
import { DefaultAzureCredential } from "@azure/identity";
import type { ApprovalMode } from "./approval-policy.js";

export type ServerTier = "python" | "node";

export interface PipelineTrigger {
  triggerDeploy(jobId: string, tier: ServerTier, approval: ApprovalMode): Promise<{ runUrl: string }>;
}

export type TriggeredCallback = (jobId: string, runUrl: string, approval: ApprovalMode) => Promise<void>;

export class FakePipelineTrigger implements PipelineTrigger {
  readonly triggered: { jobId: string; runUrl: string; tier: ServerTier; approval: ApprovalMode }[] = [];
  private readonly pending: Promise<void>[] = [];

  /** `runUrlBase` is where the fake run URL points; the dev stack passes intake's dev approval page. */
  constructor(private readonly onTriggered?: TriggeredCallback, private readonly runUrlBase = "http://localhost/fake-run") {}

  async triggerDeploy(jobId: string, tier: ServerTier, approval: ApprovalMode): Promise<{ runUrl: string }> {
    const runUrl = `${this.runUrlBase}/${jobId}`;
    this.triggered.push({ jobId, runUrl, tier, approval });
    if (this.onTriggered) {
      // Deferred so the worker's own write of the job lands before the fake pipeline's callback.
      const callback = this.onTriggered;
      this.pending.push(
        new Promise<void>((resolve) => setImmediate(resolve)).then(() => callback(jobId, runUrl, approval)).catch((err) => {
          console.error(`[pipeline] fake callback for ${jobId} failed`, err);
        }),
      );
    }
    return { runUrl };
  }

  /** Waits for every deferred callback; tests use it instead of sleeping. */
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}

/** Posts `awaiting_approval` to intake's /events, exactly as the real pipeline's Fetch stage does. */
/** What the real pipeline would post, played by the fake: the approval check on the human path, a straight
 *  deploy on the auto path. Locally no runtime exists, so "live" is the state machine only (dev page says so). */
export function postFakeCallbacks(intakeBaseUrl: string, pipelineToken: string): TriggeredCallback {
  const base = intakeBaseUrl.replace(/\/+$/, "");
  return async (jobId, runUrl, approval) => {
    const steps: { state: string; message: string }[] = approval === "human"
      ? [{ state: "awaiting_approval", message: "Fake pipeline: waiting for approval (dev stack)." }]
      : [
          { state: "deploying", message: "Fake pipeline: clean scan, auto-approved by policy (dev stack)." },
          { state: "live", message: "Fake pipeline: rollout reported healthy (dev stack; no runtime runs locally)." },
        ];
    for (const { state, message } of steps) {
      const res = await fetch(`${base}/v1/publish/${jobId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${pipelineToken}`, "content-type": "application/json" },
        body: JSON.stringify({ state, runUrl, message }),
      });
      if (!res.ok) throw new Error(`intake answered ${res.status} to the ${state} event`);
    }
  };
}

/** Azure DevOps resource id; the worker's workload identity needs Queue builds on the one pipeline (DESIGN §6.12). */
export const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

export interface TokenSource {
  getToken(scope: string): Promise<{ token: string } | null>;
}

export class AzureDevOpsPipelineTrigger implements PipelineTrigger {
  constructor(
    private readonly org: string,
    private readonly project: string,
    private readonly pipelineId: string,
    private readonly nodePipelineId: string,
    private readonly credential: TokenSource = new DefaultAzureCredential(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async triggerDeploy(jobId: string, tier: ServerTier, approval: ApprovalMode): Promise<{ runUrl: string }> {
    const token = await this.credential.getToken(ADO_SCOPE);
    if (!token) throw new Error("could not obtain an Azure DevOps access token");
    const pipelineId = tier === "node" ? this.nodePipelineId : this.pipelineId;
    const url = `https://dev.azure.com/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/_apis/pipelines/${encodeURIComponent(pipelineId)}/runs?api-version=7.1`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ templateParameters: { jobId, approvalMode: approval } }),
    });
    if (!res.ok) throw new Error(`Azure DevOps run request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { _links?: { web?: { href?: string } }; url?: string };
    const runUrl = body._links?.web?.href ?? body.url;
    if (!runUrl) throw new Error("Azure DevOps response carried no run URL");
    return { runUrl };
  }
}
