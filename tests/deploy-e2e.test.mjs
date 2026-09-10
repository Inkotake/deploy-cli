/**
 * End-to-end deployment behaviour, against local fake services.
 *
 * These tests exist because the product's claim is narrow and testable: it uploads, it fails over,
 * and it reports success only when the bytes served back match the local manifest. A fake provider
 * lets all three be verified without any network, including the failure paths that would otherwise
 * need a real outage:
 *
 *   - the first provider is a closed port, so the run must record an unreachable failure and move on;
 *   - the second provider accepts the upload and returns a URL that serves the artifact;
 *   - the same run repeated with one byte altered on the host must fail, and must not be reported as
 *     a deployment;
 *   - the ownership credential a host returns must be stored privately and never printed by default.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { inspectArtifact } from '../src/inspect.mjs';
import { loadRegistry } from '../src/registry.mjs';
import { loadHealth } from '../src/health.mjs';
import { planProviders } from '../src/planner.mjs';
import { deployArtifact } from '../src/deploy.mjs';

const CLAIM_TOKEN = `spc_${'a'.repeat(24)}`;
const tempDirs = [];
const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* a locked temp dir must not fail the suite */
    }
  }
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-e2e-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** A tiny static site plus its real manifest. */
function makeArtifact(label) {
  const dir = path.join(tempDir(label), 'dist');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><script src="assets/app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("verified");\n');
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);
  return { dir, manifest: inspected.manifest };
}

/** Serve the manifest's bytes back over HTTP, with per-path overrides the tests can mutate. */
async function startOrigin(label, manifest) {
  const entries = new Map();
  for (const [rel, entry] of manifest.byRelative) entries.set(rel, entry);
  const overrides = new Map();
  const origin = await startServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const rel = pathname === '/site/' || pathname === '/site' ? 'index.html' : pathname.replace(/^\/site\//, '');
    const entry = entries.get(rel);
    if (!entry) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const body = overrides.has(rel) ? overrides.get(rel) : entry.bytes;
    response.writeHead(200, { 'content-type': entry.record.mime });
    response.end(body);
  });
  return {
    port: origin.port,
    baseUrl: `http://127.0.0.1:${origin.port}/site/`,
    override: (rel, bytes) => overrides.set(rel, bytes),
    remove: (rel) => entries.delete(rel)
  };
}

/** A provider endpoint that records the upload and answers with a URL on the origin. */
async function startProvider(originUrl) {
  const received = [];
  const provider = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ contentType: String(request.headers['content-type'] || ''), bytes: body.length, zipSignature: body.subarray(0, 2).toString('latin1') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        url: originUrl,
        slug: 'e2e-fixture',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        claim_token: CLAIM_TOKEN
      }));
    });
  });
  return { port: provider.port, received };
}

/** A two-provider registry: a dead endpoint first, then the live local fake. */
function makeRegistryFixture(label, livePort) {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config/providers.json', import.meta.url), 'utf8'));
  const template = shipped.providers.find((provider) => provider.id === 'ship-page');
  const variant = (id, endpoint, priority) => ({
    ...structuredClone(template),
    id,
    label: id,
    endpoint,
    priority,
    enabled: true,
    allowedHosts: ['127.0.0.1']
  });
  const registry = {
    registryVersion: 1,
    capabilitySchema: 1,
    updatedAt: new Date().toISOString(),
    notes: 'end-to-end fixture registry',
    providers: [variant('dead-host', 'http://127.0.0.1:1/deploy', 10), variant('live-host', `http://127.0.0.1:${livePort}/deploy`, 5)]
  };
  const file = path.join(tempDir(label), 'providers.json');
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  return file;
}

function planFor(registryFile, manifest, label) {
  const env = { ...process.env, VERIFIED_PUBLISH_REGISTRY: registryFile, VERIFIED_PUBLISH_HOME: tempDir(label) };
  const loaded = loadRegistry({ env });
  assert.equal(loaded.ok, true, `fixture registry must load: ${loaded.error || ''} ${(loaded.problems || []).join('; ')}`);
  const health = loadHealth(env);
  const plan = planProviders({
    registry: loaded,
    manifest,
    mode: 'quick-share',
    region: 'auto',
    healthState: health.state,
    context: { root: path.dirname(manifest.dir), config: { byProvider: {}, other: [] }, gitRemote: null, cliAuth: {} },
    healthFor: (id) => ({ state: 'unknown', circuitOpen: false })
  });
  assert.deepEqual(plan.eligible.map((entry) => entry.id), ['dead-host', 'live-host']);
  return { env, registry: loaded, plan, health };
}

