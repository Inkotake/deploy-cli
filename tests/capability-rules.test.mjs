/**
 * Capability rules learned from measurement (2026-09-13).
 *
 * Two facts were established by deploying a representative fixture and by probing extensions one at a
 * time, each with the provider's own error:
 *
 *  - BrewPage, show and dropley reject `.glb` and `.wasm` (HTTP 422, HTTP 400 and a server-side
 *    rejection respectively) while accepting `.woff2`; flypod accepts all three.
 *  - flypod accepts a non-ASCII path and then answers 404 for it in every encoding tried, so an artifact
 *    containing one must be refused before uploading rather than failing afterwards.
 *
 * These tests pin the rule, not the provider: they must fail loudly if the planner stops applying a
 * capability the registry declares.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { planProviders } from '../src/planner.mjs';

function provider(overrides = {}) {
  const { capabilities, ...rest } = overrides;
  return {
    id: 'p1',
    label: 'P1',
    adapter: 'ship-page',
    transport: 'zip-post',
    endpoint: 'https://p1.test/deploy',
    allowedHosts: ['p1.test'],
    protocol: 'zip-post',
    priority: 10,
    cnPriority: 10,
    enabled: true,
    modes: ['quick-share'],
    persistent: false,
    cli: null,
    capabilities: {
      anonymous: true,
      maxFiles: 100,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
      supportedExtensions: null,
      denyExtensions: [],
      extensionPolicy: 'any',
      supportsModelFiles: true,
      htmlExact: true,
      ...(capabilities || {})
    },
    ...rest
  };
}

function manifest(overrides = {}) {
  return {
    dir: path.join(os.tmpdir(), 'artifact'),
    fileCount: 2,
    totalBytes: 100,
    largest: { path: 'assets/app.js', bytes: 60 },
    extensions: ['.html', '.js'],
    features: {},
    ...overrides
  };
}

function plan(providers, manifestOverrides = {}) {
  return planProviders({
    registry: { providers },
    manifest: manifest(manifestOverrides),
    mode: 'quick-share',
    region: 'auto',
    healthState: { providers: {} },
    context: { config: { byProvider: {}, other: [] }, gitRemote: null, cliAuth: {} },
    healthFor: () => ({ state: 'unknown', circuitOpen: false })
  });
}

const CJK_FILES = [
  { path: 'index.html', bytes: 40, mime: 'text/html' },
  { path: '中文/说明.txt', bytes: 20, mime: 'text/plain' }
];

test('an artifact with non-ASCII paths is refused by a host that cannot serve them', () => {
  const result = plan([provider({ id: 'flypod-like', capabilities: { nonAsciiPaths: false } })],
    { files: CJK_FILES, extensions: ['.html', '.txt'], fileCount: 2 });

  assert.equal(result.eligible.some((entry) => entry.id === 'flypod-like'), false,
    'a host that 404s non-ASCII paths must not be offered for this artifact');
  const refusal = result.ineligible.find((entry) => entry.id === 'flypod-like');
  assert.ok(refusal, 'the refusal must be reported');
  assert.equal(refusal.kind, 'incompatible');
  const rule = (refusal.failures || []).find((failure) => failure.kind === 'non-ascii-paths');
  assert.ok(rule, `the specific rule must be named, got: ${JSON.stringify(refusal.failures)}`);
  assert.match(rule.reason, /non-ASCII/);
  assert.deepEqual(rule.paths, ['中文/说明.txt'], 'the offending paths must be named');
});

test('a host without the restriction is unaffected by the same artifact', () => {
  const result = plan([provider({ id: 'plain' })], { files: CJK_FILES, extensions: ['.html', '.txt'], fileCount: 2 });
  assert.ok(result.eligible.some((entry) => entry.id === 'plain'));
});

test('an artifact without non-ASCII paths still plans normally on the same host', () => {
  const result = plan([provider({ id: 'flypod-like', capabilities: { nonAsciiPaths: false } })], {
    files: [
      { path: 'index.html', bytes: 40, mime: 'text/html' },
      { path: 'assets/app.js', bytes: 60, mime: 'text/javascript' }
    ]
  });
  assert.ok(result.eligible.some((entry) => entry.id === 'flypod-like'),
    'the rule must apply to the paths that are present, not to artifacts in general');
});

test('a manifest without a file list is not blocked by the non-ASCII rule', () => {
  // Older callers and fixtures describe an artifact by extension only; the rule must not invent paths.
  const result = plan([provider({ id: 'flypod-like', capabilities: { nonAsciiPaths: false } })], { files: undefined });
  assert.ok(result.eligible.some((entry) => entry.id === 'flypod-like'));
});

test('a model-file blocklist rejects the measured extensions', () => {
  const result = plan([provider({ id: 'model-free', capabilities: { supportsModelFiles: false } })], {
    files: [
      { path: 'index.html', bytes: 40, mime: 'text/html' },
      { path: 'model.glb', bytes: 60, mime: 'model/gltf-binary' }
    ],
    extensions: ['.html', '.glb']
  });

  assert.equal(result.eligible.some((entry) => entry.id === 'model-free'), false);
  const refusal = result.ineligible.find((entry) => entry.id === 'model-free');
  assert.equal(refusal.kind, 'incompatible');
  assert.match(JSON.stringify(refusal.failures), /model\/binary assets|allowlist|blocklist/);
});

test('the shipped registry reflects what was measured for these hosts', async () => {
  const { loadRegistry } = await import('../src/registry.mjs');
  const registry = loadRegistry();
  assert.equal(registry.ok, true);
  const byId = (id) => registry.providers.find((entry) => entry.id === id);

  assert.equal(byId('brewpage').capabilities.supportsModelFiles, false,
    'BrewPage answered 422 "File type is not allowed" for .glb and .wasm');
  assert.deepEqual(byId('brewpage').capabilities.denyExtensions, ['.glb', '.wasm']);
  assert.equal(byId('flypod').capabilities.nonAsciiPaths, false,
    'flypod accepted a non-ASCII path and then served 404 in every encoding');
  for (const id of ['show', 'dropley']) {
    assert.equal(byId(id).capabilities.supportsModelFiles, false, `${id} rejected .glb and .wasm with its own error`);
  }
});
