// Job record, states and transitions. States and the transition table come from contracts/states.md.

export type State =
  | "awaiting_upload" | "scanning" | "rejected" | "awaiting_approval" | "deploying" | "live" | "failed" | "expired";
export type Tier = "static" | "python" | "node";
export type Severity = "deny" | "warn" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  file?: string;
  line?: number;
  message: string;
}

export interface Manifest {
  schemaVersion: 2;
  name: string;
  tier: Tier;
  runtime?: "python-1" | "node-20" | null;
  entrypoint: "index.html" | "app.py" | "package.json";
  externalScripts?: string[];
  ttlDays: number;
  generatedBy: { tool: string; model?: string; session?: string };
}

export interface JobRecord {
  jobId: string;
  artifactId: string;
  ownerOid: string;
  ownerUpn: string;
  manifest: Manifest;
  tier: Tier;
  state: State;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  uploadTokenHash: string;
  uploadTokenUses: number;
  uploadExpiresAt: string;
  sha256?: string;
  findings: Finding[];
  runUrl?: string;
  summary?: string;
  url?: string;
  /** D16: who approves a server-tier deploy, decided by the scanner before the pipeline runs. */
  approval?: { mode: "auto" | "human"; reasons: string[] };
}

export interface EventIn {
  state: "awaiting_approval" | "deploying" | "live" | "failed" | "rejected" | "expired";
  runUrl?: string;
  message?: string;
}

/** contracts/states.md, verbatim: from → allowed targets. */
export const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  awaiting_upload: ["scanning", "expired"],
  scanning: ["rejected", "deploying", "awaiting_approval", "failed"],
  awaiting_approval: ["deploying", "rejected", "expired"],
  deploying: ["live", "failed"],
  live: ["expired"],
  rejected: [],
  failed: [],
  expired: [],
};

export const TERMINAL_STATES: readonly State[] = ["rejected", "failed", "expired"];

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Applies a pipeline callback (`POST /events`). The pipeline never touches awaiting_upload; everything else
 * follows the table. Returns false on an illegal transition (caller answers 409). Mutates and stamps the job.
 */
export function applyEvent(job: JobRecord, event: EventIn, now: Date = new Date()): boolean {
  if (job.state === "awaiting_upload" || !canTransition(job.state, event.state)) return false;
  job.state = event.state;
  if (event.runUrl) job.runUrl = event.runUrl;
  if (event.message) job.summary = event.message;
  job.updatedAt = now.toISOString();
  return true;
}

export interface StatusView {
  jobId: string;
  state: State;
  tier: Tier;
  updatedAt: string;
  url?: string;
  expiresAt?: string;
  findings?: Finding[];
  approval?: { group: string; runUrl?: string; mode?: "auto" | "human"; reasons?: string[] };
  summary?: string;
}

/** Projects a job onto the OpenAPI `Status` schema. */
export function toStatus(job: JobRecord, approverGroup: string): StatusView {
  const status: StatusView = { jobId: job.jobId, state: job.state, tier: job.tier, updatedAt: job.updatedAt };
  if (job.state === "live" && job.url) status.url = job.url;
  if (job.state === "live" || job.state === "deploying" || job.state === "awaiting_approval" || job.state === "scanning") {
    status.expiresAt = job.expiresAt;
  }
  if (job.findings.length > 0) status.findings = job.findings;
  if (job.approval && job.state !== "rejected" && job.state !== "failed") {
    // Server tiers once the policy decided (D16): the skill tells the publisher whether a human is involved.
    status.approval = { group: approverGroup, mode: job.approval.mode, reasons: job.approval.reasons };
    if (job.runUrl) status.approval.runUrl = job.runUrl;
  } else if (job.state === "awaiting_approval") {
    status.approval = job.runUrl ? { group: approverGroup, runUrl: job.runUrl } : { group: approverGroup };
  }
  if (job.summary) status.summary = job.summary;
  return status;
}
