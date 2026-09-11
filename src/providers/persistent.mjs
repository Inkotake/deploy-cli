/**
 * Persistent providers, driven through CLIs the user already has: bundled beside a distribution
 * (see `resolveDeployBinRoot`) or found on `PATH`. Nothing is ever installed by this tool.
 *
 * A persistent deploy is durable and account-owned, which is exactly why a failure here must
 * never be silently downgraded to an anonymous temporary host: `deploy` stops and reports.
 * The URL is taken from the CLI output. For github-pages the deployed repository determines the
 * Pages URL, and that value is labelled as derived-from-the-remote rather than response-reported.
 *
 * The github-pages branch is shared state that may predate this tool, so it is inspected before it
 * is touched: an unowned branch is refused rather than wiped, a `CNAME` is carried over
 * byte-for-byte, and the push is leased to the revision that was actually read.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveBundledBin, runCapture, runCaptureAsync, trace } from '../common.mjs';
import * as identity from '../identity.mjs';
import { ProviderError } from './errors.mjs';

export const id = 'persistent';

const CLI_BINARIES = { netlify: 'netlify', 'cloudflare-pages': 'wrangler', vercel: 'vercel', 'github-pages': 'git' };
/** Every spawned child is bounded: a hung credential prompt must not wedge the deploy. */
const TIMEOUT_MS = 120000;
const DEFAULT_BRANCH = 'gh-pages';
/** Files a hand-maintained Pages branch relies on; everything else is the artifact's business. */
const PRESERVED_FILES = ['CNAME', '.nojekyll'];

export function cliAvailable(providerId, env = process.env) {
  const name = CLI_BINARIES[providerId];
  if (!name) return false;
  const binary = resolveBundledBin(name, env);
  if (binary === name) {
    // Not bundled: fall back to a version probe on PATH so the CLI can still be used.
    return runCapture(name, ['--version'], { timeoutMs: 15000 }).status === 0;
  }
  return true;
}

export async function deploy({ provider, manifest, context = {} }) {
  const adapters = {
    netlify: () => deployNetlify(manifest),
    'cloudflare-pages': () => deployCloudflarePages(manifest, context),
    vercel: () => deployVercel(manifest),
    'github-pages': () => deployGithubPages(manifest, context)
  };
  const adapter = adapters[provider.id];
  if (!adapter) throw new ProviderError('capability', `${id}: no persistent adapter for ${provider.id}`, { permanent: true });
  return adapter();
}

/* ------------------------------------------------------------------ netlify ---- */

async function deployNetlify(manifest) {
  const binary = resolveBundledBin('netlify');
  const args = ['deploy', '--dir', manifest.dir, '--prod', '--json', '--message', identity.MARKERS.netlifyMessage];
  trace(`netlify: running ${path.basename(binary)} deploy --prod`);
  const result = await runCaptureAsync(binary, args, { cwd: path.dirname(manifest.dir), timeoutMs: 15 * 60 * 1000 });

  if (result.status !== 0) throw cliFailure('netlify', result);
  const payload = tryParseJson(result.stdout);
  const url = payload && (payload.url || payload.deploy_url || payload.ssl_url);
  if (!url) {
    throw new ProviderError('server', `netlify: the CLI exited successfully but printed no deploy URL. Output: ${truncate(result.stdout)}`, { permanent: false });
  }
  return resultOf(manifest, String(url), 'cli', {
    deployId: payload.deploy_id ?? null,
    siteId: payload.site_id ?? null,
    adminUrl: payload.admin_url ?? null,
    urlSource: 'cli-output'
  });
}

/* --------------------------------------------------------- cloudflare-pages ---- */

async function deployCloudflarePages(manifest, context) {
  const binary = resolveBundledBin('wrangler');
  const projectName = context.projectName || path.basename(path.dirname(manifest.dir)) || 'teacher-artifact';
  const args = ['pages', 'deploy', manifest.dir, '--project-name', projectName, '--commit-dirty=true'];
  trace(`cloudflare-pages: running wrangler pages deploy --project-name ${projectName}`);
  const result = await runCaptureAsync(binary, args, { cwd: path.dirname(manifest.dir), timeoutMs: 15 * 60 * 1000 });

  if (result.status !== 0) throw cliFailure('cloudflare-pages', result);
  const output = combined(result);
  const url = firstUrl(output, (candidate) => candidate.hostname.endsWith('.pages.dev'))
    || firstUrl(output, (candidate) => candidate.hostname.endsWith('.workers.dev'));
  if (!url) {
    throw new ProviderError('server', `cloudflare-pages: wrangler exited successfully but no *.pages.dev URL was printed. Output: ${truncate(output)}`, { permanent: false });
  }
  return resultOf(manifest, url, 'cli', { projectName, urlSource: 'cli-output' });
}

