// The token scheme shared with static-gateway and viewer-shell. The format is asserted byte for byte.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { keyFromEnv, sign, verify } from "../signed-token.js";

const key = randomBytes(32);
const now = Date.now();
const payload = { t: "view", aid: "abcdefghijkl", oid: "viewer-1", exp: Math.floor(now / 1000) + 300 };

test("format: base64url(payloadJson) . base64url(HMAC-SHA256(key, base64url(payloadJson)))", () => {
  const token = sign(payload, key);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(body, "ascii").digest("base64url");
  assert.equal(token, `${body}.${mac}`);
  assert.equal(token.split(".").length, 2);
  assert.doesNotMatch(token, /[+/=]/, "base64url only");
});

test("verify round-trips, rejects tampering, wrong keys and expiry", () => {
  const token = sign(payload, key);
  const ok = verify(token, key, now);
  assert.ok(ok.ok && ok.payload.aid === "abcdefghijkl" && ok.payload.oid === "viewer-1");
  const [body, mac] = token.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ ...payload, aid: "zzzzzzzzzzzz" })).toString("base64url");
  assert.deepEqual(verify(`${forged}.${mac}`, key, now), { ok: false, reason: "signature" });
  assert.deepEqual(verify(token, randomBytes(32), now), { ok: false, reason: "signature" });
  assert.deepEqual(verify(token, key, now + 301_000), { ok: false, reason: "expired" });
  assert.deepEqual(verify(body, key, now), { ok: false, reason: "malformed" });
  assert.deepEqual(verify(`${body}.${mac}.x`, key, now), { ok: false, reason: "malformed" });
  const notJson = Buffer.from("nope").toString("base64url");
  const macOfNotJson = createHmac("sha256", key).update(notJson, "ascii").digest("base64url");
  assert.deepEqual(verify(`${notJson}.${macOfNotJson}`, key, now), { ok: false, reason: "malformed" });
  assert.equal(verify("", key, now).ok, false);
});

test("keyFromEnv decodes base64 and insists on 32 bytes", () => {
  assert.throws(() => keyFromEnv("VIEW_TOKEN_KEY", {}), /not set/);
  assert.throws(() => keyFromEnv("VIEW_TOKEN_KEY", { VIEW_TOKEN_KEY: randomBytes(16).toString("base64") }), /32 bytes/);
  assert.equal(keyFromEnv("VIEW_TOKEN_KEY", { VIEW_TOKEN_KEY: key.toString("base64") }).equals(key), true);
});
