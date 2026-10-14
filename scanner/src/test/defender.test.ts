import assert from "node:assert/strict";
import { test } from "node:test";
import { BlobTagDefenderReader, FakeDefenderReader, normalizeResult, scanResultTag, type TagSource } from "../defender.js";
import { ADO_SCOPE, AzureDevOpsPipelineTrigger, FakePipelineTrigger } from "../pipeline.js";

test("fake reader: clean by default, malicious set, forced results", async () => {
  const r = new FakeDefenderReader(new Set(["job_bad"]));
  assert.equal(await r.result("job_ok"), "No threats found");
  assert.equal(await r.result("job_bad"), "Malicious");
  r.force("job_ok", "Not scanned");
  assert.equal(await r.result("job_ok"), "Not scanned");
});

test("tag lookup accepts Defender's key and the short form; unknown values never pass", () => {
  assert.equal(scanResultTag({ "Malware Scanning scan result": "No threats found" }), "No threats found");
  assert.equal(scanResultTag({ "Scan result": "Malicious", other: "x" }), "Malicious");
  assert.equal(scanResultTag({ other: "x" }), undefined);
  assert.equal(normalizeResult(" no threats found "), "No threats found");
  assert.equal(normalizeResult("Malicious"), "Malicious");
  assert.equal(normalizeResult("Not scanned"), "Not scanned");
  assert.equal(normalizeResult("Scan failed: SAM259200"), "Error");
  assert.equal(normalizeResult(""), "Error");
});

function tagSource(responses: Array<Record<string, string> | Error>): TagSource {
  let i = 0;
  return {
    getBlobClient: () => ({
      getTags: async () => {
        const next = responses[Math.min(i++, responses.length - 1)]!;
        if (next instanceof Error) throw next;
        return { tags: next };
      },
    }),
  };
}

test("blob tag reader polls until the tag appears, times out, and maps read errors", async () => {
  const appears = new BlobTagDefenderReader(tagSource([{}, {}, { "Malware Scanning scan result": "Malicious" }]), 5, 0.001);
  assert.equal(await appears.result("job_x"), "Malicious");
  const never = new BlobTagDefenderReader(tagSource([{}]), 0.01, 0.001);
  assert.equal(await never.result("job_x"), "Timeout");
  const broken = new BlobTagDefenderReader(tagSource([new Error("403")]), 5, 0.001);
  assert.equal(await broken.result("job_x"), "Error");
});

test("fake pipeline trigger returns a local run url and plays its callback after the caller's turn", async () => {
  const seen: string[] = [];
  const t = new FakePipelineTrigger(async (jobId, runUrl) => {
    seen.push(`${jobId}:${runUrl}`);
  });
  const { runUrl } = await t.triggerPythonDeploy("job_a");
  assert.equal(runUrl, "http://localhost/fake-run/job_a");
  assert.deepEqual(seen, [], "deferred");
  await t.drain();
  assert.deepEqual(seen, ["job_a:http://localhost/fake-run/job_a"]);
  assert.deepEqual(t.triggered, [{ jobId: "job_a", runUrl }]);
});

test("Azure DevOps trigger posts the run request with a bearer from the credential", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 7, _links: { web: { href: "https://dev.azure.com/o/p/_build/results?buildId=7" } } }), { status: 200 });
  }) as typeof fetch;
  const scopes: string[] = [];
  const credential = { getToken: async (scope: string) => (scopes.push(scope), { token: "t" }) };
  const t = new AzureDevOpsPipelineTrigger("o", "p", "12", credential, fetchImpl);
  const { runUrl } = await t.triggerPythonDeploy("job_z");
  assert.equal(runUrl, "https://dev.azure.com/o/p/_build/results?buildId=7");
  assert.deepEqual(scopes, [ADO_SCOPE]);
  assert.equal(calls[0]!.url, "https://dev.azure.com/o/p/_apis/pipelines/12/runs?api-version=7.1");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { templateParameters: { jobId: "job_z" } });
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer t");

  const failing = new AzureDevOpsPipelineTrigger("o", "p", "12", credential, (async () => new Response("nope", { status: 403 })) as typeof fetch);
  await assert.rejects(() => failing.triggerPythonDeploy("job_z"), /403/);
  const noToken = new AzureDevOpsPipelineTrigger("o", "p", "12", { getToken: async () => null }, fetchImpl);
  await assert.rejects(() => noToken.triggerPythonDeploy("job_z"), /access token/);
});
