// D16: who approves a server-tier (python/node) deploy. The platform's protection is containment (D4); the
// human gate is accountability on the cases a table cannot judge. A clean scan deploys automatically.
// Anything a reviewer could actually act on — a warning finding about the artifact — escalates to the
// Azure DevOps approval check. APPROVAL_MODE forces either path org-wide while the policy is being tuned.
import type { Finding, JobRecord } from "../../intake-api/src/job.js";

export type ApprovalMode = "auto" | "human";
export type ApprovalPolicy = "policy" | "always-human" | "always-auto";
export interface ApprovalDecision {
  mode: ApprovalMode;
  /** Why a human is looking — or, on the auto path, why no human is needed despite warnings (precedent). */
  reasons: string[];
  /** Set when auto was granted because a human approved an earlier version of this app with the same warnings. */
  precedentJobId?: string;
}

/** An earlier version of the same app (same publisher, same manifest name) that a human approved. */
export interface Precedent {
  jobId: string;
  approvedAt: string;
  warningRules: string[];
}

/** Warnings about the artifact itself: what a reviewer would judge, and what a precedent covers. */
export function artifactWarnings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "warn" && !OPERATIONAL_RULES.has(f.rule));
}

/**
 * Approve once per app: the latest live artifact by the same publisher under the same name that a human
 * approved — directly, or by an unbroken chain of precedents — carries its warning rules forward.
 */
export function findPrecedent(jobs: JobRecord[], job: JobRecord): Precedent | undefined {
  const approved = jobs
    .filter((j) => j.jobId !== job.jobId && j.ownerOid === job.ownerOid && j.manifest.name === job.manifest.name && j.tier === job.tier)
    .filter((j) => j.state === "live" && j.approval !== undefined && (j.approval.mode === "human" || j.approval.precedentJobId !== undefined))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const latest = approved[0];
  if (!latest) return undefined;
  return { jobId: latest.jobId, approvedAt: latest.updatedAt, warningRules: [...new Set(artifactWarnings(latest.findings).map((f) => f.rule))] };
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
export function decideApproval(findings: Finding[], policy: ApprovalPolicy = "policy", precedent?: Precedent): ApprovalDecision {
  if (policy === "always-human") return { mode: "human", reasons: ["APPROVAL_MODE=always-human: every server-tier publish is reviewed"] };
  if (policy === "always-auto") return { mode: "auto", reasons: [] };
  const warnings = artifactWarnings(findings);
  if (warnings.length === 0) return { mode: "auto", reasons: [] };
  const rules = [...new Set(warnings.map((f) => f.rule))];
  if (precedent && rules.every((r) => precedent.warningRules.includes(r))) {
    const day = precedent.approvedAt.slice(0, 10);
    return {
      mode: "auto",
      reasons: [`Same warnings (${rules.join(", ")}) as the version a human approved on ${day} (${precedent.jobId}); no new review needed.`],
      precedentJobId: precedent.jobId,
    };
  }
  return { mode: "human", reasons: [...new Set(warnings.map((f) => `${f.rule}: ${f.message}`))] };
}
