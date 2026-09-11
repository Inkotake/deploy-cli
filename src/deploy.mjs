/**
 * Deployment orchestration: walk the plan, classify every failure, update the health cache, and
 * only report success once remote verification has passed.
 *
 * Success semantics: an HTTP 2xx from an upload is a *candidate* success. `deploy` reports
 * `success: true` only when `verify` compares the served bytes against the local manifest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, redact, statePath, trace, warn } from './common.mjs';
import * as identity from './identity.mjs';
import { claimForOutput, storeClaim } from './claims.mjs';
import { createSnapshot, verifySnapshot } from './snapshot.mjs';
import { BREAK_MS, loadHealth, recordFailure, recordSuccess, saveHealth } from './health.mjs';
import { getAdapter } from './providers/index.mjs';
import { ProviderError } from './providers/errors.mjs';
import { buildProjectContext, planProviders } from './planner.mjs';
import { describeVerification, verifyDeployment } from './verify.mjs';

export const DEFAULT_MODE = 'quick-share';
export const MODES = ['quick-share', 'persistent', 'tunnel'];

/** Map an artifact feature to the human reason it blocks a provider that cannot serve it. */
export function entryConstraints(manifest) {
  const problems = [];
  if (!manifest.byRelative.has('index.html')) {
    problems.push('the artifact has no index.html at its root, which every quick-share provider requires');
  }
  return problems;
}

export function buildArtifactSummary(manifest) {
  return {
    dir: manifest.dir,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    largest: manifest.largest,
    extensions: manifest.extensions,
    features: manifest.features
  };
}

/**
 * Ownership credentials are never printed by default. `claimForOutput` reports that a claim exists
 * and where it was stored, and only reveals the secret when the caller passes `--show-claim-secret`;
 * `redact` is the other half of the same policy, keeping credentials out of logs and error bodies.
 */
export function claimSummary(claim, options = {}) {
  return claimForOutput(claim, options);
}

/* ------------------------------------------------------------------- deploy ---- */

