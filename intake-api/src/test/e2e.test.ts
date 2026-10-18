// The dev-stack composition end to end over HTTP: begin → upload → finalize → worker → status, static and python.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  expiresAt?: string;
  findings?: { rule: string; severity: string }[];
  approval?: { group: string; runUrl?: string; mode?: string; reasons?: string[] };
  summary?: string;
}

/** Shared by `publish` (a tests/corpus/* bundle) and the in-test prototype fixture below (an arbitrary directory):
 *  beginPublish -> upload -> finalize -> poll until the worker leaves scanning/deploying. */
async function publishFrom(dir: string, beforeFinalize?: (jobId: string) => void): Promise<{ status: Status; artifactId: string }> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const b = await call(stack.baseUrl, "POST", "/v1/publish", { headers: PUBLISHER, json: manifest });
  assert.equal(b.status, 201, b.text);
  const { jobId, uploadToken, uploadUrl } = b.body as { jobId: string; uploadToken: string; uploadUrl: string };
  assert.equal(uploadUrl, `http://localhost:8080/v1/publish/${jobId}/upload`, "PUBLIC_BASE_URL default");
  const zip = await zipDir(dir);
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

function publish(bundle: string, beforeFinalize?: (jobId: string) => void): Promise<{ status: Status; artifactId: string }> {
  return publishFrom(join(CORPUS, bundle), beforeFinalize);
}

/** A minimal, self-contained node-tier bundle (D14/§6.13): package.json with a start script, a lockfile,
 *  one server file, data as a file. Built in a temp dir rather than tests/corpus (that corpus is the scanner
 *  agent's: see tests/corpus/README or STATUS T80), so this test owns its own fixture end to end. */
async function writePrototypeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prototype-fixture-"));
  await mkdir(join(dir, "data"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, name: "node-ok", tier: "node", runtime: "node-20", entrypoint: "package.json",
    ttlDays: 14, generatedBy: { tool: "artifactctl" },
  }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "node-ok", version: "1.0.0", private: true, scripts: { start: "node server.js" } }));
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "node-ok", version: "1.0.0", lockfileVersion: 3 }));
  await writeFile(join(dir, "server.js"), "const http = require('node:http');\nhttp.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000);\n");
  await writeFile(join(dir, "data", "db.json"), JSON.stringify({ hello: "world" }));
  return dir;
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
  assert.equal(t.body.artifactExpiresAt, status.expiresAt, "view-token reports the artifact's TTL expiry, not the token's");
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

test("python-ok: clean scan → D16 auto path → the fake pipeline posts deploying then live, and the artifact has its URL", async () => {
  const { status } = await publish("python-ok");
  assert.equal(status.state, "live", JSON.stringify(status));
  assert.equal(status.approval?.mode, "auto");
  assert.deepEqual(status.approval?.reasons, []);
  assert.equal(status.approval?.runUrl, `${stack.baseUrl}/dev/approval/${status.jobId}`, "the local stack points the run URL at its own dev approval page");
  assert.match(status.url ?? "", /^https:\/\/artifacts\.example\.test\/view\/[a-z0-9]{12}$/, "pipeline-deployed artifacts get their viewer URL on live");
});

// Blocked on scanner/src/intake-checks.ts (not this package's directory, see CLAUDE.md "own only your
// directories"): its IN-007 check is `if (tier === "static") {...} else { require app.py, deny any .html }`,
// so every non-static tier is treated as python today. contracts/findings.md scopes IN-007 to
// "static/python" only -- it does not mention prototype -- so a node bundle (no app.py, no .html) should sail
// through IN-007 untouched; instead it is denied with "python bundle without app.py at the root". Everything
// on this side (manifest validator, config, the fake trigger, this fixture) already works end to end; flip
test("node-ok (in-test fixture): clean scan → auto path → live, same as python-ok", async () => {
  const fixture = await writePrototypeFixture();
  try {
    const { status } = await publishFrom(fixture);
    assert.equal(status.state, "live", JSON.stringify(status));
    assert.equal(status.approval?.mode, "auto");
    assert.equal(status.approval?.group, "artifacts-approvers");
    assert.equal(status.approval?.runUrl, `${stack.baseUrl}/dev/approval/${status.jobId}`, "the local stack points the run URL at its own dev approval page");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a Malicious Defender result is rejected with MAL-001", async () => {
  const { status } = await publish("static-ok", (jobId) => stack.defender.force(jobId, "Malicious"));
  assert.equal(status.state, "rejected");
  assert.ok(status.findings?.some((f) => f.rule === "MAL-001"));
});

test("dev approval page: the fake run URL resolves to an explanation under DEV_AUTH, 404 for unknown jobs", async () => {
  const begin = await call(stack.baseUrl, "POST", "/v1/publish", { headers: PUBLISHER, json: {
    schemaVersion: 2, name: "dev-page", tier: "static", runtime: null, entrypoint: "index.html", externalScripts: [], ttlDays: 1,
    generatedBy: { tool: "artifactctl" },
  } });
  assert.equal(begin.status, 201, begin.text);
  const jobId = (begin.body as { jobId: string }).jobId;
  const page = await fetch(`${stack.baseUrl}/dev/approval/${jobId}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Local stack/);
  assert.match(html, new RegExp(`/v1/publish/${jobId}/events`));
  assert.match(html, /state&quot;:&quot;deploying/, "the approve callback is shown, HTML-escaped");
  const missing = await fetch(`${stack.baseUrl}/dev/approval/job_00000000000000000000`);
  assert.equal(missing.status, 404);
});

test("a node bundle with a warning (JS-005 outbound fetch) → D16 human path → awaiting_approval with the reason", async () => {
  const fixture = await writePrototypeFixture();
  try {
    await writeFile(join(fixture, "server.js"), "const http = require('node:http');\nfetch('https://example.com/ping');\nhttp.createServer((req, res) => res.end('ok')).listen(process.env.PORT);\n");
    const { status } = await publishFrom(fixture);
    assert.equal(status.state, "awaiting_approval", JSON.stringify(status));
    assert.equal(status.approval?.mode, "human");
    assert.ok(status.approval?.reasons?.some((r) => r.startsWith("JS-005")), JSON.stringify(status.approval));
    assert.equal(status.url, undefined, "nothing is live while a human is looking");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
