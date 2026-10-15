// Stage 1 (part 1): unpack the bundle into a temp dir, emitting IN-001..IN-005 and never writing anything unsafe.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { Finding } from "../../intake-api/src/job.js";
import { MAX_FILES, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_BYTES, allowedExtensions, extensionOf, isAllowedFile, type ScanTier } from "./limits.js";
import { readZip, type ZipEntry } from "./zip-read.js";

export interface Extracted {
  dir: string;
  /** Relative posix paths of regular files written to `dir`, sorted. */
  files: string[];
  findings: Finding[];
}

const deny = (rule: string, message: string, file?: string): Finding =>
  file === undefined ? { rule, severity: "deny", message } : { rule, severity: "deny", file, message };

/** Returns the safe relative path, or undefined when the name would escape or is ambiguous (IN-003). */
export function safeRelativePath(name: string): string | undefined {
  if (name.length === 0 || name.includes("\0") || name.includes("\\") || /^[A-Za-z]:/.test(name)) return undefined;
  const normalized = posix.normalize(name);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized === ".") return undefined;
  return normalized.replace(/\/+$/, "");
}

/** `tier` picks the IN-005 allowlist (contracts/findings.md); defaults to the static/python list. */
export async function extractBundle(zip: Buffer, tier: ScanTier = "static"): Promise<Extracted> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-scan-"));
  const findings: Finding[] = [];
  const files: string[] = [];
  if (zip.length > MAX_ZIP_BYTES) {
    findings.push(deny("IN-001", `zip is ${zip.length} bytes; the limit is ${MAX_ZIP_BYTES}`));
    return { dir, files, findings };
  }
  const entries = readZip(zip).filter((e) => !e.isDirectory);
  if (entries.length > MAX_FILES) {
    findings.push(deny("IN-002", `${entries.length} files; the limit is ${MAX_FILES}`));
    return { dir, files, findings };
  }
  const declared = entries.reduce((n, e) => n + e.uncompressedSize, 0);
  if (declared > MAX_UNCOMPRESSED_BYTES) {
    findings.push(deny("IN-001", `bundle inflates to ${declared} bytes; the limit is ${MAX_UNCOMPRESSED_BYTES}`));
    return { dir, files, findings };
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const finding = await extractEntry(entry, dir, seen, tier);
    if (finding) findings.push(finding);
    else files.push(safeRelativePath(entry.name)!);
  }
  files.sort();
  return { dir, files, findings };
}

async function extractEntry(entry: ZipEntry, dir: string, seen: Set<string>, tier: ScanTier): Promise<Finding | undefined> {
  const rel = safeRelativePath(entry.name);
  if (rel === undefined) return deny("IN-003", "path escapes the bundle root", entry.name);
  const target = resolve(dir, rel);
  if (!target.startsWith(dir + sep)) return deny("IN-003", "path escapes the bundle root", entry.name);
  if (seen.has(rel.toLowerCase())) return deny("IN-003", "duplicate path in the archive (ambiguous bundle)", entry.name);
  seen.add(rel.toLowerCase());
  if (entry.isSymlink) return deny("IN-004", "symlink in the bundle", entry.name);
  if (entry.isSpecial) return deny("IN-004", "special file (device, fifo or socket) in the bundle", entry.name);
  const ext = extensionOf(rel);
  const base = rel.split("/").pop() ?? rel;
  if (!isAllowedFile(ext, base, tier)) {
    return deny("IN-005", `file type "${ext || "(none)"}" is not allowed; allowed: ${[...allowedExtensions(tier)].join(" ")}`, entry.name);
  }
  const data = entry.read(MAX_UNCOMPRESSED_BYTES);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data, { flag: "wx" });
  return undefined;
}
