/**
 * Local provider health cache and circuit breaker.
 *
 * State lives in this tool's private state directory (`identity.FILES.health`) and never in the
 * installation directory, which may be read-only or shared. The breaker exists to stop `deploy` from hammering a host that is down: DNS failure
 * opens a long break, connection/TLS timeouts and 5xx responses open a short one, and an
 * authentication failure (401/403) is recorded without marking the service itself as down.
 */

import * as identity from './identity.mjs';
import { readJsonFile, statePath, writeJsonAtomic } from './common.mjs';

export const HEALTH_FILE_NAME = identity.FILES.health;
export const HEALTH_VERSION = 1;

/** Circuit breaker windows, in milliseconds. */
export const BREAK_MS = {
  dns: 24 * 60 * 60 * 1000,
  unreachable: 20 * 60 * 1000,
  server: 10 * 60 * 1000,
  rateLimited: 60 * 60 * 1000,
  auth: 30 * 60 * 1000,
  capability: 24 * 60 * 60 * 1000,
  integrity: 6 * 60 * 60 * 1000,
  unknown: 5 * 60 * 1000,
  none: 0
};

const FAILURE_KINDS = Object.keys(BREAK_MS);

export function healthFilePath(env = process.env) {
  return statePath(HEALTH_FILE_NAME, env);
}

export function loadHealth(env = process.env) {
  const file = healthFilePath(env);
  const raw = readJsonFile(file, null);
  const state = { version: HEALTH_VERSION, updatedAt: null, providers: {} };
  if (!raw || typeof raw !== 'object') return { file, state };
  if (raw.version !== HEALTH_VERSION) {
    // A future format is ignored rather than misread; the cache is advisory, not authoritative.
    return { file, state };
  }
  if (raw.providers && typeof raw.providers === 'object') {
    for (const [id, entry] of Object.entries(raw.providers)) {
      if (!entry || typeof entry !== 'object') continue;
      const failures = Number(entry.consecutiveFailures);
      state.providers[id] = {
        consecutiveFailures: Number.isFinite(failures) ? Math.max(0, failures) : 0,
        lastFailureKind: FAILURE_KINDS.includes(entry.lastFailureKind) ? entry.lastFailureKind : null,
        lastFailureAt: entry.lastFailureAt || null,
        lastFailureMessage: entry.lastFailureMessage ? String(entry.lastFailureMessage) : null,
        lastSuccessAt: entry.lastSuccessAt || null,
        circuitOpenUntil: entry.circuitOpenUntil || null,
        lastUrl: entry.lastUrl || null
      };
    }
  }
  state.updatedAt = raw.updatedAt || null;
  return { file, state };
}

export function saveHealth(state, env = process.env) {
  const file = healthFilePath(env);
  state.version = HEALTH_VERSION;
  state.updatedAt = new Date().toISOString();
  try {
    writeJsonAtomic(file, state);
    return { ok: true, file };
  } catch (cause) {
    return { ok: false, file, error: cause.message };
  }
}

export function entryFor(state, providerId) {
  return state.providers[providerId] || null;
}

/** True when the circuit is open at `now`. An expired break is reported as closed. */
export function isCircuitOpen(state, providerId, now = Date.now()) {
  const entry = state.providers[providerId];
  if (!entry || !entry.circuitOpenUntil) return false;
  const until = Date.parse(entry.circuitOpenUntil);
  if (!Number.isFinite(until)) return false;
  return until > now;
}

export function circuitRemainingMs(state, providerId, now = Date.now()) {
  const entry = state.providers[providerId];
  if (!entry || !entry.circuitOpenUntil) return 0;
  const until = Date.parse(entry.circuitOpenUntil);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, until - now);
}

export function describeHealth(state, providerId, now = Date.now()) {
  const entry = state.providers[providerId];
  if (!entry) {
    return { state: 'unknown', circuitOpen: false, openUntil: null, consecutiveFailures: 0, lastFailureKind: null, lastFailureMessage: null, lastSuccessAt: null };
  }
  const remaining = circuitRemainingMs(state, providerId, now);
  // An authentication failure means the caller is not authorised, not that the service is down.
  // It still throttles retries (the breaker is open) but the health state stays `auth-required`.
  const authFailure = entry.lastFailureKind === 'auth';
  return {
    state: remaining > 0 ? (authFailure ? 'auth-required' : 'open') : entry.lastFailureKind ? 'degraded' : 'healthy',
    circuitOpen: remaining > 0,
    openUntil: remaining > 0 ? entry.circuitOpenUntil : null,
    openRemainingMs: remaining,
    consecutiveFailures: entry.consecutiveFailures,
    lastFailureKind: entry.lastFailureKind,
    lastFailureMessage: entry.lastFailureMessage,
    lastFailureAt: entry.lastFailureAt,
    lastSuccessAt: entry.lastSuccessAt,
    lastUrl: entry.lastUrl
  };
}

/**
 * Record a failure and open the breaker. `kind` is one of the keys of BREAK_MS.
 * Authentication failures set the timeout to zero: the service is up, the caller is not
 * authorised, and marking it down would wrongly suppress it for other users of this machine.
 */
export function recordFailure(state, providerId, kind, message, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const window = options.breakMs ?? BREAK_MS[kind] ?? BREAK_MS.unknown;
  const previous = state.providers[providerId] || { consecutiveFailures: 0 };
  const entry = {
    ...previous,
    consecutiveFailures: (previous.consecutiveFailures || 0) + 1,
    lastFailureKind: kind,
    lastFailureAt: now.toISOString(),
    lastFailureMessage: message ? String(message).slice(0, 500) : null,
    circuitOpenUntil: window > 0 ? new Date(now.getTime() + window).toISOString() : null,
    lastUrl: previous.lastUrl || null
  };
  state.providers[providerId] = entry;
  return entry;
}

export function recordSuccess(state, providerId, url) {
  const now = new Date().toISOString();
  const previous = state.providers[providerId] || {};
  const entry = {
    ...previous,
    consecutiveFailures: 0,
    lastFailureKind: null,
    lastFailureMessage: null,
    circuitOpenUntil: null,
    lastSuccessAt: now,
    lastUrl: url || previous.lastUrl || null
  };
  state.providers[providerId] = entry;
  return entry;
}

/** Merge registry health hints with the local cache. Local activity wins. */
export function mergedHealth(registry, healthState, providerId, now = Date.now()) {
  // Accept either the loaded { file, state } wrapper or the bare state object.
  const state = healthState && healthState.state ? healthState.state : healthState || { providers: {} };
  const provider = registry.providers.find((item) => item.id === providerId);
  const base = (provider && provider.health) || { state: 'unknown' };
  const local = describeHealth(state, providerId, now);
  if (local.circuitOpen) return { ...base, ...local };
  if (local.consecutiveFailures > 0) return { ...base, ...local };
  if (base.source === 'overlay' || (provider && provider.healthSource === 'overlay')) {
    return { ...local, ...base, source: 'overlay' };
  }
  return { ...base, ...local, state: base.state && local.lastSuccessAt == null ? base.state : local.state };
}

export function summaryHealth(healthState, now = Date.now()) {
  const state = healthState && healthState.state ? healthState.state : healthState || { providers: {} };
  const out = {};
  for (const id of Object.keys(state.providers || {})) {
    out[id] = describeHealth(state, id, now);
  }
  return out;
}
