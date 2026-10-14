import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand } from "../src/args.js";
import { loadConfig, UsageError } from "../src/config.js";

describe("parseCommand", () => {
  it("help on no arguments or --help", () => {
    assert.deepEqual(parseCommand([]), { kind: "help" });
    assert.deepEqual(parseCommand(["--help"]), { kind: "help" });
    assert.deepEqual(parseCommand(["publish", "-h"]), { kind: "help" });
  });

  it("publish defaults: no wait, 10 s interval, 600 s timeout, human output", () => {
    assert.deepEqual(parseCommand(["publish", "dist"]), {
      kind: "publish", dir: "dist", wait: false, intervalMs: 10_000, timeoutMs: 600_000, json: false,
    });
  });

  it("publish flags in any order", () => {
    assert.deepEqual(parseCommand(["--json", "publish", "--wait", "dist", "--interval", "0.5", "--timeout", "30"]), {
      kind: "publish", dir: "dist", wait: true, intervalMs: 500, timeoutMs: 30_000, json: true,
    });
  });

  it("preflight and status", () => {
    assert.deepEqual(parseCommand(["preflight", "dist/"]), { kind: "preflight", dir: "dist/" });
    assert.deepEqual(parseCommand(["status", "job_abcdefghij0123456789", "--json"]), { kind: "status", jobId: "job_abcdefghij0123456789", json: true });
  });

  it("usage errors", () => {
    for (const argv of [["bogus"], ["publish"], ["preflight"], ["status"], ["publish", "a", "b"], ["publish", "a", "--interval", "x"],
      ["publish", "a", "--timeout", "-1"], ["publish", "a", "--nope"]]) {
      assert.throws(() => parseCommand(argv), UsageError, argv.join(" "));
    }
  });
});

describe("loadConfig", () => {
  it("defaults the API URL, strips trailing slashes, needs a token unless ARTIFACTS_DEV_OID is set", () => {
    assert.deepEqual(loadConfig({ ARTIFACTS_TOKEN: "t" }), { apiUrl: "http://localhost:8080", token: "t", devOid: undefined });
    assert.deepEqual(loadConfig({ ARTIFACTS_API_URL: "https://mcp.corp.com/artifacts//", ARTIFACTS_TOKEN: "t", ARTIFACTS_DEV_OID: "u" }),
      { apiUrl: "https://mcp.corp.com/artifacts", token: "t", devOid: "u" });
    assert.deepEqual(loadConfig({ ARTIFACTS_DEV_OID: "u" }), { apiUrl: "http://localhost:8080", token: "dev", devOid: "u" });
    assert.throws(() => loadConfig({}), (e: unknown) => e instanceof UsageError && /ARTIFACTS_TOKEN/.test(e.message));
  });
});
