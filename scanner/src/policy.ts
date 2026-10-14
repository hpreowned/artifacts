// The single rule → severity table, from contracts/findings.md. Scanners emit rule ids; only this file decides.
import type { Finding, Severity } from "../../intake-api/src/job.js";

export const POLICY: Readonly<Record<string, Severity>> = {
  "IN-001": "deny", "IN-002": "deny", "IN-003": "deny", "IN-004": "deny", "IN-005": "deny", "IN-006": "deny",
  "IN-007": "deny", "IN-008": "deny", "IN-009": "deny",
  "SEC-000": "warn",
  "SEC-001": "deny",
  "MAL-001": "deny", "MAL-002": "deny",
  "HTML-001": "deny", "HTML-002": "deny", "HTML-003": "deny", "HTML-004": "deny", "HTML-005": "deny",
  "HTML-006": "deny", "HTML-007": "deny", "HTML-008": "warn", "HTML-009": "info",
  "PY-001": "deny", "PY-002": "deny", "PY-003": "deny", "PY-004": "deny", "PY-005": "warn", "PY-006": "deny",
  "LLM-001": "warn",
};

export function severityOf(rule: string): Severity {
  const severity = POLICY[rule];
  if (!severity) throw new Error(`unknown rule id ${rule}; add it to contracts/findings.md and policy.ts`);
  return severity;
}

/** Stamps severities from the table (overriding whatever a scanner put there) and decides. */
export function verdict(findings: Finding[]): { findings: Finding[]; deny: boolean } {
  const stamped = findings.map((f) => ({ ...f, severity: severityOf(f.rule) }));
  return { findings: stamped, deny: stamped.some((f) => f.severity === "deny") };
}
