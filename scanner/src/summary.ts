// The one-paragraph human summary on every job, written for Cowork to relay to the author verbatim.
import type { Finding, JobRecord } from "../../intake-api/src/job.js";
import type { ApprovalDecision } from "./approval-policy.js";

export type SummaryKind = "live" | "rejected" | "failed" | "triggering" | "triggered";

export interface SummaryExtra {
  reason?: string;
  runUrl?: string;
  group?: string;
  approval?: ApprovalDecision;
}

const MAX_LISTED = 5;

export function summarize(job: JobRecord, kind: SummaryKind, extra: SummaryExtra = {}): string {
  const name = job.manifest.name;
  switch (kind) {
    case "live":
      return `"${name}" is live at ${job.url ?? "(url pending)"} until ${day(job.expiresAt)}.${advisories(job.findings)}`;
    case "rejected": {
      const denies = job.findings.filter((f) => f.severity === "deny");
      return `"${name}" was rejected with ${denies.length} blocking finding${denies.length === 1 ? "" : "s"}: ${list(denies)}. Fix these and publish again.${advisories(job.findings)}`;
    }
    case "failed":
      return `"${name}" could not be scanned: ${extra.reason ?? "internal error"}. Nothing was published. Publish again; if it keeps failing, contact the platform team.${advisories(job.findings)}`;
    case "triggering":
      return `"${name}" passed scanning. Triggering the python deploy pipeline.${advisories(job.findings)}`;
    case "triggered": {
      const run = extra.runUrl ?? "(run url pending)";
      if (extra.approval?.mode === "auto") {
        return `"${name}" passed scanning cleanly. The deploy pipeline is running at ${run} and no approval is needed; the app goes live when the rollout is healthy.${advisories(job.findings)}`;
      }
      const why = extra.approval?.reasons.length ? ` It was sent for review because: ${extra.approval.reasons.join("; ")}.` : "";
      return `"${name}" passed scanning. The deploy pipeline is running at ${run}; a member of ${extra.group ?? "the approver group"} must approve it in Azure DevOps before the app goes live.${why}${advisories(job.findings)}`;
    }
  }
}

function advisories(findings: Finding[]): string {
  const notes = findings.filter((f) => f.severity !== "deny");
  if (notes.length === 0) return "";
  return ` ${notes.length} advisory note${notes.length === 1 ? "" : "s"}: ${list(notes)}.`;
}

function list(findings: Finding[]): string {
  const shown = findings.slice(0, MAX_LISTED).map(describe);
  const more = findings.length - shown.length;
  return shown.join("; ") + (more > 0 ? `; and ${more} more` : "");
}

export function describe(f: Finding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  return `${f.rule}${where} ${f.message}`;
}

function day(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : iso.slice(0, 10);
}
