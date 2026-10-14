import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readCookie } from '../src/handler.js';
import { securityHeaders } from '../src/headers.js';
import { signToken } from '../src/signed-token.js';
import { ARTIFACT_ID, DOMAIN, KEY, NOW, OTHER_ID, SHELL, startGateway, type Response, type TestServer } from './helpers.js';

const EXPECTED_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors http://localhost:8082; " +
    "form-action 'none'; base-uri 'none'; object-src 'none'; sandbox allow-scripts allow-same-origin allow-modals allow-forms",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'private, no-store',
};

function assertSecurityHeaders(r: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) assert.equal(r.headers[name], value, name);
}

const viewToken = (aid = ARTIFACT_ID, exp = NOW + 300) => signToken(KEY, { t: 'view', aid, oid: 'viewer-1', exp });
const sessionToken = (aid = ARTIFACT_ID, exp = NOW + 86_400) => signToken(KEY, { t: 'session', aid, exp });
const sessionCookie = (aid = ARTIFACT_ID) => ({ cookie: `__Host-session=${sessionToken(aid)}` });

describe('static-gateway handler', () => {
  let s: TestServer;
  before(async () => { s = await startGateway(); });
  after(async () => { await s.close(); });

  test('headers: the exact DESIGN §6.4 set, with frame-ancestors = SHELL_ORIGIN, on every response class', async () => {
    assert.deepEqual(Object.keys(securityHeaders(SHELL)), [
      'Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cache-Control',
    ]);
    const cases: Array<[string, Response]> = [
      ['200', await s.request({ path: '/', headers: sessionCookie() })],
      ['302 document', await s.request({ headers: { 'sec-fetch-dest': 'document' } })],
      ['302 token', await s.request({ path: `/?t=${viewToken()}` })],
      ['403', await s.request({ path: '/' })],
      ['404 host', await s.request({ host: 'nope.example' })],
      ['404 file', await s.request({ path: '/missing.html', headers: sessionCookie() })],
      ['405', await s.request({ method: 'POST', path: '/', headers: sessionCookie() })],
    ];
    for (const [label, r] of cases) {
      assert.equal(r.status, Number(label.split(' ')[0]), label);
      assertSecurityHeaders(r);
    }
  });

  test('rule 1: host that is not <12 alnum>.<ARTIFACT_DOMAIN> is 404, even with a valid session', async () => {
    for (const host of ['localhost:8081', `${ARTIFACT_ID}.evil.com`, `ABC.${DOMAIN}`, `${ARTIFACT_ID}x.${DOMAIN}`, `a.${ARTIFACT_ID}.${DOMAIN}`]) {
      const r = await s.request({ host, headers: sessionCookie() });
      assert.equal(r.status, 404, host);
    }
  });

  test('rule 2: Sec-Fetch-Dest: document is redirected to the shell before any token or cookie logic', async () => {
    const r = await s.request({ path: `/deep/page.html?t=${viewToken()}&x=1`, headers: { 'sec-fetch-dest': 'document', ...sessionCookie() } });
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], `${SHELL}/view/${ARTIFACT_ID}`);
    assert.equal(r.headers['set-cookie'], undefined);
    const r2 = await s.request({ path: '/', headers: { 'sec-fetch-dest': 'Document' } });
    assert.equal(r2.status, 302, 'value compared case-insensitively');
    const r3 = await s.request({ path: '/', headers: { 'sec-fetch-dest': 'iframe', ...sessionCookie() } });
    assert.equal(r3.status, 200, 'iframe destination is served');
  });

  test('rule 3: valid ?t= sets the __Host- session cookie and redirects to the same path without t', async () => {
    const r = await s.request({ path: `/assets/style.css?t=${viewToken()}&keep=1`, headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers['location'], '/assets/style.css?keep=1');
    const cookie = r.headers['set-cookie'];
    assert.ok(cookie, 'cookie set');
    const [pair, ...attrs] = cookie.split('; ');
    assert.deepEqual(attrs, ['Secure', 'HttpOnly', 'SameSite=None', 'Path=/', 'Partitioned']);
    const value = readCookie(pair, '__Host-session');
    assert.ok(value);
    const follow = await s.request({ path: '/assets/style.css', headers: { cookie: pair! } });
    assert.equal(follow.status, 200);
    assert.equal(follow.body, 'body{}');
    // the cookie is a session token bound to this artifact
    const r2 = await s.request({ path: `/?t=${viewToken()}` });
    assert.equal(r2.headers['location'], '/', 'root path keeps a bare / and no ?');
  });

  test('rule 3: token for another artifact, expired token, bad signature, session token in t= → no cookie, 403', async () => {
    const bad = [viewToken(OTHER_ID), viewToken(ARTIFACT_ID, NOW - 1), viewToken(ARTIFACT_ID, NOW), `${viewToken()}x`, sessionToken(), 'garbage', ''];
    for (const t of bad) {
      const r = await s.request({ path: `/?t=${encodeURIComponent(t)}` });
      assert.equal(r.status, 403, t);
      assert.equal(r.headers['set-cookie'], undefined, t);
    }
  });

  test('rule 3: a bad t= still serves when a valid session cookie is already present', async () => {
    const r = await s.request({ path: `/?t=${viewToken(ARTIFACT_ID, NOW - 1)}`, headers: sessionCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.headers['set-cookie'], undefined);
  });

  test('rule 4: no cookie, cookie for another artifact, expired cookie, view token as cookie → 403 with the shell link', async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { cookie: `__Host-session=${sessionToken(OTHER_ID)}` },
      { cookie: `__Host-session=${sessionToken(ARTIFACT_ID, NOW - 1)}` },
      { cookie: `__Host-session=${viewToken()}` },
      { cookie: `session=${sessionToken()}` },
      { cookie: `__Host-session=${sessionToken()}x` },
    ];
    for (const headers of cases) {
      const r = await s.request({ path: '/', headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.ok(r.body.includes(`${SHELL}/view/${ARTIFACT_ID}`), 'body points at the shell');
    }
    const r = await s.request({ path: '/', headers: { cookie: `other=1; __Host-session=${sessionToken()}; x=y` } });
    assert.equal(r.status, 200, 'cookie found among others');
  });

  test('rule 5: serves index.html for /, nested files, content types, nosniff; HEAD has no body', async () => {
    const index = await s.request({ path: '/', headers: sessionCookie() });
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(index.headers['content-length'], String(Buffer.byteLength('<!doctype html><h1>hello</h1>')));
    assert.equal(index.body, '<!doctype html><h1>hello</h1>');
    const js = await s.request({ path: '/app.js', headers: sessionCookie() });
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    const head = await s.request({ method: 'HEAD', path: '/app.js', headers: sessionCookie() });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String('console.log(1)'.length));
  });

  test('rule 5: traversal, symlink escape, unknown extension, directory, other artifact dir → 404', async () => {
    for (const p of ['/../outside.html', '/%2e%2e/outside.html', '/assets/../../outside.html', '/link.html', '/notes.unknownext', '/assets', '/missing.html']) {
      const r = await s.request({ path: p, headers: sessionCookie() });
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('OUTSIDE'), p);
    }
  });
});

