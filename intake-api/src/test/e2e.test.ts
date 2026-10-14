// The dev-stack composition end to end over HTTP: begin → upload → finalize → worker → status, static and python.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { zipDir } from "../../../scanner/src/test/helpers.js";
import { loadConfig } from "../config.js";
import { REPO_ROOT } from "../repo-root.js";
import { verify } from "../signed-token.js";
import { startLocalStack, type LocalStack } from "../stack.js";
import { PUBLISHER, call } from "./api-helpers.js";

const CORPUS = resolve(REPO_ROOT, "tests", "corpus");
let stack: LocalStack;
let work: string;
const secrets = { pipeline: randomBytes(24).toString("base64url"), internal: randomBytes(24).toString("base64url"), view: randomBytes(32) };

before(async () => {
  work = await mkdtemp(join(tmpdir(), "e2e-"));
  const cfg = loadConfig({
    DEV_AUTH: "1", BACKEND: "memory", PORT: "0", SERVE_ROOT: join(work, "serving"), SHELL_ORIGIN: "https://artifacts.example.test",
    PIPELINE_TOKEN: secrets.pipeline, INTERNAL_SHARED_KEY: secrets.internal, VIEW_TOKEN_KEY: secrets.view.toString("base64"),
    GITLEAKS_BIN: join(work, "no-gitleaks-here"),
  });
  stack = await startLocalStack(cfg, 0);
});
after(async () => {
  await stack.stop();
  await rm(work, { recursive: true, force: true });
});

interface Status {
  jobId: string;
  state: string;
  url?: string;
  findings?: { rule: string; severity: string }[];
  approval?: { group: string; runUrl?: string };
  summary?: string;
}

async function publish(bundle: string, beforeFinalize?: (jobId: string) => void): Promise<{ status: Status; artifactId: string }> {
  const manifest = JSON.parse(readFileSync(join(CORPUS, bundle, "manifest.json"), "utf8"));
  const b = await call(stack.baseUrl, "POST", "/v1/publish", { headers: PUBLISHER, json: manifest });
  assert.equal(b.status, 201, b.text);
  const { jobId, uploadToken, uploadUrl } = b.body as { jobId: string; uploadToken: string; uploadUrl: string };
  assert.equal(uploadUrl, `http://localhost:8080/v1/publish/${jobId}/upload`, "PUBLIC_BASE_URL default");
  const zip = await zipDir(join(CORPUS, bundle));
  const auth = { authorization: `Bearer ${uploadToken}` };
  assert.equal((await call(stack.baseUrl, "PUT", `/v1/publish/${jobId}/upload`, { headers: auth, body: zip })).status, 201);
  beforeFinalize?.(jobId);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const f = await call(stack.baseUrl, "POST", `/v1/publish/${jobId}/finalize`, { headers: auth, json: { sha256 } });
  assert.equal(f.status, 202, f.text);
  const deadline = Date.now() + 20_000;
  let status: Status = f.body;
  while (["scanning", "deploying"].includes(status.state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    status = (await call(stack.baseUrl, "GET", `/v1/publish/${jobId}`, { headers: PUBLISHER })).body;
  }
  const artifactId = (await stack.stores.jobs.get(jobId))!.artifactId;
  return { status, artifactId };
}

test("static-ok reaches live with the shell URL, files in SERVE_ROOT, and a mintable view token", async () => {
  const { status, artifactId } = await publish("static-ok");
  assert.equal(status.state, "live", JSON.stringify(status));
  assert.equal(status.url, `https://artifacts.example.test/view/${artifactId}`);
  assert.ok(existsSync(join(work, "serving", artifactId, "index.html")));
  assert.ok(existsSync(join(work, "serving", artifactId, "manifest.json")));
  assert.ok(status.findings?.some((f) => f.rule === "SEC-000" && f.severity === "warn"), "gitleaks absent is a warning, not a rejection");
  assert.match(status.summary ?? "", /is live at/);
  const t = await call(stack.baseUrl, "POST", "/v1/view-token", { headers: { "x-internal-caller": secrets.internal }, json: { artifactId, viewerOid: "viewer-1" } });
  assert.equal(t.status, 200, t.text);
  const v = verify(t.body.token, secrets.view);
  assert.ok(v.ok && v.payload.aid === artifactId && v.payload.t === "view");
});

test("static-fetch is live with an HTML-009 info; static-secret is rejected with SEC-001 offline", async () => {
  const fetchy = await publish("static-fetch");
  assert.equal(fetchy.status.state, "live");
  assert.ok(fetchy.status.findings?.some((f) => f.rule === "HTML-009" && f.severity === "info"));
  const leaky = await publish("static-secret");
  assert.equal(leaky.status.state, "rejected");
  assert.ok(leaky.status.findings?.some((f) => f.rule === "SEC-001" && f.severity === "deny"));
  assert.equal(leaky.status.url, undefined);
});

test("python-ok passes scanning and the fake pipeline posts awaiting_approval over /events", async () => {
  const { status } = await publish("python-ok");
  assert.equal(status.state, "awaiting_approval", JSON.stringify(status));
  assert.equal(status.approval?.group, "artifacts-approvers");
  assert.equal(status.approval?.runUrl, `http://localhost/fake-run/${status.jobId}`);
});

test("a Malicious Defender result is rejected with MAL-001", async () => {
  const { status } = await publish("static-ok", (jobId) => stack.defender.force(jobId, "Malicious"));
  assert.equal(status.state, "rejected");
  assert.ok(status.findings?.some((f) => f.rule === "MAL-001"));
});
