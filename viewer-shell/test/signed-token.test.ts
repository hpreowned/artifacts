import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signToken, verifyToken } from '../src/signed-token.js';
import { NOW, SESSION_KEY } from './helpers.js';

test('shared scheme: base64url(payload).base64url(hmac-sha256(key, base64url(payload))), exp enforced', () => {
  const payload = { t: 'shell', oid: 'oid-1', exp: NOW + 60 };
  const token = signToken(SESSION_KEY, payload);
  const [body, sig] = token.split('.');
  assert.equal(sig, createHmac('sha256', SESSION_KEY).update(body!).digest('base64url'));
  assert.deepEqual(verifyToken(SESSION_KEY, token, NOW), payload);
  assert.equal(verifyToken(SESSION_KEY, token, NOW + 60), null);
  assert.equal(verifyToken(Buffer.from('a-different-key-of-16+'), token, NOW), null);
  assert.equal(verifyToken(SESSION_KEY, `${body}.${sig!.slice(1)}A`, NOW), null);
});
