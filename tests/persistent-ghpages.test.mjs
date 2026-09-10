/**
 * GitHub Pages is the one persistent provider that writes to shared remote state: a branch that may
 * predate this tool and may hold a custom-domain `CNAME` or hand-maintained files. These tests drive
 * the real adapter against a local bare repository, so they prove the two properties that matter:
 *
 *   1. nothing outside the artifact is ever published, even on a brand-new branch; and
 *   2. a branch this tool does not own is refused, not overwritten.
 *
 * Everything runs offline against `file://`-style local remotes; nothing here touches github.com.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { deploy, parseGithubRemote, leaseArgs } from '../src/providers/persistent.mjs';
import { ProviderError } from '../src/providers/errors.mjs';
import * as identity from '../src/identity.mjs';

const GITHUB_REMOTE = 'https://github.com/owner/repo.git';
const CLEAN_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0'
};

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* a locked temp dir must not fail the suite */
    }
  }
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Fixture git calls carry their own identity: the machine's global config must not matter. */
const IDENTITY_ARGS = ['-c', 'user.name=verified-publish test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  const result = spawnSync('git', [...IDENTITY_ARGS, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: CLEAN_GIT_ENV });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function gitOk(args, cwd) {
  const result = git(args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Raw blob bytes: a CNAME must survive byte-for-byte, so it is never compared as decoded text. */
function gitBytes(args, cwd) {
  const result = spawnSync('git', [...IDENTITY_ARGS, ...args], { cwd, encoding: 'buffer', windowsHide: true, env: CLEAN_GIT_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${String(result.stderr)}`);
  return result.stdout;
}

/**
 * A working repository whose `origin` is a local bare repository, so pushes work offline, plus a
 * committed source tree that must NEVER appear in the published branch.
 */
function makeFixture(label) {
  const root = tempDir(label);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  gitOk(['init', '--bare', '--initial-branch=main', origin], root);
  gitOk(['init', '--initial-branch=main', work], root);
  gitOk(['config', 'core.autocrlf', 'false'], work);
  gitOk(['config', 'commit.gpgsign', 'false'], work);

  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"caller-project"}\n');
  fs.writeFileSync(path.join(work, 'src', 'main.js'), 'export const secret = "caller source";\n');
  gitOk(['add', '-A'], work);
  gitOk(['commit', '-m', 'initial project'], work);
  gitOk(['remote', 'add', 'origin', origin], work);
  gitOk(['push', '-u', 'origin', 'main'], work);

  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(path.join(artifact, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(artifact, 'index.html'), '<!doctype html><title>artifact</title>\n');
  fs.writeFileSync(path.join(artifact, 'assets', 'app.js'), 'console.log("artifact");\n');

  return {
    root,
    origin,
    work,
    artifact,
    manifest: { dir: artifact, fileCount: 2 },
    context: extra => ({ gitRemote: GITHUB_REMOTE, root: work, ...extra }),
    /** Files of a published branch, read from the remote itself so no local ref can go stale. */
    branchFiles: (branch) => {
      const listing = gitOk(['--git-dir', origin, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`], root);
      const names = listing ? listing.split('\n') : [];
      const out = new Map();
      for (const name of names) {
        out.set(name, gitBytes(['--git-dir', origin, 'show', `refs/heads/${branch}:${name}`], root));
      }
      return out;
    },
    remoteSha: (branch) => {
      const result = git(['--git-dir', origin, 'rev-parse', '--verify', `refs/heads/${branch}`], root);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    seedForeignBranch: (branch, message, files = {}) => {
      const scratch = tempDir(`${label}-scratch`);
      gitOk(['init', '--initial-branch=main', scratch], scratch);
      gitOk(['config', 'core.autocrlf', 'false'], scratch);
      for (const [name, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(scratch, name), contents);
      }
      fs.writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><title>someone else</title>\n');
      gitOk(['add', '-A'], scratch);
      gitOk(['commit', '-m', message], scratch);
      gitOk(['push', origin, `HEAD:refs/heads/${branch}`], scratch);
      gitOk(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], work);
      return gitOk(['rev-parse', 'refs/remotes/origin/' + branch], work);
    }
  };
}

const PROVIDER = { id: 'github-pages', label: 'GitHub Pages' };

test('a branch that does not exist yet is created with the artifact only', async () => {
  const fx = makeFixture('fresh');
  const result = await deploy({ provider: PROVIDER, manifest: fx.manifest, context: fx.context() });

  assert.equal(result.url, 'https://owner.github.io/repo/');
  assert.equal(result.transport, 'git');
  assert.equal(result.providerDetail.branch, 'gh-pages');

  const files = fx.branchFiles('gh-pages');
  assert.ok(files.has('index.html'), 'index.html must be published');
  assert.ok(files.has('assets/app.js'), 'assets must be published');
  assert.ok(files.has('.nojekyll'), '.nojekyll must be written or GitHub runs Jekyll');
  // The regression this test exists for: the staging worktree starts at the caller's HEAD, so a
  // missing index reset would publish the project's own sources to the public site.
  assert.ok(!files.has('package.json'), 'the caller project must never be published');
  assert.ok(!files.has('src/main.js'), 'the caller source tree must never be published');
  assert.equal(files.get('index.html').toString('utf8'), '<!doctype html><title>artifact</title>\n');
});

