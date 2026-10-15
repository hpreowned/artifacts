// Every bundle in tests/corpus through the worker on memory backends: exact state, every expected rule present.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Manifest } from "../../../intake-api/src/job.js";
import { manifestValidator } from "../../../intake-api/src/manifest-validator.js";
import { describe } from "../summary.js";
import { CORPUS, STATIC_MANIFEST, harness, runBundle, zipDir, type Harness } from "./helpers.js";

interface Expected {
  state: string;
  rules: string[];
}

let h: Harness;
before(async () => {
  h = await harness();
});
after(async () => {
  await h.cleanup();
});

const bundles = readdirSync(CORPUS).filter((name) => existsSync(join(CORPUS, name, "expected.json"))).sort();
assert.ok(bundles.length >= 28, `corpus has ${bundles.length} bundles`);

for (const name of bundles) {
  test(`corpus/${name}`, async () => {
    const dir = join(CORPUS, name);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
    const zip = await zipDir(dir);
    const job = await runBundle(h, zip, submittedManifest(dir));
    const listed = job.findings.map(describe).join("\n  ") || "(none)";
    assert.equal(job.state, expected.state, `state for ${name}; findings:\n  ${listed}`);
    for (const rule of expected.rules) {
      assert.ok(job.findings.some((f) => f.rule === rule), `${name} should carry ${rule}; findings:\n  ${listed}`);
    }
    assert.ok(job.summary && job.summary.length > 20, "summary paragraph present");
    if (expected.state === "live") {
      assert.equal(job.url, `http://localhost:8082/view/${job.artifactId}`);
      assert.ok(existsSync(join(h.serveRoot, job.artifactId, "index.html")), "index.html copied to the serving store");
      assert.equal(await h.stores.bundles.get(job.jobId), undefined, "intake bundle dropped after publish");
      assert.ok(!job.findings.some((f) => f.severity === "deny"));
    }
    if (expected.state === "rejected") {
      assert.ok(job.findings.some((f) => f.severity === "deny"), "rejected jobs carry a deny finding");
      assert.equal(await h.stores.bundles.get(job.jobId), undefined, "intake bundle dropped after rejection");
    }
    if (expected.state === "awaiting_approval") {
      assert.equal(job.runUrl, `http://localhost/fake-run/${job.jobId}`);
      assert.ok(await h.stores.bundles.get(job.jobId), "python bundle kept for the pipeline");
    }
    for (const f of job.findings) assert.ok(["deny", "warn", "info"].includes(f.severity), `severity stamped on ${f.rule}`);
  });
}

/** The manifest the API would have accepted at beginPublish. An invalid bundle manifest is submitted as a valid static one. */
function submittedManifest(dir: string): Manifest {
  const parsed = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown;
  return manifestValidator().validate(parsed).length === 0 ? (parsed as Manifest) : STATIC_MANIFEST;
}

test("a whole-bundle structure failure skips the later stages", async () => {
  const zip = await zipDir(join(CORPUS, "static-bad-filetype"));
  const job = await runBundle(h, zip, STATIC_MANIFEST);
  assert.equal(job.state, "rejected");
  assert.deepEqual([...new Set(job.findings.map((f) => f.rule))], ["IN-005"]);
});

test("Defender Malicious rejects with MAL-001; Error fails with MAL-002", async () => {
  const zip = await zipDir(join(CORPUS, "static-ok"));
  const bad = await runBundle(h, zip, STATIC_MANIFEST, { jobId: "job_malicious00000000000" });
  assert.equal(bad.state, "live", "sanity: clean result first");
  h.defender.force("job_malicious00000000001", "Malicious");
  const malicious = await runBundle(h, zip, STATIC_MANIFEST, { jobId: "job_malicious00000000001" });
  assert.equal(malicious.state, "rejected");
  assert.ok(malicious.findings.some((f) => f.rule === "MAL-001" && f.severity === "deny"));
  for (const result of ["Error", "Not scanned", "Timeout"] as const) {
    const id = `job_defender${result.replace(/\W/g, "").toLowerCase().padEnd(12, "0")}`.slice(0, 24);
    h.defender.force(id, result);
    const failed = await runBundle(h, zip, STATIC_MANIFEST, { jobId: id });
    assert.equal(failed.state, "failed", result);
    assert.ok(failed.findings.some((f) => f.rule === "MAL-002"));
    assert.match(failed.summary ?? "", /Resubmit|Publish again/);
  }
});

test("a missing bundle fails the job; a non-scanning job is left alone", async () => {
  const job = await runBundle(h, Buffer.alloc(0), STATIC_MANIFEST);
  assert.equal(job.state, "rejected", "an empty upload is not a zip: IN-009");
  assert.ok(job.findings.some((f) => f.rule === "IN-009"));
  const live = await runBundle(h, await zipDir(join(CORPUS, "static-ok")), STATIC_MANIFEST, { state: "live" });
  assert.equal(live.state, "live");
  assert.equal(live.findings.length, 0, "untouched");
});

// IN-009: corrupt/unreadable archives (not representable as a tests/corpus bundle, which is zipped by the
// test harness itself) go through the worker directly with a non-zip byte string as the "upload". See
// tests/README.md "Cases not representable as corpus bundles".
test("IN-009: a non-zip upload is rejected, distinct from an oversized-but-readable one (IN-001)", async () => {
  const job = await runBundle(h, Buffer.from("this is definitely not a zip file"), STATIC_MANIFEST);
  assert.equal(job.state, "rejected");
  assert.deepEqual([...new Set(job.findings.map((f) => f.rule))], ["IN-009"]);
  assert.match(job.summary ?? "", /blocking finding/);
});
