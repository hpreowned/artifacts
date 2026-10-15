// Stage 1 (part 2): manifest validity (IN-006), tier by content (IN-007), entrypoint presence (IN-008).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, Manifest } from "../../intake-api/src/job.js";
import { manifestValidator } from "../../intake-api/src/manifest-validator.js";
import { extensionOf } from "./limits.js";

export interface IntakeResult {
  findings: Finding[];
  /** The bundle's manifest when it is valid and agrees with the submitted one; undefined otherwise. */
  manifest: Manifest | undefined;
}

const deny = (rule: string, message: string, file: string = "manifest.json"): Finding => ({ rule, severity: "deny", file, message });

export async function intakeChecks(dir: string, files: string[], submitted: Manifest): Promise<IntakeResult> {
  const findings: Finding[] = [];
  if (!files.includes("manifest.json")) {
    return { findings: [deny("IN-006", "manifest.json is missing from the bundle root")], manifest: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch (err) {
    return { findings: [deny("IN-006", `manifest.json is not valid JSON: ${(err as Error).message}`)], manifest: undefined };
  }
  const errors = manifestValidator().validate(parsed);
  if (errors.length > 0) return { findings: errors.map((e) => deny("IN-006", e)), manifest: undefined };
  const manifest = parsed as Manifest;
  for (const field of ["tier", "entrypoint", "runtime"] as const) {
    if ((manifest[field] ?? null) !== (submitted[field] ?? null)) {
      findings.push(deny("IN-006", `manifest.json ${field} (${String(manifest[field])}) differs from the submitted manifest (${String(submitted[field])})`));
    }
  }
  if (findings.length > 0) return { findings, manifest: undefined };

  // Tier-by-content (IN-007). prototype has no extra content rule here: its entrypoint is "package.json", already
  // checked generically below (IN-008), and DESIGN §6.13 leaves a stray app.py or index.html alone.
  const exts = files.map((f) => ({ file: f, ext: extensionOf(f) }));
  if (manifest.tier === "static") {
    for (const { file, ext } of exts) if (ext === "py") findings.push(deny("IN-007", "python file in a static bundle", file));
  } else if (manifest.tier === "python") {
    if (!files.includes("app.py")) findings.push(deny("IN-007", "python bundle without app.py at the root", "app.py"));
    for (const { file, ext } of exts) if (ext === "html") findings.push(deny("IN-007", "html file in a python bundle", file));
  }
  if (!files.includes(manifest.entrypoint)) findings.push(deny("IN-008", `entrypoint ${manifest.entrypoint} is missing`, manifest.entrypoint));
  return { findings, manifest };
}
