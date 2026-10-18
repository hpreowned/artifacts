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