test('a foreign branch is refused and left byte-identical', async () => {
  const fx = makeFixture('foreign');
  const before = fx.seedForeignBranch('gh-pages', 'school website', { CNAME: 'school.example.edu\n' });

  await assert.rejects(
    () => deploy({ provider: PROVIDER, manifest: fx.manifest, context: fx.context() }),
    (error) => {
      assert.ok(error instanceof ProviderError, 'must be a typed provider failure');
      assert.equal(error.kind, 'capability');
      assert.match(error.message, /--force-push/, 'the refusal must say how to proceed');
      assert.match(error.message, /not owned by this tool/);
      return true;
    }
  );

  assert.equal(fx.remoteSha('gh-pages'), before, 'a refused deploy must not move the branch');
});

test('an explicit force-push overwrites a foreign branch and keeps its CNAME', async () => {
  const fx = makeFixture('force');
  fx.seedForeignBranch('gh-pages', 'school website', { CNAME: 'school.example.edu\n' });

  const result = await deploy({
    provider: PROVIDER,
    manifest: fx.manifest,
    context: fx.context({ forcePush: true })
  });

  assert.equal(result.providerDetail.overwroteForeignBranch, true);
  assert.deepEqual(result.providerDetail.preserved, ['CNAME'], 'only the files that actually existed are reported');
  const files = fx.branchFiles('gh-pages');
  assert.equal(files.get('CNAME').toString('utf8'), 'school.example.edu\n', 'the custom domain must survive');
  assert.ok(files.has('index.html'));
  assert.ok(!files.has('src/main.js'), 'the caller project must still never be published');
});

test('our own branch is updated and the new commit carries our markers', async () => {
  const fx = makeFixture('ours');
  const first = await deploy({ provider: PROVIDER, manifest: fx.manifest, context: fx.context() });
  assert.ok(first.url);

  fs.writeFileSync(path.join(fx.artifact, 'index.html'), '<!doctype html><title>artifact v2</title>\n');
  const second = await deploy({ provider: PROVIDER, manifest: fx.manifest, context: fx.context() });
  assert.ok(second.url);

  const subject = gitOk(['log', '-1', '--format=%s', 'refs/heads/gh-pages'], fx.origin);
  assert.equal(subject, identity.MARKERS.commitSubject);
  const body = gitOk(['log', '-1', '--format=%B', 'refs/heads/gh-pages'], fx.origin);
  assert.match(body, new RegExp(`X-Verified-Publish: ${identity.NAME}`));
  assert.equal(
    fx.branchFiles('gh-pages').get('index.html').toString('utf8'),
    '<!doctype html><title>artifact v2</title>\n',
    'the second deploy must replace the first'
  );
});

test('a non-default branch is created and explains itself', async () => {
  const fx = makeFixture('branch');
  const result = await deploy({
    provider: PROVIDER,
    manifest: fx.manifest,
    context: fx.context({ branch: 'pages-preview' })
  });

  assert.equal(result.providerDetail.branch, 'pages-preview');
  assert.match(result.providerDetail.urlNote, /pages-preview/);
  assert.ok(fx.branchFiles('pages-preview').has('index.html'));
  assert.equal(fx.remoteSha('gh-pages'), null, 'the default branch must stay untouched');
});

test('lease arguments: none for a new branch, a lease for ours, force only when asked', () => {
  assert.deepEqual(leaseArgs(false, false, null, 'gh-pages'), []);
  assert.deepEqual(leaseArgs(true, false, 'a'.repeat(40), 'gh-pages'), [
    `--force-with-lease=refs/heads/gh-pages:${'a'.repeat(40)}`
  ]);
  assert.deepEqual(leaseArgs(true, true, 'a'.repeat(40), 'gh-pages'), ['--force']);
});

test('parseGithubRemote understands the remote forms a project actually uses', () => {
  assert.deepEqual(parseGithubRemote('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubRemote('https://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubRemote('https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubRemote('ssh://git@github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubRemote('git://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.equal(parseGithubRemote('https://gitlab.com/o/r.git'), null);
  assert.equal(parseGithubRemote(''), null);
});

test('a project without a GitHub remote cannot deploy to Pages', async () => {
  const fx = makeFixture('noremote');
  await assert.rejects(
    () => deploy({ provider: PROVIDER, manifest: fx.manifest, context: { root: fx.work, gitRemote: 'https://gitlab.com/o/r.git' } }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'capability');
      assert.match(error.message, /not a recognisable GitHub URL/);
      return true;
    }
  );
});
