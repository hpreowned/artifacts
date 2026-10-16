import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, handle, type Tool } from "../protocol.js";

const fakeTools: Tool[] = [
  { name: "beginPublish", description: "d", inputSchema: { type: "object" }, handler: async (a) => ({ echoed: a }) },
  { name: "boom", description: "d", inputSchema: { type: "object" }, handler: async () => { throw new Error("intake unreachable"); } },
];

test("initialize advertises tools capability and the protocol version", async () => {
  const res = await handle(fakeTools, "artifacts-local")(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
  const r = res!.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
  assert.equal(r.protocolVersion, "2025-06-18");
  assert.ok(r.capabilities.tools);
  assert.equal(r.serverInfo.name, "artifacts-local");
});

test("tools/list returns both tool definitions without handlers", async () => {
  const res = await handle(fakeTools, "x")(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const r = res!.result as { tools: { name: string; handler?: unknown }[] };
  assert.deepEqual(r.tools.map((t) => t.name), ["beginPublish", "boom"]);
  assert.equal(r.tools[0]!.handler, undefined);
});

test("tools/call wraps the result as MCP content", async () => {
  const res = await handle(fakeTools, "x")(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "beginPublish", arguments: { manifest: { tier: "static" } } } }));
  const r = res!.result as { content: { type: string; text: string }[] };
  assert.equal(r.content[0]!.type, "text");
  assert.deepEqual(JSON.parse(r.content[0]!.text), { echoed: { manifest: { tier: "static" } } });
});

test("a failing tool is an isError result, not a transport error", async () => {
  const r = (await callTool(fakeTools, "boom", {})) as { content: { text: string }[]; isError: boolean };
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /intake unreachable/);
});

test("unknown tools and methods are reported, notifications are silent", async () => {
  const unknown = (await callTool(fakeTools, "nope", {})) as { isError: boolean };
  assert.equal(unknown.isError, true);
  const bad = await handle(fakeTools, "x")(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "wat" }));
  assert.equal(bad!.error!.code, -32601);
  assert.equal(await handle(fakeTools, "x")(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  assert.equal(await handle(fakeTools, "x")("not json"), null);
});
