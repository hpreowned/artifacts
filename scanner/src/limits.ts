// Intake limits from contracts/findings.md (IN-001, IN-002, IN-005) and DESIGN.md §5.
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 500;
/** Decompression-bomb guard. Not in the contract; reported under IN-001 with an explicit message. */
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = new Set(["html", "css", "js", "json", "svg", "png", "jpg", "jpeg", "webp", "woff2", "txt", "md", "csv", "py"]);
export const TEXT_EXTENSIONS = new Set(["html", "css", "js", "json", "svg", "txt", "md", "csv", "py"]);

export function extensionOf(file: string): string {
  const base = file.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}
