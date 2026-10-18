// Unit tests for jsChecks (contracts/findings.md JS-001..JS-006), independent of the corpus/worker harness.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jsChecks } from "../js-checks.js";

const OPTS = { npmRegistryHost: "jfrog.corp.com" };
const rules = (findings: { rule: string }[]) => [...new Set(findings.map((f) => f.rule))].sort();

async function withBundle(files: Record<string, string>, run: (dir: string, names: string[]) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "js-checks-"));
  try {
    const names = Object.keys(files).sort();
    for (const name of names) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await writeFile(join(dir, name), files[name]!);
    }
    await run(dir, names);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LOCKFILE_OK = JSON.stringify({
  lockfileVersion: 3,
  packages: { "": {}, "node_modules/x": { resolved: "https://jfrog.corp.com/artifactory/api/npm/npm-remote/x/-/x-1.0.0.tgz" } },
});
const PACKAGE_OK = JSON.stringify({ name: "a", scripts: { start: "node server.js" } });

test("a clean bundle carries no findings", async () => {
  await withBundle(
    { "package.json": PACKAGE_OK, "package-lock.json": LOCKFILE_OK, "server/index.js": "const x = require('express');" },
    async (dir, names) => assert.deepEqual(await jsChecks(dir, names, OPTS), []),
  );
});

test("JS-001: deny modules in require/import/dynamic-import form, any quote style; process.binding", async () => {
  const body = [
    `const { execSync } = require("child_process");`,
    `import vm from 'vm';`,
    `const w = require(\`worker_threads\`);`,
    `import("cluster");`,
    `const net = require("net");`,
    `const dgram = require("node:dgram");`,
    `import tls from "tls";`,
    `process.binding("fs");`,
    `const ok = require("express");`,
  ].join("\n");
  await withBundle({ "package.json": PACKAGE_OK, "package-lock.json": LOCKFILE_OK, "server/index.js": body }, async (dir, names) => {
    const f = await jsChecks(dir, names, OPTS);
    assert.deepEqual(rules(f), ["JS-001"]);
    assert.equal(f.filter((x) => x.rule === "JS-001").length, 8);
    assert.ok(f.every((x) => x.severity === "deny"));
  });
});

test("JS-001: notes an obvious client path without changing the verdict", async () => {
  await withBundle({ "package.json": PACKAGE_OK, "package-lock.json": LOCKFILE_OK, "src/widget.js": `require("child_process");` }, async (dir, names) => {
    const f = await jsChecks(dir, names, OPTS);
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /src\//);
  });
});

test("JS-002: missing lockfile, invalid JSON, and a foreign registry (v1 and v2/v3 shapes)", async () => {
  await withBundle({ "package.json": PACKAGE_OK }, async (dir, names) => {
    assert.deepEqual(rules(await jsChecks(dir, names, OPTS)), ["JS-002"]);
  });
  await withBundle({ "package.json": PACKAGE_OK, "package-lock.json": "{not json" }, async (dir, names) => {
    assert.deepEqual(rules(await jsChecks(dir, names, OPTS)), ["JS-002"]);
  });
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { x: { resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } } });
  await withBundle({ "package.json": PACKAGE_OK, "package-lock.json": v1 }, async (dir, names) => {
    const f = await jsChecks(dir, names, OPTS);
    assert.deepEqual(rules(f), ["JS-002"]);
    assert.match(f[0]!.message, /registry\.npmjs\.org/);
  });
  await withBundle({ "package.json": PACKAGE_OK, "package-lock.json": LOCKFILE_OK }, async (dir, names) => {
    assert.deepEqual(await jsChecks(dir, names, OPTS), []);
  });
});

test("JS-003: node_modules present anywhere, and its contents are not scanned for the other rules", async () => {
  await withBundle(
    {
      "package.json": PACKAGE_OK,
      "package-lock.json": LOCKFILE_OK,
      "node_modules/x/index.js": `require("child_process");`, // would be JS-001 if it were scanned
    },
    async (dir, names) => {
      const f = await jsChecks(dir, names, OPTS);
      assert.deepEqual(rules(f), ["JS-003"]);
    },
  );
});

test("JS-004: .env, .env.local, and .npmrc anywhere in the bundle", async () => {
  await withBundle(
    { "package.json": PACKAGE_OK, "package-lock.json": LOCKFILE_OK, ".env": "PORT=3000", "config/.env.local": "X=1", ".npmrc": "registry=x" },
    async (dir, names) => {
      const f = await jsChecks(dir, names, OPTS);
      assert.deepEqual(rules(f), ["JS-004"]);
      assert.equal(f.length, 3);
    },
  );
});

test("JS-005 (warn): eval, new Function, dynamic require, and absolute fetch/http(s).request URLs", async () => {
  const body = [
    `eval("1+1");`,
    `new Function("a", "return a");`,
    `require(mod);`,
    `require("express");`,
    `fetch("https://evil.example/x");`,
    `fetch(\`/api/\${id}\`);`,
    `fetch("/api/companies");`,
    `http.request("http://internal.example");`,
    `https.request(url);`,
  ].join("\n");
  await withBundle({ "package.json": PACKAGE_OK, "package-lock.json": LOCKFILE_OK, "server/index.js": body }, async (dir, names) => {
    const f = await jsChecks(dir, names, OPTS);
    assert.deepEqual(rules(f), ["JS-005"]);
    assert.ok(f.every((x) => x.severity === "warn"));
    // eval, new Function, require(mod), fetch(evil), fetch(`/api/${id}`), http.request(abs), https.request(url) = 7;
    // require("express") and fetch("/api/companies") are literal/relative and not reported.
    assert.equal(f.length, 7);
  });
});

test("JS-006: no scripts.start, and a lifecycle script", async () => {
  await withBundle({ "package.json": JSON.stringify({ name: "a" }), "package-lock.json": LOCKFILE_OK }, async (dir, names) => {
    assert.deepEqual(rules(await jsChecks(dir, names, OPTS)), ["JS-006"]);
  });
  const withLifecycle = JSON.stringify({ scripts: { start: "node x.js", postinstall: "node setup.js", prepare: "husky install" } });
  await withBundle({ "package.json": withLifecycle, "package-lock.json": LOCKFILE_OK }, async (dir, names) => {
    const f = await jsChecks(dir, names, OPTS);
    assert.deepEqual(rules(f), ["JS-006"]);
    assert.equal(f.length, 2);
  });
  await withBundle({ "package.json": "{not json", "package-lock.json": LOCKFILE_OK }, async (dir, names) => {
    assert.deepEqual(rules(await jsChecks(dir, names, OPTS)), ["JS-006"]);
  });
});

test("JS-002: NPM_REGISTRY_HOST may list several hosts (dev stack); any listed host is accepted, others still fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "js002-multi-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { start: "node a.js" } }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({
      packages: {
        "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
        "node_modules/b": { resolved: "https://jfrog.corp.com/artifactory/api/npm/npm-remote/b/-/b-1.0.0.tgz" },
        "node_modules/c": { resolved: "https://evil.example/c/-/c-1.0.0.tgz" },
      },
    }));
    const found = await jsChecks(dir, ["package.json", "package-lock.json"], { npmRegistryHost: "jfrog.corp.com, registry.npmjs.org" });
    const js002 = found.filter((x) => x.rule === "JS-002");
    assert.equal(js002.length, 1, JSON.stringify(js002));
    assert.match(js002[0]!.message, /evil\.example/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

