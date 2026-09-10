/**
 * Provider registry: a builtin data file plus an optional local availability overlay.
 *
 * `config/providers.json` is authoritative for identity and protocol: `adapter`, `endpoint`,
 * `allowedHosts`, `protocol`, `modes` and `capabilities`. It declares `capabilitySchema`, and a file
 * that declares a version this build does not understand is refused rather than misread — the same
 * policy the health cache uses, because a silently misread provider table is worse than no table.
 *
 * The overlay may only change presentation and availability fields (`enabled`, `priority`,
 * `health`, `lastValidated`, `notes`). Any attempt to move an endpoint, swap an adapter or change a
 * protocol is refused and reported instead of being silently ignored. The overlay is read from disk
 * and never fetched: there is no network call in the registry path, and it is NOT signed yet — the
 * protection today is the field allowlist, so treat a writable overlay as a local trust decision.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as identity from './identity.mjs';
import { CLI_ROOT, PACKAGE_ROOT, readJsonFile, statePath } from './common.mjs';

/** Fields the overlay is permitted to touch. */
export const OVERLAY_MUTABLE_FIELDS = ['enabled', 'priority', 'health', 'lastValidated', 'notes'];
/** Fields the overlay must never touch, even to an identical value. */
export const OVERLAY_PROTECTED_FIELDS = ['adapter', 'endpoint', 'protocol', 'allowedHosts', 'capabilities', 'modes', 'id', 'persistent'];

const MODES = ['quick-share', 'persistent', 'tunnel'];
const HEALTH_STATES = ['healthy', 'degraded', 'unreachable', 'auth-required', 'incompatible', 'rate-limited', 'unknown'];

/** Capability schema version this build understands. */
export const CAPABILITY_SCHEMA = identity.CAPABILITY_SCHEMA;

const EXTENSION_POLICIES = ['any', 'blocklist', 'allowlist-exact', 'unpublished-server-allowlist', 'unknown'];

/**
 * Required capability keys and their expected shape.
 *
 * A missing key is a hard failure rather than a default: a provider whose limit is unknown must say
 * `null` explicitly ("the service documents no limit, so nothing is enforced client-side"), because
 * an omitted key is indistinguishable from a forgotten one and the planner would silently skip a
 * limit that does exist. Booleans are facts, not limits, so `null` is not accepted for them.
 */
const REQUIRED_CAPABILITIES = {
  anonymous: 'boolean',
  maxFiles: 'number',
  maxFileBytes: 'number',
  maxTotalBytes: 'number',
  supportedExtensions: 'array',
  denyExtensions: 'array',
  extensionPolicy: 'string',
  supportsModelFiles: 'boolean',
  claimable: 'boolean',
  htmlExact: 'boolean',
  ttl: 'ttl'
};

/** Keys that only some providers can state. Absent means "not established", which is reported. */
const OPTIONAL_CAPABILITIES = {
  idempotent: 'boolean',
  updateInPlace: 'boolean',
  singlePageOnly: 'boolean',
  spa: 'boolean',
  maxTotalBytesSource: 'string',
  supportsModelFilesSource: 'string'
};

function shapeProblem(id, key, kind, value) {
  if (value === null) {
    if (kind === 'boolean') return `${id}: capabilities.${key} must be a boolean, not null`;
    return null;
  }
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${id}: capabilities.${key} must be a boolean`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${id}: capabilities.${key} must be a finite number or null`;
    case 'string':
      return typeof value === 'string' && value ? null : `${id}: capabilities.${key} must be a non-empty string or null`;
    case 'array':
      return Array.isArray(value) ? null : `${id}: capabilities.${key} must be an array or null`;
    default:
      return `${id}: capabilities.${key} has an unsupported declaration`;
  }
}

function ttlProblems(id, ttl) {
  if (ttl === null) return [];
  if (typeof ttl !== 'object' || Array.isArray(ttl)) return [`${id}: capabilities.ttl must be an object or null`];
  const problems = [];
  if (!('defaultSeconds' in ttl)) problems.push(`${id}: capabilities.ttl.defaultSeconds is missing`);
  else if (ttl.defaultSeconds !== null && !(typeof ttl.defaultSeconds === 'number' && Number.isFinite(ttl.defaultSeconds))) {
    problems.push(`${id}: capabilities.ttl.defaultSeconds must be a finite number or null`);
  }
  if (!('optionsSeconds' in ttl)) problems.push(`${id}: capabilities.ttl.optionsSeconds is missing`);
  else if (ttl.optionsSeconds !== null && !Array.isArray(ttl.optionsSeconds)) {
    problems.push(`${id}: capabilities.ttl.optionsSeconds must be an array or null`);
  }
  if (!('source' in ttl)) problems.push(`${id}: capabilities.ttl.source is missing`);
  else if (ttl.source !== null && typeof ttl.source !== 'string') {
    problems.push(`${id}: capabilities.ttl.source must be a string or null`);
  }
  return problems;
}