/* ------------------------------------------------------------------- vercel ---- */

async function deployVercel(manifest) {
  const binary = resolveBundledBin('vercel');
  const args = ['deploy', manifest.dir, '--prod', '--yes'];
  trace('vercel: running vercel deploy --prod');
  const result = await runCaptureAsync(binary, args, { cwd: path.dirname(manifest.dir), timeoutMs: 15 * 60 * 1000 });

  if (result.status !== 0) throw cliFailure('vercel', result);
  const url = firstUrl(combined(result), (candidate) => candidate.hostname.endsWith('.vercel.app') || candidate.hostname.endsWith('.now.sh'));
  if (!url) {
    throw new ProviderError('server', `vercel: the CLI exited successfully but no deployment URL was printed. Output: ${truncate(combined(result))}`, { permanent: false });
  }
  return resultOf(manifest, url, 'cli', { urlSource: 'cli-output' });
}

/* ------------------------------------------------------------- github-pages ---- */

async function deployGithubPages(manifest, context) {
  const cwd = context.root || process.cwd();
  const git = resolveBundledBin('git');
  const remote = context.gitRemote || await originUrl(git, cwd);
  if (!remote) {
    throw new ProviderError('capability', 'github-pages: the project has no git origin remote, so there is nowhere to publish', { permanent: true });
  }
  const slug = parseGithubRemote(remote);
  if (!slug) {
    throw new ProviderError('capability', `github-pages: the origin remote (${remote}) is not a recognisable GitHub URL`, { permanent: true });
  }

  const branch = context.branch || DEFAULT_BRANCH;
  const ref = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  // The staging worktree lives in the OS temp directory: inside the project it could be swept into
  // the very artifact it publishes, and a fixed name lets two concurrent runs fight over it.
  const staging = path.join(os.tmpdir(), `${identity.MARKERS.ghPagesStagingPrefix}-${crypto.randomBytes(6).toString('hex')}`);
  // Two explicit runners instead of one cwd-defaulting helper. A staging command that silently ran
  // in the caller's project would delete the user's own files (`git clean -fdx`, `git rm`), and a
  // project command that ran in the staging worktree would read the wrong repository.
  const inProject = (label, args, options) => runStep(label, git, args, cwd, options);
  const inStaging = (label, args, options) => runStep(label, git, args, staging, options);

  // Tolerant fetch: an absent branch (or any fetch failure) means "create it", never "abort".
  await inProject('fetch', ['fetch', 'origin', `+${ref}:${remoteRef}`], { allowFailure: true });
  const probe = await inProject('rev-parse', ['rev-parse', '--verify', remoteRef], { allowFailure: true });
  const remoteSha = String(probe.stdout || '').trim();
  const exists = /^[0-9a-f]{40,64}$/i.test(remoteSha);

  let foreign = false;
  if (exists) {
    foreign = !isOurs((await inProject('log', ['log', '-1', '--format=%B', remoteSha])).stdout);
    if (foreign && context.forcePush !== true) {
      throw new ProviderError('capability',
        `github-pages: the remote branch "${branch}" is not owned by this tool, so forcing it would destroy content `
        + 'this deployment did not create (a custom-domain CNAME, hand-maintained files, another team\'s site). '
        + 'Three ways forward: re-run with --force-push to overwrite it anyway; publish to a different branch '
        + `(set context.branch, for example "pages-preview" instead of "${branch}"); or publish through a GitHub `
        + 'Actions Pages workflow, where a normal push to your default branch performs the deployment.',
        { permanent: true, detail: 'foreign-branch' });
    }
  }

  // Read what must survive before anything in the branch is replaced.
  const carry = {};
  for (const name of PRESERVED_FILES) {
    const bytes = await readRemoteFile(inProject, remoteSha, name);
    if (bytes !== null) carry[name] = bytes;
  }
  const preserved = Object.keys(carry);

  let added = false;
  try {
    // A detached worktree keeps this branch out of the caller's local branch namespace, so a stale
    // local branch (or one checked out in another worktree) cannot block or be clobbered by a run.
    await inProject('worktree', ['worktree', 'add', '--force', '--detach', staging]);
    added = true;
    // Ignore patterns (node_modules, *.log) must not leak the project into the published branch.
    await inStaging('clean', ['clean', '-d', '-f', '-x']);
    let parent = null;
    if (exists) {
      await inStaging('checkout', ['checkout', '--detach', remoteSha]);
      parent = remoteSha;
    }
    // Empty the index in BOTH cases. On a branch that does not exist yet the worktree was
    // materialised from the caller's HEAD, so without this the project's own sources would be
    // committed into the Pages branch and published next to the artifact.
    await inStaging('rm', ['rm', '-r', '--quiet', '--ignore-unmatch', '--', '.'], { allowFailure: true });
    fs.cpSync(manifest.dir, staging, { recursive: true, force: true });
    for (const [name, bytes] of Object.entries(carry)) fs.writeFileSync(path.join(staging, name), bytes);
    // Pages must not run Jekyll over the artifact (it would drop files whose names start with `_`).
    fs.writeFileSync(path.join(staging, '.nojekyll'), '');
    // `-c core.autocrlf=false` keeps the staged blobs byte-identical to the artifact on Windows.
    // A committed `.gitattributes` would achieve the same, but it would itself be published.
    await inStaging('add', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'add', '-A']);
    const tree = (await inStaging('write-tree', ['-c', 'core.autocrlf=false', 'write-tree'])).stdout.trim();
    const commitArgs = ['commit-tree', tree];
    if (parent) commitArgs.push('-p', parent);
    commitArgs.push('-m', identity.MARKERS.commitSubject, '-m', `${identity.MARKERS.trailer}: ${identity.NAME}`, '-m', identity.MARKERS.producedBy);
    // Push the commit that was actually created. The worktree HEAD stays detached at the previous
    // revision, so `HEAD:<branch>` would push the old tree instead.
    const created = (await inStaging('commit-tree', commitArgs, { env: commitEnv() })).stdout.trim();
    await inProject('update-ref', ['update-ref', ref, created]);
    await inStaging('push', ['push', 'origin', `${created}:${ref}`, ...leaseArgs(exists, foreign, remoteSha, branch)]);

    const detail = {
      urlSource: 'derived-from-git-remote',
      branch,
      owner: slug.owner,
      repo: slug.repo,
      preserved,
      note: 'The published URL comes from the GitHub repository itself; the deployment appears only after GitHub Pages finishes building, so immediate remote verification can legitimately fail.'
    };
    if (foreign) detail.overwroteForeignBranch = true;
    if (branch !== DEFAULT_BRANCH) {
      detail.urlNote = `Branch "${branch}" is not the default Pages branch: this URL only serves the artifact once the repository's GitHub Pages settings publish from "${branch}".`;
    }
    return resultOf(manifest, `https://${slug.owner}.github.io/${slug.repo}/`, 'git', detail);
  } finally {
    if (added) await runCaptureAsync(git, ['worktree', 'remove', '--force', staging], { cwd, timeoutMs: TIMEOUT_MS });
    // Git refuses to remove a worktree holding ignored/untracked leftovers, so the directory goes.
    try {
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Best effort: a temp directory that refuses to vanish must not fail an otherwise good deploy. */
    }
  }
}

