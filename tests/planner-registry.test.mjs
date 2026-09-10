/**
 * The provider registry is the only source of truth about what a host can serve, and the planner is
 * the only place those facts turn into a decision. Both are tested here because a mistake in either
 * shows up as a failed upload the user cannot explain.
 *
 * Registry tests use fixture files (through `VERIFIED_PUBLISH_REGISTRY`) so the shipped registry is
 * never mutated; planner tests use hand-written provider objects so each capability can be isolated.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyOverlay, loadRegistry, providerById } from '../src/registry.mjs';
import { DEFAULT_REGION, planProviders, summarizePlan } from '../src/planner.mjs';

const SHIPPED = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config/providers.json', import.meta.url)), 'utf8'));
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

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-reg-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Load a fixture registry (or the shipped one) through the documented environment override. */
function loadFixture(registry, label) {
  if (registry === null) return loadRegistry();
  const file = path.join(tempDir(label), 'providers.json');
  fs.writeFileSync(file, typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2));
  return loadRegistry({ env: { VERIFIED_PUBLISH_REGISTRY: file } });
}

function withProviders(providers) {
  return { ...SHIPPED, providers };
}

const REQUIRED_KEYS = ['anonymous', 'maxFiles', 'maxFileBytes', 'maxTotalBytes', 'supportedExtensions', 'denyExtensions', 'extensionPolicy', 'supportsModelFiles', 'claimable', 'htmlExact', 'ttl'];

function provider(overrides = {}) {
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
      maxFileBytes: null,
      maxTotalBytes: null,
      supportedExtensions: null,
      denyExtensions: [],
      extensionPolicy: 'any',
      supportsModelFiles: true,
      claimable: true,
      htmlExact: true,
      ttl: { defaultSeconds: 3600, optionsSeconds: null, source: 'test fixture' }
    },
    verification: { status: 'live-tested', resourcesByteExact: true, verifiedAt: null, note: 'test fixture' },
    ...overrides
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

function plan(providers, manifestOverrides = {}, options = {}) {
  return planProviders({
    registry: { providers },
    manifest: manifest(manifestOverrides),
    mode: 'quick-share',
    region: 'auto',
    healthState: { providers: {} },
    context: { config: { byProvider: {}, other: [] }, gitRemote: null, cliAuth: {} },
    healthFor: () => ({ state: 'unknown', circuitOpen: false }),
    ...options
  });
}

/* ------------------------------------------------------------------ registry ---- */

test('the shipped registry loads with the documented schema and shape', () => {
  const registry = loadRegistry();
  assert.equal(registry.ok, true, registry.error);
  assert.equal(registry.capabilitySchema, 1);
  assert.equal(registry.version, 1);
  assert.equal(registry.providers.length, 11);
  const disabled = registry.providers.filter((entry) => entry.enabled !== true);
  assert.deepEqual(disabled.map((entry) => entry.id), ['wh-drop']);
  assert.ok(disabled[0].disabledReason, 'a disabled provider must say why');
  for (const entry of registry.providers) {
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in entry.capabilities, `${entry.id} is missing capabilities.${key}`);
    }
  }
  assert.equal(providerById(registry, 'ship-page').capabilities.htmlExact, true);
  assert.equal(providerById(registry, 'shipstatic').capabilities.htmlExact, false);
});

test('a missing capability key is refused, and null is only allowed for limits', () => {
  const missing = structuredClone(provider());
  delete missing.capabilities.claimable;
  const refused = loadFixture(withProviders([missing]), 'missing-key');
  assert.equal(refused.ok, false);
  assert.ok(refused.problems.some((problem) => problem.includes('capabilities.claimable')), refused.problems.join('; '));

  const nullBoolean = structuredClone(provider());
  nullBoolean.capabilities.htmlExact = null;
  assert.equal(loadFixture(withProviders([nullBoolean]), 'null-boolean').ok, false);

  const nullLimit = structuredClone(provider());
  nullLimit.capabilities.maxFiles = null;
  assert.equal(loadFixture(withProviders([nullLimit]), 'null-limit').ok, true);
});

test('the capability schema version is enforced instead of guessed', () => {
  const noSchema = structuredClone(SHIPPED);
  delete noSchema.capabilitySchema;
  const missing = loadFixture(noSchema, 'no-schema');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not declare capabilitySchema/);

  const futureSchema = { ...structuredClone(SHIPPED), capabilitySchema: 2 };
  const future = loadFixture(futureSchema, 'future-schema');
  assert.equal(future.ok, false);
  assert.match(future.error, /capabilitySchema 2/);
  assert.match(future.error, /understands 1/);
});

