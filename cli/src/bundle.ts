// Read a dist/ directory into a deterministic zip: files only, at the root, byte-order sorted, no symlinks.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { UsageError } from "./config.js";
import { createZip, type ZipEntry } from "./zip.js";

export interface Bundle {
  dir: string;
  manifest: unknown;
  files: string[];
  zip: Buffer;
  sha256: string;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) throw new UsageError(`symlink in bundle (rule IN-004): ${relative(root, p)}`);
    if (d.isDirectory()) walk(root, p, out);
    else if (d.isFile()) out.push(relative(root, p).split(sep).join("/"));
    else throw new UsageError(`special file in bundle (rule IN-004): ${relative(root, p)}`);
  }
}

export function listBundleFiles(dir: string): string[] {
  const files: string[] = [];
  walk(dir, dir, files);
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export function readBundle(dir: string): Bundle {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new UsageError(`not a directory: ${dir}`);
  }
  if (!st.isDirectory()) throw new UsageError(`not a directory: ${dir}`);
  const files = listBundleFiles(dir);
  if (!files.includes("manifest.json")) throw new UsageError(`${dir}/manifest.json missing (rule IN-006)`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown;
  } catch (e) {
    throw new UsageError(`${dir}/manifest.json is not valid JSON (rule IN-006): ${(e as Error).message}`);
  }
  const entries: ZipEntry[] = files.map((name) => ({ name, data: readFileSync(join(dir, name)) }));
  const zip = createZip(entries);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  return { dir, manifest, files, zip, sha256 };
}
