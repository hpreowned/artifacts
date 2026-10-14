import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finalizeUrl, type Status } from "../src/client.js";
import { exitCodeFor, formatFinding, formatJson, formatStatus } from "../src/output.js";

describe("exit codes", () => {
  it("0 live/awaiting_approval/in-progress, 3 rejected, 4 failed/expired/timeout", () => {
    assert.equal(exitCodeFor("live"), 0);
    assert.equal(exitCodeFor("awaiting_approval"), 0);
    assert.equal(exitCodeFor("scanning"), 0);
    assert.equal(exitCodeFor("rejected"), 3);
    assert.equal(exitCodeFor("failed"), 4);
    assert.equal(exitCodeFor("expired"), 4);
    assert.equal(exitCodeFor("timeout"), 4);
  });
});

describe("formatting", () => {
  it("findings as RULE file:line message, severity shown unless deny", () => {
    assert.equal(formatFinding({ rule: "HTML-005", severity: "deny", file: "index.html", line: 10, message: "password input" }), "HTML-005 index.html:10 password input");
    assert.equal(formatFinding({ rule: "HTML-009", severity: "info", file: "index.html", message: "fetch" }), "HTML-009 index.html:0 (info) fetch");
    assert.equal(formatFinding({ rule: "MAL-002", severity: "deny", message: "resubmit" }), "MAL-002 - resubmit");
  });

  it("live shows url and expiry; awaiting_approval shows run and group; rejected lists findings", () => {
    const live: Status = { jobId: "job_a", state: "live", tier: "static", updatedAt: "t", url: "https://a.internal/", expiresAt: "2026-10-28T00:00:00Z" };
    assert.equal(formatStatus(live), "job      job_a\nstate    live\ntier     static\nurl      https://a.internal/\nexpires  2026-10-28T00:00:00Z\n");
    const wait: Status = { jobId: "job_b", state: "awaiting_approval", updatedAt: "t", approval: { group: "artifacts-approvers", runUrl: "https://dev.azure.com/run/1" } };
    assert.equal(formatStatus(wait), "job      job_b\nstate    awaiting_approval\nrun      https://dev.azure.com/run/1\ngroup    artifacts-approvers\n");
    const rej: Status = { jobId: "", state: "rejected", updatedAt: "t", summary: "no", findings: [{ rule: "IN-006", severity: "deny", file: "manifest.json", line: 0, message: "bad" }] };
    assert.equal(formatStatus(rej), "state    rejected\nsummary  no\nIN-006 manifest.json:0 bad\n");
  });

  it("json output is the Status object, pretty-printed", () => {
    const s: Status = { jobId: "job_a", state: "scanning", updatedAt: "t" };
    assert.deepEqual(JSON.parse(formatJson(s)), s);
  });
});

describe("finalizeUrl", () => {
  it("swaps the last segment and drops the query string", () => {
    assert.equal(finalizeUrl("http://h/v1/publish/job_x/upload?sig=1"), "http://h/v1/publish/job_x/finalize");
    assert.throws(() => finalizeUrl("http://h/v1/publish/job_x"));
  });
});