/** `--force-with-lease` pins the push to the revision that was read, closing the fetch/push race. */
export function leaseArgs(exists, foreign, remoteSha, branch) {
  if (!exists) return []; // A brand-new branch needs no force at all.
  if (foreign) return ['--force']; // Only reachable when the caller explicitly asked with forcePush.
  return [`--force-with-lease=refs/heads/${branch}:${remoteSha}`];
}

/**
 * The branch is ours when the previous deploy wrote our subject or our trailer. Anything else —
 * including unrelated history that merely shares the branch name — belongs to someone else.
 */
function isOurs(message) {
  const lines = String(message || '').split(/\r?\n/);
  if (lines[0] && lines[0].trim().startsWith(identity.MARKERS.commitSubject)) return true;
  // The current trailer wins, but the earlier spelling stays recognised: refusing a branch this
  // tool published before the rename would be a false accusation of foreign ownership.
  const trailers = [identity.MARKERS.trailer, ...identity.MARKERS.legacyTrailers];
  return trailers.some((trailer) => new RegExp(`^${trailer}:\\s*\\S+\\s*$`, 'im').test(String(message || '')));
}

/** Author identity is supplied explicitly so a headless (or unconfigured) git can still commit. */
function commitEnv() {
  const stamp = `${Math.floor(Date.now() / 1000)} +0000`;
  const who = { GIT_AUTHOR_NAME: identity.COMMAND, GIT_COMMITTER_NAME: identity.COMMAND, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  const mail = `${identity.COMMAND}@localhost`;
  return { ...who, GIT_AUTHOR_EMAIL: mail, GIT_COMMITTER_EMAIL: mail };
}

/**
 * Exact bytes of `file` at `sha`, or null when the file (or the revision) does not exist.
 *
 * The shared capture helper decodes stdout as UTF-8, which would mangle a `CNAME` that is not
 * valid UTF-8, so this one call keeps git's raw stdout instead of going through that decode.
 */
async function readRemoteFile(run, sha, file) {
  if (!sha) return null;
  const result = await run('show', ['show', `${sha}:${file}`], { allowFailure: true, rawStdout: true });
  return result.status === 0 ? result.stdout : null;
}

async function originUrl(git, cwd) {
  const result = await runCaptureAsync(git, ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 15000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Spawn git with a timeout; `rawStdout` keeps bytes exact where a decode would corrupt them. */
function runGitRaw(binary, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, TIMEOUT_MS);
    const finish = (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    };
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', () => finish(1));
  });
}