test('inconsistent capability declarations are refused', () => {
  const badPolicy = structuredClone(provider());
  badPolicy.capabilities.extensionPolicy = 'whatever';
  assert.equal(loadFixture(withProviders([badPolicy]), 'bad-policy').ok, false);

  const overlap = structuredClone(provider());
  overlap.capabilities.supportedExtensions = ['.html', '.js'];
  overlap.capabilities.denyExtensions = ['.js'];
  const refused = loadFixture(withProviders([overlap]), 'overlap');
  assert.equal(refused.ok, false);
  assert.ok(refused.problems.some((problem) => problem.includes('.js')));

  const disabledNoReason = structuredClone(provider());
  disabledNoReason.enabled = false;
  assert.equal(loadFixture(withProviders([disabledNoReason]), 'no-reason').ok, false);
});

test('duplicate provider ids are refused', () => {
  const registry = loadFixture(withProviders([provider(), provider()]), 'duplicate');
  assert.equal(registry.ok, false);
  assert.ok(registry.problems.some((problem) => problem.includes('duplicate provider id')));
});

test('the overlay may change availability and nothing else', () => {
  const providers = [structuredClone(provider())];
  const { report } = applyOverlay(providers, {
    providers: [
      { id: 'p1', enabled: false, priority: 42, endpoint: 'https://evil.test/', adapter: 'other', capabilities: {}, notes: 'set by operator' },
      { id: 'ghost', enabled: true }
    ]
  });
  assert.equal(providers[0].enabled, false, 'enabled is overlay-mutable');
  assert.equal(providers[0].priority, 42);
  assert.equal(providers[0].endpoint, 'https://p1.test/deploy', 'a protected field must not move');
  assert.deepEqual(report.unknownProviders, ['ghost']);
  const refusedFields = report.rejected.map((entry) => entry.field);
  for (const field of ['endpoint', 'adapter', 'capabilities']) {
    assert.ok(refusedFields.includes(field), `${field} must be refused explicitly`);
  }
  assert.ok(report.applied.some((entry) => entry.field === 'notes'));
});

/* ------------------------------------------------------------------- planner ---- */

test('an incompatible extension class is excluded with a reason, never merely ranked lower', () => {
  const models = plan([provider({ id: 'no-models', capabilities: { ...provider().capabilities, supportsModelFiles: false } })], { extensions: ['.html', '.glb'] });
  assert.deepEqual(models.eligible, []);
  assert.equal(models.ineligible[0].kind, 'incompatible');
  assert.match(models.ineligible[0].reason, /model/i);

  const allowlist = plan([provider({ id: 'allow', capabilities: { ...provider().capabilities, supportedExtensions: ['.html'] } })], { extensions: ['.html', '.js'] });
  assert.match(allowlist.ineligible[0].reason, /allowlist/i);

  const blocklist = plan([provider({ id: 'deny', capabilities: { ...provider().capabilities, denyExtensions: ['.js'] } })], { extensions: ['.html', '.js'] });
  assert.match(blocklist.ineligible[0].reason, /blocklist/i);
  assert.ok(blocklist.ineligible[0].failures[0].extensions.includes('.js'));
});

test('size limits are enforced before upload and near-limit is reported', () => {
  const caps = { ...provider().capabilities, maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 400 };
  const planResult = plan([provider({ capabilities: caps })], { fileCount: 5, largest: { path: 'big.js', bytes: 99 }, totalBytes: 500 });
  const reasons = planResult.ineligible[0].reason;
  assert.match(reasons, /at most 1 files/);
  assert.match(reasons, /at most 10 bytes per file/);
  assert.match(reasons, /at most 400 bytes in total/);

  const near = plan([provider({ capabilities: { ...provider().capabilities, maxTotalBytes: 1000 } })], { totalBytes: 950 });
  assert.equal(near.eligible.length, 1);
  assert.match(near.eligible[0].reason, /within 10%/);
});

test('a host that rewrites HTML is excluded unless the caller accepts presence-only checks', () => {
  const rewriting = provider({ id: 'rewriter', capabilities: { ...provider().capabilities, htmlExact: false } });
  const excluded = plan([rewriting]);
  assert.deepEqual(excluded.eligible, []);
  assert.equal(excluded.ineligible[0].kind, 'html-rewritten');
  assert.match(excluded.ineligible[0].reason, /--allow-inexact/);

  const included = plan([rewriting], {}, { allowInexact: true });
  assert.equal(included.eligible.length, 1);
  assert.equal(included.eligible[0].htmlExact, false, 'the caller must still see that HTML is not byte-compared');
});

