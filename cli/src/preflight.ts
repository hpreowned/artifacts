// `artifactctl preflight` runs the skill's preflight.sh so there is exactly one implementation.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./config.js";

const REL = "skill/publish-to-aks/scripts/preflight.sh";

/** ARTIFACTS_PREFLIGHT, or the first ancestor of this file that contains skill/publish-to-aks/scripts/preflight.sh. */
export function locatePreflight(env: NodeJS.ProcessEnv): string {
  if (env.ARTIFACTS_PREFLIGHT) {
    if (!existsSync(env.ARTIFACTS_PREFLIGHT)) throw new UsageError(`ARTIFACTS_PREFLIGHT not found: ${env.ARTIFACTS_PREFLIGHT}`);
    return env.ARTIFACTS_PREFLIGHT;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, REL);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new UsageError(`cannot find ${REL}; set ARTIFACTS_PREFLIGHT`);
}

export function runPreflight(dir: string, script: string, out: (s: string) => void, err: (s: string) => void): number {
  const r = spawnSync("bash", [script, dir], { encoding: "utf8" });
  if (r.error) throw new UsageError(`cannot run ${script}: ${r.error.message}`);
  if (r.stdout) out(r.stdout);
  if (r.stderr) err(r.stderr);
  return r.status ?? 1;
}
