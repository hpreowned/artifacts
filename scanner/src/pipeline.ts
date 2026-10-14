// Python tier hand-off: trigger the Azure DevOps pipeline (DESIGN §6.12) behind an interface. The fake answers
// with a local run URL and, when given a callback, plays the pipeline's first callback (awaiting_approval).
import { DefaultAzureCredential } from "@azure/identity";

export interface PipelineTrigger {
  triggerPythonDeploy(jobId: string): Promise<{ runUrl: string }>;
}

export type TriggeredCallback = (jobId: string, runUrl: string) => Promise<void>;

export class FakePipelineTrigger implements PipelineTrigger {
  readonly triggered: { jobId: string; runUrl: string }[] = [];
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly onTriggered?: TriggeredCallback) {}

  async triggerPythonDeploy(jobId: string): Promise<{ runUrl: string }> {
    const runUrl = `http://localhost/fake-run/${jobId}`;
    this.triggered.push({ jobId, runUrl });
    if (this.onTriggered) {
      // Deferred so the worker's own write of the job lands before the fake pipeline's callback.
      const callback = this.onTriggered;
      this.pending.push(
        new Promise<void>((resolve) => setImmediate(resolve)).then(() => callback(jobId, runUrl)).catch((err) => {
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
export function postAwaitingApproval(intakeBaseUrl: string, pipelineToken: string): TriggeredCallback {
  return async (jobId, runUrl) => {
    const res = await fetch(`${intakeBaseUrl.replace(/\/+$/, "")}/v1/publish/${jobId}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${pipelineToken}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "awaiting_approval", runUrl, message: "Fake pipeline: waiting for approval (dev stack)." }),
    });
    if (!res.ok) throw new Error(`intake answered ${res.status} to the awaiting_approval event`);
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
    private readonly credential: TokenSource = new DefaultAzureCredential(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async triggerPythonDeploy(jobId: string): Promise<{ runUrl: string }> {
    const token = await this.credential.getToken(ADO_SCOPE);
    if (!token) throw new Error("could not obtain an Azure DevOps access token");
    const url = `https://dev.azure.com/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/_apis/pipelines/${encodeURIComponent(this.pipelineId)}/runs?api-version=7.1`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ templateParameters: { jobId } }),
    });
    if (!res.ok) throw new Error(`Azure DevOps run request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { _links?: { web?: { href?: string } }; url?: string };
    const runUrl = body._links?.web?.href ?? body.url;
    if (!runUrl) throw new Error("Azure DevOps response carried no run URL");
    return { runUrl };
  }
}
