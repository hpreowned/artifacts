// Intake limits from contracts/findings.md (IN-001, IN-002, IN-005) and DESIGN.md §5.
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 500;
/** Decompression-bomb guard. Not in the contract; reported under IN-001 with an explicit message. */
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/**
 * IN-005 is tier-dependent (contracts/findings.md): static/python keep the original list; node adds a handful
 * of JS/TS extensions plus two filenames that are allowed regardless of extension. Local literal union instead
 * of importing `Tier` from intake-api/src/job.ts: that type does not carry "node" yet (not scanner's file to
 * change; see the final report), and every real call site passes a `Tier` value, which is a subset of this one.
 */
export type ScanTier = "static" | "python" | "node";

export const ALLOWED_EXTENSIONS = new Set(["html", "css", "js", "json", "svg", "png", "jpg", "jpeg", "webp", "woff2", "txt", "md", "csv", "py"]);
export const NODE_TIER_EXTRA_EXTENSIONS = new Set(["jsx", "ts", "tsx", "mjs", "cjs", "ico", "map"]);
/** Allowed by filename regardless of extension, node tier only (contracts/findings.md IN-005). */
export const NODE_TIER_ALLOWED_FILENAMES = new Set(["package.json", "package-lock.json"]);
/**
 * `.env`, `.env.*`, `.npmrc` are extension-less (or carry a bogus "extension" like `.env.local` -> `local`), so
 * IN-005 would otherwise reject them as an unknown file type before JS-004 gets a chance to name them properly.
 * Node tier lets them extract; JS-004 (js-checks.ts) is the rule that denies them, with a clearer message.
 */
const NODE_TIER_DOTFILE_RE = /^\.env(\..+)?$|^\.npmrc$/;

export const TEXT_EXTENSIONS = new Set(["html", "css", "js", "json", "svg", "txt", "md", "csv", "py", "jsx", "ts", "tsx", "mjs", "cjs"]);

export function allowedExtensions(tier: ScanTier): ReadonlySet<string> {
  return tier === "node" ? new Set([...ALLOWED_EXTENSIONS, ...NODE_TIER_EXTRA_EXTENSIONS]) : ALLOWED_EXTENSIONS;
}

/** IN-005: true when `basename` (with extension `ext`) is allowed in a bundle of this tier. */
export function isAllowedFile(ext: string, basename: string, tier: ScanTier): boolean {
  if (tier === "node" && (NODE_TIER_ALLOWED_FILENAMES.has(basename) || NODE_TIER_DOTFILE_RE.test(basename))) return true;
  return allowedExtensions(tier).has(ext);
}

export function extensionOf(file: string): string {
  const base = file.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}