test('an open circuit breaker removes a provider without disabling it', () => {
  const result = planProviders({
    registry: { providers: [provider({ id: 'tripped' }), provider({ id: 'fine' })] },
    manifest: manifest(),
    mode: 'quick-share',
    region: 'auto',
    healthState: { providers: {} },
    context: { config: { byProvider: {}, other: [] }, gitRemote: null, cliAuth: {} },
    healthFor: (id) => (id === 'tripped' ? { state: 'open', circuitOpen: true, openUntil: '2030-01-01T00:00:00.000Z', lastFailureKind: 'server' } : { state: 'healthy', circuitOpen: false })
  });
  assert.deepEqual(result.eligible.map((entry) => entry.id), ['fine']);
  assert.equal(result.ineligible[0].kind, 'circuit-open');
  assert.match(result.ineligible[0].reason, /circuit breaker open/);
});

test('region decides whether the region priority leads, breaks ties, or is ignored', () => {
  const providers = [
    provider({ id: 'a', priority: 10, cnPriority: 10 }),
    provider({ id: 'b', priority: 10, cnPriority: 99 }),
    provider({ id: 'c', priority: 20, cnPriority: 1 })
  ];
  const orderOf = (region) => plan(providers, {}, { region }).eligible.map((entry) => entry.id);

  // cn-mainland: the region priority is applied before the capability score, so a host that is
  // reachable from the region outranks one that merely scores higher.
  assert.deepEqual(orderOf('cn-mainland'), ['b', 'a', 'c']);
  // auto: score first, region priority only breaks ties.
  assert.deepEqual(orderOf('auto'), ['c', 'b', 'a']);
  // global: the region priority is ignored entirely, so the tie falls through to registry priority.
  assert.deepEqual(orderOf('global'), ['c', 'a', 'b']);
  // An unknown region is a programming error, not a silent switch of behaviour.
  assert.deepEqual(orderOf('mars'), orderOf(DEFAULT_REGION));
});

test('persistent mode requires evidence and never falls back to an anonymous host', () => {
  const durable = provider({ id: 'durable', persistent: true, modes: ['persistent'], cli: 'netlify' });
  const anonymous = provider({ id: 'anon', modes: ['quick-share'] });
  const noEvidence = planProviders({
    registry: { providers: [durable, anonymous] },
    manifest: manifest(),
    mode: 'persistent',
    region: 'auto',
    healthState: { providers: {} },
    context: { config: { byProvider: {}, other: [] }, gitRemote: null, cliAuth: {} },
    healthFor: () => ({ state: 'unknown', circuitOpen: false })
  });
  assert.deepEqual(noEvidence.eligible, [], 'without configuration or a session nothing may be attempted');
  const durableVerdict = noEvidence.ineligible.find((entry) => entry.id === 'durable');
  assert.equal(durableVerdict.kind, 'no-evidence', 'a durable host without evidence is excluded for that reason');
  assert.equal(noEvidence.ineligible.find((entry) => entry.id === 'anon').kind, 'incompatible', 'a quick-share-only host cannot serve persistent mode at all');

  const withConfig = planProviders({
    registry: { providers: [durable] },
    manifest: manifest(),
    mode: 'persistent',
    region: 'auto',
    healthState: { providers: {} },
    context: { config: { byProvider: { durable: ['netlify.toml'] }, other: [] }, gitRemote: null, cliAuth: {} },
    healthFor: () => ({ state: 'unknown', circuitOpen: false })
  });
  assert.deepEqual(withConfig.eligible.map((entry) => entry.id), ['durable']);

  const withAuth = planProviders({
    registry: { providers: [durable] },
    manifest: manifest(),
    mode: 'persistent',
    region: 'auto',
    healthState: { providers: {} },
    context: { config: { byProvider: {}, other: [] }, gitRemote: null, cliAuth: { durable: { installed: true, authenticated: true, detail: 'test' } } },
    healthFor: () => ({ state: 'unknown', circuitOpen: false })
  });
  assert.deepEqual(withAuth.eligible.map((entry) => entry.id), ['durable']);
});

test('a plan summary is rank-ordered and carries the machine-readable facts', () => {
  const result = plan([provider({ id: 'a', priority: 20 }), provider({ id: 'b', priority: 10 })]);
  const summary = summarizePlan(result);
  assert.deepEqual(summary.order.map((entry) => entry.rank), [1, 2]);
  assert.deepEqual(summary.order.map((entry) => entry.id), ['a', 'b']);
  for (const entry of summary.order) {
    assert.equal(typeof entry.reason, 'string');
    assert.equal(typeof entry.score, 'number');
    assert.equal(typeof entry.htmlExact, 'boolean');
    assert.equal(typeof entry.claimable, 'boolean');
  }
  assert.equal(summary.region, 'auto');
  assert.equal(summary.mode, 'quick-share');
});
