import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { extractBundle, safeRelativePath } from "../extract.js";
import { writeZip } from "../zip-write.js";
import { ZipError } from "../zip-read.js";
import { zipOf } from "./helpers.js";

const rules = (findings: { rule: string }[]) => [...new Set(findings.map((f) => f.rule))].sort();

async function extract(zip: Buffer) {
  const result = await extractBundle(zip);
  try {
    return { ...result, exists: (rel: string) => existsSync(join(result.dir, rel)) };
  } finally {
    await rm(result.dir, { recursive: true, force: true });
  }
}

test("a clean bundle extracts every file, sorted, with no findings", async () => {
  const r = await extract(zipOf({ "index.html": "<html></html>", "manifest.json": "{}", "assets/app.css": "body{}" }));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.files, ["assets/app.css", "index.html", "manifest.json"]);
});

test("IN-003: zip-slip and absolute paths are refused and not written", async () => {
  const r = await extract(zipOf({ "../evil.txt": "x", "/etc/passwd": "x", "ok.txt": "x", "a/../../b.txt": "x" }));
  assert.deepEqual(rules(r.findings), ["IN-003"]);
  assert.equal(r.findings.length, 3);
  assert.deepEqual(r.files, ["ok.txt"]);
});

test("IN-003: duplicate paths (case-insensitive) are ambiguous", async () => {
  const r = await extract(writeZip([{ name: "Index.html", data: "a" }, { name: "index.html", data: "b" }]));
  assert.deepEqual(rules(r.findings), ["IN-003"]);
});

test("IN-004: symlinks and special files", async () => {
  const r = await extract(writeZip([
    { name: "link.txt", data: "/etc/passwd", mode: 0o120777 },
    { name: "fifo.txt", data: "", mode: 0o010644 },
    { name: "ok.txt", data: "x" },
  ]));
  assert.deepEqual(rules(r.findings), ["IN-004"]);
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.files, ["ok.txt"]);
});

test("IN-005: a file outside the allowlist is reported; the rest still extracts", async () => {
  const r = await extract(zipOf({ "helper.sh": "echo", "index.html": "<p>", "noext": "x", "x.PNG": "p" }));
  assert.deepEqual(rules(r.findings), ["IN-005"]);
  assert.deepEqual(r.findings.map((f) => f.file).sort(), ["helper.sh", "noext"]);
  assert.deepEqual(r.files, ["index.html", "x.PNG"]);
});

test("IN-002: more than 500 files", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 501; i++) files[`f${i}.txt`] = "x";
  const r = await extract(zipOf(files));
  assert.deepEqual(rules(r.findings), ["IN-002"]);
  assert.deepEqual(r.files, []);
});

test("IN-001: zip over 25 MiB, and a bundle that inflates past the bomb guard", async () => {
  const big = await extract(writeZip([{ name: "big.txt", data: Buffer.alloc(25 * 1024 * 1024 + 1, 0x41), store: true }]));
  assert.deepEqual(rules(big.findings), ["IN-001"]);
  const bomb = await extract(writeZip([{ name: "zeros.txt", data: Buffer.alloc(101 * 1024 * 1024) }]));
  assert.deepEqual(rules(bomb.findings), ["IN-001"]);
  assert.match(bomb.findings[0]!.message, /inflates/);
});

test("directories are skipped, nested files land in place", async () => {
  const r = await extract(writeZip([{ name: "assets/", data: "" }, { name: "assets/a.css", data: "x" }]));
  assert.deepEqual(r.files, ["assets/a.css"]);
  assert.deepEqual(r.findings, []);
});

test("corrupt archives throw ZipError", async () => {
  await assert.rejects(() => extractBundle(Buffer.from("not a zip at all, definitely not")), ZipError);
  const zip = zipOf({ "a.txt": "hello" });
  zip.writeUInt8(zip.readUInt8(zip.length - 10) ^ 0xff, zip.length - 10); // damage the central directory offset
  await assert.rejects(() => extractBundle(zip), ZipError);
});

test("safeRelativePath normalises and refuses escapes", () => {
  assert.equal(safeRelativePath("a/./b.txt"), "a/b.txt");
  assert.equal(safeRelativePath("a//b/"), "a/b");
  for (const bad of ["", "..", "../x", "/x", "C:\\x", "a\\b", "a\0b", "."]) assert.equal(safeRelativePath(bad), undefined, bad);
});