/** Validate one provider's `capabilities` object against the declared schema version. */
export function validateCapabilities(id, caps) {
  const problems = [];
  for (const [key, kind] of Object.entries(REQUIRED_CAPABILITIES)) {
    if (!(key in caps)) {
      problems.push(`${id}: capabilities.${key} is missing (use null when the service documents no limit)`);
      continue;
    }
    const problem = kind === 'ttl' ? null : shapeProblem(id, key, kind, caps[key]);
    if (problem) problems.push(problem);
  }
  for (const [key, kind] of Object.entries(OPTIONAL_CAPABILITIES)) {
    if (!(key in caps)) continue;
    const problem = shapeProblem(id, key, kind, caps[key]);
    if (problem) problems.push(problem);
  }
  if ('ttl' in caps) problems.push(...ttlProblems(id, caps.ttl));

  if (typeof caps.extensionPolicy === 'string' && !EXTENSION_POLICIES.includes(caps.extensionPolicy)) {
    problems.push(`${id}: capabilities.extensionPolicy "${caps.extensionPolicy}" is not one of ${EXTENSION_POLICIES.join(', ')}`);
  }
  if (Array.isArray(caps.supportedExtensions) && Array.isArray(caps.denyExtensions)) {
    const overlap = caps.supportedExtensions.filter((extension) => caps.denyExtensions.includes(extension));
    if (overlap.length) {
      problems.push(`${id}: capabilities.supportedExtensions and denyExtensions both list ${overlap.join(', ')}`);
    }
  }
  return problems;
}

/** Refuse a registry whose capability schema this build does not understand. */
export function capabilitySchemaProblem(registryFile, raw) {
  if (typeof raw.capabilitySchema !== 'number' || !Number.isFinite(raw.capabilitySchema)) {
    return `Registry ${registryFile} does not declare capabilitySchema.`;
  }
  if (raw.capabilitySchema !== CAPABILITY_SCHEMA) {
    return `Registry ${registryFile} declares capabilitySchema ${raw.capabilitySchema}, but this build understands ${CAPABILITY_SCHEMA}.`;
  }
  return null;
}

function builtinRegistryCandidates(env) {
  return [
    identity.pickEnv(env, identity.ENV.registry),
    path.join(CLI_ROOT, 'config', 'providers.json'),
    path.join(PACKAGE_ROOT, 'config', 'providers.json')
  ].filter(Boolean);
}

