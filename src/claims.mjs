/**
 * Ownership credentials ("claims").
 *
 * Several anonymous hosts return a token or URL that grants ownership of a deployment to whoever
 * holds it: ship.page returns a one-time `claim_token` (`spc_…`), ShipStatic returns a claim URL,
 * here.now returns a `claimToken` plus `claimUrl`, aft.page an `editToken`, Dropley an
 * `artifactToken`. Losing one means losing the deployment; leaking one means someone else owns it.
 *
 * WHY THIS MODULE EXISTS: `--json` output is captured verbatim by callers — agents, CI logs,
 * transcripts. Printing a capability-bearing secret by default therefore leaks it. So the secret is
 * written to the private state directory (owner-only where the filesystem supports it) and the JSON
 * reports only that a claim exists, unless the caller explicitly passes `--show-claim-secret`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './common.mjs';
import { FILES } from './identity.mjs';

export const CLAIM_WARNING = 'Ownership credential: whoever holds it can take ownership of this deployment. Never forward it.';

/** Absolute path of the claim store for this environment. */
export function claimsPath(env = process.env) {
  return statePath(FILES.claims, env);
}

/**
 * Read the claim store. A damaged or future-format file never throws: the store is a convenience,
 * not a source of truth, so it degrades to "no stored claims" and reports why.
 */
export function readClaims(env = process.env) {
  const file = claimsPath(env);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { file, claims: [], problems: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const claims = Array.isArray(parsed && parsed.claims) ? parsed.claims.filter((entry) => entry && typeof entry === 'object') : [];
    return { file, claims, problems: [] };
  } catch {
    return { file, claims: [], problems: [`${file} is not valid JSON and was ignored`] };
  }
}

function writeClaims(file, claims) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), claims }, null, 2) + '\n';
  // 0o600 is enforced by POSIX filesystems; Windows ignores the mode and relies on the per-user
  // state directory instead. Both are documented in the README's security section.
  fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort: some filesystems cannot express it */
  }
  return file;
}

/**
 * Persist the claim for one deployment, replacing any previous entry for the same URL.
 * @returns {{ file: string, entry: object } | null} null when the provider returned no claim.
 */
export function storeClaim(claim, deployment = {}, env = process.env) {
  if (!claim || (!claim.value && !claim.claimUrl)) return null;
  const { file, claims } = readClaims(env);
  const url = deployment.url || null;
  const entry = {
    url,
    provider: deployment.provider || null,
    kind: claim.kind || null,
    field: claim.field || null,
    value: claim.value || null,
    claimUrl: claim.claimUrl || null,
    capturedAt: new Date().toISOString()
  };
  const next = claims.filter((existing) => existing.url !== url || url === null);
  next.push(entry);
  writeClaims(file, next);
  return { file, entry };
}

/**
 * Shape a claim for `--json` output.
 * The default result deliberately contains no secret; `reveal` is the `--show-claim-secret` path.
 */
export function claimForOutput(claim, options = {}) {
  if (!claim) return null;
  const reveal = options.reveal === true;
  return {
    kind: claim.kind || null,
    field: claim.field || null,
    available: true,
    value: reveal ? claim.value || null : null,
    claimUrl: reveal ? claim.claimUrl || null : null,
    valuePreview: claim.value ? previewSecret(claim.value) : null,
    secretStored: options.storedIn || null,
    hidden: reveal ? false : Boolean(claim.value || claim.claimUrl),
    // The provider's own note is kept, but the ownership warning is never dropped for it: that
    // sentence is the only thing telling a caller that forwarding this value hands over the site.
    warning: claim.warning ? `${claim.warning} ${CLAIM_WARNING}` : CLAIM_WARNING
  };
}

/** Non-reversible hint that does not reveal enough to use: `spc_…(27 chars)`. */
export function previewSecret(value) {
  const text = String(value);
  const prefix = /^([a-z]{2,5}_)/i.exec(text);
  return `${prefix ? prefix[1] : ''}…(${text.length} chars)`;
}

/**
 * Find a stored claim by public URL, by provider id, or the literal `latest`.
 * @returns {{ file: string, entry: object } | null}
 */
export function findClaim(key, env = process.env) {
  const { file, claims } = readClaims(env);
  if (!claims.length) return null;
  const wanted = String(key || 'latest');
  if (wanted === 'latest') return { file, entry: claims[claims.length - 1] };
  const byUrl = claims.find((entry) => entry.url === wanted);
  if (byUrl) return { file, entry: byUrl };
  const byProvider = claims.filter((entry) => entry.provider === wanted);
  return byProvider.length ? { file, entry: byProvider[byProvider.length - 1] } : null;
}

/** Human-readable lines for one stored claim. */
export function formatClaim(entry, options = {}) {
  const reveal = options.reveal === true;
  const lines = [];
  lines.push(`Deployment: ${entry.url || '(unknown url)'}`);
  if (entry.provider) lines.push(`Provider:   ${entry.provider}`);
  lines.push(`Claim kind: ${entry.kind || 'unknown'} (field ${entry.field || 'unknown'})`);
  if (reveal) {
    if (entry.value) lines.push(`Claim value: ${entry.value}`);
    if (entry.claimUrl) lines.push(`Claim URL:   ${entry.claimUrl}`);
  } else {
    if (entry.value) lines.push(`Claim value: stored, hidden — ${previewSecret(entry.value)}`);
    if (entry.claimUrl) lines.push('Claim URL:   stored, hidden');
    lines.push('Re-run with --reveal to print it.');
  }
  if (entry.capturedAt) lines.push(`Captured:   ${entry.capturedAt}`);
  lines.push('');
  lines.push(CLAIM_WARNING);
  return lines;
}
