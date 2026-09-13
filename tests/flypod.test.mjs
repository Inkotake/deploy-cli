/**
 * flypod adapter: the proven parts of a live-measured protocol, without the network.
 *
 * The protocol was measured against the real service on 2026-09-13 (see
 * `research/anonymous-compliance/flypod.json`): raw-zip POST, epoch-millisecond `expires_at`, an
 * injected HTML page, and two credentials. These tests pin the parts that a stub can prove: the exact
 * request shape, the parsing, the host allowlist, and the failure classification.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { deploy, documentedAnonymousTtlSeconds } from '../src/providers/flypod.mjs';
import { ProviderError } from '../src/providers/errors.mjs';
import { inspectArtifact } from '../src/inspect.mjs';

const tempDirs = [];
const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best effort */
    }
  }
});

function makeManifest(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-flypod-${label}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>flypod stub</body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("flypod");\n');
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);
  return inspected.manifest;
}

/** A stub of the measured response, with every field name taken from the live one. */
function startStub(responder) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: request.method, url: request.url, contentType: request.headers['content-type'], body });
        responder({ request, response, body, requests });
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function providerFor(port, overrides = {}) {
  return {
    id: 'flypod',
    label: 'flypod (stub)',
    endpoint: `http://127.0.0.1:${port}/sites`,
    allowedHosts: ['127.0.0.1'],
    claim: { kind: 'claim_token', field: 'claim_token', warning: 'Never forward the claim token.' },
    capabilities: { ttl: { defaultSeconds: documentedAnonymousTtlSeconds(), source: 'test' } },
    ...overrides
  };
}

test('an anonymous raw-zip POST is parsed into a deployment', async () => {
  const manifest = makeManifest('happy');
  const expiry = Date.now() + documentedAnonymousTtlSeconds() * 1000;
  const stub = await startStub(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      site_id: '8daea739ef854473',
      slug: 'quick-amber-fox',
      url: `http://127.0.0.1:${stubRef.port}/site/`,
      version_id: 'v1',
      expires_at: expiry,
      manage_token: 'mk_0123456789abcdef',
      claim_token: 'cl_0123456789abcdef',
      healed: false,
      warnings: [],
      render: { status: 'pending' },
      next_actions: [{ name: 'get_site', method: 'GET', path: '/sites/8daea739ef854473' }]
    }));
  });
  const stubRef = stub;

  const result = await deploy({ provider: providerFor(stub.port), manifest });

  assert.equal(result.url, `http://127.0.0.1:${stub.port}/site/`);
  assert.equal(result.persistence, 'temporary');
  assert.equal(result.transport, 'http-raw-zip');
  assert.equal(result.expiresAtSource, 'provider-response');
  assert.equal(new Date(result.expiresAt).getTime(), expiry, 'epoch milliseconds must not be misread as seconds');
  assert.equal(result.claim.kind, 'claim_token');
  assert.equal(result.claim.value, 'cl_0123456789abcdef');
  assert.equal(result.providerDetail.siteId, '8daea739ef854473');
  assert.equal(result.providerDetail.renderStatus, 'pending');
  assert.deepEqual(result.providerDetail.nextActions, ['get_site']);
  assert.match(result.providerDetail.manageToken, /NOT stored/, 'an unpersisted credential must say so');
  assert.equal(result.fileCount, 2);

  // The request itself: raw zip body, not multipart, and no credential of any kind.
  const request = stub.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.contentType, 'application/zip');
  assert.equal(request.body.subarray(0, 2).toString('latin1'), 'PK');
  assert.equal(request.body.includes(Buffer.from('boundary=')), false);
});

test('a url outside the registry allowlist is refused', async () => {
  const manifest = makeManifest('foreign');
  const stub = await startStub(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: 'https://evil.example/site/', expires_at: Date.now() + 1000, claim_token: 'cl_x' }));
  });

  await assert.rejects(
    () => deploy({ provider: providerFor(stub.port), manifest }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /allowlist/);
      return true;
    }
  );
});

test('failures are classified, not guessed', async () => {
  const manifest = makeManifest('failures');

  const unauthorized = await startStub(({ response }) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'authentication required' }));
  });
  await assert.rejects(
    () => deploy({ provider: providerFor(unauthorized.port), manifest }),
    (error) => {
      assert.equal(error.kind, 'auth');
      return true;
    }
  );

  const notJson = await startStub(({ response }) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>proxy error page</html>');
  });
  await assert.rejects(
    () => deploy({ provider: providerFor(notJson.port), manifest }),
    (error) => {
      assert.equal(error.kind, 'server');
      assert.match(error.message, /not JSON/);
      return true;
    }
  );

  const noUrl = await startStub(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ site_id: 'x', render: { status: 'ok' } }));
  });
  await assert.rejects(
    () => deploy({ provider: providerFor(noUrl.port), manifest }),
    (error) => {
      assert.equal(error.kind, 'server');
      assert.match(error.message, /url/);
      return true;
    }
  );
});

test('the documented anonymous lifetime is fourteen days', () => {
  assert.equal(documentedAnonymousTtlSeconds(), 14 * 24 * 60 * 60);
});

test('an owned deploy with a null expiry does not invent one from the response', async () => {
  const manifest = makeManifest('owned');
  const stub = await startStub(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    // `expires_at: null` is what flypod returns for an owned site; the fallback then applies and the
    // source is reported as the documented lifetime rather than the response.
    response.end(JSON.stringify({ url: `http://127.0.0.1:${stub.port}/site/`, expires_at: null, claim_token: null }));
  });
  const result = await deploy({ provider: providerFor(stub.port), manifest });
  assert.equal(result.expiresAtSource, 'documented-anonymous-lifetime');
  assert.ok(result.expiresAt, 'a documented fallback is still returned, and labelled as such');
});
