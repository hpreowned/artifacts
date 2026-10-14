// Human and JSON rendering of a Status, and the exit code contract.
import type { Finding, State, Status } from "./client.js";

/** 0 live or awaiting_approval (and in-progress states), 3 rejected, 4 failed or expired. */
export function exitCodeFor(state: State | "timeout"): number {
  switch (state) {
    case "rejected":
      return 3;
    case "failed":
    case "expired":
    case "timeout":
      return 4;
    default:
      return 0;
  }
}

/** `RULE file:line message`, the same shape preflight.sh prints. */
export function formatFinding(f: Finding): string {
  const where = f.file ? `${f.file}:${f.line ?? 0}` : "-";
  const sev = f.severity && f.severity !== "deny" ? `(${f.severity}) ` : "";
  return `${f.rule} ${where} ${sev}${f.message}`;
}

export function formatStatus(s: Status): string {
  const lines: string[] = [];
  const row = (k: string, v: string | undefined): void => {
    if (v) lines.push(`${k.padEnd(9)}${v}`);
  };
  row("job", s.jobId);
  row("state", s.state);
  row("tier", s.tier);
  if (s.state === "live") {
    row("url", s.url);
    row("expires", s.expiresAt);
  }
  if (s.state === "awaiting_approval") {
    row("run", s.approval?.runUrl);
    row("group", s.approval?.group);
  }
  row("summary", s.summary);
  for (const f of s.findings ?? []) lines.push(formatFinding(f));
  return lines.join("\n") + "\n";
}

export function formatJson(s: Status): string {
  return JSON.stringify(s, null, 2) + "\n";
}
