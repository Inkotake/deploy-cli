/**
 * meethtml, Display.dev, shiply.now and shippage.ai — protocol round-trips for the four providers added
 * in the parallel batch.
 *
 * Each protocol was measured live and confirmed from two egresses
 * (`research/anonymous-compliance/{meethtml,display-dev,shiply,shippage}.json`). The stubs reproduce the
 * measured response shapes; the assertions pin what a regression would break, including the two traps
 * that cost real time during measurement: a zip sent where a document is expected, and a three-step
 * publish reported as live without finalizing.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { deploy as meethtmlDeploy } from '../src/providers/meethtml.mjs';
import { deploy as displayDevDeploy } from '../src/providers/display-dev.mjs';
import { deploy as shiplyDeploy } from '../src/providers/shiply.mjs';
import { deploy as shippageDeploy } from '../src/providers/shippage.mjs';
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

const DOCUMENT = '<!doctype html><html><head><link rel="stylesheet" href="assets/app.css"></head><body>parallel batch<script src="assets/app.js"></script></body></html>\n';

function makeManifest({ withAssets = true, html = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-batch-'));
  tempDirs.push(dir);
  if (withAssets) fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  if (html) fs.writeFileSync(path.join(dir, 'index.html'), DOCUMENT);
  if (withAssets) fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("batch");\n');
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
        handler({ response, record: requests.at(-1), requests, port: server.address().port });
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

/** The registry supplies the real claim specs; only the endpoint moves to the stub. */
function providerFor(id, stub, extraHosts = []) {
  const provider = loadRegistry().providers.find((entry) => entry.id === id);
  assert.ok(provider, `${id} must be registered`);
  return {
    ...provider,
    endpoint: `http://127.0.0.1:${stub.port}/publish`,
    allowedHosts: [...(provider.allowedHosts || []), ...extraHosts, '127.0.0.1']
  };
}

test('meethtml posts the document as JSON and wires the edit token', async () => {
  const manifest = makeManifest({ withAssets: false });
  const expiry = '2026-09-14T08:55:05.000Z';
  const stub = await startStub(({ response, port }) => json(response, 201, {
    url: `http://127.0.0.1:${port}/`, slug: 'noble-grove', expires_at: expiry, edit_token: 'edit_token_abc'
  }));

  const result = await meethtmlDeploy({ provider: providerFor('meethtml', stub), manifest, context: {} });

  assert.equal(result.slug, 'noble-grove');
  assert.equal(new Date(result.expiresAt).toISOString(), expiry);
  assert.equal(result.expiresAtSource, 'provider-response');
  assert.equal(result.transport, 'json-single-page');
  assert.equal(result.claim.kind, 'edit_token');
  assert.equal(result.claim.value, 'edit_token_abc');
  const body = JSON.parse(stub.requests[0].body.toString('utf8'));
  assert.match(body.html, /parallel batch/);
  assert.match(String(stub.requests[0].headers['user-agent'] || ''), /^vpublish\//);
});

test('meethtml refuses an artifact that is not an HTML document, sending nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-batch-txt-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a page\n');
  const inspected = inspectArtifact(dir);
  const stub = await startStub(({ response, port }) => json(response, 201, { url: `http://127.0.0.1:${port}/` }));

  await assert.rejects(
    () => meethtmlDeploy({ provider: providerFor('meethtml', stub), manifest: inspected.manifest, context: {} }),
    (error) => {
      assert.equal(error.kind, 'capability');
      assert.equal(error.permanent, true);
      return true;
    }
  );
  assert.equal(stub.requests.length, 0);
});

test('display-dev sends the document text, not an archive', async () => {
  const manifest = makeManifest({ withAssets: false });
  const stub = await startStub(({ response, port }) => json(response, 201, {
    shortId: 'TIeFhM3U', previewUrl: `http://127.0.0.1:${port}/TIeFhM3U`,
    claimUrl: `http://127.0.0.1:${port}/claim?code=x`, expiresAt: '2026-10-13T08:55:10.711Z'
  }));

  const result = await displayDevDeploy({ provider: providerFor('display-dev', stub), manifest, context: {} });

  assert.equal(result.shortId, 'TIeFhM3U');
  assert.equal(result.transport, 'multipart-single-document');
  assert.equal(result.claim.kind, 'claim_url');
  assert.match(result.providerDetail.servedAs, /viewer/);
  const body = stub.requests[0].body.toString('latin1');
  assert.match(body, /name="file"/);
  assert.match(body, /parallel batch/);
  // The trap that produced a 422 during measurement: a zip where the document belongs.
  assert.equal(body.includes('PK\u0003\u0004'), false, 'the part must carry the document, never a zip');
});