export async function deployArtifact(options) {
  const {
    manifest,
    registry,
    mode = DEFAULT_MODE,
    healthState,
    plan,
    dryRun = false,
    onlyProvider = null,
    env = process.env,
    verify: verifyEnabled = true,
    inspectSummary = null,
    revealClaim = false,
    keepSnapshot = false,
    verifyAll = false,
    forcePush = false,
    branch = null
  } = options;

  const blocked = inspectSummary ? inspectSummary.blocked : [];
  if (blocked.length) {
    return {
      success: false,
      artifactOk: false,
      reason: `the safety scan hard-blocked ${blocked.length} file(s); nothing was uploaded`,
      nextAction: 'remove or rename the blocked files, or move them outside the artifact directory, then run inspect again',
      blocked: blocked.map((item) => ({ path: item.path, reasons: item.reasons })),
      attempts: []
    };
  }
  const constraints = entryConstraints(manifest);
  if (constraints.length) {
    return {
      success: false,
      artifactOk: false,
      reason: constraints.join('; '),
      nextAction: 'build the artifact so that index.html sits at the root of the published directory',
      attempts: []
    };
  }

  let candidates = plan.eligible;
  if (onlyProvider) {
    candidates = candidates.filter((entry) => entry.id === onlyProvider);
    if (!candidates.length) {
      const provider = registry.providers.find((item) => item.id === onlyProvider);
      const excluded = plan.ineligible.find((item) => item.id === onlyProvider);
      const reason = !provider
        ? `unknown provider ${onlyProvider}`
        : provider.enabled !== true
          ? `provider ${onlyProvider} is disabled in the registry (${provider.disabledReason || 'no reason given'})`
          : excluded
            ? excluded.reason
            : `provider ${onlyProvider} is not eligible for ${mode} mode`;
      return {
        success: false,
        artifactOk: true,
        reason,
        nextAction: `run ${identity.COMMAND} plan --json to see the eligible providers, or drop --provider`,
        attempts: []
      };
    }
  }

  if (!candidates.length) {
    return {
      success: false,
      artifactOk: true,
      reason: `no enabled provider can serve this artifact in ${mode} mode`,
      nextAction: `run ${identity.COMMAND} plan --json to see why each provider was excluded`,
      attempts: [],
      plan: { ineligible: plan.ineligible, disabled: plan.disabled }
    };
  }

  if (dryRun) {
    return {
      success: false,
      dryRun: true,
      artifactOk: true,
      reason: 'dry run: no provider was contacted',
      nextAction: `run without --dry-run to deploy to ${candidates[0].id}`,
      attempts: candidates.map((entry) => ({ provider: entry.id, result: 'skipped', detail: 'dry run' })),
      order: candidates.map((entry) => entry.id)
    };
  }

  const attempts = [];
  let lastFailure = null;
  // Upload snapshots are cleaned as soon as the next candidate starts, and again on the way out, so
  // at most one snapshot exists at a time even when every provider fails.
  const snapshots = [];
  const releaseSnapshots = () => {
    for (const snapshot of snapshots.splice(0)) snapshot.cleanup();
  };

  for (const candidate of candidates) {
    releaseSnapshots();
    const provider = registry.providers.find((item) => item.id === candidate.id);
    if (!provider) continue;
    const adapter = getAdapter(provider);
    if (!adapter) {
      attempts.push({ provider: candidate.id, result: 'skipped', failureKind: 'capability', detail: 'no adapter is registered for this provider' });
      recordFailure(healthState, candidate.id, 'capability', 'no adapter registered');
      saveHealth(healthState, env);
      continue;
    }

    attempts.push({ provider: candidate.id, result: 'attempted' });
    const attempt = attempts[attempts.length - 1];

    if (verifyEnabled && !providerAllowedHostsSane(provider)) {
      attempt.result = 'failed';
      attempt.failureKind = 'capability';
      attempt.detail = 'the registry lists no allowed hosts for this provider, so a returned URL could not be trusted';
      recordFailure(healthState, candidate.id, 'capability', attempt.detail);
      saveHealth(healthState, env);
      lastFailure = { provider: candidate.id, kind: 'capability', message: attempt.detail };
      if (mode === 'persistent') break;
      continue;
    }

    // Anonymous adapters upload the very bytes that were hashed in this process, so they are already
    // snapshot-consistent. Providers driven through an external CLI or `git` re-read the directory
    // from disk, so they publish from an immutable copy instead: without it a rebuild between
    // inspection and upload would go live without ever being verified.
    let uploadManifest = manifest;
    if (provider.transport === 'cli' || provider.transport === 'git') {
      let snapshot;
      try {
        snapshot = await createSnapshot(manifest.dir, { keep: keepSnapshot, onWarn: (message) => trace(message) });
      } catch (cause) {
        attempt.result = 'failed';
        attempt.failureKind = 'capability';
        attempt.detail = `could not create an upload snapshot: ${cause.message}`;
        recordFailure(healthState, candidate.id, 'capability', attempt.detail);
        saveHealth(healthState, env);
        lastFailure = { provider: candidate.id, kind: 'capability', message: attempt.detail };
        continue;
      }
      snapshots.push(snapshot);
      const check = verifySnapshot(snapshot.dir, manifest);
      if (!check.ok) {
        attempt.result = 'failed';
        attempt.failureKind = 'integrity';
        attempt.detail = `the artifact changed on disk between inspection and upload (${check.mismatches.length} changed, `
          + `${check.missing.length} missing, ${check.extra.length} extra file(s)); nothing was uploaded`;
        recordFailure(healthState, candidate.id, 'integrity', attempt.detail, { breakMs: BREAK_MS.integrity });
        saveHealth(healthState, env);
        lastFailure = { provider: candidate.id, kind: 'integrity', message: attempt.detail };
        warn(`${candidate.id} skipped: ${attempt.detail}`);
        continue;
      }
      attempt.snapshot = { strategy: snapshot.strategy, fileCount: snapshot.fileCount, bytes: snapshot.bytes };
      uploadManifest = { ...manifest, dir: snapshot.dir, sourceDir: manifest.dir };
    }

    let deployment;
    try {
      deployment = await adapter.deploy({
        provider,
        manifest: uploadManifest,
        mode,
        env,
        context: { ...(options.context || {}), forcePush, branch: branch || (options.context && options.context.branch) || null }
      });
    } catch (cause) {
      const failure = normalizeFailure(candidate.id, cause);
      attempt.result = 'failed';
      attempt.failureKind = failure.kind;
      attempt.detail = redact(failure.message);
      attempt.status = failure.status ?? null;
      if (failure.retryAfterMs != null) attempt.retryAfterMs = failure.retryAfterMs;
      if (failure.nextHint) attempt.nextAction = failure.nextHint;
      recordFailure(healthState, candidate.id, failure.kind, redact(failure.message), { breakMs: breakerFor(failure) });
      saveHealth(healthState, env);
      lastFailure = { provider: candidate.id, kind: failure.kind, message: redact(failure.message), nextHint: failure.nextHint || null };
      warn(`${candidate.id} failed (${failure.kind}): ${failure.message}`);
      if (mode === 'persistent') {
        // A persistent request is never silently downgraded to an anonymous temporary host.
        attempt.result = 'failed';
        return failureResult({
          attempts,
          lastFailure,
          artifactOk: true,
          mode,
          reason: `${candidate.id} failed with a ${failure.kind} failure and persistent mode never falls back to a temporary host: ${failure.message}`
        });
      }
      continue;
    }

    let verification = null;
    if (verifyEnabled) {
      const providerHtmlPolicy = provider.capabilities.htmlExact === true ? 'strict' : 'presence-only';
      try {
        verification = await verifyDeployment({
          publicUrl: deployment.url,
          manifest,
          options: { ...(options.verifyOptions || {}), htmlPolicy: providerHtmlPolicy, full: verifyAll === true }
        });
      } catch (cause) {
        const failure = normalizeFailure(candidate.id, cause, 'verification');
        attempt.result = 'failed';
        attempt.failureKind = failure.kind;
        attempt.detail = `verification could not run: ${failure.message}`;
        recordFailure(healthState, candidate.id, failure.kind, failure.message, { breakMs: breakerFor(failure) });
        saveHealth(healthState, env);
        lastFailure = { provider: candidate.id, kind: failure.kind, message: failure.message };
        if (mode === 'persistent') {
          return failureResult({
            attempts,
            lastFailure,
            artifactOk: true,
            mode,
            reason: `${candidate.id} deployed but verification could not run; success is not reported without verification: ${failure.message}`
          });
        }
        continue;
      }
      if (!verification.passed) {
        // A remote hash mismatch means the deployment is failed, not merely unverified.
        const detail = describeVerification(verification);
        attempt.result = 'failed';
        attempt.failureKind = 'integrity';
        attempt.detail = detail;
        attempt.url = deployment.url;
        recordFailure(healthState, candidate.id, 'integrity', detail, { breakMs: BREAK_MS.integrity });
        saveHealth(healthState, env);
        lastFailure = { provider: candidate.id, kind: 'integrity', message: detail };
        warn(`${candidate.id} deployed to ${deployment.url} but verification failed: ${detail}`);
        if (mode === 'persistent') {
          return failureResult({
            attempts,
            lastFailure,
            artifactOk: true,
            mode,
            reason: `${candidate.id} accepted the upload but remote verification failed, so the deployment is treated as failed: ${detail}`
          });
        }
        continue;
      }
    }

    attempt.result = 'success';
    attempt.url = deployment.url;
    recordSuccess(healthState, candidate.id, deployment.url);
    saveHealth(healthState, env);

    // The ownership credential is written to the private state directory and reported without its
    // secret value unless the caller explicitly asked for it with --show-claim-secret.
    const stored = storeClaim(deployment.claim, { url: deployment.url, provider: candidate.id }, env);
    releaseSnapshots();

    return {
      success: true,
      provider: candidate.id,
      providerLabel: provider.label,
      mode,
      url: deployment.url,
      urlSource: deployment.providerDetail?.urlSource || 'provider-response',
      persistence: deployment.persistence || candidate.persistence || (mode === 'tunnel' ? 'session' : 'temporary'),
      expiresAt: deployment.expiresAt ?? null,
      expiresAtSource: deployment.expiresAtSource || (provider.capabilities?.ttl ? provider.capabilities.ttl.source : null),
      claim: stored ? claimForOutput(deployment.claim, { reveal: revealClaim, storedIn: stored.file }) : null,
      snapshot: attempt.snapshot || null,
      verification: verification
        ? {
            passed: true,
            method: verification.method,
            filesExpected: verification.filesExpected,
            filesRequired: verification.filesRequired ?? verification.filesExpected,
            filesVerified: verification.filesVerified,
            filesPresenceChecked: verification.filesPresenceChecked ?? 0,
            bytesVerified: verification.bytesVerified,
            browserVerified: verification.browserVerified,
            strategy: verification.strategy,
            htmlPolicy: verification.htmlPolicy,
            htmlExact: verification.htmlExact,
            htmlNotCompared: verification.htmlNotCompared,
            hashComplete: verification.hashComplete,
            rootStatus: verification.rootStatus,
            browserRepresentation: verification.browserRepresentation,
            note: verification.note
          }
        : { passed: false, method: 'skipped', filesExpected: manifest.fileCount, filesVerified: 0, bytesVerified: 0, browserVerified: false, note: 'verification was disabled with --no-verify; this is not a verified deployment' },
      attempts,
      artifact: buildArtifactSummary(manifest),
      providerDetail: deployment.providerDetail || null,
      healthFile: statePath('publish-provider-health.json', env)
    };
  }

  releaseSnapshots();
  return failureResult({ attempts, lastFailure, artifactOk: true, mode });
}

