import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listBundleFiles, readBundle } from "../src/bundle.js";
import { UsageError } from "../src/config.js";
import { crc32, createZip } from "../src/zip.js";
import { CORPUS } from "./paths.js";
import { unzip } from "./unzip.js";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "artifactctl-bundle-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("zip", () => {
  it("crc32 matches the reference value", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });

  it("round-trips entries, deflates when smaller, stores otherwise, and is byte-deterministic", () => {
    const big = Buffer.from("x".repeat(5000));
    const tiny = Buffer.from("ab");
    const entries = [{ name: "a/big.txt", data: big }, { name: "tiny.txt", data: tiny }];
    const zip = createZip(entries);
    assert.deepEqual(zip, createZip(entries), "same input, same bytes");
    const got = unzip(zip);
    assert.deepEqual(got.map((e) => e.name), ["a/big.txt", "tiny.txt"]);
    assert.deepEqual(got[0]?.data, big);
    assert.deepEqual(got[1]?.data, tiny);
    assert.equal(got[0]?.method, 8, "deflated");
    assert.equal(got[1]?.method, 0, "stored");
    assert.equal(got[0]?.crc, crc32(big));
    assert.equal(got[0]?.flags & 0x0800, 0x0800, "utf8 names");
    assert.ok(zip.length < big.length, "deflate made the archive smaller than its biggest member");
  });

  it("writes an empty archive", () => {
    assert.deepEqual(unzip(createZip([])), []);
  });
});

describe("readBundle", () => {
  it("reads a corpus bundle: sorted file list, parsed manifest, zip of the same bytes, sha256 of the zip", () => {
    const b = readBundle(join(CORPUS, "static-ok"));
    assert.deepEqual(b.files, ["expected.json", "index.html", "manifest.json"]);
    assert.equal((b.manifest as { name: string }).name, "q3-sales");
    assert.equal(b.sha256, createHash("sha256").update(b.zip).digest("hex"));
    const got = unzip(b.zip);
    assert.deepEqual(got.map((e) => e.name), b.files);
    for (const e of got) assert.deepEqual(e.data, readFileSync(join(CORPUS, "static-ok", e.name)));
  });

  it("keeps subdirectory paths relative to the bundle root, no directory entries, byte-order sorted", () => {
    const dir = join(scratch, "nested");
    mkdirSync(join(dir, "assets", "img"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    writeFileSync(join(dir, "assets", "img", "Z.svg"), "<svg/>");
    writeFileSync(join(dir, "assets", "a.css"), "p{}");
    assert.deepEqual(listBundleFiles(dir), ["assets/a.css", "assets/img/Z.svg", "index.html", "manifest.json"]);
    assert.deepEqual(unzip(readBundle(dir).zip).map((e) => e.name), ["assets/a.css", "assets/img/Z.svg", "index.html", "manifest.json"]);
  });

  it("refuses symlinks before any network call (IN-004)", () => {
    const dir = join(scratch, "link");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");
    symlinkSync("manifest.json", join(dir, "alias.json"));
    assert.throws(() => readBundle(dir), (e: unknown) => e instanceof UsageError && /IN-004/.test(e.message));
  });

  it("refuses a missing or unparsable manifest (IN-006) and a non-directory", () => {
    const dir = join(scratch, "nomanifest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "");
    assert.throws(() => readBundle(dir), (e: unknown) => e instanceof UsageError && /IN-006/.test(e.message));
    writeFileSync(join(dir, "manifest.json"), "{not json");
    assert.throws(() => readBundle(dir), (e: unknown) => e instanceof UsageError && /IN-006/.test(e.message));
    assert.throws(() => readBundle(join(dir, "index.html")), (e: unknown) => e instanceof UsageError && /not a directory/.test(e.message));
    assert.throws(() => readBundle(join(scratch, "does-not-exist")), UsageError);
  });
});