export function resolveRegistryFile(env = process.env) {
  for (const candidate of builtinRegistryCandidates(env)) {
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveOverlayFile(env = process.env) {
  const explicit = identity.pickEnv(env, identity.ENV.statusFile);
  if (explicit) return path.resolve(explicit);
  return statePath(identity.FILES.status, env);
}

/* ----------------------------------------------------------- validation ---- */

/**
 * A plain-http endpoint is accepted only for a loopback host: that is what lets the real providers
 * be exercised against a local fake service in tests without weakening the rule that a public
 * provider must be reached over TLS.
 */
function isLoopbackEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function validateProvider(entry, index) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return [`entry ${index} is not an object`];
  if (!entry.id || typeof entry.id !== 'string') problems.push(`entry ${index}: missing id`);
  if (!entry.adapter || typeof entry.adapter !== 'string') problems.push(`${entry.id}: missing adapter`);
  if (!entry.label || typeof entry.label !== 'string') problems.push(`${entry.id}: missing label`);
  if (typeof entry.enabled !== 'boolean') problems.push(`${entry.id}: enabled must be a boolean`);
  if (!Array.isArray(entry.modes) || !entry.modes.length) problems.push(`${entry.id}: modes must be a non-empty array`);
  else {
    for (const mode of entry.modes) {
      if (!MODES.includes(mode)) problems.push(`${entry.id}: unknown mode ${mode}`);
    }
  }
  if (entry.transport === 'cli') {
    if (!entry.cli || typeof entry.cli !== 'string') problems.push(`${entry.id}: a cli-transport provider requires a cli name`);
  } else if (entry.endpoint === null || entry.endpoint === undefined) {
    // A registry entry with no service (wh-drop) may omit the endpoint, but it must be disabled.
    if (entry.enabled !== false) problems.push(`${entry.id}: a provider without an endpoint must be disabled`);
  } else if (!/^https:\/\//.test(entry.endpoint) && !isLoopbackEndpoint(entry.endpoint)) {
    problems.push(`${entry.id}: endpoint must be an absolute https URL (plain http is allowed only for a loopback test server)`);
  }
  if (!Array.isArray(entry.allowedHosts) || !entry.allowedHosts.length) {
    problems.push(`${entry.id}: allowedHosts must be a non-empty array`);
  } else {
    for (const host of entry.allowedHosts) {
      if (!/^(\*\.)?[a-z0-9.-]+$/i.test(host)) problems.push(`${entry.id}: invalid allowed host ${host}`);
    }
    if (entry.endpoint) {
      const endpointHost = new URL(entry.endpoint).hostname;
      const allowed = entry.allowedHosts.some((host) => (host.startsWith('*.') ? endpointHost.endsWith(host.slice(1)) : endpointHost === host));
      if (!allowed) problems.push(`${entry.id}: endpoint host ${endpointHost} is not listed in allowedHosts`);
    }
  }
  if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority)) problems.push(`${entry.id}: priority must be a number`);
  if (typeof entry.cnPriority !== 'number' || !Number.isFinite(entry.cnPriority)) problems.push(`${entry.id}: cnPriority must be a number`);
  if (!entry.capabilities || typeof entry.capabilities !== 'object') {
    problems.push(`${entry.id}: missing capabilities`);
  } else {
    problems.push(...validateCapabilities(entry.id, entry.capabilities));
  }
  if (entry.enabled === false && !entry.disabledReason) {
    problems.push(`${entry.id}: a disabled provider must carry disabledReason`);
  }
  if (entry.health && !HEALTH_STATES.includes(entry.health.state)) {
    problems.push(`${entry.id}: unknown health state ${entry.health.state}`);
  }
  return problems;
}

/**
 * Validate an overlay and merge it into the builtin registry.
 * Returns the merged provider list plus a report of every rejected change.
 */
export function applyOverlay(providers, overlay) {
  const report = { applied: [], rejected: [], unknownProviders: [] };
  if (!overlay || typeof overlay !== 'object') {
    report.rejected.push({ provider: '*', field: '*', reason: 'overlay is not a JSON object' });
    return { providers, report };
  }
  const entries = Array.isArray(overlay.providers) ? overlay.providers : [];
  if (!Array.isArray(overlay.providers)) {
    report.rejected.push({ provider: '*', field: 'providers', reason: 'overlay.providers must be an array' });
    return { providers, report };
  }
  for (const candidate of entries) {
    if (!candidate || typeof candidate.id !== 'string') {
      report.rejected.push({ provider: String(candidate && candidate.id), field: 'id', reason: 'overlay entry needs a provider id' });
      continue;
    }
    const target = providers.find((provider) => provider.id === candidate.id);
    if (!target) {
      report.unknownProviders.push(candidate.id);
      report.rejected.push({ provider: candidate.id, field: '*', reason: 'overlay references a provider that is not in the builtin registry' });
      continue;
    }
    for (const key of Object.keys(candidate)) {
      if (key === 'id') continue;
      if (OVERLAY_PROTECTED_FIELDS.includes(key)) {
        report.rejected.push({
          provider: candidate.id,
          field: key,
          reason: `refused: overlay may not change ${key} (protected field)`
        });
        continue;
      }
      if (!OVERLAY_MUTABLE_FIELDS.includes(key)) {
        report.rejected.push({ provider: candidate.id, field: key, reason: `refused: ${key} is not an overlay-mutable field` });
        continue;
      }
      const value = candidate[key];
      if (key === 'enabled') {
        if (typeof value !== 'boolean') {
          report.rejected.push({ provider: candidate.id, field: key, reason: 'enabled must be a boolean' });
          continue;
        }
        target.enabled = value;
      } else if (key === 'priority') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          report.rejected.push({ provider: candidate.id, field: key, reason: 'priority must be a finite number' });
          continue;
        }
        target.priority = value;
      } else if (key === 'health') {
        if (!value || typeof value !== 'object' || !HEALTH_STATES.includes(value.state)) {
          report.rejected.push({ provider: candidate.id, field: key, reason: 'health must be an object with a known state' });
          continue;
        }
        target.health = { ...target.health, ...value };
        target.healthSource = 'overlay';
      } else if (key === 'lastValidated') {
        target.lastValidated = value == null ? null : String(value);
      } else if (key === 'notes') {
        target.notes = value == null ? null : String(value);
      }
      report.applied.push({ provider: candidate.id, field: key });
    }
  }
  // A refused field must not be half-applied: callers can inspect report.rejected and decide.
  return { providers, report };
}