function failureResult({ attempts, lastFailure, artifactOk, mode, reason }) {
  const detail = reason
    || (lastFailure
      ? `every compatible provider failed; the last failure was ${lastFailure.provider} (${lastFailure.kind}): ${lastFailure.message}`
      : 'no provider was attempted');
  return {
    success: false,
    artifactOk,
    mode,
    // Which provider the caller should look at first: the last one that was actually tried.
    provider: lastFailure ? lastFailure.provider : null,
    reason: detail,
    attempts,
    nextAction: nextActionFor(lastFailure, mode)
  };
}

function nextActionFor(lastFailure, mode) {
  if (!lastFailure) return `run ${identity.COMMAND} plan --json to check provider eligibility`;
  if (lastFailure.nextHint) return lastFailure.nextHint;
  switch (lastFailure.kind) {
    case 'auth':
      return 'authenticate the provider (for example run the bundled netlify/vercel/wrangler CLI once) and retry';
    case 'rateLimited':
      return 'wait for the provider rate limit window, then retry; a circuit break was recorded so this provider is skipped until then';
    case 'dns':
      return 'check the network or DNS for the provider host; a long circuit break was recorded, or retry another provider';
    case 'capability':
      return mode === 'persistent'
        ? 'the artifact is outside this provider\'s documented limits; build a smaller artifact or pick another persistent provider'
        : 'build a smaller artifact or remove unsupported file types, then retry';
    case 'integrity':
      return 'the host did not serve the exact bytes that were uploaded; retry, and treat any URL from this attempt as unusable';
    case 'unreachable':
    case 'server':
      return 'retry later; a short circuit break was recorded for this provider';
    default:
      return `run ${identity.COMMAND} plan --json and ${identity.COMMAND} providers --json to inspect provider state`;
  }
}

