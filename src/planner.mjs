/**
 * Mode- and capability-aware provider ranking.
 *
 * Ranking is never latency-based. A provider is first filtered on facts that are not negotiable:
 * mode, required file extensions, file count, per-file size, total size, and local breaker state.
 * Only the surviving providers are ordered, and every decision carries a `reason`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveBundledBin, runCapture } from './common.mjs';

/** Files and directories that prove a project already targets a persistent provider. */
export const PROVIDER_CONFIG_MARKERS = {
  netlify: ['netlify.toml', '.netlify', path.join('.netlify', 'state.json')],
  'cloudflare-pages': ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', '.wrangler'],
  vercel: ['vercel.json', '.vercel'],
  'github-pages': [path.join('.github', 'workflows')]
};

const EXTRA_MARKERS = [path.join('.github', 'workflows'), 'firebase.json'];

export function detectProjectConfig(root) {
  const found = {};
  for (const [providerId, markers] of Object.entries(PROVIDER_CONFIG_MARKERS)) {
    const hits = [];
    for (const marker of markers) {
      const full = path.join(root, marker);
      if (fs.existsSync(full)) hits.push(marker.split(path.sep).join('/'));
    }
    found[providerId] = hits;
  }
  const other = EXTRA_MARKERS.filter((marker) => fs.existsSync(path.join(root, marker))).map((marker) => marker.split(path.sep).join('/'));
  return { byProvider: found, other };
}

