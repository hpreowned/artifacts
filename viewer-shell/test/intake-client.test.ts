import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpIntakeClient } from '../src/intake-client.js';

interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

/** A loopback stand-in for intake-api's /v1/view-token that records the request and answers per artifact id. */
async function fakeIntake(): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.headers['x-internal-caller'] !== 'shared-key-1') { res.statusCode = 401; return res.end(); }
      const { artifactId } = JSON.parse(body) as { artifactId: string };
      res.setHeader('Content-Type', 'application/json');
      if (artifactId === 'live00000001') return res.end(JSON.stringify({ token: 'tok.sig', expiresAt: '2027-01-01T00:05:00Z' }));
      if (artifactId === 'live00000002') return res.end(JSON.stringify({ token: 'tok.sig', expiresAt: '2027-01-01T00:05:00Z', artifactExpiresAt: '2027-02-01T00:00:00Z' }));
      if (artifactId === 'broken000001') return res.end('not json');
      if (artifactId === 'broken000002') return res.end(JSON.stringify({ token: 42 }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not live' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('POSTs {artifactId, viewerOid} to /v1/view-token with X-Internal-Caller and parses the grant', async () => {
  const intake = await fakeIntake();
  try {
    const client = new HttpIntakeClient(intake.url + '/', 'shared-key-1');
    const grant = await client.createViewToken('live00000001', 'oid-9');
    assert.deepEqual(grant, { token: 'tok.sig', expiresAt: '2027-01-01T00:05:00Z' });
    const req = intake.seen[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/view-token');
    assert.equal(req.headers['x-internal-caller'], 'shared-key-1');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(req.body), { artifactId: 'live00000001', viewerOid: 'oid-9' });
    assert.deepEqual(await client.createViewToken('live00000002', 'oid-9'), { token: 'tok.sig', expiresAt: '2027-01-01T00:05:00Z', artifactExpiresAt: '2027-02-01T00:00:00Z' });
  } finally {
    await intake.close();
  }
});

test('404 resolves null; wrong key, malformed and non-JSON bodies throw', async () => {
  const intake = await fakeIntake();
  try {
    const client = new HttpIntakeClient(intake.url, 'shared-key-1');
    assert.equal(await client.createViewToken('dead00000000', 'oid-9'), null);
    await assert.rejects(client.createViewToken('broken000001', 'oid-9'));
    await assert.rejects(client.createViewToken('broken000002', 'oid-9'), /malformed/);
    await assert.rejects(new HttpIntakeClient(intake.url, 'wrong').createViewToken('live00000001', 'oid-9'), /401/);
  } finally {
    await intake.close();
  }
});
