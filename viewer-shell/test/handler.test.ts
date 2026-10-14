import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MsalAuthenticator, type AuthCodeClient } from '../src/auth.js';
import { BANNER_TEXT, STYLE_HASH } from '../src/page.js';
import { signToken } from '../src/signed-token.js';
import { ARTIFACT_ID, GRANT, NOW, SESSION_KEY, startShell, type TestShell } from './helpers.js';

const EXPECTED_CSP =
  `default-src 'self'; frame-src http://*.localhost:8081; script-src 'self'; style-src 'self' '${STYLE_HASH}'; ` +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

describe('viewer-shell with DEV_AUTH', () => {
  let s: TestShell;
  before(async () => { s = await startShell(); });
  after(async () => { await s.close(); });

  test('GET /view/<id> renders banner + iframe only, with the exact sandbox attribute and CSP', async () => {
    const r = await s.request({ path: `/view/${ARTIFACT_ID}`, headers: { 'user-agent': 'TestBrowser/1.0' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['content-security-policy'], EXPECTED_CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.ok(r.body.includes(`<iframe src="http://${ARTIFACT_ID}.localhost:8081/?t=${GRANT.token}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" referrerpolicy="no-referrer"`), r.body);
    assert.ok(!/allow-popups|allow-top-navigation|allow-downloads/.test(r.body));
    assert.ok(r.body.includes(BANNER_TEXT));
    assert.ok(r.body.includes('AI-generated artifact. Never enter passwords or credentials here.'));
    assert.ok(!r.body.includes('Expires'), 'no expiry shown when intake did not send one');
    assert.ok(!r.body.includes('<script'), 'page has no scripts; CSP script-src self would block inline anyway');
    assert.ok(!EXPECTED_CSP.includes('unsafe-inline'), 'no unsafe-inline anywhere in the shell CSP');
    const inlineStyle = /<style>([\s\S]*?)<\/style>/.exec(r.body)?.[1];
    assert.ok(inlineStyle, 'exactly one inline <style> block');
    assert.equal(`sha256-${createHash('sha256').update(inlineStyle, 'utf8').digest('base64')}`, STYLE_HASH, 'style-src hash matches the served <style> block');
    assert.ok(!/ style=/.test(r.body), 'no inline style attributes (the hash only covers the <style> element)');
    const banner = r.body.indexOf('class="banner"');
    const iframe = r.body.indexOf('<iframe');
    assert.ok(banner > 0 && iframe > banner, 'banner is above the frame');
  });

  test('audit: one JSON line per view with ts, viewerOid, artifactId, userAgent and nothing else', async () => {
    s.audit.length = 0;
    await s.request({ path: `/view/${ARTIFACT_ID}`, headers: { 'user-agent': 'TestBrowser/1.0' } });
    assert.equal(s.audit.length, 1);
    assert.deepEqual(JSON.parse(s.audit[0]!), { ts: new Date(NOW * 1000).toISOString(), viewerOid: 'dev-viewer', artifactId: ARTIFACT_ID, userAgent: 'TestBrowser/1.0' });
  });

  test('intake is asked for a token for (artifactId, dev-viewer)', async () => {
    s.intake.calls.length = 0;
    await s.request({ path: `/view/${ARTIFACT_ID}` });
    assert.deepEqual(s.intake.calls, [{ artifactId: ARTIFACT_ID, viewerOid: 'dev-viewer' }]);
  });

  test('404 page when intake says the artifact is not live; no audit line, headers still set', async () => {
    s.audit.length = 0;
    const r = await s.request({ path: '/view/zzz999yyy888' });
    assert.equal(r.status, 404);
    assert.ok(r.body.includes('not live'));
    assert.equal(r.headers['content-security-policy'], EXPECTED_CSP);
    assert.equal(s.audit.length, 0);
  });

  test('malformed ids, unknown paths, callback in dev mode, non-GET', async () => {
    for (const p of ['/view/ABC123DEF456', '/view/abc', '/view/abc123def456/', '/view/', '/', '/auth']) assert.equal((await s.request({ path: p })).status, 404, p);
    assert.equal((await s.request({ path: '/auth/callback?code=x&state=y' })).status, 404);
    const post = await s.request({ method: 'POST', path: `/view/${ARTIFACT_ID}` });
    assert.equal(post.status, 405);
    assert.equal(post.headers['allow'], 'GET, HEAD');
    assert.equal((await s.request({ path: '/healthz' })).status, 200);
  });
});

describe('viewer-shell with expiry and https', () => {
  let s: TestShell;
  before(async () => {
    s = await startShell({
      config: { artifactScheme: 'https', artifactDomain: 'corp-artifacts.net', shellOrigin: 'https://artifacts.corp.com' },
      grants: { [ARTIFACT_ID]: { ...GRANT, artifactExpiresAt: '2027-03-01T12:00:00.000Z' } },
    });
  });
  after(async () => { await s.close(); });

  test('shows "Expires <date>" when intake sends artifactExpiresAt; production CSP and iframe scheme', async () => {
    const r = await s.request({ path: `/view/${ARTIFACT_ID}` });
    assert.ok(r.body.includes('Expires 2027-03-01 12:00:00 UTC'), r.body);
    assert.ok(r.headers['content-security-policy']!.includes('frame-src https://*.corp-artifacts.net;'));
    assert.ok(r.body.includes(`<iframe src="https://${ARTIFACT_ID}.corp-artifacts.net/?t=${GRANT.token}"`));
  });
});

describe('viewer-shell with MSAL (fake client)', () => {
  const fake: AuthCodeClient = {
    getAuthCodeUrl: async (r) => `https://login.microsoftonline.com/t/oauth2/v2.0/authorize?client_id=c&redirect_uri=${encodeURIComponent(r.redirectUri)}&state=${encodeURIComponent(r.state ?? '')}`,
    acquireTokenByCode: async (r) => (r.code === 'good' ? { uniqueId: 'oid-123', idTokenClaims: { oid: 'oid-123', nonce: r.nonce } } : Promise.reject(new Error('invalid_grant'))),
  };
  let s: TestShell;
  before(async () => {
    s = await startShell({
      config: { devAuth: false, sessionKey: SESSION_KEY },
      auth: new MsalAuthenticator(fake, { redirectUri: 'http://localhost:8082/auth/callback', sessionKey: SESSION_KEY, sessionTtlSeconds: 3600, devInsecureCookies: false, now: () => NOW }),
    });
  });
  after(async () => { await s.close(); });

  test('round trip: /view redirects to Entra, callback sets the session cookie and returns to /view, which then renders', async () => {
    const first = await s.request({ path: `/view/${ARTIFACT_ID}` });
    assert.equal(first.status, 302);
    const authUrl = new URL(first.headers['location']!);
    assert.equal(authUrl.host, 'login.microsoftonline.com');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://localhost:8082/auth/callback');
    const state = authUrl.searchParams.get('state')!;
    assert.equal(s.intake.calls.length, 0, 'no token minted before sign-in');

    const cb = await s.request({ path: `/auth/callback?code=good&state=${encodeURIComponent(state)}` });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers['location'], `/view/${ARTIFACT_ID}`);
    const cookie = cb.headers['set-cookie']!;
    assert.ok(cookie.startsWith('__Host-shell='));
    assert.deepEqual(cookie.split('; ').slice(1), ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']);

    const page = await s.request({ path: `/view/${ARTIFACT_ID}`, headers: { cookie: cookie.split('; ')[0]! } });
    assert.equal(page.status, 200);
    assert.deepEqual(s.intake.calls, [{ artifactId: ARTIFACT_ID, viewerOid: 'oid-123' }]);
    assert.equal(JSON.parse(s.audit[0]!).viewerOid, 'oid-123');
  });

  test('callback rejects a forged state, a missing code, an Entra error and a bad code', async () => {
    const forged = signToken(Buffer.from('wrong-key-wrong-key-wrong-key!!!'), { t: 'state', rt: `/view/${ARTIFACT_ID}`, n: 'n', exp: NOW + 600 });
    assert.equal((await s.request({ path: `/auth/callback?code=good&state=${encodeURIComponent(forged)}` })).status, 400);
    assert.equal((await s.request({ path: '/auth/callback?state=x' })).status, 400);
    assert.equal((await s.request({ path: '/auth/callback?error=access_denied' })).status, 401);
    const good = signToken(SESSION_KEY, { t: 'state', rt: `/view/${ARTIFACT_ID}`, n: 'n', exp: NOW + 600 });
    assert.equal((await s.request({ path: `/auth/callback?code=bad&state=${encodeURIComponent(good)}` })).status, 401);
  });

  test('an expired or forged session cookie sends the viewer back to sign-in', async () => {
    const expired = signToken(SESSION_KEY, { t: 'shell', oid: 'oid-123', exp: NOW - 1 });
    assert.equal((await s.request({ path: `/view/${ARTIFACT_ID}`, headers: { cookie: `__Host-shell=${expired}` } })).status, 302);
    const wrongType = signToken(SESSION_KEY, { t: 'state', oid: 'oid-123', exp: NOW + 100 });
    assert.equal((await s.request({ path: `/view/${ARTIFACT_ID}`, headers: { cookie: `__Host-shell=${wrongType}` } })).status, 302);
  });
});
