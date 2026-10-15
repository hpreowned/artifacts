// Unit coverage for manifest-validator.ts against the frozen contracts/manifest.schema.json: the demo-tier
// `allOf` branch (schemaVersion 2, tier "demo", runtime "node-20", entrypoint "package.json", ttlDays 1..30).
// static/python already exercise the validator indirectly through api.test.ts's beginPublish 400 case; this
// file is the validator's own direct test, covering all three tiers' allOf branches.
import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestValidator } from "../manifest-validator.js";

const DEMO_OK = {
  schemaVersion: 2,
  name: "demo-ok",
  tier: "demo",
  runtime: "node-20",
  entrypoint: "package.json",
  ttlDays: 14,
  generatedBy: { tool: "artifactctl" },
};

test("manifest-validator: a well-formed demo manifest validates clean", () => {
  const errors = manifestValidator().validate(DEMO_OK);
  assert.deepEqual(errors, []);
});

test("manifest-validator: demo ttlDays over 30 is rejected (schema caps demo at 30, static/python at 90)", () => {
  const bad = { ...DEMO_OK, ttlDays: 60 };
  const errors = manifestValidator().validate(bad);
  assert.ok(errors.some((e) => e.includes("ttlDays") && e.includes("<= 30")), JSON.stringify(errors));
});

test("manifest-validator: demo requires runtime node-20 and entrypoint package.json", () => {
  const wrongRuntime = manifestValidator().validate({ ...DEMO_OK, runtime: "python-1" });
  assert.ok(wrongRuntime.some((e) => e.includes("runtime")), JSON.stringify(wrongRuntime));

  const wrongEntry = manifestValidator().validate({ ...DEMO_OK, entrypoint: "index.html" });
  assert.ok(wrongEntry.some((e) => e.includes("entrypoint")), JSON.stringify(wrongEntry));

  const missingRuntime: Record<string, unknown> = { ...DEMO_OK };
  delete missingRuntime.runtime;
  const errors = manifestValidator().validate(missingRuntime);
  assert.ok(errors.some((e) => e.includes("missing required property \"runtime\"")), JSON.stringify(errors));
});

test("manifest-validator: static and python allOf branches still hold (regression against the demo addition)", () => {
  assert.deepEqual(
    manifestValidator().validate({
      schemaVersion: 2, name: "static-ok", tier: "static", runtime: null, entrypoint: "index.html",
      ttlDays: 14, generatedBy: { tool: "cowork" },
    }),
    [],
  );
  assert.deepEqual(
    manifestValidator().validate({
      schemaVersion: 2, name: "python-ok", tier: "python", runtime: "python-1", entrypoint: "app.py",
      ttlDays: 14, generatedBy: { tool: "cowork" },
    }),
    [],
  );
  // static/python are not capped at 30: 60 is only invalid for demo.
  assert.deepEqual(
    manifestValidator().validate({
      schemaVersion: 2, name: "python-ok", tier: "python", runtime: "python-1", entrypoint: "app.py",
      ttlDays: 60, generatedBy: { tool: "cowork" },
    }),
    [],
  );
});
