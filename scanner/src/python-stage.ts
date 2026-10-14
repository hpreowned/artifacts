// Stage 5 (python): runs imports.py in a child process and maps its JSON to findings. The script only parses;
// a non-zero exit is a scanner problem (job → failed), not an author problem.
import { spawn } from "node:child_process";
import type { Finding } from "../../intake-api/src/job.js";

export interface PythonOptions {
  pythonBin: string;
  importsScript: string;
  runtimeManifestPath: string;
  timeoutMs?: number;
}

const RULE_RE = /^PY-00[1-5]$/;

export async function pythonChecks(dir: string, opts: PythonOptions): Promise<Finding[]> {
  const { stdout, stderr, code } = await run(opts.pythonBin, [opts.importsScript, dir, opts.runtimeManifestPath], opts.timeoutMs ?? 60_000);
  if (code !== 0) throw new Error(`imports.py exited with ${code}: ${stderr.trim().slice(0, 500)}`);
  let items: unknown;
  try {
    items = JSON.parse(stdout);
  } catch {
    throw new Error(`imports.py printed invalid JSON: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(items)) throw new Error("imports.py did not print an array");
  return items.map(toFinding);
}

function toFinding(item: unknown): Finding {
  const v = item as Record<string, unknown>;
  if (typeof v !== "object" || v === null || typeof v.rule !== "string" || !RULE_RE.test(v.rule) || typeof v.message !== "string") {
    throw new Error(`imports.py emitted a malformed finding: ${JSON.stringify(item).slice(0, 200)}`);
  }
  const finding: Finding = { rule: v.rule, severity: "deny", message: v.message };
  if (typeof v.file === "string") finding.file = v.file;
  if (typeof v.line === "number" && v.line > 0) finding.line = v.line;
  return finding;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`imports.py timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${bin}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? signal ?? -1 });
    });
  });
}
