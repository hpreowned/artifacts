// policy.ts must be exactly contracts/findings.md. The table is parsed from the markdown so drift fails the build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../../../intake-api/src/repo-root.js";
import { POLICY, severityOf, verdict } from "../policy.js";

const ROW = /^\|\s*([A-Z]+-\d{3})\s*\|\s*[a-z]+\s*\|\s*(deny|warn|info)\s*\|/;

function contractRules(): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const line of readFileSync(resolve(REPO_ROOT, "contracts", "findings.md"), "utf8").split("\n")) {
    const m = ROW.exec(line);
    if (m) rules[m[1]!] = m[2]!;
  }
  return rules;
}

test("every contract rule has the contract severity, and nothing else is in the table", () => {
  const contract = contractRules();
  assert.equal(Object.keys(contract).length, 26, "parsed the whole findings table");
  for (const [rule, severity] of Object.entries(contract)) assert.equal(POLICY[rule], severity, rule);
  const extra = Object.keys(POLICY).filter((r) => !(r in contract));
  assert.deepEqual(extra, ["SEC-000"], "SEC-000 is the one documented addition (gitleaks unavailable)");
});

test("verdict stamps severities from the table and denies on any deny row", () => {
  const { findings, deny } = verdict([{ rule: "HTML-009", severity: "deny", message: "x" }, { rule: "HTML-008", severity: "deny", message: "y" }]);
  assert.deepEqual(findings.map((f) => f.severity), ["info", "warn"]);
  assert.equal(deny, false);
  assert.equal(verdict([{ rule: "HTML-005", severity: "info", message: "z" }]).deny, true);
  assert.throws(() => severityOf("XX-999"), /unknown rule id/);
});