describe('GET /healthz', () => {
  let s: TestServer;
  before(async () => { s = await startGateway(); });
  after(async () => { await s.close(); });

  test('200 {"ok":true} with an arbitrary Host, with no Host at all, and before any security headers', async () => {
    for (const host of ['nope.invalid', 'totally-unrelated.example:9999', '']) {
      const r = await s.request({ path: '/healthz', host });
      assert.equal(r.status, 200, host);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', host);
      assert.equal(r.body, JSON.stringify({ ok: true }), host);
      assert.equal(r.headers['content-security-policy'], undefined, 'healthz is not artifact content; no CSP');
    }
  });

  test('a valid, live artifact Host still gets the health body, not a file, on this exact path', async () => {
    const r = await s.request({ path: '/healthz', headers: sessionCookie() }); // default host = ARTIFACT_ID.DOMAIN
    assert.equal(r.status, 200);
    assert.equal(r.body, JSON.stringify({ ok: true }));
    assert.notEqual(r.body, '<!doctype html><h1>hello</h1>', 'did not fall through to index.html');
  });

  test('every other path keeps the existing host-parsing and header behaviour', async () => {
    assert.equal((await s.request({ path: '/not-healthz', host: 'nope.invalid' })).status, 404);
    assert.equal((await s.request({ path: '/', headers: sessionCookie() })).headers['content-security-policy'], EXPECTED_HEADERS['content-security-policy']);
  });
});

describe('DEV_INSECURE_COOKIES=1', () => {
  let s: TestServer;
  before(async () => { s = await startGateway({ devInsecureCookies: true }); });
  after(async () => { await s.close(); });

  test('names the cookie `session`, drops Secure, and reads it back', async () => {
    const r = await s.request({ path: `/?t=${viewToken()}` });
    assert.equal(r.status, 302);
    const cookie = r.headers['set-cookie']!;
    const [pair, ...attrs] = cookie.split('; ');
    assert.ok(pair!.startsWith('session='));
    assert.deepEqual(attrs, ['HttpOnly', 'SameSite=Lax', 'Path=/']);
    assert.equal((await s.request({ path: '/', headers: { cookie: pair! } })).status, 200);
    assert.equal((await s.request({ path: '/', headers: { cookie: `__Host-session=${sessionToken()}` } })).status, 403, '__Host- name ignored in dev mode');
  });
});