test('a failing provider is recorded and a verified provider still wins the run', async () => {
  const { manifest } = makeArtifact('failover');
  const origin = await startOrigin('failover', manifest);
  const provider = await startProvider(origin.baseUrl);
  const registryFile = makeRegistryFixture('failover', provider.port);
  const { env, registry, plan, health } = planFor(registryFile, manifest, 'failover');

  const result = await deployArtifact({
    manifest, registry, mode: 'quick-share', healthState: health.state, plan, env,
    context: { root: path.dirname(manifest.dir) }
  });

  assert.equal(result.success, true, `expected success, got: ${result.reason || ''}`);
  assert.equal(result.provider, 'live-host', 'the surviving provider must be reported');
  assert.equal(result.url, origin.baseUrl);
  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.hashComplete, true);
  assert.equal(result.verification.browserVerified, false);
  assert.equal(result.snapshot, null, 'an in-process HTTP provider needs no upload snapshot');

  const attempted = result.attempts.map((attempt) => `${attempt.provider}:${attempt.result}`);
  assert.deepEqual(attempted, ['dead-host:failed', 'live-host:success']);
  assert.equal(result.attempts[0].failureKind, 'unreachable');

  // The upload really was the artifact: one zip POST, carrying a zip signature.
  assert.equal(provider.received.length, 1);
  assert.equal(provider.received[0].contentType, 'application/zip');
  assert.equal(provider.received[0].zipSignature, 'PK');

  // The ownership credential is stored, and the default output does NOT contain it.
  assert.ok(result.claim, 'the provider returned a claim, so it must be reported as available');
  assert.equal(result.claim.value, null, 'the secret must not be printed by default');
  assert.equal(result.claim.hidden, true);
  assert.ok(result.claim.secretStored, 'the caller must learn where the secret was stored');
  assert.ok(!JSON.stringify(result).includes(CLAIM_TOKEN), 'the secret must not appear anywhere in the result');
  assert.ok(fs.readFileSync(result.claim.secretStored, 'utf8').includes(CLAIM_TOKEN), 'the secret must be stored');
});

test('a host that serves altered bytes fails the run even though the upload succeeded', async () => {
  const { manifest } = makeArtifact('integrity');
  const origin = await startOrigin('integrity', manifest);
  const provider = await startProvider(origin.baseUrl);
  const registryFile = makeRegistryFixture('integrity', provider.port);
  const { env, registry, plan, health } = planFor(registryFile, manifest, 'integrity');

  // One byte differs on the wire, same length: exactly the case a bytes-blind tool would miss.
  const appJs = Buffer.from(manifest.byRelative.get('assets/app.js').bytes);
  appJs[appJs.length - 2] = 0x21;
  origin.override('assets/app.js', appJs);

  const result = await deployArtifact({
    manifest, registry, mode: 'quick-share', healthState: health.state, plan, env,
    context: { root: path.dirname(manifest.dir) }
  });

  assert.equal(result.success, false, 'a byte mismatch must never be reported as a deployment');
  assert.equal(result.provider, 'live-host');
  assert.match(result.reason, /verification|integrity/i);
  const live = result.attempts.find((attempt) => attempt.provider === 'live-host');
  assert.equal(live.failureKind, 'integrity');
  assert.match(live.detail, /sha256/i);
});

test('a missing resource on the host fails the run', async () => {
  const { manifest } = makeArtifact('missing');
  const origin = await startOrigin('missing', manifest);
  const provider = await startProvider(origin.baseUrl);
  const registryFile = makeRegistryFixture('missing', provider.port);
  const { env, registry, plan, health } = planFor(registryFile, manifest, 'missing');

  origin.remove('assets/app.js'); // the host no longer has a resource the manifest requires
  const result = await deployArtifact({
    manifest, registry, mode: 'quick-share', healthState: health.state, plan, env,
    context: { root: path.dirname(manifest.dir) }
  });

  assert.equal(result.success, false);
  const live = result.attempts.find((attempt) => attempt.provider === 'live-host');
  assert.equal(live.failureKind, 'integrity');
  assert.match(live.detail, /404|missing/i);
});

test('the requested provider only is attempted, and a disabled one is refused with its reason', async () => {
  const { manifest } = makeArtifact('only');
  const origin = await startOrigin('only', manifest);
  const provider = await startProvider(origin.baseUrl);
  const registryFile = makeRegistryFixture('only', provider.port);
  const { env, registry, plan, health } = planFor(registryFile, manifest, 'only');

  const result = await deployArtifact({
    manifest, registry, mode: 'quick-share', healthState: health.state, plan, env,
    onlyProvider: 'wh-drop', context: { root: path.dirname(manifest.dir) }
  });
  assert.equal(result.success, false);
  assert.match(result.reason, /not eligible|disabled|unknown provider/i);
  assert.equal(result.attempts.length, 0, 'nothing may be attempted when the requested provider cannot serve');
});