function normalizeFailure(providerId, cause, phase) {
  if (cause instanceof ProviderError) return cause;
  const message = cause && cause.message ? cause.message : String(cause);
  return new ProviderError('unknown', `${providerId}${phase ? ` (${phase})` : ''}: ${message}`, { permanent: false });
}

function breakerFor(failure) {
  if (failure.kind === 'capability') return BREAK_MS.capability;
  if (failure.kind === 'auth') return BREAK_MS.auth;
  if (failure.retryAfterMs != null) return Math.max(failure.retryAfterMs, BREAK_MS.rateLimited);
  return undefined; // fall back to the per-kind default in health.mjs
}

function providerAllowedHostsSane(provider) {
  if (provider.transport === 'cli') return true;
  return Array.isArray(provider.allowedHosts) && provider.allowedHosts.length > 0;
}

/* -------------------------------------------------------------------- output ---- */

export function printDeployResult(result) {
  if (result.dryRun) {
    log('Dry run: no provider was contacted.');
    log(`  order: ${(result.order || []).join(' -> ')}`);
    if (result.nextAction) log(`  next:  ${result.nextAction}`);
    return;
  }
  if (result.success) {
    log('Deployment verified.');
    log(`  provider:  ${result.provider} (${result.persistence})`);
    log(`  url:       ${result.url}`);
    log(`  source:    ${result.urlSource}`);
    if (result.expiresAt) log(`  expires:   ${result.expiresAt}`);
    log(`  verified:  ${result.verification.filesVerified} of ${result.verification.filesRequired} required resources hash-matched by ${result.verification.method}`);
    if (result.verification.htmlExact === false) {
      log(`  html:      presence-checked only, not hash-verified (htmlPolicy=${result.verification.htmlPolicy}); ${result.verification.htmlNotCompared.map((item) => item.path).join(', ')}`);
    }
    if (result.claim) {
      log('');
      log('  NOT A SHARE LINK — ownership claim for this deployment (do not forward it):');
      if (result.claim.value) log(`    ${result.claim.kind}: ${result.claim.value}`);
      if (result.claim.claimUrl) log(`    claim url: ${result.claim.claimUrl}`);
      log(`    ${result.claim.warning}`);
    }
    return;
  }
  log('Deployment failed.');
  log(`  reason: ${result.reason}`);
  if (result.nextAction) log(`  next:   ${result.nextAction}`);
  for (const attempt of result.attempts) {
    log(`  ${attempt.provider}: ${attempt.result}${attempt.failureKind ? ` (${attempt.failureKind})` : ''}${attempt.detail ? ` - ${attempt.detail}` : ''}`);
  }
}

