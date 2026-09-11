/**
 * The safety scan, and the artifact facts the planner depends on.
 *
 * Two properties are load-bearing here. First, secrets are blocked in every situation: the scan is
 * fixed, not configurable, because a credential is unsafe to publish no matter who is asking.
 * Second, the core stays *generic*: it must not judge project-specific data. A classroom product may
 * refuse `grades.csv`, but that decision belongs to that product — `inspect --json` gives it every
 * path, size and hash it needs, so it can apply its own rules before it calls `deploy`
 * (see docs/consuming.md). An upstream that guesses is wrong for everyone else.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RULES, SENSITIVE_DIRECTORIES, classifyBlock, classifyDirectory, safetyScanName } from '../src/safety.mjs';
import { inspectArtifact, printInspect, summarizeInspect } from '../src/inspect.mjs';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-safety-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeTree(label, files) {
  const root = path.join(tempDir(label), 'dist');
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

test('every credential rule blocks, and nothing else does', () => {
  const secrets = ['.env', '.env.production', 'server.pem', 'private.key', 'bundle.p12', 'id_rsa', 'id_ed25519',
    'credentials.json', '.netrc', '.npmrc', '.htpasswd', 'secrets.yaml', 'service-account.json', 'vercel-token.json'];
  for (const name of secrets) {
    const verdict = classifyBlock(name);
    assert.ok(verdict, `${name} must be classified`);
    assert.equal(verdict.severity, 'blocked', `${name} must be blocked`);
    assert.ok(verdict.reasons.length > 0, 'a block must explain itself');
  }
  for (const name of ['index.html', 'assets/app.js', 'data.csv', 'report.pdf', 'README.md']) {
    assert.equal(classifyBlock(name), null, `${name} must not be classified`);
  }
});

test('the core does not judge project-specific data', () => {
  // These names are what a *downstream* product may choose to refuse. Shipping that judgment here
  // would make this tool wrong for everyone else, so the assertion is that the core stays silent.
  const someoneElsesData = ['grades.csv', 'student-archive.xlsx', 'roster.csv', 'attendance.csv',
    'parent-contacts.pdf', 'report-card.docx', 'student-list.json', 'roster'];
  for (const name of someoneElsesData) {
    assert.equal(classifyBlock(name), null, `${name} is the caller's decision, not the core's`);
  }
});

test('rule scanning reports ids without deciding anything', () => {
  assert.deepEqual(safetyScanName('app.js'), []);
  // More than one rule may describe the same name; reporting both explains the refusal fully.
  assert.ok(safetyScanName('.env').some((hit) => hit.id === 'dotenv'));
  assert.ok(safetyScanName('service-account.json').some((hit) => hit.id === 'service-account'));
  assert.ok(RULES.length >= 15, 'the shipped rule set is the reviewed one');
});

test('sensitive directories are blocked, ordinary ones are not', () => {
  for (const dir of SENSITIVE_DIRECTORIES) {
    assert.equal(classifyDirectory(dir), 'sensitive-directory', `${dir} must be blocked`);
  }
  assert.equal(classifyDirectory('assets'), null);
  assert.equal(classifyDirectory('src/components'), null);
});

test('inspect reports the manifest facts the planner trusts', () => {
  const dir = writeTree('manifest', {
    'index.html': '<!doctype html><html><body><script src="assets/app.js"></script></body></html>\n',
    'assets/app.js': 'console.log("x");\n',
    'assets/model.glb': Buffer.from([0x67, 0x6c, 0x54, 0x46]),
    'deep/a/b/c/d/file.txt': 'nested\n',
    'empty.txt': ''
  });
  const result = inspectArtifact(dir);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.fileCount, 5);
  assert.equal(result.manifest.features.hasIndexHtml, true);
  assert.equal(result.manifest.features.models, true);
  assert.equal(result.manifest.features.emptyFiles, true);
  assert.equal(result.manifest.totalBytes, result.manifest.files.reduce((sum, file) => sum + file.bytes, 0));
  // Documented layout limits need these two numbers, so the inspector measures them.
  // `deep/a/b/c/d/file.txt` sits under five directories.
  assert.equal(result.manifest.features.maxDirectoryDepth, 5);
  assert.ok(result.manifest.features.longestPathLength >= 'deep/a/b/c/d/file.txt'.length);
  assert.equal(result.safety.clean, true);
  assert.deepEqual(result.safety.warnings, [], 'the built-in scan currently only blocks');
});

test('client-side routes are distinguished from broken links', () => {
  const dir = writeTree('routes', {
    'index.html': '<!doctype html><html><body><a href="/dashboard">d</a><a href="./about/">a</a><script src="missing.js"></script></body></html>\n'
  });
  const result = inspectArtifact(dir);
  assert.equal(result.safety.routes.length, 2, 'extensionless and directory references are routes');
  assert.equal(result.safety.missingReferences.length, 1, 'a reference with an extension that does not exist is a broken link');
  assert.equal(result.safety.missingReferences[0].resolved, 'missing.js');
  assert.equal(result.manifest.features.spaRouting, true);
  assert.equal(result.safety.clean, false);

  const flat = inspectArtifact(writeTree('flat', { 'index.html': '<!doctype html><html></html>\n' }));
  assert.equal(flat.manifest.features.spaRouting, false);
});

test('a blocked artifact never echoes the blocked content', () => {
  const dir = writeTree('blocked', {
    'index.html': '<!doctype html><html></html>\n',
    '.env': 'SUPER_SECRET_VALUE=1\n',
    '.git/config': '[core]\n'
  });
  const result = inspectArtifact(dir);
  assert.equal(result.safety.clean, false);
  assert.ok(result.safety.blocked.some((entry) => entry.path === '.env'));
  assert.ok(result.safety.blocked.some((entry) => entry.path.endsWith('.git/') && entry.rules.includes('sensitive-directory')));
  assert.ok(!JSON.stringify(result).includes('SUPER_SECRET_VALUE'), 'the scan reports locations and rules, never contents');
});

test('inspection failures are values, not throws', () => {
  const empty = tempDir('empty');
  assert.equal(inspectArtifact(empty).ok, false);
  assert.equal(inspectArtifact(path.join(empty, 'does-not-exist')).ok, false);
  assert.equal(inspectArtifact(path.join(empty, 'index.html')).ok, false, 'a file is not an artifact directory');
});

test('the human summary reports files, routes and the scan', () => {
  const dir = writeTree('summary', {
    'index.html': '<!doctype html><html><body><a href="/dashboard">d</a></body></html>\n'
  });
  const lines = [];
  printInspect(summarizeInspect(inspectArtifact(dir)), { write: (line) => lines.push(line) });
  const text = lines.join('\n');
  assert.match(text, /files:/);
  assert.match(text, /client-side routes/);
  assert.match(text, /safety scan: no hard-blocked files/);
  assert.doesNotMatch(text, /policy/, 'the core has no policy concept to report');
});
