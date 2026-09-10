/**
 * Shared failure classification for every adapter.
 *
 * `kind` is the contract between an adapter and the health cache: it decides how long the
 * circuit breaker stays open. Classification is deliberately conservative — an unknown
 * transport error is treated as a short connect/TLS style break, never as "service is down".
 */

import { redact } from '../common.mjs';
import { BREAK_MS } from '../health.mjs';

export class ProviderError extends Error {
  constructor(kind, message, options = {}) {
    // Every provider error eventually reaches a log line, the health cache or a JSON document,
    // so credential-shaped substrings are stripped at construction time.
    super(redact(message));
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.detail = options.detail == null ? null : redact(options.detail);
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.permanent = options.permanent ?? kind === 'capability';
    this.mismatches = options.mismatches ?? null;
    // Adapter-authored guidance for the caller, surfaced as `nextAction` when nothing else fits.
    this.nextHint = options.nextHint ?? null;
  }
}

export function capabilityError(message, detail, nextHint = null) {
  return new ProviderError('capability', message, { detail, permanent: true, nextHint });
}

/** Map a thrown Node.js network error into the health vocabulary. */
export function classifyNetworkError(cause, context) {
  if (cause instanceof ProviderError) return cause;
  const code = cause && cause.code ? String(cause.code) : '';
  const message = cause && cause.message ? cause.message : String(cause);
  const where = context ? ` during ${context}` : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
    return new ProviderError('dns', `DNS lookup failed${where}: ${message}`, { detail: code });
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new ProviderError('unreachable', `Connection or TLS timeout${where}: ${message}`, { detail: code });
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EPIPE') {
    return new ProviderError('unreachable', `Connection failure${where}: ${message}`, { detail: code });
  }
  if (/certificate|TLS|SSL|self.signed|unable to verify/i.test(message)) {
    return new ProviderError('unreachable', `TLS failure${where}: ${message}`, { detail: code || 'tls' });
  }
  if (code === 'EBODYTOOLARGE') {
    return new ProviderError('server', `Provider response exceeded the client limit${where}: ${message}`, { detail: code });
  }
  return new ProviderError('unknown', `Unexpected transport failure${where}: ${message}`, { detail: code || null });
}

/** Map an HTTP status that is not a success into the health vocabulary. */
export function classifyHttpStatus(status, bodyText, context) {
  const where = context ? ` during ${context}` : '';
  const snippet = redact(String(bodyText || '').replace(/\s+/g, ' ')).slice(0, 300);
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `HTTP ${status}${where}: authentication or permission failure. ${snippet}`, { status });
  }
  if (status === 429) {
    return new ProviderError('rateLimited', `HTTP 429${where}: rate limited. ${snippet}`, { status });
  }
  if (status === 404 && /not found|unknown endpoint|no such/i.test(snippet)) {
    return new ProviderError('server', `HTTP 404${where}: the documented endpoint was not found. ${snippet}`, { status });
  }
  if (status === 413 || status === 415 || status === 422) {
    return new ProviderError('capability', `HTTP ${status}${where}: the service rejected the upload as unsupported. ${snippet}`, { status, permanent: true });
  }
  if (status >= 500) {
    return new ProviderError('server', `HTTP ${status}${where}: server error. ${snippet}`, { status });
  }
  if (status >= 400) {
    return new ProviderError('capability', `HTTP ${status}${where}: request rejected. ${snippet}`, { status, permanent: false });
  }
  return new ProviderError('unknown', `HTTP ${status}${where}: unexpected status. ${snippet}`, { status });
}

export function breakMsFor(kind) {
  return BREAK_MS[kind] ?? BREAK_MS.unknown;
}

export function isPermanent(kind) {
  return kind === 'capability';
}
