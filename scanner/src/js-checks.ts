// Node tier stage (contracts/findings.md JS-001..JS-006, DESIGN §6.13). Runs over the bundle's own
// .js/.jsx/.ts/.tsx/.mjs/.cjs files. There is no `node_modules` in a valid bundle; if one exists that is JS-003
// and its contents are never scanned for the other rules.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../../intake-api/src/job.js";
import { literalArguments } from "./checks.js";
import { lineAt } from "./html-parse.js";
import { extensionOf } from "./limits.js";
import { severityOf } from "./policy.js";

export interface JsOptions {
  /**
   * Registry host(s) every lockfile `resolved` URL must match (env NPM_REGISTRY_HOST). Production pins the
   * single JFrog host; the dev stack passes a comma-separated list so laptop lockfiles are valid too.
   */
  npmRegistryHost: string;
}

const JS_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const CLIENT_DIR_RE = /^(?:src|public)\//;
const LIFECYCLE_SCRIPTS = ["preinstall", "postinstall", "prepare"] as const;

const f = (rule: string, file: string, line: number | undefined, message: string): Finding => {
  const finding: Finding = { rule, severity: severityOf(rule), file, message };
  if (line !== undefined) finding.line = line;
  return finding;
};

function isInNodeModules(file: string): boolean {
  return file === "node_modules" || file.startsWith("node_modules/");
}

/** The whole prototype stage. `dir`/`files` are the already-extracted bundle (worker.ts, after intake checks). */
export async function jsChecks(dir: string, files: string[], opts: JsOptions): Promise<Finding[]> {
  const findings: Finding[] = [
    ...(await lockfileCheck(dir, files, opts)),
    ...nodeModulesCheck(files),
    ...envFileCheck(files),
    ...(await packageJsonCheck(dir, files)),
  ];
  const jsFiles = files.filter((file) => !isInNodeModules(file) && JS_EXTENSIONS.has(extensionOf(file)));
  for (const file of jsFiles) {
    const body = await readFile(join(dir, file), "utf8");
    findings.push(...denyCalls(file, body), ...warnCalls(file, body));
  }
  return findings;
}

// JS-003: node_modules present anywhere in the bundle.
function nodeModulesCheck(files: string[]): Finding[] {
  return files.some(isInNodeModules)
    ? [f("JS-003", "node_modules", undefined, "node_modules/ is present in the bundle; dependencies are installed by the pipeline, never shipped")]
    : [];
}

// JS-004: .env, .env.*, or .npmrc anywhere in the bundle.
const DOTFILE_RE = /^\.env(\..+)?$|^\.npmrc$/;
function envFileCheck(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const base = file.split("/").pop() ?? file;
    if (DOTFILE_RE.test(base)) findings.push(f("JS-004", file, undefined, `${base} must never ship inside a node bundle`));
  }
  return findings;
}

// JS-006: package.json has no scripts.start, or carries a lifecycle script.
async function packageJsonCheck(dir: string, files: string[]): Promise<Finding[]> {
  if (!files.includes("package.json")) return []; // IN-008 already denies a missing entrypoint
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as typeof pkg;
  } catch (err) {
    return [f("JS-006", "package.json", undefined, `package.json is not valid JSON: ${(err as Error).message}`)];
  }
  const scripts = pkg.scripts ?? {};
  const findings: Finding[] = [];
  if (typeof scripts.start !== "string" || scripts.start.trim() === "") {
    findings.push(f("JS-006", "package.json", undefined, "package.json has no scripts.start"));
  }
  for (const name of LIFECYCLE_SCRIPTS) {
    if (typeof scripts[name] === "string" && scripts[name]!.trim() !== "") {
      findings.push(f("JS-006", "package.json", undefined, `scripts.${name} is not allowed; the pipeline installs with lifecycle scripts disabled`));
    }
  }
  return findings;
}

