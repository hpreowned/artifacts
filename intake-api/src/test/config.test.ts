// loadConfig's ADO wiring: PIPELINE_TRIGGER=ado needs all four ADO_* vars, including the demo-tier pipeline id
// added for T81 (D14/§6.13) next to the existing python-tier one. "Trigger selects by tier" itself lives in
// the trigger implementation (scanner/src/pipeline.ts, not this package); this test covers the half owned
// here: both pipeline ids are threaded from the environment into cfg.worker.ado, and startup fails fast
// when either is missing rather than deferring to a confusing error on the first demo publish.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";

const BASE_ENV = { DEV_AUTH: "1", VIEW_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") };

test("config: PIPELINE_TRIGGER=ado requires ADO_ORG, ADO_PROJECT, ADO_PIPELINE_ID and ADO_DEMO_PIPELINE_ID", () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, PIPELINE_TRIGGER: "ado", ADO_ORG: "o", ADO_PROJECT: "p", ADO_PIPELINE_ID: "1" }),
    /ADO_ORG, ADO_PROJECT, ADO_PIPELINE_ID and ADO_DEMO_PIPELINE_ID/,
    "missing ADO_DEMO_PIPELINE_ID alone must fail startup, not just the eventual demo trigger call",
  );
  assert.throws(
    () => loadConfig({ ...BASE_ENV, PIPELINE_TRIGGER: "ado", ADO_ORG: "o", ADO_PROJECT: "p", ADO_DEMO_PIPELINE_ID: "2" }),
    /ADO_ORG, ADO_PROJECT, ADO_PIPELINE_ID and ADO_DEMO_PIPELINE_ID/,
  );
});

test("config: both pipeline ids land on cfg.worker.ado, kept apart by name", () => {
  const cfg = loadConfig({ ...BASE_ENV, PIPELINE_TRIGGER: "ado", ADO_ORG: "o", ADO_PROJECT: "p", ADO_PIPELINE_ID: "python-run", ADO_DEMO_PIPELINE_ID: "demo-run" });
  assert.equal(cfg.worker.ado.pipelineId, "python-run");
  assert.equal(cfg.worker.ado.demoPipelineId, "demo-run");
});

test("config: PIPELINE_TRIGGER=fake (the dev-stack default on BACKEND=memory) needs neither ADO_PIPELINE_ID nor ADO_DEMO_PIPELINE_ID", () => {
  const cfg = loadConfig({ ...BASE_ENV, BACKEND: "memory" });
  assert.equal(cfg.worker.pipelineTrigger, "fake");
  assert.equal(cfg.worker.ado.pipelineId, undefined);
  assert.equal(cfg.worker.ado.demoPipelineId, undefined);
});
