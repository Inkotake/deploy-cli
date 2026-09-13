/**
 * Every anonymous adapter must at least *run*.
 *
 * WHY THIS EXISTS: `shipstatic`, `here-now`, `show` and `aft-page` called an undefined helper
 * (`providerTtlSeconds`) for two rounds because a rename rewrote the call site and skipped the import.
 * Only the ship-page adapter had an end-to-end test, so nothing failed. This test closes that hole the
 * cheap way: it calls each adapter's entry point against a **closed port**, which needs no network and
 * no per-provider stub.
 *
 * The contract it asserts is the one that matters and that the bug violated:
 *   an adapter that cannot reach its provider must reject with a *classified* ProviderError
 *   (`unreachable` / `server`), never with a raw ReferenceError/TypeError surfacing as `unknown`.
 *
 * This is deliberately not a substitute for per-provider protocol tests: it proves the entry path
 * executes and classifies, not that the protocol is parsed correctly.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRegistry } from '../src/registry.mjs';
import { inspectArtifact } from '../src/inspect.mjs';
import { ADAPTERS, getAdapter } from '../src/providers/index.mjs';
import { ProviderError } from '../src/providers/errors.mjs';

/** The adapters that speak HTTP to an anonymous host; `persistent` is covered by its own suite. */
const ANONYMOUS = ['ship-page', 'shipstatic', 'here-now', 'show', 'aft-page', 'dropley', 'flypod'];
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best effort */
    }
  }
});

function makeManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-adapter-contract-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>contract</body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("contract");\n');
  const inspected = inspectArtifact(dir);
  assert.equal(inspected.ok, true);
  return inspected.manifest;
}

test('every anonymous adapter is registered and exposes an id and a deploy function', () => {
  const registry = loadRegistry();
  assert.equal(registry.ok, true);
  for (const id of ANONYMOUS) {
    const provider = registry.providers.find((entry) => entry.id === id);
    assert.ok(provider, `${id} must be in the registry`);
    const adapter = ADAPTERS.get(provider.adapter);
    assert.ok(adapter, `${id} declares adapter "${provider.adapter}", which must be registered in providers/index.mjs`);
    assert.equal(adapter.id, provider.adapter, `${id}: the adapter's own id must match the registry's adapter field`);
    assert.equal(typeof adapter.deploy, 'function', `${id}: the adapter must export deploy()`);
    assert.equal(getAdapter(provider), adapter, `${id}: getAdapter must resolve it`);
  }
});

test('an adapter that cannot reach its provider rejects with a classified error, not a crash', async () => {
  const manifest = makeManifest();
  const registry = loadRegistry();

  for (const id of ANONYMOUS) {
    const provider = registry.providers.find((entry) => entry.id === id);
    const adapter = getAdapter(provider);
    // A closed port: no network, no stub, and the same code path an unreachable host would take.
    const target = { ...provider, endpoint: 'http://127.0.0.1:1/deploy' };

    let caught = null;
    try {
      await adapter.deploy({ provider: target, manifest, context: {} });
    } catch (cause) {
      caught = cause;
    }

    assert.ok(caught, `${id}: deploying to a closed port must fail`);
    assert.ok(caught instanceof ProviderError,
      `${id}: expected a ProviderError, got ${caught && caught.constructor ? caught.constructor.name : typeof caught}: ${caught && caught.message}`);
    assert.notEqual(caught.kind, 'unknown',
      `${id}: an unreachable provider must be classified, not reported as unknown (${caught.message})`);
    assert.ok(['unreachable', 'server'].includes(caught.kind),
      `${id}: a closed port should classify as unreachable or server, got "${caught.kind}"`);
    assert.match(caught.message, new RegExp(id), `${id}: the message must name the provider`);
  }
});

test('the registry only enables providers whose adapter exists and is dispatchable', () => {
  const registry = loadRegistry();
  const enabled = registry.providers.filter((entry) => entry.enabled === true);
  assert.ok(enabled.length > 0, 'at least one provider is enabled');
  for (const provider of enabled) {
    const adapter = getAdapter(provider);
    assert.ok(adapter, `${provider.id} is enabled but has no dispatchable adapter`);
    // URL-carrying providers must declare an allowlist, or a spoofed response could redirect users.
    if (provider.transport !== 'cli') {
      assert.ok(Array.isArray(provider.allowedHosts) && provider.allowedHosts.length > 0,
        `${provider.id} is enabled without an allowedHosts allowlist`);
    }
  }
});
