import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArtifactFile } from '../src/static-files.js';
import { artifactIdFromHost } from '../src/artifact-host.js';
import { ARTIFACT_ID, DOMAIN, startGateway, type TestServer } from './helpers.js';

let s: TestServer;
before(async () => { s = await startGateway(); });
after(async () => { await s.close(); });

test('resolves / to index.html and nested files with the right content type', async () => {
  const index = await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/');
  assert.equal(index?.contentType, 'text/html; charset=utf-8');
  assert.ok(index?.absolutePath.endsWith('/index.html'));
  const css = await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/assets/style.css');
  assert.equal(css?.contentType, 'text/css; charset=utf-8');
  const js = await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/app.js');
  assert.equal(js?.contentType, 'text/javascript; charset=utf-8');
  assert.equal(js?.size, 'console.log(1)'.length);
});

test('refuses traversal, encoded traversal, backslashes, null bytes and bad encodings', async () => {
  for (const p of ['/../outside.html', '/assets/../../outside.html', '/%2e%2e/outside.html', '/..%2foutside.html',
    '/%2e%2e%2foutside.html', '/assets\\..\\..\\outside.html', '/index.html%00.png', '/%zz', '/./index.html', '/assets/./style.css']) {
    assert.equal(await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, p), null, p);
  }
});

test('refuses symlinks that escape the artifact directory, directories, unknown extensions and missing files', async () => {
  assert.equal(await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/link.html'), null, 'symlink out');
  assert.equal(await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/assets'), null, 'directory');
  assert.equal(await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/notes.unknownext'), null, 'extension');
  assert.equal(await resolveArtifactFile(s.serveRoot, ARTIFACT_ID, '/missing.html'), null, 'missing');
  assert.equal(await resolveArtifactFile(s.serveRoot, 'zzz999yyy888', '/index.html'), null, 'other artifact');
});

test('artifactIdFromHost accepts exactly <12 lowercase alnum>.<domain>', () => {
  assert.equal(artifactIdFromHost(`${ARTIFACT_ID}.${DOMAIN}`, DOMAIN), ARTIFACT_ID);
  assert.equal(artifactIdFromHost(`ABC123DEF456.${DOMAIN}`, DOMAIN), 'abc123def456');
  assert.equal(artifactIdFromHost('abc123def456.corp-artifacts.net', 'corp-artifacts.net'), 'abc123def456');
  for (const bad of [undefined, '', DOMAIN, `.${DOMAIN}`, `abc.${DOMAIN}`, `abc123def4567.${DOMAIN}`, `abc123def45_.${DOMAIN}`,
    `a.${ARTIFACT_ID}.${DOMAIN}`, `${ARTIFACT_ID}.evil.com`, `${ARTIFACT_ID}.${DOMAIN}.evil.com`, `${ARTIFACT_ID}.localhost:9999`]) {
    assert.equal(artifactIdFromHost(bad, DOMAIN), null, String(bad));
  }
});
