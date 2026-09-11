/**
 * The command-line contract, asserted from the outside.
 *
 * The JSON payload, the exit codes and the stdout/stderr split are the interface every caller —
 * agent, script or CI — programs against. These tests spawn the real entry point, so they catch the
 * class of regression that unit tests cannot: a diagnostic leaking onto stdout, a code drifting, a
 * flag returning the wrong status.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/vpublish.mjs', import.meta.url));
const SHIPPED_REGISTRY = fileURLToPath(new URL('../config/providers.json', import.meta.url));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-cli-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeArtifact(label, files) {
  const dir = path.join(tempDir(label), 'dist');
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

const SITE = {
  'index.html': '<!doctype html><html><body><script src="assets/app.js"></script></body></html>\n',
  'assets/app.js': 'console.log("cli contract");\n'
};

/** Run the CLI with an isolated state home so nothing touches the developer's machine. */
function runCli(args, options = {}) {
  const env = {
    ...process.env,
    VERIFIED_PUBLISH_HOME: options.stateHome || tempDir('state'),
    ...(options.env || {})
  };
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: options.timeoutMs || 20000, windowsHide: true });
}

/** Parse stdout and assert it is exactly one JSON document carrying the contract header. */
function jsonOf(result, command) {
  const stdout = result.stdout.trim();
  assert.ok(stdout.startsWith('{') && stdout.endsWith('}'), `stdout must be one JSON document, got: ${stdout.slice(0, 200)}`);
  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 1, 'every payload declares the contract version');
  if (command) assert.equal(payload.command, command);
  return payload;
}

test('help and --version describe the tool without touching anything', () => {
  const help = runCli(['help']);
  assert.equal(help.status, 0);
  for (const command of ['deploy', 'verify', 'doctor', 'claim', 'tunnel']) {
    assert.match(help.stdout, new RegExp(command), `help must mention ${command}`);
  }
  const version = runCli(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^vpublish \d+\.\d+\.\d+$/);
});

test('every JSON command emits exactly one document with the contract header', () => {
  const dir = writeArtifact('json', SITE);
  for (const [command, args] of [
    ['detect', ['detect', dir, '--json']],
    ['inspect', ['inspect', dir, '--json']],
    ['plan', ['plan', dir, '--mode', 'quick-share', '--json']],
    ['providers', ['providers', '--json']],
    ['doctor', ['doctor', dir, '--json']],
    ['claim', ['claim', 'list', '--json']],
    ['tunnel', ['tunnel', 'detect', '--json']]
  ]) {
    const result = runCli(args);
    assert.ok([0, 8].includes(result.status), `${command} exited ${result.status}: ${result.stderr}`);
    jsonOf(result, command);
  }
});

test('usage errors exit 2 and never print JSON on stdout', () => {
  const dir = writeArtifact('usage', SITE);
  for (const args of [['frobnicate'], ['inspect', dir, '--mode', 'nope'], ['inspect', dir, '--policy', 'nope'], ['plan', dir, '--region', 'mars']]) {
    const result = runCli(args);
    assert.equal(result.status, 2, `${args.join(' ')} should be a usage error, got ${result.status}`);
    assert.equal(result.stdout.trim(), '', 'a usage error must not write to stdout');
    assert.notEqual(result.stderr.trim(), '', 'a usage error must explain itself on stderr');
  }
});

test('the safety scan is observable from the outside through the exit code', () => {
  const clean = writeArtifact('clean', SITE);
  const blocked = writeArtifact('blocked', { ...SITE, '.env': 'SECRET_TOKEN=abc\n', 'grades.csv': 'name,grade\n' });

  assert.equal(runCli(['inspect', clean, '--json']).status, 0);
  const withSecret = runCli(['inspect', blocked, '--json']);
  assert.equal(withSecret.status, 4);
  const payload = jsonOf(withSecret, 'inspect');
  assert.ok(payload.blocked.some((entry) => entry.path === '.env'));
  assert.ok(!JSON.stringify(payload).includes('SECRET_TOKEN'), 'a blocked file\'s contents must never be echoed');

  // The teacher policy is the only way `grades.csv` blocks: without it the same artifact is clean.
  assert.equal(runCli(['inspect', blocked, '--policy', 'teacher', '--json']).status, 4);
});

