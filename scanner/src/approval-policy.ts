// D16: who approves a server-tier (python/node) deploy. The platform's protection is containment (D4); the
// human gate is accountability on the cases a table cannot judge. A clean scan deploys automatically.
// Anything a reviewer could actually act on — a warning finding about the artifact — escalates to the
// Azure DevOps approval check. APPROVAL_MODE forces either path org-wide while the policy is being tuned.
import type { Finding } from "../../intake-api/src/job.js";

export type ApprovalMode = "auto" | "human";
export type ApprovalPolicy = "policy" | "always-human" | "always-auto";
export interface ApprovalDecision {
  mode: ApprovalMode;
  /** Why a human is looking; empty on the auto path. Relayed to the publisher in plain words by the skill. */
  reasons: string[];
}

/** Warnings about the platform's own coverage, not about the artifact (gitleaks unavailable). A reviewer has
 *  nothing to judge there; the warning still reaches the publisher through `findings`. */
export const OPERATIONAL_RULES: ReadonlySet<string> = new Set(["SEC-000"]);

export function parseApprovalPolicy(value: string | undefined): ApprovalPolicy {
  if (value === undefined || value === "" || value === "policy") return "policy";
  if (value === "always-human" || value === "always-auto") return value;
  throw new Error(`APPROVAL_MODE must be policy, always-human or always-auto (got "${value}")`);
}

/** Deny findings never reach this: the worker rejects before deciding. Info findings do not escalate. */
export function decideApproval(findings: Finding[], policy: ApprovalPolicy = "policy"): ApprovalDecision {
  if (policy === "always-human") return { mode: "human", reasons: ["APPROVAL_MODE=always-human: every server-tier publish is reviewed"] };
  if (policy === "always-auto") return { mode: "auto", reasons: [] };
  const reasons = [...new Set(
    findings.filter((f) => f.severity === "warn" && !OPERATIONAL_RULES.has(f.rule)).map((f) => `${f.rule}: ${f.message}`),
  )];
  return reasons.length > 0 ? { mode: "human", reasons } : { mode: "auto", reasons: [] };
}
