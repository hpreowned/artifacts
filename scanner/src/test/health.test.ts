import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { HealthState, startHealthServer } from "../health.js";

test("GET /healthz: 200 ok=true while the queue runs, 503 once marked down", async () => {
  const state = new HealthState("memory");
  const server = startHealthServer(0, state);
  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/healthz`;

    const up = await fetch(url);
    assert.equal(up.status, 200);
    assert.deepEqual(await up.json(), { ok: true, queue: "memory" });

    state.markDown();
    const down = await fetch(url);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { ok: false, queue: "memory" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("anything other than GET /healthz is 404; the queue kind is reported verbatim", async () => {
  const state = new HealthState("servicebus");
  const server = startHealthServer(0, state);
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`, { method: "POST" })).status, 404);
    const ok = await fetch(`${base}/healthz?x=1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, queue: "servicebus" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