test('missing artifacts, unusable registries and empty claim stores have their own codes', () => {
  const empty = tempDir('empty');
  assert.equal(runCli(['inspect', empty]).status, 3);

  const brokenRegistry = path.join(tempDir('broken'), 'providers.json');
  fs.writeFileSync(brokenRegistry, 'not json at all');
  const broken = runCli(['providers', '--json'], { env: { VERIFIED_PUBLISH_REGISTRY: brokenRegistry } });
  assert.equal(broken.status, 5);

  assert.equal(runCli(['claim', 'show', 'latest']).status, 9, 'an empty claim store is not an error, but it is a distinct outcome');
});

test('a registry with no eligible provider exits 6', () => {
  const dir = writeArtifact('noeligible', SITE);
  const shipped = JSON.parse(fs.readFileSync(SHIPPED_REGISTRY, 'utf8').replace(/^\uFEFF/, ''));
  const only = structuredClone(shipped.providers.find((provider) => provider.id === 'ship-page'));
  only.enabled = false;
  only.disabledReason = 'disabled by the test fixture';
  const file = path.join(tempDir('noregistry'), 'providers.json');
  fs.writeFileSync(file, JSON.stringify({ ...shipped, providers: [only] }, null, 2));

  const result = runCli(['plan', dir, '--mode', 'quick-share', '--json'], { env: { VERIFIED_PUBLISH_REGISTRY: file } });
  assert.equal(result.status, 6);
  const payload = jsonOf(result, 'plan');
  assert.equal(payload.plan.order.length, 0);
  assert.ok(payload.plan.disabled.some((entry) => entry.id === 'ship-page'));
});

test('dry-run deploys exit 0 and never claim success; an unusable provider exits 1', () => {
  const dir = writeArtifact('dryrun', SITE);
  const dry = runCli(['deploy', dir, '--mode', 'quick-share', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const payload = jsonOf(dry, 'deploy');
  assert.equal(payload.dryRun, true);
  assert.equal(payload.success, false, 'a dry run must never report a deployment');
  assert.ok(payload.order.length > 0, 'a dry run reports the order it would have used');

  const refused = runCli(['deploy', dir, '--dry-run', '--provider', 'wh-drop', '--json']);
  assert.equal(refused.status, 1);
  const refusedPayload = jsonOf(refused, 'deploy');
  assert.equal(refusedPayload.success, false);
  assert.match(refusedPayload.reason, /disabled|not eligible|unknown provider/i);
});

test('doctor reports the runtime contract, the registry schema and the provider table', () => {
  const dir = writeArtifact('doctor', SITE);
  const result = runCli(['doctor', dir, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result, 'doctor');
  assert.equal(payload.registry.capabilitySchema, 1);
  assert.equal(payload.providers.length, 11);
  assert.equal(payload.policy.active, 'generic');
  assert.equal(payload.region, 'auto');
  assert.ok(payload.artifact.dir.endsWith('dist'));
  assert.ok(Array.isArray(payload.envContract) && payload.envContract.length > 0);
});

test('the older environment variable spellings still work', () => {
  // A rename must not break a deployment that exports the previous names: they are read as
  // fallbacks, so a caller that only sets an old variable still gets a working, isolated state dir.
  const legacyState = tempDir('legacy-state');
  const result = runCli(['providers', '--json'], { env: { VERIFIED_PUBLISH_HOME: legacyState } });
  assert.equal(result.status, 0, result.stderr);
  const payload = jsonOf(result, 'providers');
  assert.equal(payload.ok, true);
  assert.equal(payload.providers.length, 11);

  // And the desktop product's original spelling keeps working too.
  const desktopState = tempDir('desktop-state');
  const desktop = runCli(['providers', '--json'], { env: { TEACHER_DSH_HOME: desktopState } });
  assert.equal(desktop.status, 0, desktop.stderr);
});
