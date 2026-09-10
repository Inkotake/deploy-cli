/**
 * ShipStatic — `POST https://api.shipstatic.com/deployments`, anonymous multipart.
 *
 * Anonymous deployments live for 3 days and return a `claim` URL that grants ownership. That URL
 * is surfaced only in the `claim` block, never as the share link. An `Idempotency-Key` is sent so
 * a retry of the same artifact replays the original 201 instead of creating a second deployment.
 */

import { md5Hex, trace } from '../common.mjs';
import * as identity from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, idempotencyKey, multipartRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'shipstatic';

/** Epoch seconds in `expires`/`created`, not an ISO string. */
function epochToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toISOString();
}

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);

  // Live-verified: the ShipStatic multipart parser does not count a zero-byte file part, so a
  // deployment containing one fails validation with "Files count (n) must match checksums
  // count (n+1)". Empty files cannot be represented, so this is a capability failure.
  const empty = manifest.files.filter((file) => file.bytes === 0).map((file) => file.path);
  if (empty.length) {
    throw new ProviderError('capability', `shipstatic: the service does not accept zero-byte files (${empty.slice(0, 3).join(', ')}${empty.length > 3 ? `, +${empty.length - 3} more` : ''}); its multipart parser drops the empty part and then rejects the checksum count`, { permanent: true });
  }

  const parts = files.map((file) => ({
    name: 'files[]',
    filename: file.path,
    contentType: file.mime,
    data: file.bytes
  }));
  parts.push({ name: 'checksums', value: JSON.stringify(files.map((file) => md5Hex(file.bytes))) });
  parts.push({ name: 'via', value: identity.NAME });
  // The `ttl` field is documented as optional but is rejected with 403 in anonymous mode
  // ("An expiring deployment requires a credential"). The platform schedule is used instead and
  // the effective deadline is read back from the response `expires` field.
  const ttlSeconds = providerTtlSeconds(provider, 259200);

  const response = await multipartRequest(id, provider.endpoint, parts, {
    headers: { accept: 'application/json', 'idempotency-key': idempotencyKey(manifest).slice(0, 200) },
    successStatuses: [200, 201],
    context: 'upload'
  });

  if (response.headers['idempotency-replay'] === 'true') {
    // The original 201 was replayed; the deployment already exists and is unchanged.
    trace('shipstatic: the service replayed a previous deployment for this exact artifact');
  }

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');
  if (payload.status && !['ready', 'deployed', 'success', 'ok'].includes(String(payload.status).toLowerCase())) {
    throw new ProviderError('server', `${id}: the deployment was accepted but reports status "${payload.status}"`, { permanent: false });
  }

  return {
    url: publicUrl,
    deployment: payload.deployment ?? null,
    expiresAt: epochToIso(payload.expires) || expiresAtFrom(payload, ttlSeconds),
    persistence: 'temporary',
    fileCount: Array.isArray(payload.files) ? payload.files.length : files.length,
    bytes: typeof payload.size === 'number' ? payload.size : null,
    claim: buildClaim(provider.claim, payload),
    providerDetail: { idempotencyReplay: response.headers['idempotency-replay'] === 'true' },
    transport: 'multipart'
  };
}
