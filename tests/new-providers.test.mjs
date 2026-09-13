/**
 * BrewPage and ht-ml.app: protocol round-trips for the two providers added in round 7.
 *
 * Both protocols were measured live and confirmed from two egresses
 * (`research/anonymous-compliance/{brewpage,ht-ml-app}.json`). The stubs below reproduce the measured
 * response shapes, and the assertions pin what a regression would break: the archive part name and the
 * required User-Agent, the claim wiring, an expiry that must stay null when the service returns none,
 * and the disclosure of referenced files a single-document host cannot publish.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { deploy as brewpageDeploy } from '../src/providers/brewpage.mjs';
import { deploy as htMlAppDeploy } from '../src/providers/ht-ml-app.mjs';
import { loadRegistry } from '../src/registry.mjs';
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

function makeManifest({ withAssets = true, index = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-new-provider-'));
  tempDirs.push(dir);
  if (withAssets) fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  if (index) {
    fs.writeFileSync(path.join(dir, 'index.html'), withAssets
      ? '<!doctype html><html><head><link rel="stylesheet" href="assets/app.css"></head><body>new provider<script src="assets/app.js"></script></body></html>\n'
      : '<!doctype html><html><body>new provider, no assets</body></html>\n');
  }
  if (withAssets) fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("new provider");\n');
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);
  return inspected.manifest;
}

function startStub(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: request.method, url: request.url, headers: request.headers, contentType: request.headers['content-type'] || '', body });
        handler({ response, port: server.address().port });
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

const json = (response, status, payload) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
};

const providerOf = (id, stub) => {
  const provider = loadRegistry().providers.find((entry) => entry.id === id);
  assert.ok(provider, `${id} must be registered`);
  return { ...provider, endpoint: `http://127.0.0.1:${stub.port}/deploy`, allowedHosts: [...(provider.allowedHosts || []), '127.0.0.1'] };
};

test('brewpage sends the archive part with the required User-Agent and wires the owner token', async () => {
  const manifest = makeManifest();
  const expiresAt = '2026-09-28T07:53:40.287Z';
  const stub = await startStub(({ response, port }) => json(response, 201, {
    id: 'YZYbDhTUSw', namespace: 'public', entryFile: 'index.html',
    link: `http://127.0.0.1:${port}/public/YZYbDhTUSw`, ownerLink: `http://127.0.0.1:${port}/manage/YZYbDhTUSw`,
    fileCount: 3, totalSizeBytes: 312, expiresAt, tags: [],
    ownerToken: 'owner_token_abcdef', result: 'created', visibilityNotice: 'public and may be indexed'
  }));

  const provider = providerOf('brewpage', stub);
  const result = await brewpageDeploy({ provider, manifest, context: {} });

  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/public\/YZYbDhTUSw$/);
  assert.equal(result.siteId, 'YZYbDhTUSw');
  assert.equal(result.fileCount, 3);
  assert.equal(result.bytes, 312);
  assert.equal(new Date(result.expiresAt).toISOString(), expiresAt);
  assert.equal(result.expiresAtSource, 'provider-response');
  assert.equal(result.transport, 'multipart-archive');
  assert.equal(result.claim.kind, 'ownerToken');
  assert.equal(result.claim.value, 'owner_token_abcdef');
  assert.match(result.providerDetail.ownerLink, /stored with the claim/);

  const request = stub.requests[0];
  assert.equal(request.method, 'POST');
  assert.match(request.contentType, /multipart\/form-data/);
  assert.match(request.body.toString('latin1'), /name="archive"/);
  assert.match(request.body.toString('latin1'), /filename="site\.zip"/);
  assert.match(String(request.headers['user-agent'] || ''), /^vpublish\//, 'BrewPage requires a User-Agent');
});

test('brewpage: a server error is classified, not returned as a deployment', async () => {
  const manifest = makeManifest();
  const stub = await startStub(({ response }) => json(response, 500, { error: 'cleanup job' }));
  await assert.rejects(() => brewpageDeploy({ provider: providerOf('brewpage', stub), manifest, context: {} }), (error) => {
    assert.equal(error.kind, 'server');
    return true;
  });
});

test('ht-ml.app posts the document as JSON and keeps a missing expiry null', async () => {
  const manifest = makeManifest({ withAssets: false });
  const stub = await startStub(({ response, port }) => json(response, 200, {
    site_id: 'f5532e0f', update_key: 'update_key_abcdef', status: 'live',
    url: `http://127.0.0.1:${port}/`, message: 'published'
  }));

  const provider = providerOf('ht-ml-app', stub);
  const result = await htMlAppDeploy({ provider, manifest, context: {} });

  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(result.siteId, 'f5532e0f');
  assert.equal(result.expiresAt, null, 'the service returns no expiry; inventing one would be a lie');
  assert.equal(result.expiresAtSource, 'not-returned');
  assert.equal(result.fileCount, 1);
  assert.equal(result.transport, 'json-single-page');
  assert.equal(result.claim.kind, 'update_key');
  assert.equal(result.claim.value, 'update_key_abcdef');

  const request = stub.requests[0];
  assert.equal(request.contentType, 'application/json');
  const body = JSON.parse(request.body.toString('utf8'));
  assert.equal(typeof body.html_content, 'string');
  assert.match(body.html_content, /new provider/);
  assert.match(String(request.headers['user-agent'] || ''), /^vpublish\//);
});

test('ht-ml.app discloses referenced files it cannot publish', async () => {
  const manifest = makeManifest({ withAssets: true });
  const stub = await startStub(({ response, port }) => json(response, 200, {
    site_id: 'x', update_key: 'k', status: 'live', url: `http://127.0.0.1:${port}/`
  }));

  const result = await htMlAppDeploy({ provider: providerOf('ht-ml-app', stub), manifest, context: {} });

  // Only files that both exist locally and are referenced can be reported; the fixture references a
  // stylesheet it never writes, so that path is not in the manifest and is not listed.
  assert.deepEqual(result.providerDetail.referencedFilesNotUploaded, ['assets/app.js'],
    'a page that points at files this host never received must say so');
});

test('ht-ml.app refuses an artifact with no HTML document', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-new-provider-bad-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'no html here\n');
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);

  const stub = await startStub(({ response, port }) => json(response, 200, { url: `http://127.0.0.1:${port}/` }));
  await assert.rejects(
    () => htMlAppDeploy({ provider: providerOf('ht-ml-app', stub), manifest: inspected.manifest, context: {} }),
    (error) => {
      assert.equal(error.kind, 'capability');
      assert.match(error.message, /single HTML document/);
      return true;
    }
  );
  assert.equal(stub.requests.length, 0, 'nothing may be sent when the artifact cannot be published');
});
