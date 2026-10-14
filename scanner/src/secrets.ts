// Stage 2: secrets. gitleaks runs as a child process when the binary is present; a built-in pattern pack runs
// always, so a leaked key is rejected even on a laptop without gitleaks. Both emit SEC-001. A missing or failing
// gitleaks emits SEC-000 (warn) and logs loudly; policy.ts decides what that means.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Finding } from "../../intake-api/src/job.js";
import { TEXT_EXTENSIONS, extensionOf } from "./limits.js";

export interface SecretsOptions {
  gitleaksBin: string;
  timeoutMs?: number;
}

/** Patterns are deliberately high-precision: a hit here is a deny with no exceptions (DESIGN §5 stage 2). */
export const BUILTIN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "azure-storage-account-key", re: /AccountKey=[A-Za-z0-9+/]{86}==/ },
  { name: "azure-sas-signature", re: /(?:^|[?&;])sig=[A-Za-z0-9%+/]{40,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: "private-key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
];

const secret = (file: string, line: number, message: string): Finding => ({ rule: "SEC-001", severity: "deny", file, line, message });

/** Scans every text file line by line. The message names the pattern, never the matched value. */
export async function builtinSecretScan(dir: string, files: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extensionOf(file))) continue;
    const lines = (await readFile(join(dir, file), "utf8")).split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const { name, re } of BUILTIN_PATTERNS) {
        if (re.test(text)) findings.push(secret(file, i + 1, `built-in pattern ${name} matched; remove the credential and resubmit`));
      }
    });
  }
  return findings;
}

export interface GitleaksResult {
  findings: Finding[];
  /** Set when the binary was missing or failed; the caller emits SEC-000 with it. */
  problem?: string;
}

interface GitleaksReportItem {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
}

export async function runGitleaks(dir: string, opts: SecretsOptions): Promise<GitleaksResult> {
  const work = await mkdtemp(join(tmpdir(), "gitleaks-"));
  const report = join(work, "report.json");
  try {
    const args = ["detect", "--no-git", "--source", dir, "--report-format", "json", "--report-path", report, "--exit-code", "0", "--no-banner"];
    const run = await execute(opts.gitleaksBin, args, opts.timeoutMs ?? 60_000);
    if (run.problem) return { findings: [], problem: run.problem };
    let items: GitleaksReportItem[] = [];
    try {
      const text = (await readFile(report, "utf8")).trim();
      items = text ? (JSON.parse(text) as GitleaksReportItem[]) : [];
    } catch (err) {
      return { findings: [], problem: `gitleaks report unreadable: ${(err as Error).message}` };
    }
    if (!Array.isArray(items)) return { findings: [], problem: "gitleaks report is not a JSON array" };
    return {
      findings: items.map((item) => {
        const file = item.File ? relative(dir, item.File) || item.File : "(unknown)";
        return secret(file.startsWith("..") ? item.File ?? file : file, item.StartLine ?? 0, `gitleaks ${item.RuleID ?? "rule"}: ${item.Description ?? "secret detected"}`);
      }),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function execute(bin: string, args: string[], timeoutMs: number): Promise<{ problem?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const done = (problem?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(problem === undefined ? {} : { problem });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(`gitleaks timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8").slice(0, 2000)));
    child.on("error", (err: NodeJS.ErrnoException) => done(err.code === "ENOENT" ? `gitleaks binary not found at "${bin}"` : `gitleaks could not start: ${err.message}`));
    child.on("close", (code, signal) => done(code === 0 ? undefined : `gitleaks exited with ${signal ?? code}: ${stderr.trim().slice(0, 300)}`));
  });
}

/** The whole stage: built-in pack plus gitleaks, de-duplicated per file and line. */
export async function secretsScan(dir: string, files: string[], opts: SecretsOptions): Promise<Finding[]> {
  const [builtin, gitleaks] = await Promise.all([builtinSecretScan(dir, files), runGitleaks(dir, opts)]);
  const findings: Finding[] = [];
  if (gitleaks.problem) {
    console.error(`[secrets] SEC-000: ${gitleaks.problem}. Only the built-in patterns ran. Install gitleaks and set GITLEAKS_BIN.`);
    findings.push({ rule: "SEC-000", severity: "warn", message: `${gitleaks.problem}; only the built-in secret patterns ran` });
  }
  const seen = new Set<string>();
  for (const f of [...gitleaks.findings, ...builtin]) {
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }
  return findings;
}
