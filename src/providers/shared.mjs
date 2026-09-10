/**
 * Helpers shared by the provider adapters.
 *
 * Every adapter follows the same contract: take the inspected manifest, upload the exact bytes
 * that were hashed locally, and return the public URL exactly as the service reported it.
 * A URL is never derived from a naming convention.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { baseContentType, buildMultipart, httpRequest, jsonOf, mimeForPath, randomBoundary, redact, retryAfterMs, textOf, trace } from '../common.mjs';
import { ProviderError, classifyHttpStatus, classifyNetworkError } from './errors.mjs';

/** Files in stable manifest order, each with its raw bytes. */
export function artifactFiles(manifest) {
  return manifest.files.map((record) => {
    const entry = manifest.byRelative.get(record.path);
    if (!entry) {
      throw new ProviderError('unknown', `Manifest entry ${record.path} has no bytes loaded`, { permanent: false });
    }
    return { path: record.path, bytes: entry.bytes, mime: record.mime || mimeForPath(record.path), sha256: record.sha256 };
  });
}

export function artifactName(manifest) {
  const base = path.basename(manifest.dir || 'artifact');
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'artifact';
}

export function idempotencyKey(manifest) {
  const digest = manifest.files.map((file) => `${file.path}:${file.sha256}`).join('\n');
  return 'tp-' + crypto.createHash('sha256').update(digest).digest('hex').slice(0, 40);
}

/**
 * Issue a request and convert failures into ProviderError. `successStatuses` defaults to any 2xx.
 */
export async function requestOrThrow(providerId, options, context) {
  let response;
  try {
    response = await httpRequest(options);
  } catch (cause) {
    throw classifyNetworkError(cause, `${providerId} ${context}`);
  }
  const ok = options.successStatuses
    ? options.successStatuses.includes(response.status)
    : response.status >= 200 && response.status < 300;
  if (!ok) {
    const failure = classifyHttpStatus(response.status, textOf(response), `${providerId} ${context}`);
    const retry = retryAfterMs(response);
    if (retry != null) failure.retryAfterMs = retry;
    throw failure;
  }
  return response;
}

/** Multipart POST with a unique boundary. */
export function multipartRequest(providerId, url, parts, options = {}) {
  const boundary = randomBoundary();
  const body = buildMultipart(parts, boundary);
  return requestOrThrow(providerId, {
    url,
    method: options.method || 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      ...(options.headers || {})
    },
    body,
    timeoutMs: options.timeoutMs ?? 180000,
    successStatuses: options.successStatuses,
    maxBytes: options.maxBytes
  }, options.context || 'upload');
}

export function jsonRequest(providerId, url, payload, options = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return requestOrThrow(providerId, {
    url,
    method: options.method || 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'content-length': String(body.length),
      ...(options.headers || {})
    },
    body,
    timeoutMs: options.timeoutMs ?? 120000,
    successStatuses: options.successStatuses
  }, options.context || 'request');
}

export function requireJson(providerId, response, context) {
  const parsed = jsonOf(response);
  if (!parsed || typeof parsed !== 'object') {
    throw new ProviderError('server', `${providerId} ${context}: response was not JSON (${baseContentType(response) || 'no content-type'})`, {
      status: response.status,
      detail: redact(textOf(response)).slice(0, 300)
    });
  }
  return parsed;
}

/**
 * Take the public URL from the response only, and validate it against the registry's allowed
 * hosts so a compromised or mistaken response cannot send a teacher to an unrelated origin.
 */
export function requireUrl(providerId, value, allowedHosts = [], field = 'url') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderError('server', `${providerId}: the response did not include a ${field} field. No URL is invented.`, { permanent: false });
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ProviderError('server', `${providerId}: the ${field} field is not an absolute URL: ${value}`, { permanent: false });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProviderError('server', `${providerId}: the ${field} field uses an unsupported protocol: ${parsed.protocol}`, { permanent: false });
  }
  if (allowedHosts.length) {
    const host = parsed.hostname.toLowerCase();
    const allowed = allowedHosts.some((pattern) => {
      const rule = String(pattern).toLowerCase();
      if (rule.startsWith('*.')) return host.endsWith(rule.slice(1)) || host === rule.slice(2);
      return host === rule;
    });
    if (!allowed) {
      throw new ProviderError('server', `${providerId}: the ${field} host ${host} is not in the registry allowlist (${allowedHosts.join(', ')})`, { permanent: false });
    }
  }
  return parsed.toString();
}

/** Build the claim block from whatever the provider returned, or null when it returns nothing. */
export function buildClaim(claimSpec, payload, extra = {}) {
  if (!claimSpec) return null;
  const warnings = [];
  const value = payload[claimSpec.field];
  const claimUrl = claimSpec.urlField ? payload[claimSpec.urlField] : null;
  if (!value && !claimUrl) return null;
  if (claimSpec.pattern && value && !new RegExp(claimSpec.pattern).test(String(value))) {
    warnings.push(`the returned ${claimSpec.field} does not match the documented shape ${claimSpec.pattern}`);
  }
  if (claimSpec.warning) warnings.push(claimSpec.warning);
  warnings.push('Do not forward the claim value or claim link: holding it means owning the deployment.');
  return {
    kind: claimSpec.kind,
    value: value ? String(value) : null,
    claimUrl: claimUrl ? String(claimUrl) : null,
    field: claimSpec.field,
    warning: warnings.join(' ')
  };
}

export function expiresAtFrom(payload, fallbackSeconds) {
  const candidate = payload.expiresAt || payload.expires_at || payload.expires || payload.expiration;
  if (typeof candidate === 'string' && candidate.trim()) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    const ms = candidate < 1e12 ? candidate * 1000 : candidate;
    return new Date(ms).toISOString();
  }
  if (typeof fallbackSeconds === 'number' && fallbackSeconds > 0) {
    return new Date(Date.now() + fallbackSeconds * 1000).toISOString();
  }
  return null;
}

/**
 * Anonymous lifetime the provider documents, in seconds; \`fallback\` when the registry states none.
 * Capabilities carry it as \`ttl.defaultSeconds\`, so the number and the documentation it came from
 * (plus any other lifetimes the service offers) stay in one object instead of two loose fields.
 */
export function providerTtlSeconds(provider, fallback) {
  const ttl = provider && provider.capabilities ? provider.capabilities.ttl : null;
  const seconds = ttl && typeof ttl.defaultSeconds === 'number' && Number.isFinite(ttl.defaultSeconds)
    ? ttl.defaultSeconds
    : null;
  return seconds === null ? fallback : seconds;
}

export function noteTrace(providerId, message) {
  trace(`${providerId}: ${message}`);
}
