// Unit coverage for manifest-validator.ts against the frozen contracts/manifest.schema.json: the node-tier
// `allOf` branch (schemaVersion 2, tier "node", runtime "node-20", entrypoint "package.json", ttlDays 1..30).
// static/python already exercise the validator indirectly through api.test.ts's beginPublish 400 case; this
// file is the validator's own direct test, covering all three tiers' allOf branches.
import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestValidator } from "../manifest-validator.js";

const NODE_TIER_OK = {
  schemaVersion: 2,
  name: "node-ok",
  tier: "node",
  runtime: "node-20",
  entrypoint: "package.json",
  ttlDays: 14,
  generatedBy: { tool: "artifactctl" },
};

test("manifest-validator: a well-formed node manifest validates clean", () => {
  const errors = manifestValidator().validate(NODE_TIER_OK);
  assert.deepEqual(errors, []);
});

test("manifest-validator: ttlDays over 90 is rejected for every tier; 60 is valid for node (uniform cap)", () => {
  const sixty = manifestValidator().validate({ ...NODE_TIER_OK, ttlDays: 60 });
  assert.equal(sixty.length, 0);
  const bad = { ...NODE_TIER_OK, ttlDays: 95 };
  const errors = manifestValidator().validate(bad);
  assert.ok(errors.some((e) => e.includes("ttlDays")), JSON.stringify(errors));
});

test("manifest-validator: prototype requires runtime node-20 and entrypoint package.json", () => {
  const wrongRuntime = manifestValidator().validate({ ...NODE_TIER_OK, runtime: "python-1" });
  assert.ok(wrongRuntime.some((e) => e.includes("runtime")), JSON.stringify(wrongRuntime));

  const wrongEntry = manifestValidator().validate({ ...NODE_TIER_OK, entrypoint: "index.html" });
  assert.ok(wrongEntry.some((e) => e.includes("entrypoint")), JSON.stringify(wrongEntry));

  const missingRuntime: Record<string, unknown> = { ...NODE_TIER_OK };
  delete missingRuntime.runtime;
  const errors = manifestValidator().validate(missingRuntime);
  assert.ok(errors.some((e) => e.includes("missing required property \"runtime\"")), JSON.stringify(errors));
});

test("manifest-validator: static and python allOf branches still hold (regression against the node prototype addition)", () => {
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
  // static/python are not capped at 30: 60 is only invalid for prototype.
  assert.deepEqual(
    manifestValidator().validate({
      schemaVersion: 2, name: "python-ok", tier: "python", runtime: "python-1", entrypoint: "app.py",
      ttlDays: 60, generatedBy: { tool: "cowork" },
    }),
    [],
  );
});
