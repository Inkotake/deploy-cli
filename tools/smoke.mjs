#!/usr/bin/env node
/**
 * Offline command-surface smoke test — NOT part of the CLI.
 *
 * It builds its own throwaway artifact, points the tool at a private state directory, and then
 * asserts the two things every caller depends on: `--json` puts exactly one parseable document on
 * stdout (all diagnostics on stderr), and the documented exit codes still hold. It never contacts a
 * provider, so it is safe in CI and on a train.
 *
 * Usage: node tools/smoke.mjs [artifact-dir]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'vpublish.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpublish-smoke-'));
const stateHome = path.join(tempRoot, 'state');

function makeArtifact() {
  const provided = process.argv[2];
  if (provided) return path.resolve(provided);
  const dir = path.join(tempRoot, 'dist');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><script src="assets/app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("smoke");\n');
  fs.writeFileSync(path.join(dir, 'assets', 'scene.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]));
  return dir;
}

const artifact = makeArtifact();
const blockedArtifact = path.join(tempRoot, 'blocked');
fs.mkdirSync(blockedArtifact, { recursive: true });
fs.writeFileSync(path.join(blockedArtifact, 'index.html'), '<!doctype html><html></html>\n');
fs.writeFileSync(path.join(blockedArtifact, '.env'), 'SMOKE_SECRET=1\n');
const emptyDir = path.join(tempRoot, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });

const cases = [
  { name: 'help', args: ['help'], expectExit: 0, json: false },
  { name: 'version', args: ['--version'], expectExit: 0, json: false },
  { name: 'detect', args: ['detect', artifact, '--json'], expectExit: 0, json: true, command: 'detect' },
  { name: 'inspect', args: ['inspect', artifact, '--json'], expectExit: 0, json: true, command: 'inspect' },
  { name: 'removed --policy flag', args: ['inspect', artifact, '--policy', 'teacher'], expectExit: 2, json: false, expectEmptyStdout: true },
  { name: 'inspect blocked', args: ['inspect', blockedArtifact, '--json'], expectExit: 4, json: true, command: 'inspect' },
  { name: 'plan quick-share', args: ['plan', artifact, '--mode', 'quick-share', '--json'], expectExit: 0, json: true, command: 'plan' },
  { name: 'plan persistent', args: ['plan', artifact, '--mode', 'persistent', '--json'], expectExit: [0, 6], json: true, command: 'plan' },
  { name: 'plan cn-mainland', args: ['plan', artifact, '--region', 'cn-mainland', '--json'], expectExit: 0, json: true, command: 'plan' },
  { name: 'deploy dry-run', args: ['deploy', artifact, '--mode', 'quick-share', '--auto', '--dry-run', '--json'], expectExit: 0, json: true, command: 'deploy' },
  { name: 'deploy refuses a unusable provider', args: ['deploy', artifact, '--dry-run', '--provider', 'wh-drop', '--json'], expectExit: 1, json: true, command: 'deploy' },
  { name: 'providers', args: ['providers', '--json'], expectExit: 0, json: true, command: 'providers' },
  { name: 'claim list', args: ['claim', 'list', '--json'], expectExit: 0, json: true, command: 'claim' },
  { name: 'claim show with nothing stored', args: ['claim', 'show', 'latest', '--json'], expectExit: 9, json: true, command: 'claim' },
  { name: 'doctor', args: ['doctor', artifact, '--json'], expectExit: 0, json: true, command: 'doctor' },
  { name: 'tunnel detect', args: ['tunnel', 'detect', '--json'], expectExit: [0, 8], json: true, command: 'tunnel' },
  { name: 'missing artifact', args: ['inspect', emptyDir], expectExit: 3, json: false, expectEmptyStdout: true },
  { name: 'bad mode', args: ['plan', artifact, '--mode', 'nope'], expectExit: 2, json: false, expectEmptyStdout: true },
  { name: 'bad region', args: ['plan', artifact, '--region', 'mars'], expectExit: 2, json: false, expectEmptyStdout: true },
  { name: 'unknown command', args: ['frobnicate'], expectExit: 2, json: false, expectEmptyStdout: true }
];

const failures = [];
for (const testCase of cases) {
  const result = spawnSync(process.execPath, [bin, ...testCase.args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, VERIFIED_PUBLISH_HOME: stateHome }
  });
  const expected = Array.isArray(testCase.expectExit) ? testCase.expectExit : [testCase.expectExit];
  const status = result.status === null ? 'killed' : result.status;
  if (!expected.includes(status)) failures.push(`${testCase.name}: exit ${status}, expected ${expected.join('|')}`);

  if (testCase.json) {
    const stdout = (result.stdout || '').trim();
    if (!stdout.startsWith('{') || !stdout.endsWith('}')) {
      failures.push(`${testCase.name}: stdout is not one JSON document (${stdout.slice(0, 120)})`);
    } else {
      try {
        const payload = JSON.parse(stdout);
        if (payload.schemaVersion === undefined) failures.push(`${testCase.name}: payload has no schemaVersion`);
        if (testCase.command && payload.command !== testCase.command) {
          failures.push(`${testCase.name}: command is "${payload.command}", expected "${testCase.command}"`);
        }
      } catch (cause) {
        failures.push(`${testCase.name}: stdout is not parseable JSON (${cause.message})`);
      }
    }
  } else if (testCase.expectEmptyStdout === true && (result.stdout || '').trim() !== '') {
    failures.push(`${testCase.name}: expected no stdout, got ${(result.stdout || '').slice(0, 120)}`);
  }
}

try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* a locked temp dir must not fail the smoke run */
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} smoke check(s) failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${cases.length} command smoke checks passed\n`);
