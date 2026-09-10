/**
 * Remote verification is the product's central promise: a deployment is a success only when the
 * bytes served from the public URL are the bytes that were hashed locally. These tests serve a real
 * artifact over a local HTTP server and mutate exactly what goes over the wire, so both directions
 * are covered — a faithful host passes, and every kind of infidelity fails.
 *
 * No test here touches the public internet.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { inspectArtifact } from '../src/inspect.mjs';
import { FULL_VERIFY_LIMIT_BYTES, selectVerificationTargets, verifyDeployment } from '../src/verify.mjs';

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

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-verify-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function makeManifest(label, extraFiles = 0) {
  const dir = path.join(tempDir(label), 'dist');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/app.css"></head><body><script src="assets/app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("one");\nconsole.log("two");\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), 'body { color: rebeccapurple; }\n');
  fs.writeFileSync(path.join(dir, 'assets', 'model.glb', ), Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ ok: true }));
  for (let index = 0; index < extraFiles; index += 1) {
    fs.writeFileSync(path.join(dir, 'assets', `pad-${index}.png`), Buffer.alloc(256, index + 1));
  }
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);
  return inspected.manifest;
}

/** Serve the manifest's bytes back, with per-path overrides for body, content-type and status. */
async function startOrigin(manifest) {
  const overrides = new Map();
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const rel = pathname === '/site/' || pathname === '/site' ? 'index.html' : pathname.replace(/^\/site\//, '');
    const entry = manifest.byRelative.get(rel);
    const override = overrides.get(rel) || {};
    if (!entry && !override.body) {
      response.writeHead(override.status || 404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const body = override.body !== undefined ? override.body : entry.bytes;
    response.writeHead(override.status || 200, { 'content-type': override.contentType || (entry && entry.record.mime) || 'application/octet-stream' });
    response.end(body);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/site/`, override: (rel, value) => overrides.set(rel, value) };
}

test('a faithful host verifies completely, and never claims a browser check', async () => {
  const manifest = makeManifest('faithful');
  const origin = await startOrigin(manifest);
  const result = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });

  assert.equal(result.passed, true);
  assert.equal(result.method, 'http-sha256');
  assert.equal(result.strategy, 'all-files');
  assert.equal(result.htmlPolicy, 'strict');
  assert.equal(result.htmlExact, true);
  assert.equal(result.hashComplete, true);
  assert.equal(result.filesVerified, manifest.fileCount);
  assert.equal(result.filesRequired, manifest.fileCount);
  assert.equal(result.bytesVerified, manifest.totalBytes);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.failures, []);
  assert.equal(result.browserVerified, false);
  assert.match(result.note, /no browser rendering/i);
  assert.equal(result.rootStatus, 200);
});

test('one altered byte in a non-HTML resource fails the run', async () => {
  const manifest = makeManifest('tampered-js');
  const origin = await startOrigin(manifest);
  const altered = Buffer.from(manifest.byRelative.get('assets/app.js').bytes);
  altered[0] = 0x43; // 'C'
  origin.override('assets/app.js', { body: altered });

  const result = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });
  assert.equal(result.passed, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].path, 'assets/app.js');
  assert.equal(result.mismatches[0].kind, 'sha256');
  assert.equal(result.mismatches[0].expectedBytes, undefined);
  assert.equal(result.htmlExact, true, 'an altered resource says nothing about HTML policy');
});

test('rewritten HTML fails under strict policy and is only presence-checked under presence-only', async () => {
  const manifest = makeManifest('rewritten-html');
  const origin = await startOrigin(manifest);
  const rewritten = Buffer.from('<!doctype html><html><body>host injected a banner<script src="assets/app.js"></script></body></html>\n');
  origin.override('index.html', { body: rewritten, contentType: 'text/html; charset=utf-8' });

  const strict = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });
  assert.equal(strict.passed, false);
  assert.equal(strict.mismatches.some((mismatch) => mismatch.path === 'index.html'), true);

  const presenceOnly = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: { htmlPolicy: 'presence-only' } });
  assert.equal(presenceOnly.passed, true, 'the rest of the artifact is still byte-identical');
  assert.equal(presenceOnly.htmlExact, false);
  assert.equal(presenceOnly.filesPresenceChecked, 1);
  assert.equal(presenceOnly.htmlNotCompared[0].path, 'index.html');
  assert.ok(presenceOnly.filesVerified < presenceOnly.filesRequired, 'a presence check must never count as a hash check');
  assert.equal(presenceOnly.hashComplete, false);
  assert.match(presenceOnly.note, /presence-checked/);
});

test('an HTML body served for a JS file is a failure even with status 200', async () => {
  const manifest = makeManifest('html-fallback');
  const origin = await startOrigin(manifest);
  origin.override('assets/app.js', { body: Buffer.from('<!doctype html><html><body>spa fallback</body></html>'), contentType: 'text/html' });

  const result = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });
  assert.equal(result.passed, false);
  const failure = result.failures.find((entry) => entry.path === 'assets/app.js');
  assert.equal(failure.kind, 'html-fallback');
});

test('a removed resource and a corrupted status both fail', async () => {
  const manifest = makeManifest('missing');
  const origin = await startOrigin(manifest);
  origin.override('assets/app.css', { body: 'gone', status: 404 });
  const result = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });
  assert.equal(result.passed, false);
  assert.equal(result.failures.find((entry) => entry.path === 'assets/app.css').kind, 'missing');

  const manifest2 = makeManifest('status');
  const origin2 = await startOrigin(manifest2);
  origin2.override('assets/app.css', { body: 'boom', status: 500 });
  const result2 = await verifyDeployment({ publicUrl: origin2.baseUrl, manifest: manifest2, options: {} });
  assert.equal(result2.passed, false);
  assert.equal(result2.failures.find((entry) => entry.path === 'assets/app.css').kind, 'status');
});

test('a root that is not HTML, or not there at all, is reported without per-file work', async () => {
  const manifest = makeManifest('root-content-type');
  const origin = await startOrigin(manifest);
  origin.override('index.html', { contentType: 'text/plain' });
  const notHtml = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });
  assert.equal(notHtml.passed, false);
  assert.equal(notHtml.strategy, 'root');
  assert.equal(notHtml.filesVerified, 0);
  assert.ok(notHtml.problems.some((problem) => /did not answer with HTML/.test(problem)));

  const manifest2 = makeManifest('root-status');
  const origin2 = await startOrigin(manifest2);
  origin2.override('index.html', { body: 'gone', status: 404 });
  const missingRoot = await verifyDeployment({ publicUrl: origin2.baseUrl, manifest: manifest2, options: {} });
  assert.equal(missingRoot.passed, false);
  assert.equal(missingRoot.strategy, 'root');
  assert.ok(missingRoot.problems.some((problem) => /HTTP 404/.test(problem)));
});

test('a host error page served with status 200 is detected', async () => {
  const manifest = makeManifest('error-page');
  const origin = await startOrigin(manifest);
  origin.override('index.html', { body: '<!doctype html><html><body>404 Not Found — deployment not found</body></html>', contentType: 'text/html' });

  const result = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: {} });
  assert.equal(result.passed, false);
  const failure = result.failures.find((entry) => entry.path === 'index.html');
  assert.equal(failure.kind, 'error-page');
});

test('above the threshold only the required subset is compared, unless full verification is asked for', async () => {
  // Enough padding that the selective set is genuinely smaller than the artifact.
  const manifest = makeManifest('threshold', 5);
  const origin = await startOrigin(manifest);

  const selective = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: { fullLimitBytes: 1 } });
  assert.equal(selective.strategy, 'selective');
  assert.ok(selective.filesRequired < manifest.fileCount, 'a selective run must not look like a complete one');
  assert.equal(selective.filesExpected, manifest.fileCount);
  assert.match(selective.note, /only \d+ of \d+ files were compared/i, 'the note must say the comparison was partial');
  assert.match(selective.note, /--verify-all/);
  assert.equal(selective.passed, true, 'the compared subset was faithful');

  const full = await verifyDeployment({ publicUrl: origin.baseUrl, manifest, options: { fullLimitBytes: 1, full: true } });
  assert.equal(full.strategy, 'all-files');
  assert.equal(full.filesRequired, manifest.fileCount);
  assert.equal(full.hashComplete, true);
});

test('target selection always keeps the structurally important files', () => {
  const manifest = makeManifest('targets');
  const selection = selectVerificationTargets(manifest, { fullLimitBytes: 1 });
  for (const required of ['index.html', 'assets/app.js', 'assets/app.css', 'assets/model.glb']) {
    assert.ok(selection.targets.includes(required), `${required} must always be compared`);
  }
  assert.equal(selection.targets.length, new Set(selection.targets).size, 'no duplicates');
  const largest = [...manifest.files].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  for (const file of largest) assert.ok(selection.targets.includes(file.path), 'the three largest files are compared');

  const everything = selectVerificationTargets(manifest, { fullLimitBytes: 1, full: true });
  assert.deepEqual(everything.targets, manifest.files.map((file) => file.path));

  const defaultLimit = selectVerificationTargets(manifest, {});
  assert.equal(defaultLimit.strategy, 'all-files', `a small artifact is compared in full under the ${FULL_VERIFY_LIMIT_BYTES} byte limit`);
});