// JS-002: package-lock.json missing, or a dependency resolved from a registry other than the JFrog mirror.
async function lockfileCheck(dir: string, files: string[], opts: JsOptions): Promise<Finding[]> {
  if (!files.includes("package-lock.json")) {
    return [f("JS-002", "package-lock.json", undefined, "package-lock.json is missing; dependencies cannot be audited")];
  }
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"));
  } catch (err) {
    return [f("JS-002", "package-lock.json", undefined, `package-lock.json is not valid JSON: ${(err as Error).message}`)];
  }
  const findings: Finding[] = [];
  const allowed = new Set(opts.npmRegistryHost.split(",").map((h) => h.trim()).filter(Boolean));
  for (const url of resolvedUrls(lock)) {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      findings.push(f("JS-002", "package-lock.json", undefined, `resolved URL "${url}" could not be parsed`));
      continue;
    }
    if (!allowed.has(host)) {
      findings.push(f("JS-002", "package-lock.json", undefined, `dependency resolved from "${host}", not the JFrog mirror ("${opts.npmRegistryHost}")`));
    }
  }
  return findings;
}

/** Walks lockfile v1 (`dependencies`, nested) and v2/v3 (`packages`, flat) shapes for every `resolved` string. */
function resolvedUrls(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) resolvedUrls(item, out);
  } else if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.resolved === "string") out.push(obj.resolved);
    for (const [key, value] of Object.entries(obj)) if (key !== "resolved") resolvedUrls(value, out);
  }
  return out;
}

// JS-001: child_process, vm, worker_threads, cluster, raw net/dgram/tls socket creation, process.binding.
const DENY_MODULES = new Set(["child_process", "vm", "worker_threads", "cluster", "net", "dgram", "tls"]);
const MODULE_REF_RE = /\b(?:require\s*\(\s*|import\s*\(\s*|from\s*)(['"`])([^'"`]+)\1/g;
const PROCESS_BINDING_RE = /\bprocess\s*\.\s*binding\s*\(/g;

function denyCalls(file: string, body: string): Finding[] {
  const findings: Finding[] = [];
  const clientNote = CLIENT_DIR_RE.test(file) ? ` (in ${file.split("/")[0]}/, an obvious client path — confirm this is really server code)` : "";
  for (const m of body.matchAll(MODULE_REF_RE)) {
    const mod = m[2]!.replace(/^node:/, "");
    if (DENY_MODULES.has(mod)) findings.push(f("JS-001", file, lineAt(body, m.index), `references "${mod}"${clientNote}`));
  }
  for (const m of body.matchAll(PROCESS_BINDING_RE)) {
    findings.push(f("JS-001", file, lineAt(body, m.index), `process.binding( is not allowed${clientNote}`));
  }
  return findings;
}

// JS-005 (warn): eval(, new Function(, dynamic require(, and fetch/http(s).request to a non-relative URL.
const EVAL_RE = /\beval\s*\(/g;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/g;
const REQUIRE_RE = /\brequire\s*\(/g;
const FETCH_RE = /\b(fetch|http\s*\.\s*request|https\s*\.\s*request)\s*\(/g;

function warnCalls(file: string, body: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of body.matchAll(EVAL_RE)) findings.push(f("JS-005", file, lineAt(body, m.index), "eval( dynamically evaluates code"));
  for (const m of body.matchAll(NEW_FUNCTION_RE)) findings.push(f("JS-005", file, lineAt(body, m.index), "new Function( dynamically compiles code"));
  for (const m of body.matchAll(REQUIRE_RE)) {
    if (!literalArguments(body, m.index + m[0].length)) findings.push(f("JS-005", file, lineAt(body, m.index), "require( with a non-literal argument"));
  }
  for (const m of body.matchAll(FETCH_RE)) {
    const call = m[1]!.replace(/\s+/g, "");
    const arg = firstLiteralArg(body, m.index + m[0].length);
    if (arg === undefined) {
      findings.push(f("JS-005", file, lineAt(body, m.index), `${call}( with a non-literal URL; egress is denied at run time regardless`));
    } else if (/^https?:\/\//i.test(arg)) {
      findings.push(f("JS-005", file, lineAt(body, m.index), `${call}("${arg}") is an absolute URL; egress is denied at run time`));
    }
  }
  return findings;
}

/** The value of a single leading string-literal call argument, or undefined when the argument is not one. */
function firstLiteralArg(src: string, from: number): string | undefined {
  let p = from;
  while (p < src.length && /\s/.test(src[p]!)) p++;
  const quote = src[p];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let end = p + 1;
  while (end < src.length && src[end] !== quote) {
    if (src[end] === "\\") {
      end += 2;
      continue;
    }
    if (quote === "`" && src[end] === "$" && src[end + 1] === "{") return undefined; // template interpolation
    end++;
  }
  return end >= src.length ? undefined : src.slice(p + 1, end);
}
