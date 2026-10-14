import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { builtinSecretScan, runGitleaks, secretsScan } from "../secrets.js";
import { fakeGitleaks } from "./helpers.js";

// Probe strings are assembled at run time so no credential-shaped literal sits in the repository.
const PROBES: Record<string, string> = {
  aws: "AKIA" + "Q".repeat(16),
  azureKey: "AccountKey=" + "B".repeat(86) + "==",
  sas: "https://acct.blob.core.windows.net/c/b?sv=2024-01-01&sig=" + "C".repeat(44),
  github: "ghp_" + "D".repeat(36),
  githubPat: "github_pat_" + "E".repeat(30),
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----",
  jwt: "eyJ" + "F".repeat(12) + ".eyJ" + "G".repeat(12) + "." + "H".repeat(12),
};

let dir: string;
let gitleaks: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "secrets-"));
  gitleaks = await fakeGitleaks(dir);
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("every built-in pattern fires once with the right line; benign text does not", async () => {
  const lines = ["<html>", ...Object.values(PROBES).map((p) => `// ${p}`), "const data = [1, 2, 3];", "</html>"];
  await writeFile(join(dir, "index.html"), lines.join("\n"));
  const f = await builtinSecretScan(dir, ["index.html"]);
  assert.equal(f.length, Object.keys(PROBES).length, JSON.stringify(f));
  assert.deepEqual(f.map((x) => x.line), Object.keys(PROBES).map((_, i) => i + 2));
  assert.ok(f.every((x) => x.rule === "SEC-001" && x.file === "index.html"));
  for (const x of f) for (const probe of Object.values(PROBES)) assert.ok(!x.message.includes(probe), "messages never echo the value");
});

test("only text files are scanned", async () => {
  await writeFile(join(dir, "pic.png"), PROBES.aws!);
  await writeFile(join(dir, "clean.js"), "const key = process.env.KEY;\nconst sig = 'short';");
  assert.deepEqual(await builtinSecretScan(dir, ["pic.png", "clean.js"]), []);
});

test("SEC-000 when the gitleaks binary is missing; the built-in pack still rejects", async () => {
  const missing = await runGitleaks(dir, { gitleaksBin: join(dir, "does-not-exist") });
  assert.match(missing.problem ?? "", /not found/);
  const f = await secretsScan(dir, ["index.html"], { gitleaksBin: join(dir, "does-not-exist") });
  assert.equal(f.filter((x) => x.rule === "SEC-000").length, 1);
  assert.equal(f[0]!.rule, "SEC-000");
  assert.equal(f[0]!.severity, "warn");
  assert.ok(f.some((x) => x.rule === "SEC-001"));
});

test("gitleaks report findings are mapped and de-duplicated against the built-in pack", async () => {
  const report = [
    { RuleID: "aws-access-token", Description: "AWS access token", File: join(dir, "index.html"), StartLine: 2 },
    { RuleID: "generic-api-key", Description: "Generic API key", File: "other.js", StartLine: 7 },
  ];
  process.env.FAKE_GITLEAKS_REPORT = JSON.stringify(report);
  try {
    const f = await secretsScan(dir, ["index.html"], { gitleaksBin: gitleaks });
    assert.ok(!f.some((x) => x.rule === "SEC-000"));
    const atLine2 = f.filter((x) => x.file === "index.html" && x.line === 2);
    assert.equal(atLine2.length, 1, "one finding per file:line");
    assert.match(atLine2[0]!.message, /gitleaks aws-access-token/);
    assert.ok(f.some((x) => x.file === "other.js" && x.line === 7));
  } finally {
    delete process.env.FAKE_GITLEAKS_REPORT;
  }
});

test("a gitleaks failure is SEC-000, not a crash", async () => {
  await writeFile(join(dir, "broken.sh"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const r = await runGitleaks(dir, { gitleaksBin: join(dir, "broken.sh") });
  assert.match(r.problem ?? "", /exited with 3/);
});