export function detectGitRemote(root) {
  const result = runCapture('git', ['remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 8000 });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return null;
}

/* --------------------------------------------------------- cli auth probe ---- */

const AUTH_PROBES = {
  netlify: { args: ['status', '--json'], parse: (result) => (result.status === 0 && /"accountName"|"email"|"account_id"|"accountId"/.test(result.stdout) ? 'authenticated' : null) },
  'cloudflare-pages': { args: ['whoami'], parse: (result) => (/You are logged in|associated with the email|Account Name/i.test(result.stdout + result.stderr) ? 'authenticated' : null) },
  vercel: { args: ['whoami'], parse: (result) => (result.status === 0 && /^[\s\S]*\S/.test(result.stdout) && !/Error|not logged in/i.test(result.stdout) ? 'authenticated' : null) }
};

let cachedProbes = null;

/**
 * Probe bundled CLIs for authentication. Probes are slow (a bundled CLI start-up is seconds), so
 * the result is cached per process and can be skipped entirely with `probe: false`.
 */
export function detectCliAuth(options = {}) {
  const env = options.env || process.env;
  if (options.probe === false) return {};
  if (cachedProbes) return cachedProbes;
  const out = {};
  for (const [providerId, probe] of Object.entries(AUTH_PROBES)) {
    const binary = resolveBundledBin(providerId === 'cloudflare-pages' ? 'wrangler' : providerId, env);
    let result;
    try {
      result = runCapture(binary, probe.args, { cwd: options.cwd || process.cwd(), timeoutMs: options.timeoutMs ?? 20000 });
    } catch (cause) {
      out[providerId] = { installed: false, authenticated: false, detail: cause.message };
      continue;
    }
    const text = `${result.stderr || ''}\n${result.stdout || ''}`;
    const missing = Boolean(result.error && (result.error.code === 'ENOENT' || result.error.code === 'EACCES'))
      || /is not recognized|command not found|no such file or directory/i.test(text);
    const verdict = missing ? null : probe.parse(result);
    out[providerId] = {
      installed: !missing,
      authenticated: verdict === 'authenticated',
      detail: missing
        ? 'the CLI is not installed (looked in the bundled deploy directory and on PATH)'
        : verdict ? 'the CLI reports an authenticated session' : 'the CLI has no authenticated session'
    };
  }
  out['github-pages'] = {
    installed: true,
    authenticated: false,
    detail: 'github-pages deploys through the git origin remote, which git already knows how to authenticate'
  };
  cachedProbes = out;
  return out;
}

export function resetCliAuthCache() {
  cachedProbes = null;
}

/* -------------------------------------------------------------- capability ---- */

/**
 * Required extensions are the real extension set of the artifact, restricted to those that are
 * structurally required (a provider that cannot serve a .glb cannot serve this artifact at all).
 */
export function requiredExtensions(manifest) {
  return manifest.extensions.filter((extension) => extension && extension !== '.');
}

export function checkCompatibility(provider, manifest) {
  const caps = provider.capabilities || {};
  const hardFailures = [];
  const limits = [];

  if (provider.enabled !== true) {
    hardFailures.push({
      kind: 'disabled',
      reason: provider.disabledReason ? `disabled in the registry (${provider.disabledReason})` : 'disabled in the registry'
    });
    return { compatible: false, hardFailures, limits };
  }

  if (!provider.modes.includes(manifest.mode)) {
    hardFailures.push({ kind: 'mode', reason: `does not serve ${manifest.mode} mode` });
  }

  const required = requiredExtensions(manifest);
  if (Array.isArray(caps.supportedExtensions)) {
    const allow = new Set(caps.supportedExtensions.map((extension) => extension.toLowerCase()));
    const unsupported = required.filter((extension) => !allow.has(extension));
    if (unsupported.length) {
      hardFailures.push({
        kind: 'extension',
        reason: `has a fixed extension allowlist and rejects ${unsupported.join(', ')}`,
        extensions: unsupported
      });
    }
  }
  if (Array.isArray(caps.denyExtensions) && caps.denyExtensions.length) {
    const denied = new Set(caps.denyExtensions.map((extension) => extension.toLowerCase()));
    const blockedExtensions = required.filter((extension) => denied.has(extension));
    if (blockedExtensions.length) {
      hardFailures.push({
        kind: 'extension',
        reason: `documents a blocklist that rejects ${blockedExtensions.join(', ')}`,
        extensions: blockedExtensions
      });
    }
  }
  if (caps.supportsModelFiles === false) {
    const models = required.filter((extension) => ['.glb', '.gltf', '.bin', '.wasm'].includes(extension));
    if (models.length) {
      hardFailures.push({
        kind: 'extension',
        reason: `treats model/binary assets as unsupported (${models.join(', ')})`,
        extensions: models
      });
    }
  }

  if (typeof caps.maxFiles === 'number' && manifest.fileCount > caps.maxFiles) {
    hardFailures.push({
      kind: 'file-count',
      reason: `accepts at most ${caps.maxFiles} files, artifact has ${manifest.fileCount}`,
      limit: caps.maxFiles,
      actual: manifest.fileCount
    });
  }

  if (typeof caps.maxFileBytes === 'number' && manifest.largest && manifest.largest.bytes > caps.maxFileBytes) {
    hardFailures.push({
      kind: 'file-size',
      reason: `accepts at most ${caps.maxFileBytes} bytes per file, largest is ${manifest.largest.path} at ${manifest.largest.bytes}`,
      limit: caps.maxFileBytes,
      actual: manifest.largest.bytes,
      path: manifest.largest.path
    });
  }

  if (typeof caps.maxTotalBytes === 'number') {
    if (manifest.totalBytes > caps.maxTotalBytes) {
      hardFailures.push({
        kind: 'total-size',
        reason: `accepts at most ${caps.maxTotalBytes} bytes in total, artifact is ${manifest.totalBytes}`,
        limit: caps.maxTotalBytes,
        actual: manifest.totalBytes
      });
    } else if (manifest.totalBytes > caps.maxTotalBytes * 0.9) {
      limits.push(`within 10% of the ${caps.maxTotalBytes} byte total limit`);
    }
  }

  // Layout limits are real rejections, not preferences: Dropley documents 5 directory levels and
  // 255-character paths, and a deeper artifact is refused by the service rather than uploaded badly.
  const features = manifest.features || {};
  if (typeof caps.maxDirectoryDepth === 'number' && typeof features.maxDirectoryDepth === 'number'
      && features.maxDirectoryDepth > caps.maxDirectoryDepth) {
    hardFailures.push({
      kind: 'file-layout',
      reason: `accepts at most ${caps.maxDirectoryDepth} directory levels, the artifact nests ${features.maxDirectoryDepth}`,
      limit: caps.maxDirectoryDepth,
      actual: features.maxDirectoryDepth
    });
  }
  if (typeof caps.maxPathLength === 'number' && typeof features.longestPathLength === 'number'
      && features.longestPathLength > caps.maxPathLength) {
    hardFailures.push({
      kind: 'file-layout',
      reason: `accepts at most ${caps.maxPathLength} characters per path, the longest is ${features.longestPathLength}`,
      limit: caps.maxPathLength,
      actual: features.longestPathLength
    });
  }

  return { compatible: hardFailures.length === 0, hardFailures, limits };
}

/* ------------------------------------------------------------------ ranking ---- */

/**
 * Persistent providers only rank first when the project shows provider configuration or the
 * bundled CLI already holds a session. Evidence, not preference.
 */
export function persistentEvidence(provider, context) {
  const markers = context.config.byProvider[provider.id] || [];
  if (markers.length) return { evidence: true, reason: `project already configures ${provider.label} (${markers.join(', ')})`, weight: 30 };
  if (provider.id === 'github-pages' && context.gitRemote) {
    return { evidence: true, reason: `git origin remote present (${context.gitRemote})`, weight: 30 };
  }
  const auth = context.cliAuth[provider.id];
  if (auth && auth.authenticated) {
    return { evidence: true, reason: `the ${provider.cli || provider.id} CLI is installed and holds an authenticated session`, weight: 20 };
  }
  if (auth && auth.installed === false) {
    return { evidence: false, reason: `no ${provider.label} configuration found and its CLI (${provider.cli || provider.id}) is not installed`, weight: 0 };
  }
  return { evidence: false, reason: `no ${provider.label} configuration found and the ${provider.cli || provider.id} CLI has no authenticated session`, weight: 0 };
}

export const REGIONS = ['auto', 'cn-mainland', 'global'];
export const DEFAULT_REGION = 'auto';

export function planProviders(options) {
  const { registry, manifest, mode, healthState, context } = options;
  const now = options.now ?? Date.now();
  const region = REGIONS.includes(options.region) ? options.region : DEFAULT_REGION;
  const modeManifest = { ...manifest, mode };

  const eligible = [];
  const ineligible = [];
  const disabled = [];

  for (const provider of registry.providers) {
    if (provider.enabled !== true) {
      disabled.push({
        id: provider.id,
        label: provider.label,
        enabled: false,
        disabledReason: provider.disabledReason || 'disabled',
        detail: provider.protocolNotes || null
      });
      continue;
    }
    if (provider.adapter === 'wh-drop') {
      disabled.push({
        id: provider.id,
        label: provider.label,
        enabled: false,
        disabledReason: 'no-public-service-found',
        detail: 'Never attempted.'
      });
      continue;
    }

    const compatibility = checkCompatibility(provider, modeManifest);
    const health = options.healthFor ? options.healthFor(provider.id) : { state: 'unknown', circuitOpen: false };

    if (health.circuitOpen) {
      ineligible.push({
        id: provider.id,
        label: provider.label,
        reason: `excluded: circuit breaker open until ${health.openUntil} after ${health.lastFailureKind} (${health.lastFailureMessage || 'no detail'})`,
        kind: 'circuit-open',
        health
      });
      continue;
    }

    if (!compatibility.compatible) {
      ineligible.push({
        id: provider.id,
        label: provider.label,
        reason: 'incompatible: ' + compatibility.hardFailures.map((failure) => failure.reason).join('; '),
        kind: 'incompatible',
        failures: compatibility.hardFailures,
        health
      });
      continue;
    }

    // A provider whose HTML the service rewrites can never pass strict SHA-256 verification, so it
    // is excluded unless the caller explicitly accepts that with --allow-inexact. Even then,
    // deploy still requires verification to pass; HTML is simply presence-checked instead.
    // Whether a host serves HTML byte-for-byte is a *capability*, not a verification setting: a host
    // that rewrites HTML can never satisfy the verification contract, so it is excluded unless the
    // caller explicitly accepts a presence-only check with --allow-inexact.
    const htmlPolicy = provider.capabilities.htmlExact === true ? 'strict' : 'presence-only';
    if (htmlPolicy === 'presence-only' && options.allowInexact !== true) {
      ineligible.push({
        id: provider.id,
        label: provider.label,
        reason: `excluded: the service rewrites served HTML, so the deployment can never pass strict byte verification${provider.verification && provider.verification.note ? ` (${provider.verification.note})` : ''}. Pass --allow-inexact to include it anyway; deploy still requires verification to pass.`,
        kind: 'html-rewritten',
        health
      });
      continue;
    }

    let score = provider.priority;
    let reason;
    let evidence = null;

    if (mode === 'persistent' || provider.persistent) {
      evidence = persistentEvidence(provider, context);
      score = (provider.persistentRank ?? provider.priority) + evidence.weight;
      reason = evidence.evidence
        ? `${evidence.reason}; persistent hosting is durable and rank ${score}`
        : `excluded from the primary order: ${evidence.reason}`;
      if (!evidence.evidence && mode === 'persistent') {
        ineligible.push({
          id: provider.id,
          label: provider.label,
          reason: `excluded: ${evidence.reason}, so a persistent deploy would create a new project or need an interactive login`,
          kind: 'no-evidence',
          health
        });
        continue;
      }
    } else if (mode === 'tunnel') {
      continue;
    } else {
      reason = `anonymous ${mode} provider, capability score ${score}`;
      if (htmlPolicy === 'presence-only') reason += '; included because --allow-inexact was given, but this service rewrites served HTML';
      else if (!provider.verification || provider.verification.resourcesByteExact == null) reason += '; byte fidelity is UNVERIFIED, so remote verification decides';
      if (compatibility.limits.length) reason += `; ${compatibility.limits.join('; ')}`;
    }

    eligible.push({
      id: provider.id,
      label: provider.label,
      adapter: provider.adapter,
      transport: provider.transport,
      endpoint: provider.endpoint,
      cli: provider.cli || null,
      priority: provider.priority,
      score,
      cnPriority: provider.cnPriority,
      persistence: provider.persistent ? 'persistent' : 'temporary',
      ttlSeconds: provider.capabilities.ttl ? provider.capabilities.ttl.defaultSeconds : null,
      claimable: provider.capabilities.claimable === true,
      htmlExact: provider.capabilities.htmlExact === true,
      reason,
      evidence: evidence ? evidence.reason : null,
      health,
      htmlPolicy,
      verificationNote: provider.verification ? provider.verification.note : null,
      claim: provider.claim || null
    });
  }

  // Deterministic order, and the only place `region` changes a decision:
  //   cn-mainland — a host that is reachable from mainland China outranks one that merely scores
  //                 higher, so the region priority is applied before the capability score;
  //   auto        — the region priority only breaks ties;
  //   global      — the region priority is ignored entirely.
  eligible.sort((a, b) => {
    if (region === 'cn-mainland' && b.cnPriority !== a.cnPriority) return b.cnPriority - a.cnPriority;
    return (b.score - a.score)
      || (region === 'auto' ? (b.cnPriority - a.cnPriority) : 0)
      || (b.priority - a.priority)
      || (a.id < b.id ? -1 : 1);
  });

  return { mode, region, eligible, ineligible, disabled, generatedAt: new Date(now).toISOString() };
}

/* ------------------------------------------------------------------ context ---- */

export function buildProjectContext(root, options = {}) {
  return {
    root,
    config: detectProjectConfig(root),
    gitRemote: options.gitRemote !== undefined ? options.gitRemote : detectGitRemote(root),
    cliAuth: detectCliAuth({ cwd: root, probe: options.probe, env: options.env })
  };
}

/* ------------------------------------------------------------------ output ---- */

export function summarizePlan(plan) {
  return {
    mode: plan.mode,
    region: plan.region || DEFAULT_REGION,
    generatedAt: plan.generatedAt,
    order: plan.eligible.map((entry, index) => ({
      rank: index + 1,
      id: entry.id,
      label: entry.label,
      persistence: entry.persistence,
      score: entry.score,
      htmlExact: entry.htmlExact === true,
      claimable: entry.claimable === true,
      ttlSeconds: entry.ttlSeconds ?? null,
      reason: entry.reason
    })),
    excluded: plan.ineligible,
    disabled: plan.disabled
  };
}

export function printPlan(plan, options = {}) {
  const write = options.write || ((line) => process.stdout.write(line + '\n'));
  write(`Publish plan (${plan.mode}, region ${plan.region || DEFAULT_REGION})`);
  if (!plan.eligible.length) write('  no provider can serve this artifact in this mode');
  for (const [index, entry] of plan.eligible.entries()) {
    write(`  ${index + 1}. ${entry.id} [${entry.persistence}] score=${entry.score}`);
    write(`     ${entry.reason}`);
  }
  if (plan.ineligible.length) {
    write('  excluded:');
    for (const entry of plan.ineligible) write(`    ${entry.id}: ${entry.reason}`);
  }
  if (plan.disabled.length) {
    write('  disabled:');
    for (const entry of plan.disabled) write(`    ${entry.id}: ${entry.disabledReason}`);
  }
  return plan;
}
