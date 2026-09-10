/**
 * aft.page — `POST https://api.aft.page/v1/deploy`, anonymous multipart.
 *
 * Multipart parts are `file0`, `file0_path`, `file1`, `file1_path`, ... . Unclaimed sites are
 * deleted after 30 days idle, so the reported expiry is a soft hint, not a fixed deadline.
 * The response `url` field is authoritative; the slug is used only when the service omits a URL,
 * and in that case the deployment is reported as a failure rather than guessed.
 */

import { ProviderError } from './errors.mjs';
import * as identity from '../identity.mjs';
import { artifactFiles, artifactName, buildClaim, expiresAtFrom, multipartRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'aft-page';

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const parts = [];
  for (const [index, file] of files.entries()) {
    parts.push({ name: `file${index}`, filename: file.path, contentType: file.mime, data: file.bytes });
    parts.push({ name: `file${index}_path`, value: file.path });
  }

  const response = await multipartRequest(id, provider.endpoint, parts, {
    headers: { accept: 'application/json' },
    successStatuses: [200, 201],
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  if (payload.ok === false) {
    throw new ProviderError('server', `${id}: the service reported ok=false: ${payload.error || payload.notice || 'no detail'}`, { permanent: false });
  }
  if (!payload.url) {
    throw new ProviderError('server', `${id}: the response had no url field (slug=${payload.slug ?? 'none'}). No URL is invented from the slug.`, { permanent: false });
  }
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');
  const ttlSeconds = providerTtlSeconds(provider, null);

  return {
    url: publicUrl,
    slug: typeof payload.slug === 'string' ? payload.slug : null,
    deployId: payload.deployId ?? null,
    expiresAt: expiresAtFrom(payload, null),
    expiresAtNote: 'unclaimed aft.page sites are deleted after 30 days idle, so the expiry is not a fixed deadline',
    idleExpirySeconds: ttlSeconds,
    persistence: 'temporary',
    fileCount: Array.isArray(payload.files) ? payload.files.length : files.length,
    bytes: typeof payload.bytes === 'number' ? payload.bytes : null,
    claim: buildClaim(provider.claim, payload),
    providerDetail: { owned: payload.owned === true, notice: payload.notice ?? null, name: artifactName(manifest) },
    transport: 'multipart'
  };
}
