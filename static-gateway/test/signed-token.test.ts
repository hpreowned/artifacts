import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { keyFromEnv, signToken, verifyToken } from '../src/signed-token.js';
import { KEY, NOW } from './helpers.js';

test('token layout is base64url(payload).base64url(hmac-sha256(key, base64url(payload)))', () => {
  const payload = { t: 'view', aid: 'abc123def456', oid: 'u1', exp: NOW + 300 };
  const token = signToken(KEY, payload);
  const [body, sig, extra] = token.split('.');
  assert.equal(extra, undefined);
  assert.equal(Buffer.from(body!, 'base64url').toString('utf8'), JSON.stringify(payload));
  assert.equal(sig, createHmac('sha256', KEY).update(body!).digest('base64url'));
});

test('verify round-trips a valid token and returns its payload', () => {
  const token = signToken(KEY, { t: 'view', aid: 'abc123def456', exp: NOW + 300 });
  assert.deepEqual(verifyToken(KEY, token, NOW), { t: 'view', aid: 'abc123def456', exp: NOW + 300 });
});

test('verify rejects expired, tampered, wrong-key and malformed tokens', () => {
  const token = signToken(KEY, { t: 'view', aid: 'abc123def456', exp: NOW + 300 });
  assert.equal(verifyToken(KEY, token, NOW + 300), null, 'exp == now is expired');
  assert.equal(verifyToken(KEY, token, NOW + 301), null);
  assert.equal(verifyToken(Buffer.from('another-key-of-16b'), token, NOW), null);
  const [body, sig] = token.split('.');
  const flippedBody = Buffer.from(JSON.stringify({ t: 'view', aid: 'zzz999yyy888', exp: NOW + 300 })).toString('base64url');
  assert.equal(verifyToken(KEY, `${flippedBody}.${sig}`, NOW), null, 'payload swap');
  assert.equal(verifyToken(KEY, `${body}.${sig!.slice(0, -2)}xx`, NOW), null, 'signature edit');
  assert.equal(verifyToken(KEY, `${body}.${sig}.${sig}`, NOW), null, 'three parts');
  assert.equal(verifyToken(KEY, body!, NOW), null, 'no signature');
  assert.equal(verifyToken(KEY, '', NOW), null);
  assert.equal(verifyToken(KEY, '.', NOW), null);
});

test('verify rejects payloads that are not an object with string t and numeric exp', () => {
  const sign = (json: string) => {
    const body = Buffer.from(json).toString('base64url');
    return `${body}.${createHmac('sha256', KEY).update(body).digest('base64url')}`;
  };
  assert.equal(verifyToken(KEY, sign('"str"'), NOW), null);
  assert.equal(verifyToken(KEY, sign('null'), NOW), null);
  assert.equal(verifyToken(KEY, sign('{"t":"view"}'), NOW), null);
  assert.equal(verifyToken(KEY, sign('{"t":1,"exp":9999999999}'), NOW), null);
  assert.equal(verifyToken(KEY, sign('{"t":"view","exp":"9999999999"}'), NOW), null);
  assert.equal(verifyToken(KEY, sign('not json'), NOW), null);
});

test('keyFromEnv decodes base64 and rejects short or missing keys', () => {
  assert.deepEqual(keyFromEnv('K', { K: KEY.toString('base64') }), KEY);
  assert.throws(() => keyFromEnv('K', {}), /K is required/);
  assert.throws(() => keyFromEnv('K', { K: Buffer.from('short').toString('base64') }), /at least 16 bytes/);
});
