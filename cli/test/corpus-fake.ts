// Standalone fake intake whose verdicts come from tests/corpus/*/expected.json, keyed by manifest name.
// Usage: node .tsbuild/test/corpus-fake.js   → prints the base URL, serves until killed.
// Lets tests/lib/selftest.sh prove tests/negative.sh end to end before the real intake-api exists.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, State } from "../src/client.js";
import { FakeIntake, LIVE, type Scenario } from "./fake-intake.js";
import { CORPUS } from "./paths.js";

interface Expected {
  state: State;
  rules: string[];
}

const SOFT: Record<string, Finding["severity"]> = { "HTML-008": "warn", "HTML-009": "info", "PY-005": "warn" };

function scenarioFor(e: Expected): Scenario {
  const findings: Finding[] = e.rules.map((rule) => ({
    rule, severity: SOFT[rule] ?? "deny", file: "index.html", line: 1, message: `corpus expectation ${rule}`,
  }));
  switch (e.state) {
    case "live":
      return { ...LIVE, findings };
    case "awaiting_approval":
      return { states: ["scanning", "awaiting_approval"], findings, approval: { group: "artifacts-approvers", runUrl: "https://dev.azure.com/corp/artifacts/_build/results?buildId=1" } };
    default:
      return { states: ["scanning", e.state], findings, summary: `corpus expectation: ${e.state}` };
  }
}

export function loadScenarios(corpus = CORPUS): Map<string, Scenario> {
  const out = new Map<string, Scenario>();
  for (const name of readdirSync(corpus)) {
    let expected: Expected;
    let manifest: { name?: string };
    try {
      expected = JSON.parse(readFileSync(join(corpus, name, "expected.json"), "utf8")) as Expected;
      manifest = JSON.parse(readFileSync(join(corpus, name, "manifest.json"), "utf8")) as { name?: string };
    } catch {
      continue; // static-bad-manifest has no parsable manifest; the fake's 400 handles it
    }
    if (typeof manifest.name === "string") out.set(manifest.name, scenarioFor(expected));
  }
  return out;
}

const fake = new FakeIntake();
const scenarios = loadScenarios();
fake.scenarioFor = (manifest) => {
  const name = (manifest as { name?: unknown }).name;
  const found = typeof name === "string" ? scenarios.get(name) : undefined;
  if (process.env.CORPUS_FAKE_FORCE_STATE) {
    return { states: ["scanning", process.env.CORPUS_FAKE_FORCE_STATE as State] };
  }
  return found ?? { states: ["scanning", "failed"], summary: `corpus-fake: no scenario for manifest name ${String(name)}` };
};
const base = await fake.listen();
process.stdout.write(`${base}\n`);