test('display-dev surfaces the server message when it refuses the source', async () => {
  const manifest = makeManifest({ withAssets: false });
  const stub = await startStub(({ response }) => json(response, 422, {
    error: 'unsupported_source_encoding', message: 'Artifact source must be valid UTF-8.'
  }));

  await assert.rejects(
    () => displayDevDeploy({ provider: providerFor('display-dev', stub), manifest, context: {} }),
    (error) => {
      // 422 is classified as a capability failure by this project's shared HTTP mapping: the provider
      // cannot accept this input. What matters to a caller is that the server's own words survive.
      assert.equal(error.kind, 'capability');
      assert.match(error.message, /valid UTF-8/);
      return true;
    }
  );
});

test('shiply performs all three steps and only then reports a URL', async () => {
  const manifest = makeManifest({ withAssets: true });
  const stub = await startStub(({ response, record, port, requests }) => {
    if (record.url === '/finalize') {
      return json(response, 200, {
        success: true, slug: 'quick-garnet', siteUrl: `http://127.0.0.1:${port}/`, currentVersionId: 'v2', addedToProfile: false
      });
    }
    if (record.method === 'PUT') {
      response.writeHead(200);
      return response.end();
    }
    // The create call: hand back one upload URL per manifest entry, exactly as the service does.
    const files = JSON.parse(record.body.toString('utf8')).files || [];
    return json(response, 200, {
      slug: 'quick-garnet', siteId: 'site_1', siteUrl: `http://127.0.0.1:${port}/`,
      upload: {
        versionId: 'v1',
        uploads: files.map((file) => ({ path: file.path, url: `http://127.0.0.1:${port}/put/${file.path}` })),
        finalizeUrl: `http://127.0.0.1:${port}/finalize`
      },
      claimToken: 'claim_token_xyz', claimUrl: `http://127.0.0.1:${port}/claim`,
      expiresAt: '2026-09-14T09:06:56.427Z', anonymous: true, toUpdate: 'POST the same three-step flow with claimToken'
    });
  });

  const result = await shiplyDeploy({ provider: providerFor('shiply', stub), manifest, context: {} });

  const created = JSON.parse(stub.requests[0].body.toString('utf8'));
  assert.ok(created.agentName, 'agentName is required on anonymous publishes');
  assert.equal(created.files.length, 2);
  assert.ok(created.files.every((file) => file.path && file.hash && file.size), 'the manifest carries path, size and hash');
  const puts = stub.requests.filter((request) => request.method === 'PUT');
  assert.equal(puts.length, 2, 'every file must be uploaded');
  const finalize = stub.requests.find((request) => request.url === '/finalize');
  assert.ok(finalize, 'finalize must be called: the site is not live before it');
  assert.equal(JSON.parse(finalize.body.toString('utf8')).versionId, 'v1');
  assert.equal(result.versionId, 'v2');
  assert.equal(result.transport, 'three-step-manifest');
  assert.equal(result.claim.value, 'claim_token_xyz');
  assert.ok(result.providerDetail.toUpdate, 'the provider update path must be passed through, not acted on');
});

