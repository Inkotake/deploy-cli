/**
 * ship.page — `POST https://ship.page/deploy`, anonymous, 30 day lifetime.
 *
 * Protocol note: docs/provider-protocols.md documents the JSON file-map body, but the live
 * service also accepts `application/zip`, and the zip form preserves bytes exactly, which remote
 * SHA-256 verification requires. The zip path is therefore used and is flagged in the registry
 * as `protocolNotes`. The public URL is taken from the response `url` field, never from the slug.
 */

import { createZip } from '../common.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, providerTtlSeconds, requestOrThrow, requireJson, requireUrl } from './shared.mjs';

export const id = 'ship-page';

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const zip = createZip(files.map((file) => ({ name: file.path, data: file.bytes, mime: file.mime })));

  const caps = provider.capabilities || {};
  if (typeof caps.maxTotalBytes === 'number' && zip.length > caps.maxTotalBytes) {
    throw new ProviderError('capability', `ship-page: the generated zip is ${zip.length} bytes, above the documented 25 MiB limit of ${caps.maxTotalBytes}`, { permanent: true });
  }

  const ttlSeconds = providerTtlSeconds(provider, 2592000);
  const url = new URL(provider.endpoint);
  url.searchParams.set('ttl', String(ttlSeconds));

  const response = await requestOrThrow(id, {
    url: url.toString(),
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      accept: 'application/json',
      'content-length': String(zip.length)
    },
    body: zip,
    timeoutMs: 240000
  }, 'upload');

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');
  // `slug` is reported for diagnostics only; the share URL stays exactly what the service sent.
  const slug = typeof payload.slug === 'string' ? payload.slug : null;

  return {
    url: publicUrl,
    slug,
    expiresAt: expiresAtFrom(payload, ttlSeconds),
    persistence: 'temporary',
    fileCount: Array.isArray(payload.files) ? payload.files.length : files.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: { plan: payload.plan ?? null, passwordProtected: payload.password_protected === true, claimEmailSent: Boolean(payload.claim_email) },
    transport: 'zip'
  };
}