/* ------------------------------------------------------------------ load ---- */

export function loadRegistry(options = {}) {
  const env = options.env || process.env;
  const warnings = [];
  const registryFile = resolveRegistryFile(env);
  if (!registryFile) {
    return {
      ok: false,
      error: 'Cannot locate the bundled provider registry (config/providers.json).',
      providers: [],
      warnings,
      overlay: null
    };
  }

  const raw = readJsonFile(registryFile, null);
  if (!raw || !Array.isArray(raw.providers)) {
    return { ok: false, error: `Registry ${registryFile} is missing a providers array.`, providers: [], warnings, overlay: null, registryFile };
  }
  const schemaProblem = capabilitySchemaProblem(registryFile, raw);
  if (schemaProblem) {
    return { ok: false, error: schemaProblem, providers: [], warnings, overlay: null, registryFile };
  }

  const problems = [];
  const providers = [];
  const seen = new Set();
  for (const [index, entry] of raw.providers.entries()) {
    const entryProblems = validateProvider(entry, index);
    problems.push(...entryProblems);
    if (entry && typeof entry.id === 'string') {
      if (seen.has(entry.id)) problems.push(`duplicate provider id ${entry.id}`);
      seen.add(entry.id);
    }
    providers.push({
      ...entry,
      allowedHosts: Array.isArray(entry.allowedHosts) ? [...entry.allowedHosts] : [],
      capabilities: { ...(entry.capabilities || {}) },
      modes: Array.isArray(entry.modes) ? [...entry.modes] : [],
      health: entry.health && typeof entry.health === 'object' ? { ...entry.health } : { state: 'unknown' },
      healthSource: 'builtin',
      registryFile
    });
  }

  if (problems.length) {
    return { ok: false, error: 'Registry validation failed.', problems, providers, warnings, overlay: null, registryFile };
  }

  const overlayFile = resolveOverlayFile(env);
  let overlay = null;
  let merged = providers;
  if (overlayFile) {
    let overlayRaw = null;
    let overlayExists = false;
    try {
      overlayExists = fs.statSync(overlayFile).isFile();
    } catch {
      overlayExists = false;
    }
    if (overlayExists) {
      overlayRaw = readJsonFile(overlayFile, undefined);
      if (overlayRaw === undefined) {
        warnings.push(`Overlay ${overlayFile} is not valid JSON and was ignored.`);
        overlay = { file: overlayFile, applied: [], rejected: [{ provider: '*', field: '*', reason: 'invalid JSON' }], unknownProviders: [] };
      } else {
        const result = applyOverlay(merged, overlayRaw);
        merged = result.providers;
        overlay = { file: overlayFile, ...result.report };
        for (const rejection of result.report.rejected) {
          warnings.push(`Overlay refused ${rejection.provider}.${rejection.field}: ${rejection.reason}`);
        }
      }
    }
  }

  const order = new Map(raw.providers.map((entry, index) => [entry.id, index]));
  merged.sort((a, b) => (b.priority - a.priority) || (order.get(a.id) - order.get(b.id)));

  return {
    ok: true,
    version: raw.registryVersion ?? null,
    capabilitySchema: raw.capabilitySchema ?? null,
    updatedAt: raw.updatedAt ?? null,
    notes: raw.notes ?? null,
    registryFile,
    overlayFile: overlayFile || null,
    overlay,
    providers: merged,
    warnings,
    problems: []
  };
}

export function providerById(registry, id) {
  return registry.providers.find((provider) => provider.id === id) || null;
}

export function isEnabled(provider) {
  return provider.enabled === true;
}
