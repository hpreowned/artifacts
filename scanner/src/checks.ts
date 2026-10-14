// Stage 4 (static): HTML-001..HTML-009, and stage 5 (python): PY-004 by file presence. Rule texts are in
// contracts/findings.md; severities are looked up in policy.ts, the single rule → severity table.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, Manifest } from "../../intake-api/src/job.js";
import { manifestValidator } from "../../intake-api/src/manifest-validator.js";
import { isExternalHttp, lineAt, parseHtml, pointsElsewhere } from "./html-parse.js";
import { extensionOf } from "./limits.js";
import { severityOf } from "./policy.js";

const f = (rule: string, file: string, line: number, message: string): Finding => ({ rule, severity: severityOf(rule), file, line, message });

const FRAMING_TAGS = new Set(["iframe", "frame", "embed", "object"]);
const DOCUMENT_EXTENSIONS = new Set(["html", "svg"]); // svg executes inline <script> when opened as a document
const BLOB_MIN_CHARS = 64 * 1024;
const DANGEROUS_CALL_RE = /\b(eval|new\s+Function|document\s*\.\s*write(?:ln)?)\s*\(/g;
const NETWORK_RE = /\b(fetch\s*\(|XMLHttpRequest\b|WebSocket\s*\()/g;

/** Runs every HTML rule over the bundle: documents get the tag rules, documents and .js files get the script rules. */
export async function htmlChecks(dir: string, files: string[], manifest: Manifest): Promise<Finding[]> {
  const cdn = manifestValidator().externalScriptPattern;
  const findings: Finding[] = [];
  for (const file of files) {
    const ext = extensionOf(file);
    if (DOCUMENT_EXTENSIONS.has(ext)) findings.push(...checkDocument(file, await readFile(join(dir, file), "utf8"), manifest, cdn));
    else if (ext === "js") findings.push(...checkScript(file, await readFile(join(dir, file), "utf8"), 1));
  }
  return findings;
}

export function checkDocument(file: string, html: string, manifest: Manifest, cdn: RegExp): Finding[] {
  const findings: Finding[] = [];
  const declared = new Set(manifest.externalScripts ?? []);
  const { tags, scripts } = parseHtml(html);
  for (const tag of tags) {
    const line = lineAt(html, tag.offset);
    const a = tag.attrs;
    switch (tag.name) {
      case "script":
        if (a.src !== undefined && pointsElsewhere(a.src)) {
          if (!declared.has(a.src.trim())) findings.push(f("HTML-001", file, line, `<script src="${a.src}"> is not listed in manifest externalScripts`));
          else if (!cdn.test(a.src.trim())) findings.push(f("HTML-001", file, line, `<script src="${a.src}"> is not on an allowlisted CDN`));
        }
        break;
      case "base":
        if (a.href !== undefined && pointsElsewhere(a.href)) {
          findings.push(f("HTML-001", file, line, `<base href="${a.href}"> would make every relative <script src> load from another host`));
        }
        break;
      case "form":
        if (a.action !== undefined && pointsElsewhere(a.action)) findings.push(f("HTML-002", file, line, `<form action="${a.action}"> posts to another host`));
        break;
      case "meta":
        if ((a["http-equiv"] ?? "").trim().toLowerCase() === "refresh") findings.push(f("HTML-004", file, line, `<meta http-equiv="refresh"> is not allowed`));
        break;
      case "link":
        if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("import")) findings.push(f("HTML-004", file, line, `<link rel="import"> is not allowed`));
        break;
      case "input":
        if ((a.type ?? "").trim().toLowerCase() === "password") findings.push(f("HTML-005", file, line, `<input type="password"> is not allowed; artifacts never collect credentials`));
        break;
      case "a":
        if (a.href !== undefined && isExternalHttp(a.href)) findings.push(f("HTML-008", file, line, `<a href="${a.href}"> points to an external host and will not open inside the viewer`));
        break;
      default:
        if (FRAMING_TAGS.has(tag.name)) findings.push(f("HTML-003", file, line, `<${tag.name}> is not allowed`));
    }
    if ((tag.name === "button" || tag.name === "input") && a.formaction !== undefined && pointsElsewhere(a.formaction)) {
      findings.push(f("HTML-002", file, line, `formaction="${a.formaction}" posts to another host`));
    }
  }
  for (const script of scripts) findings.push(...checkScript(file, script.body, lineAt(html, script.offset)));
  return findings;
}

/** HTML-006, HTML-007, HTML-009 over one script body. `baseLine` is the document line the body starts on. */
export function checkScript(file: string, body: string, baseLine: number): Finding[] {
  const findings: Finding[] = [];
  const lineOf = (offset: number) => baseLine + lineAt(body, offset) - 1;
  for (const m of body.matchAll(DANGEROUS_CALL_RE)) {
    if (!literalArguments(body, m.index + m[0].length)) {
      findings.push(f("HTML-006", file, lineOf(m.index), `${m[1]!.replace(/\s+/g, " ")}( with a non-literal argument`));
    }
  }
  for (const run of encodedRuns(body, BLOB_MIN_CHARS)) {
    findings.push(f("HTML-007", file, lineOf(run.offset), `encoded blob of ${run.length} characters inside a script (limit ${BLOB_MIN_CHARS})`));
  }
  for (const m of body.matchAll(NETWORK_RE)) {
    findings.push(f("HTML-009", file, lineOf(m.index), `${m[1]!.replace(/\s*\($/, "")} is blocked at serve time by connect-src 'none'`));
  }
  return findings;
}

/** Maximal runs of base64 / base64url / hex characters at least `min` long. Linear: a regex with `{65536,}` backtracks quadratically. */
export function encodedRuns(body: string, min: number): { offset: number; length: number }[] {
  const runs: { offset: number; length: number }[] = [];
  let start = -1;
  for (let i = 0; i <= body.length; i++) {
    const c = i < body.length ? body.charCodeAt(i) : -1;
    const inClass = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61 || c === 95 || c === 45;
    if (inClass) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= min) runs.push({ offset: start, length: i - start });
      start = -1;
    }
  }
  return runs;
}

/** True when everything up to the closing paren is string literals (no `${`) separated by commas, or nothing. */
export function literalArguments(src: string, from: number): boolean {
  let p = skipSpace(src, from);
  if (src[p] === ")") return true;
  for (;;) {
    const quote = src[p];
    if (quote !== '"' && quote !== "'" && quote !== "`") return false;
    p++;
    for (;;) {
      const ch = src[p];
      if (ch === undefined) return false;
      if (ch === "\\") {
        p += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && src[p + 1] === "{") return false;
      if (ch === quote) break;
      p++;
    }
    p = skipSpace(src, p + 1);
    if (src[p] === ")") return true;
    if (src[p] !== ",") return false;
    p = skipSpace(src, p + 1);
  }
}

function skipSpace(src: string, p: number): number {
  while (p < src.length && /\s/.test(src[p]!)) p++;
  return p;
}

const PACKAGING_FILES = new Set(["requirements.txt", "pyproject.toml", "setup.py"]);

/** PY-004: dependency or packaging files anywhere in the bundle. The curated runtime decides dependencies. */
export function pythonFileChecks(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const base = file.split("/").pop() ?? file;
    if (PACKAGING_FILES.has(base.toLowerCase()) || /\.(whl|tar\.gz)$/i.test(base)) {
      findings.push({ rule: "PY-004", severity: severityOf("PY-004"), file, message: `${base} is not allowed; the python-1 runtime fixes the dependency set` });
    }
  }
  return findings;
}