export function summarizeDeploy(result) {
  const base = {
    success: result.success === true,
    mode: result.mode,
    attempts: result.attempts
  };
  if (result.success) {
    return {
      ...base,
      provider: result.provider,
      url: result.url,
      urlSource: result.urlSource,
      persistence: result.persistence,
      expiresAt: result.expiresAt,
      expiresAtSource: result.expiresAtSource,
      claim: result.claim,
      snapshot: result.snapshot || null,
      verification: result.verification,
      artifact: result.artifact,
      providerDetail: result.providerDetail
    };
  }
  return {
    ...base,
    artifactOk: result.artifactOk === true,
    provider: result.provider ?? null,
    reason: result.reason,
    nextAction: result.nextAction,
    ...(result.blocked ? { blocked: result.blocked } : {}),
    ...(result.dryRun ? { dryRun: true, order: result.order || [] } : {})
  };
}

/* ------------------------------------------------------------------- tunnel ---- */

/**
 * Tunnel tools are a fallback, never a publishing path: nothing here is verified and the URL only
 * lives as long as the process. Two families are recognised — local listener binaries, and SSH
 * reverse tunnels that need only the `ssh` client most machines already have. The SSH family is
 * marked `experimental` because those free relays are third-party services with no availability or
 * correctness guarantee, which is why they are not preferred when a local listener exists.
 */
export const TUNNEL_TOOLS = [
  { id: 'cloudflared', binaries: ['cloudflared'], kind: 'binary', hint: 'cloudflared tunnel --url http://localhost:PORT' },
  { id: 'localtunnel', binaries: ['lt'], kind: 'binary', hint: 'lt --port PORT' },
  { id: 'ngrok', binaries: ['ngrok'], kind: 'binary', hint: 'ngrok http PORT' },
  { id: 'serveo', binaries: ['ssh'], kind: 'ssh', experimental: true, sshTarget: 'serveo.net', hint: 'ssh -R 80:localhost:PORT serveo.net' },
  { id: 'localhost-run', binaries: ['ssh'], kind: 'ssh', experimental: true, sshTarget: 'nokey@localhost.run', hint: 'ssh -R 80:localhost:PORT nokey@localhost.run' },
  { id: 'pinggy', binaries: ['ssh'], kind: 'ssh', experimental: true, sshTarget: 'a.pinggy.io', hint: 'ssh -R 0:localhost:PORT a.pinggy.io' }
];

export function detectTunnelTools(options = {}) {
  const { findBinary } = options;
  const lookup = (name) => (findBinary ? findBinary(name) : whichSync(name));
  const found = [];
  const missing = [];
  const hasSsh = Boolean(lookup('ssh'));
  for (const tool of TUNNEL_TOOLS) {
    const binary = tool.kind === 'ssh' ? (hasSsh ? lookup('ssh') : null) : tool.binaries.find((name) => lookup(name));
    if (binary) {
      found.push({ id: tool.id, binary, kind: tool.kind, experimental: tool.experimental === true, hint: tool.hint });
    } else {
      missing.push({
        id: tool.id,
        experimental: tool.experimental === true,
        hint: tool.hint,
        reason: tool.kind === 'ssh' ? 'the ssh client is not installed' : `no ${tool.binaries.join(' or ')} on PATH`
      });
    }
  }
  return { supported: found.length > 0, available: found, unavailable: missing };
}

function whichSync(name) {
  const pathValue = process.env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}