test('shiply never returns a URL when finalize is missing or fails', async () => {
  const manifest = makeManifest({ withAssets: false });
  const noFinalize = await startStub(({ response, record, port }) => {
    if (record.method === 'PUT') {
      response.writeHead(200);
      return response.end();
    }
    return json(response, 200, {
      slug: 'x', siteUrl: `http://127.0.0.1:${port}/`,
      upload: { versionId: 'v1', uploads: [{ path: 'index.html', url: `http://127.0.0.1:${port}/put/index.html` }] }
    });
  });
  await assert.rejects(
    () => shiplyDeploy({ provider: providerFor('shiply', noFinalize), manifest, context: {} }),
    (error) => {
      assert.equal(error.kind, 'server');
      assert.match(error.message, /finalizeUrl/);
      return true;
    }
  );

  const failedFinalize = await startStub(({ response, record, port }) => {
    if (record.url === '/finalize') return json(response, 500, { error: { code: 'service_unavailable' } });
    if (record.method === 'PUT') {
      response.writeHead(200);
      return response.end();
    }
    return json(response, 200, {
      slug: 'x', siteUrl: `http://127.0.0.1:${port}/`,
      upload: { versionId: 'v1', uploads: [{ path: 'index.html', url: `http://127.0.0.1:${port}/put/index.html` }], finalizeUrl: `http://127.0.0.1:${port}/finalize` }
    });
  });
  await assert.rejects(() => shiplyDeploy({ provider: providerFor('shiply', failedFinalize), manifest, context: {} }));
});

test('shiply refuses a manifest whose upload URLs do not cover every file', async () => {
  const manifest = makeManifest({ withAssets: true });
  const stub = await startStub(({ response, port }) => json(response, 200, {
    slug: 'x', siteUrl: `http://127.0.0.1:${port}/`,
    upload: { versionId: 'v1', uploads: [{ path: 'index.html', url: `http://127.0.0.1:${port}/put/index.html` }], finalizeUrl: `http://127.0.0.1:${port}/finalize` }
  }));

  await assert.rejects(
    () => shiplyDeploy({ provider: providerFor('shiply', stub), manifest, context: {} }),
    (error) => {
      assert.equal(error.kind, 'server');
      assert.match(error.message, /1 of 2 files/);
      return true;
    }
  );
  assert.equal(stub.requests.filter((request) => request.method === 'PUT').length, 0, 'nothing may be uploaded for a partial manifest');
});

test('shippage reports agent registration as presence only and keeps a missing expiry null', async () => {
  const manifest = makeManifest({ withAssets: false });
  const stub = await startStub(({ response, port }) => json(response, 201, {
    ok: true, url: `http://127.0.0.1:${port}/p/3v5q2d`, slug: '3v5q2d', expires_at: null, password_protected: false,
    _registration: { agent_id: 'a1', api_key: 'secret_value_must_not_be_recorded' }
  }));

  const result = await shippageDeploy({ provider: providerFor('shippage', stub), manifest, context: {} });

  assert.equal(result.slug, '3v5q2d');
  assert.equal(result.expiresAtSource, 'documented-retention');
  assert.equal(result.providerDetail.passwordProtected, false);
  assert.deepEqual(result.providerDetail.agentRegistration, { present: true, fields: ['agent_id', 'api_key'], treatedAsClaim: false });
  assert.equal(JSON.stringify(result).includes('secret_value_must_not_be_recorded'), false,
    'an undocumented registration field must never be copied into the result');
  assert.equal(result.claim, null, 'no claim spec means no claim, not a guessed one');
});

test('a root-serving host is not asked for index.html at its own path', async () => {
  const manifest = makeManifest({ withAssets: true });
  const { selectVerificationTargets } = await import('../src/verify.mjs');

  const normal = selectVerificationTargets(manifest, {});
  assert.ok(normal.targets.includes('index.html'), 'a normal host is verified at the document path');

  const rooted = selectVerificationTargets(manifest, { rootServesDocument: true });
  assert.equal(rooted.targets.includes('index.html'), false,
    'a wrapping host renders the document at the root, so asking for /index.html reports a missing file that is not missing');
  assert.ok(rooted.targets.includes('assets/app.js'), 'other files are still verified normally');

  const forced = selectVerificationTargets(manifest, { rootServesDocument: true, full: true });
  assert.equal(forced.targets.includes('index.html'), false);
});

test('shippage treats ok:false as a server failure', async () => {
  const manifest = makeManifest({ withAssets: false });
  const stub = await startStub(({ response }) => json(response, 201, { ok: false, url: 'http://127.0.0.1:1/' }));
  await assert.rejects(
    () => shippageDeploy({ provider: providerFor('shippage', stub), manifest, context: {} }),
    (error) => {
      assert.equal(error.kind, 'server');
      return true;
    }
  );
});
