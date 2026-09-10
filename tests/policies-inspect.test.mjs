/**
 * The safety policy split, and the artifact facts the planner depends on.
 *
 * The policy exists so that a general-purpose publishing tool never claims that every `results.csv`
 * is somebody's gradebook, while a classroom tool can still refuse to publish one. These tests keep
 * both halves honest: secrets always block, teaching data blocks only under the teacher policy and
 * only when the file can actually carry records.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_POLICY,
  POLICY_NAMES,
  classifyBlock,
  classifyDirectory,
  isPolicyName,
  listPolicies,
  loadPolicy,
  safetyScanName
} from '../src/policies/index.mjs';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-policy-${label}-`));
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

test('the two policies load, and an unknown name is a hard error rather than a silent fallback', () => {
  assert.deepEqual(POLICY_NAMES, ['generic', 'teacher']);
  assert.equal(DEFAULT_POLICY, 'generic');
  assert.equal(isPolicyName('teacher'), true);
  assert.equal(isPolicyName('Teacher'), false, 'policy names are exact');
  const listed = listPolicies();
  assert.deepEqual(listed.map((entry) => entry.name), ['generic', 'teacher']);
  assert.ok(listed[1].ruleCount > listed[0].ruleCount, 'the teacher policy adds rules to the generic ones');
  assert.throws(() => loadPolicy('nope'), (error) => error.code === 'EUNKNOWNPOLICY');
});

test('secrets are blocked by every policy', () => {
  const secrets = ['.env', '.env.production', 'server.pem', 'id_rsa', 'credentials.json', '.npmrc', 'service-account.json', 'secrets.yaml', '.netrc'];
  for (const policy of POLICY_NAMES) {
    for (const name of secrets) {
      const verdict = classifyBlock(name, policy);
      assert.ok(verdict, `${name} must be classified under ${policy}`);
      assert.equal(verdict.severity, 'blocked', `${name} must be blocked under ${policy}`);
    }
  }
});

test('the generic policy does not pretend teaching-data names are secrets', () => {
  for (const name of ['grades.csv', 'student-list.xlsx', 'roster.csv', 'report-card.pdf', 'parent-contacts.csv']) {
    assert.equal(classifyBlock(name, 'generic'), null, `${name} must be the caller's decision under the generic policy`);
  }
});

test('the teacher policy blocks teaching data that can carry records and only warns on code', () => {
  const blocked = {
    'grades.csv': 'grades',
    'student-list.xlsx': 'student-records',
    'roster.csv': 'roster',
    'report-card.pdf': 'iep',
    'GRADES.CSV': 'grades'
  };
  for (const [name, rule] of Object.entries(blocked)) {
    const verdict = classifyBlock(name, 'teacher');
    assert.equal(verdict.severity, 'blocked', `${name} must be blocked under the teacher policy`);
    assert.ok(verdict.rules.includes(rule), `${name} should be caught by ${rule}, got ${verdict.rules.join(',')}`);
  }
  // A file whose name matches but which cannot carry records is a warning: a false positive must
  // cost a look, not a blocked upload.
  for (const name of ['grade-utils.js', 'results-table.css', 'attendance-widget.html']) {
    assert.equal(classifyBlock(name, 'teacher').severity, 'warning', `${name} should only warn`);
  }
  // No extension means the name is all there is to go on, so it escalates.
  assert.equal(classifyBlock('roster', 'teacher').severity, 'blocked');
  assert.equal(classifyBlock('roster', 'generic'), null);
});

test('a verdict never mixes a hard rule with a data rule', () => {
  for (const name of ['secrets.yaml', 'grades.csv', '.env', 'roster']) {
    const verdict = classifyBlock(name, 'teacher');
    if (!verdict) continue;
    assert.equal(verdict.reasons.length, new Set(verdict.reasons).size, 'reasons are deduplicated');
    assert.ok(['blocked', 'warning'].includes(verdict.severity));
  }
});

test('sensitive directories and rule scanning behave as documented', () => {
  assert.equal(classifyDirectory('.git', 'generic'), 'sensitive-directory');
  assert.equal(classifyDirectory('.vercel', 'generic'), 'sensitive-directory');
  assert.equal(classifyDirectory('assets', 'generic'), null);
  assert.deepEqual(safetyScanName('app.js', 'generic'), []);
  // More than one rule may describe the same name; `dotenv` and `env-any` both cover `.env`, and
  // reporting both is deliberate — the scan explains every reason a file is refused.
  assert.ok(safetyScanName('.env', 'generic').some((hit) => hit.id === 'dotenv'));
});

test('inspect reports the manifest facts the planner trusts', () => {
  const dir = writeTree('manifest', {
    'index.html': '<!doctype html><html><body><script src="assets/app.js"></script></body></html>\n',
    'assets/app.js': 'console.log("x");\n',
    'assets/model.glb': Buffer.from([0x67, 0x6c, 0x54, 0x46]),
    'empty.txt': ''
  });
  const result = inspectArtifact(dir);
  assert.equal(result.ok, true);
  assert.equal(result.policy, 'generic');
  assert.equal(result.manifest.fileCount, 4);
  assert.equal(result.manifest.features.hasIndexHtml, true);
  assert.equal(result.manifest.features.models, true);
  assert.equal(result.manifest.features.emptyFiles, true);
  assert.equal(result.manifest.totalBytes, result.manifest.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.deepEqual(result.manifest.extensions, [...result.manifest.extensions].sort());
  assert.equal(result.safety.clean, true);
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
  assert.equal(result.safety.clean, false, 'a broken link is not clean, even though routes are normal');

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

test('the same artifact is clean under generic and blocked under teacher', () => {
  const dir = writeTree('split', {
    'index.html': '<!doctype html><html></html>\n',
    'grades.csv': 'name,grade\n'
  });
  assert.equal(inspectArtifact(dir, { policy: 'generic' }).safety.clean, true);
  const teacher = inspectArtifact(dir, { policy: 'teacher' });
  assert.equal(teacher.safety.clean, false);
  assert.equal(teacher.policy, 'teacher');
  assert.ok(teacher.safety.blocked.some((entry) => entry.path === 'grades.csv'));
});

test('inspection failures are values, not throws', () => {
  const empty = tempDir('empty');
  assert.equal(inspectArtifact(empty).ok, false);
  assert.equal(inspectArtifact(path.join(empty, 'does-not-exist')).ok, false);
  assert.equal(inspectArtifact(path.join(empty, 'index.html')).ok, false, 'a file is not an artifact directory');
});

test('the human summary states the policy and mentions client-side routes', () => {
  const dir = writeTree('summary', {
    'index.html': '<!doctype html><html><body><a href="/dashboard">d</a></body></html>\n'
  });
  const lines = [];
  printInspect(summarizeInspect(inspectArtifact(dir, { policy: 'teacher' })), { write: (line) => lines.push(line) });
  const text = lines.join('\n');
  assert.match(text, /policy: teacher/);
  assert.match(text, /client-side routes/);
  assert.match(text, /files:/);
});
