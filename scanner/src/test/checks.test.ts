import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestValidator } from "../../../intake-api/src/manifest-validator.js";
import { checkDocument, checkScript, htmlChecks, literalArguments, pythonFileChecks } from "../checks.js";
import { parseHtml } from "../html-parse.js";
import { STATIC_MANIFEST } from "./helpers.js";

const CDN = manifestValidator().externalScriptPattern;
const CHART = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
const doc = (body: string) => `<!doctype html><html><head><title>t</title></head>\n<body>\n${body}\n</body></html>`;
const run = (html: string) => checkDocument("index.html", html, STATIC_MANIFEST, CDN);
const rules = (findings: { rule: string }[]) => findings.map((f) => f.rule).sort();

test("HTML-001: script src must be declared and on an allowlisted CDN; local scripts pass", () => {
  assert.deepEqual(rules(run(doc(`<script src="${CHART}"></script>`))), []);
  assert.deepEqual(rules(run(doc(`<script src="app.js"></script><script src="./lib/x.js"></script>`))), []);
  assert.deepEqual(rules(run(doc(`<script src="https://evil.example/x.js"></script>`))), ["HTML-001"]);
  assert.deepEqual(rules(run(doc(`<script src="//cdnjs.cloudflare.com/ajax/libs/x/1/x.js"></script>`))), ["HTML-001"]);
  const declaredButNotCdn = { ...STATIC_MANIFEST, externalScripts: ["https://evil.example/x.js"] };
  const f = checkDocument("index.html", doc(`<script src="https://evil.example/x.js"></script>`), declaredButNotCdn, CDN);
  assert.deepEqual(rules(f), ["HTML-001"]);
  assert.match(f[0]!.message, /allowlisted CDN/);
  assert.deepEqual(rules(run(doc(`<base href="https://evil.example/">`))), ["HTML-001"]);
});

test("HTML-002: form actions and formaction to another host", () => {
  assert.deepEqual(rules(run(doc(`<form action="https://collector.example/p"></form>`))), ["HTML-002"]);
  assert.deepEqual(rules(run(doc(`<form action="//collector.example/p"></form>`))), ["HTML-002"]);
  assert.deepEqual(rules(run(doc(`<form action="javascript:void(0)"></form>`))), ["HTML-002"]);
  assert.deepEqual(rules(run(doc(`<form><button formaction="https://x.example/p"></button></form>`))), ["HTML-002"]);
  assert.deepEqual(rules(run(doc(`<form action="#" method="get"></form><form></form>`))), []);
});

test("HTML-003/004/005: framing, refresh/import, password inputs", () => {
  for (const tag of ["iframe", "frame", "embed", "object"]) assert.deepEqual(rules(run(doc(`<${tag} src="x"></${tag}>`))), ["HTML-003"], tag);
  assert.deepEqual(rules(run(doc(`<meta HTTP-EQUIV="Refresh" content="0;url=https://x">`))), ["HTML-004"]);
  assert.deepEqual(rules(run(doc(`<link rel="stylesheet import" href="x.html">`))), ["HTML-004"]);
  assert.deepEqual(rules(run(doc(`<meta charset="utf-8"><link rel="stylesheet" href="a.css">`))), []);
  assert.deepEqual(rules(run(doc(`<input type=PASSWORD name=p>`))), ["HTML-005"]);
  assert.deepEqual(rules(run(doc(`<input type="text"><input>`))), []);
});