async function runStep(label, binary, args, cwd, options = {}) {
  trace(`github-pages: ${label} ${args[0]}`);
  if (options.rawStdout) return runGitRaw(binary, args, cwd);
  const result = await runCaptureAsync(binary, args, { cwd, timeoutMs: TIMEOUT_MS, env: options.env });
  if (result.status !== 0 && !options.allowFailure) throw cliFailure('github-pages', result, label);
  return result;
}

export function parseGithubRemote(remote) {
  if (!remote) return null;
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i,
    /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
    /^git:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i
  ];
  for (const pattern of patterns) {
    const match = remote.match(pattern);
    if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
  }
  return null;
}

/* ------------------------------------------------------------------ helpers ---- */

/** Stable result envelope shared by every persistent transport. */
function resultOf(manifest, url, transport, providerDetail) {
  return { url, persistence: 'persistent', expiresAt: null, claim: null, fileCount: manifest.fileCount, providerDetail, transport };
}

function combined(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the last balanced object */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function firstUrl(text, predicate) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  for (const candidate of matches) {
    try {
      const parsed = new URL(candidate);
      if (predicate(parsed)) return parsed.origin + (parsed.pathname === '/' ? '/' : parsed.pathname);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Arguments reach the spawned process as an argv array and never through a shell (a Windows
 * `.cmd` shim is resolved to its entry script first), so a path containing spaces is safe.
 */
function cliFailure(providerId, result, label) {
  const message = truncate(combined(result).trim(), 600);
  const startup = /is not recognized|command not found|no such file/i.test(message);
  if ((result.error && (result.error.code === 'ENOENT' || result.error.code === 'EACCES')) || startup) {
    return new ProviderError('capability', `${providerId}: the CLI could not be started (${label || 'deploy'}), which is a local installation problem, not a service outage. ${message}`, { detail: (result.error && result.error.code) || 'ENOENT', permanent: true });
  }
  if (/not logged in|authentication|unauthorized|401|403|no token|must be logged|access token/i.test(message)) {
    return new ProviderError('auth', `${providerId}: the CLI is not authenticated. ${message}`, { status: 401 });
  }
  if (/could not parse configuration|invalid toml|invalid json|configuration file|no such directory|does not exist|not a directory|enoent/i.test(message)) {
    // A local configuration problem is not a service outage; do not count it against the host.
    return new ProviderError('capability', `${providerId}: local configuration problem. ${message}`, { permanent: true });
  }
  if (/enotfound|getaddrinfo|eai_again|etimedout|econnreset|network error|socket hang up/i.test(message)) {
    return new ProviderError('unreachable', `${providerId}: network failure from the CLI. ${message}`, { detail: 'network' });
  }
  if (/too many files|exceeds|invalid argument|unsupported|not supported|file too large|payload too large/i.test(message)) {
    return new ProviderError('capability', `${providerId}: the service rejected the artifact. ${message}`, { permanent: true });
  }
  return new ProviderError('server', `${providerId}: the CLI exited with status ${result.status}. ${message}`, { permanent: false });
}

function truncate(text, limit = 400) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + '...' : value;
}
