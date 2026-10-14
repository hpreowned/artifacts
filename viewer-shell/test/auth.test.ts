import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { DevAuthenticator, MsalAuthenticator, type AuthCodeClient } from '../src/auth.js';
import { verifyToken } from '../src/signed-token.js';
import { NOW, SESSION_KEY } from './helpers.js';

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as IncomingMessage;

function fakeClient(): AuthCodeClient & { urlCalls: Array<{ state?: string; nonce?: string }>; codeCalls: Array<{ code: string; nonce?: string }> } {
  const urlCalls: Array<{ state?: string; nonce?: string }> = [];
  const codeCalls: Array<{ code: string; nonce?: string }> = [];
  return {
    urlCalls,
    codeCalls,
    getAuthCodeUrl: async (r) => { urlCalls.push({ state: r.state, nonce: r.nonce }); return `https://login/?state=${encodeURIComponent(r.state ?? '')}`; },
    acquireTokenByCode: async (r) => { codeCalls.push({ code: r.code, nonce: r.nonce }); return { uniqueId: 'u', idTokenClaims: { oid: 'oid-7' } }; },
  };
}

test('DevAuthenticator always answers dev-viewer and has no callback', async () => {
  const a = new DevAuthenticator();
  assert.deepEqual(await a.authenticate(), { kind: 'viewer', oid: 'dev-viewer' });
  assert.equal((await a.callback()).kind, 'error');
});

test('MsalAuthenticator: state carries the return path and a nonce, and the nonce is replayed into the code exchange', async () => {
  const client = fakeClient();
  const a = new MsalAuthenticator(client, { redirectUri: 'https://artifacts.corp.com/auth/callback', sessionKey: SESSION_KEY, sessionTtlSeconds: 100, devInsecureCookies: false, now: () => NOW });
  const out = await a.authenticate(req(), '/view/abc123def456');
  assert.equal(out.kind, 'redirect');
  const state = client.urlCalls[0]!.state!;
  const st = verifyToken(SESSION_KEY, state, NOW)!;
  assert.equal(st['t'], 'state');
  assert.equal(st['rt'], '/view/abc123def456');
  assert.equal(st['n'], client.urlCalls[0]!.nonce);
  assert.equal(st['exp'], NOW + 600);

  const cb = await a.callback(req(), new URL(`https://artifacts.corp.com/auth/callback?code=c1&state=${encodeURIComponent(state)}`));
  assert.equal(cb.kind, 'signed-in');
  if (cb.kind !== 'signed-in') return;
  assert.equal(cb.location, '/view/abc123def456');
  assert.deepEqual(client.codeCalls, [{ code: 'c1', nonce: st['n'] }]);
  const session = verifyToken(SESSION_KEY, cb.setCookie.split('; ')[0]!.replace('__Host-shell=', ''), NOW)!;
  assert.deepEqual(session, { t: 'shell', oid: 'oid-7', exp: NOW + 100 });
  assert.deepEqual(await a.authenticate(req(cb.setCookie.split('; ')[0]), '/view/abc123def456'), { kind: 'viewer', oid: 'oid-7' });
});

test('MsalAuthenticator: return path is sanitised to /view/<id> or /, and the dev cookie drops Secure', async () => {
  const client = fakeClient();
  const a = new MsalAuthenticator(client, { redirectUri: 'http://localhost:8082/auth/callback', sessionKey: SESSION_KEY, sessionTtlSeconds: 100, devInsecureCookies: true, now: () => NOW });
  await a.authenticate(req(), 'https://evil.example/phish');
  assert.equal(verifyToken(SESSION_KEY, client.urlCalls[0]!.state!, NOW)!['rt'], '/');
  await a.authenticate(req(), '/view/abc123def456?x=1');
  assert.equal(verifyToken(SESSION_KEY, client.urlCalls[1]!.state!, NOW)!['rt'], '/');
  const cb = await a.callback(req(), new URL(`http://localhost:8082/auth/callback?code=c&state=${encodeURIComponent(client.urlCalls[0]!.state!)}`));
  assert.equal(cb.kind, 'signed-in');
  if (cb.kind === 'signed-in') {
    assert.ok(cb.setCookie.startsWith('shell='));
    assert.deepEqual(cb.setCookie.split('; ').slice(1), ['HttpOnly', 'SameSite=Lax', 'Path=/']);
  }
});

test('MsalAuthenticator: expired state and missing oid are rejected', async () => {
  const client = fakeClient();
  client.acquireTokenByCode = async () => ({ idTokenClaims: {} });
  const a = new MsalAuthenticator(client, { redirectUri: 'x', sessionKey: SESSION_KEY, sessionTtlSeconds: 100, devInsecureCookies: false, now: () => NOW });
  await a.authenticate(req(), '/view/abc123def456');
  const state = client.urlCalls[0]!.state!;
  const late = new MsalAuthenticator(client, { redirectUri: 'x', sessionKey: SESSION_KEY, sessionTtlSeconds: 100, devInsecureCookies: false, now: () => NOW + 601 });
  assert.deepEqual(await late.callback(req(), new URL(`http://h/auth/callback?code=c&state=${encodeURIComponent(state)}`)), { kind: 'error', status: 400, message: 'Invalid or expired sign-in state' });
  const noOid = await a.callback(req(), new URL(`http://h/auth/callback?code=c&state=${encodeURIComponent(state)}`));
  assert.deepEqual(noOid, { kind: 'error', status: 401, message: 'Sign-in failed: no oid claim' });
});
