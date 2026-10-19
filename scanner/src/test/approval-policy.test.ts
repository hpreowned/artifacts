import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../../../intake-api/src/job.js";
import { decideApproval, parseApprovalPolicy } from "../approval-policy.js";

const f = (rule: string, severity: Finding["severity"], message = "m"): Finding => ({ rule, severity, message });

test("clean scan → auto; info findings do not escalate", () => {
  assert.deepEqual(decideApproval([]), { mode: "auto", reasons: [] });
  assert.deepEqual(decideApproval([f("HTML-009", "info")]), { mode: "auto", reasons: [] });
});

test("a warning about the artifact → human, with the finding as the reason (deduplicated)", () => {
  const d = decideApproval([f("JS-005", "warn", "outbound HTTP"), f("JS-005", "warn", "outbound HTTP"), f("HTML-009", "info")]);
  assert.equal(d.mode, "human");
  assert.deepEqual(d.reasons, ["JS-005: outbound HTTP"]);
});

test("operational warnings (SEC-000: gitleaks unavailable) are not a reason to send a human a bundle", () => {
  assert.equal(decideApproval([f("SEC-000", "warn")]).mode, "auto");
  assert.equal(decideApproval([f("SEC-000", "warn"), f("JS-005", "warn")]).mode, "human");
});

test("APPROVAL_MODE forces either path; invalid values are rejected at startup", () => {
  assert.equal(decideApproval([f("JS-005", "warn")], "always-auto").mode, "auto");
  const forced = decideApproval([], "always-human");
  assert.equal(forced.mode, "human");
  assert.equal(forced.reasons.length, 1);
  assert.equal(parseApprovalPolicy(undefined), "policy");
  assert.equal(parseApprovalPolicy("always-auto"), "always-auto");
  assert.throws(() => parseApprovalPolicy("sometimes"), /APPROVAL_MODE/);
});

import { findPrecedent, type Precedent } from "../approval-policy.js";
import type { JobRecord } from "../../../intake-api/src/job.js";

const precedent: Precedent = { jobId: "job_prev", approvedAt: "2026-10-18T10:00:00.000Z", warningRules: ["JS-005"] };

test("approve once per app: the same warnings as a human-approved earlier version → auto, with the precedent named", () => {
  const d = decideApproval([f("JS-005", "warn", "outbound HTTP"), f("SEC-000", "warn")], "policy", precedent);
  assert.equal(d.mode, "auto");
  assert.equal(d.precedentJobId, "job_prev");
  assert.match(d.reasons[0]!, /approved on 2026-10-18 \(job_prev\)/);
});

test("a new warning rule the precedent did not cover → human again; always-human ignores precedents", () => {
  assert.equal(decideApproval([f("JS-005", "warn"), f("JS-001", "warn")], "policy", precedent).mode, "human");
  assert.equal(decideApproval([f("JS-005", "warn")], "always-human", precedent).mode, "human");
});

function job(over: Partial<JobRecord>): JobRecord {
  return {
    jobId: "job_x", artifactId: "a", ownerOid: "oid-1", ownerUpn: "a@x", tier: "node", state: "live",
    manifest: { schemaVersion: 2, name: "inventory", tier: "node", runtime: "node-20", entrypoint: "package.json", externalScripts: [], ttlDays: 14, generatedBy: { tool: "artifactctl" } } as JobRecord["manifest"],
    createdAt: "2026-10-18T09:00:00.000Z", updatedAt: "2026-10-18T09:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z",
    uploadTokenHash: "", uploadTokenUses: 2, uploadExpiresAt: "", findings: [], ...over,
  };
}

test("findPrecedent: latest live human-approved (or precedent-chained) job by the same owner and name; others ignored", () => {
  const current = job({ jobId: "job_new", state: "scanning" });
  const jobs = [
    current,
    job({ jobId: "job_old", updatedAt: "2026-10-10T00:00:00.000Z", approval: { mode: "human", reasons: ["JS-005: x"] }, findings: [f("JS-005", "warn"), f("SEC-000", "warn")] }),
    job({ jobId: "job_newer", updatedAt: "2026-10-15T00:00:00.000Z", approval: { mode: "auto", reasons: [], precedentJobId: "job_old" }, findings: [f("JS-005", "warn")] }),
    job({ jobId: "job_other_owner", ownerOid: "oid-2", approval: { mode: "human", reasons: [] } }),
    job({ jobId: "job_other_name", manifest: { ...job({}).manifest, name: "else" }, approval: { mode: "human", reasons: [] } }),
    job({ jobId: "job_pending", state: "awaiting_approval", approval: { mode: "human", reasons: [] } }),
    job({ jobId: "job_clean_auto", updatedAt: "2026-10-17T00:00:00.000Z", approval: { mode: "auto", reasons: [] } }),
  ];
  const p = findPrecedent(jobs, current);
  assert.equal(p?.jobId, "job_newer", "chained precedent counts; a clean auto job carries no human judgment");
  assert.deepEqual(p?.warningRules, ["JS-005"]);
  assert.equal(findPrecedent([current], current), undefined);
});
