/**
 * Protocol round-trip tests for the anonymous adapters.
 *
 * The contract test (`adapters-contract.test.mjs`) proves each adapter *runs* and classifies failures.
 * This file proves it *parses*: every stub below returns the response shape that was captured from the
 * live service (see `research/reachability-2026-09-13.json` and
 * `research/anonymous-compliance/*.json`), and the assertions pin the mapping the adapter must perform —
 * field names, expiry units, credential wiring, and the cases where inventing a value would be wrong.
 *
 * No network: each stub is a local HTTP server, and `endpoint` is overridden to point at it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { loadRegistry } from '../src/registry.mjs';
import { inspectArtifact } from '../src/inspect.mjs';
import { getAdapter } from '../src/providers/index.mjs';

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

function makeManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-proto-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>proto</body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("proto");\n');
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);
  return inspected.manifest;
}

/** Start a stub whose handler decides the response; it records what the adapter actually sent. */
function startStub(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        const record = { method: request.method, url: request.url, contentType: request.headers['content-type'] || '', body };
        requests.push(record);
        handler({ request, response, record, requests, port: server.address().port });
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

async function deployWith(id, stub, manifest) {
  const registry = loadRegistry();
  const provider = registry.providers.find((entry) => entry.id === id);
  assert.ok(provider, `${id} must be in the registry`);
  // Only the endpoint moves to the stub: the registry's own allowlist is kept (plus loopback), because
  // several adapters check the *returned* host against it, and that check is worth exercising.
  const target = {
    ...provider,
    endpoint: `http://127.0.0.1:${stub.port}/deploy`,
    allowedHosts: [...(provider.allowedHosts || []), '127.0.0.1']
  };
  const adapter = getAdapter(provider);
  const result = await adapter.deploy({ provider: target, manifest, context: {} });
  return { result, provider };
}

test('ship-page: reads url, slug, expires_at and its claim token', async () => {
  const manifest = makeManifest();
  const expiry = '2026-10-13T07:04:29.832Z';
  const stub = await startStub(({ response }) => json(response, 200, {
    slug: 'atom-stealer-cpeol', url: 'http://127.0.0.1:1/', files: ['index.html', 'assets/app.js'],
    plan: 'anonymous', expires_at: expiry, password_protected: false, claim_token: 'claim_abcdef123456'
  }));
  const { result, provider } = await deployWith('ship-page', stub, manifest);

  assert.match(result.url, /^http:\/\/127\.0\.0\.1:1\//);
  assert.equal(result.slug, 'atom-stealer-cpeol');
  assert.equal(new Date(result.expiresAt).toISOString(), expiry);
  assert.equal(result.persistence, 'temporary');
  assert.equal(result.transport, 'zip');
  assert.equal(result.fileCount, 2);
  if (provider.claim) assert.equal(result.claim.value, 'claim_abcdef123456');
  assert.equal(stub.requests[0].method, 'POST');
  assert.equal(stub.requests[0].contentType, 'application/zip', 'ship-page takes the archive as a raw body');
  assert.equal(stub.requests[0].body.subarray(0, 2).toString('latin1'), 'PK');
});

test('shipstatic: converts the epoch-seconds expiry and checks the reported status', async () => {
  const manifest = makeManifest();
  const expires = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
  const stub = await startStub(({ response }) => json(response, 201, {
    deployment: 'hovering-loop.shipstatic.com', url: 'http://127.0.0.1:1/', files: 2, size: 96,
    status: 'success', created: Math.floor(Date.now() / 1000), expires, screenshot: 'http://127.0.0.1:1/shot.jpg'
  }));
  const { result } = await deployWith('shipstatic', stub, manifest);

  assert.equal(result.deployment, 'hovering-loop.shipstatic.com');
  assert.equal(new Date(result.expiresAt).toISOString(), new Date(expires * 1000).toISOString(),
    'epoch seconds must be converted, not treated as milliseconds');
  assert.equal(result.bytes, 96);
  assert.equal(result.fileCount, 2);
  // The adapter sends the checksums part the service requires; a missing one is a silent data risk.
  assert.match(stub.requests[0].body.toString('latin1'), /name="checksums"/);
});

test('shipstatic: a non-success status is a server failure, not a deployment', async () => {
  const manifest = makeManifest();
  const stub = await startStub(({ response }) => json(response, 201, { url: 'http://127.0.0.1:1/', status: 'failed' }));
  await assert.rejects(() => deployWith('shipstatic', stub, manifest), (error) => {
    assert.equal(error.kind, 'server');
    assert.match(error.message, /status "failed"/);
    return true;
  });
});

test('here-now: parses the create response, then refuses to upload to a host outside its documented set', async () => {
  // The full three-step flow cannot be exercised offline: the adapter pins the upload host to the
  // documented R2 / here.now hosts, so a loopback stub is refused *after* the create response has been
  // parsed. That refusal is itself the contract worth testing here, and the steps it did reach are
  // asserted below (one POST, no PUT, paths already matched).
  const manifest = makeManifest();
  const expiry = '2026-09-14T07:04:45.707Z';
  let stub;
  stub = await startStub(({ response, record, port }) => {
    if (record.method === 'PUT') {
      response.writeHead(200);
      return response.end();
    }
    return json(response, 200, {
      slug: 'sentient-chant', siteUrl: `http://127.0.0.1:${port}/`, status: 'pending', isLive: false,
      requiresFinalize: true, publishStatus: { persistence: 'expiring', expiresAt: expiry },
      upload: {
        versionId: 'ver_1',
        uploads: [
          { path: 'index.html', uploadUrl: `http://127.0.0.1:${port}/put/index.html` },
          { path: 'assets/app.js', uploadUrl: `http://127.0.0.1:${port}/put/assets/app.js` }
        ],
        finalizeUrl: `http://127.0.0.1:${port}/finalize`,
        expiresInSeconds: 900
      },
      claimToken: 'here_claim_token', claimUrl: 'http://127.0.0.1:1/c/token', expiresAt: expiry, anonymous: true
    });
  });

  await assert.rejects(() => deployWith('here-now', stub, manifest), (error) => {
    assert.equal(error.kind, 'server');
    assert.match(error.message, /unexpected host/);
    assert.match(error.message, /127\.0\.0\.1/);
    return true;
  });
  assert.equal(stub.requests.filter((request) => request.method === 'POST').length, 1, 'the create call happened');
  assert.equal(stub.requests.filter((request) => request.method === 'PUT').length, 0, 'no file may leave for that host');
});

test('here-now: a create response whose uploads[] cannot be matched to a local file is refused', async () => {
  const manifest = makeManifest();
  const stub = await startStub(({ response, port }) => json(response, 200, {
    slug: 'x', siteUrl: `http://127.0.0.1:${port}/`,
    upload: {
      versionId: 'v1',
      uploads: [{ path: 'not-in-the-artifact.js', uploadUrl: `http://127.0.0.1:${port}/put/x.js` }],
      finalizeUrl: `http://127.0.0.1:${port}/finalize`
    }
  }));
  await assert.rejects(() => deployWith('here-now', stub, manifest), (error) => {
    assert.equal(error.kind, 'server');
    // The adapter reports coverage rather than a single bad entry: it says which files the service did
    // not offer an upload URL for, and refuses to finalise a partial deployment.
    assert.match(error.message, /1 of 2 files/);
    assert.match(error.message, /Nothing was finalised/);
    return true;
  });
  assert.equal(stub.requests.filter((request) => request.method === 'PUT').length, 0);
});

test('here-now: a create response without an upload url is refused before anything is sent', async () => {
  const manifest = makeManifest();
  const stub = await startStub(({ response }) => json(response, 200, {
    slug: 'x', siteUrl: 'http://127.0.0.1:1/', upload: { versionId: 'v1', uploads: [], finalizeUrl: 'http://127.0.0.1:1/finalize' }
  }));
  await assert.rejects(() => deployWith('here-now', stub, manifest), (error) => {
    assert.equal(error.kind, 'server');
    assert.match(error.message, /upload\.uploads/);
    return true;
  });
  assert.equal(stub.requests.filter((request) => request.method === 'PUT').length, 0, 'nothing may be uploaded');
});

test('show: reads deploymentId, url, expiresAt and mode', async () => {
  const manifest = makeManifest();
  const expiry = '2026-09-15T07:04:53.907Z';
  const stub = await startStub(({ response }) => json(response, 200, {
    deploymentId: 'dep_123', url: 'http://127.0.0.1:1/', createdAt: '2026-09-13T07:04:00.000Z', expiresAt: expiry, mode: 'static', requestId: 'req_1'
  }));
  const { result } = await deployWith('show', stub, manifest);

  assert.equal(result.deploymentId, 'dep_123');
  assert.equal(new Date(result.expiresAt).toISOString(), expiry);
  assert.equal(result.providerDetail.mode, 'static');
  assert.ok(result.providerDetail.archiveBytes > 0);
  assert.match(stub.requests[0].contentType, /multipart\/form-data/);
});

test('aft-page: no expiry is invented, and ok=false is surfaced', async () => {
  const manifest = makeManifest();
  const stub = await startStub(({ response }) => json(response, 200, {
    ok: true, slug: 'reach-9849', deployId: 'dp_1', url: 'http://127.0.0.1:1/', files: 2, bytes: 96,
    runtime: 'static', editToken: 'edit_token_123', claimUrl: 'http://127.0.0.1:1/claim', owned: false
  }));
  const { result, provider } = await deployWith('aft-page', stub, manifest);

  assert.equal(result.expiresAt, null, 'aft.page returns no lifetime; inventing one would be a lie');
  assert.equal(result.slug, 'reach-9849');
  assert.equal(result.deployId, 'dp_1');
  if (provider.claim) assert.equal(result.claim.value, 'edit_token_123');

  const failing = await startStub(({ response }) => json(response, 200, { ok: false, error: 'quota exceeded' }));
  await assert.rejects(() => deployWith('aft-page', failing, manifest), (error) => {
    assert.equal(error.kind, 'server');
    assert.match(error.message, /quota exceeded/);
    return true;
  });
});

test('aft-page: a response without a url never gets one derived from the slug', async () => {
  const manifest = makeManifest();
  const stub = await startStub(({ response }) => json(response, 200, { ok: true, slug: 'some-slug' }));
  await assert.rejects(() => deployWith('aft-page', stub, manifest), (error) => {
    assert.equal(error.kind, 'server');
    assert.match(error.message, /no url field/);
    return true;
  });
});

test('dropley: reads shortId, url, expiresAt and the artifact token', async () => {
  const manifest = makeManifest();
  const expiry = '2026-09-20T07:05:06.728Z';
  const stub = await startStub(({ response }) => json(response, 201, {
    shortId: 'gVWvUY3r', url: 'https://preview.dropley.app/p/gVWvUY3r', expiresAt: expiry, artifactToken: 'artifact_token_xyz'
  }));
  const { result, provider } = await deployWith('dropley', stub, manifest);

  assert.equal(result.shortId, 'gVWvUY3r');
  assert.equal(new Date(result.expiresAt).toISOString(), expiry);
  assert.equal(result.persistence, 'temporary');
  if (provider.claim) assert.equal(result.claim.value, 'artifact_token_xyz');
  assert.match(stub.requests[0].body.toString('latin1'), /name="manifest"/);
});