test("HTML-006: only non-literal arguments to eval, new Function, document.write", () => {
  assert.deepEqual(rules(checkScript("a.js", `eval("1+1"); new Function("a", "return a"); document.write('<p>hi</p>'); eval()`, 1)), []);
  assert.deepEqual(rules(checkScript("a.js", `eval(atob(code))`, 1)), ["HTML-006"]);
  assert.deepEqual(rules(checkScript("a.js", `window.eval(x)`, 1)), ["HTML-006"]);
  assert.deepEqual(rules(checkScript("a.js", "new Function(`return ${x}`)", 1)), ["HTML-006"]);
  assert.deepEqual(rules(checkScript("a.js", "new  Function(code)", 1)), ["HTML-006"]);
  assert.deepEqual(rules(checkScript("a.js", `document.write(location.hash)`, 1)), ["HTML-006"]);
  assert.deepEqual(rules(checkScript("a.js", `document.writeln(x)`, 1)), ["HTML-006"]);
  assert.equal(literalArguments(`("a" + b)`, 1), false);
  assert.equal(literalArguments(`('a\\'b', "c")`, 1), true);
});

test("HTML-007: encoded blobs of 64 KiB or more inside scripts", () => {
  assert.deepEqual(rules(checkScript("a.js", `const p = "${"A".repeat(65535)}";`, 1)), []);
  assert.deepEqual(rules(checkScript("a.js", `const p = "${"A".repeat(65536)}";`, 1)), ["HTML-007"]);
  assert.deepEqual(rules(checkScript("a.js", `const p = "${"0f".repeat(40000)}";`, 1)), ["HTML-007"]);
});

test("HTML-008 (warn) and HTML-009 (info) carry their severities", () => {
  const f = run(doc(`<a href="https://example.com/">x</a><a href="/local">y</a><a href="#top">z</a>`));
  assert.deepEqual(rules(f), ["HTML-008"]);
  assert.equal(f[0]!.severity, "warn");
  const s = checkScript("a.js", `fetch("/x"); const r = new XMLHttpRequest(); new WebSocket("wss://x")`, 1);
  assert.deepEqual(rules(s), ["HTML-009", "HTML-009", "HTML-009"]);
  assert.ok(s.every((x) => x.severity === "info"));
});

test("line numbers point at the tag or the script line", () => {
  const html = `<html>\n<body>\n<iframe src="x"></iframe>\n<script>\nconst a = 1;\neval(a);\n</script>\n</body></html>`;
  const f = run(html);
  assert.deepEqual(f.map((x) => [x.rule, x.line]), [["HTML-003", 3], ["HTML-006", 6]]);
});

test("comments are skipped like a browser does; script bodies are not parsed as tags", () => {
  assert.deepEqual(rules(run(doc(`<!-- <iframe src="x"></iframe> --><p>ok</p>`))), []);
  assert.deepEqual(rules(run(doc(`<script>const s = "<iframe src='x'></iframe>";</script>`))), []);
  const { tags, scripts } = parseHtml(`<a href="x>y" title='q"'>t</a><script type=module>\n1\n</script>`);
  assert.equal(tags[0]!.attrs.href, "x>y");
  assert.equal(tags[0]!.attrs.title, 'q"');
  assert.equal(scripts[0]!.body, "\n1\n");
});

test("htmlChecks covers .html, .svg and .js files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checks-"));
  try {
    await writeFile(join(dir, "index.html"), doc(`<p>fine</p>`));
    await writeFile(join(dir, "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>eval(x)</script></svg>`);
    await writeFile(join(dir, "app.js"), `document.write(y)`);
    await writeFile(join(dir, "notes.txt"), `eval(x)`);
    const f = await htmlChecks(dir, ["app.js", "index.html", "logo.svg", "notes.txt"], STATIC_MANIFEST);
    assert.deepEqual(f.map((x) => [x.rule, x.file]), [["HTML-006", "app.js"], ["HTML-006", "logo.svg"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PY-004: packaging files anywhere in the bundle", () => {
  const f = pythonFileChecks(["app.py", "requirements.txt", "sub/pyproject.toml", "Setup.py", "dist/x-1.0-py3-none-any.whl", "src.tar.gz", "notes.txt"]);
  assert.deepEqual(f.map((x) => x.file), ["requirements.txt", "sub/pyproject.toml", "Setup.py", "dist/x-1.0-py3-none-any.whl", "src.tar.gz"]);
  assert.ok(f.every((x) => x.rule === "PY-004"));
});
