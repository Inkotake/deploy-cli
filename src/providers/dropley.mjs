/**
 * Dropley — `POST https://dropley.app/api/artifacts`, multipart with a JSON `manifest` field.
 *
 * Strict server validation: `manifestVersion` must be 1, `entry` must be `index.html` and be
 * present in `files`, every file entry must carry `contentType`, and the number of `file` parts
 * must equal `manifest.files.length` exactly. Parts are emitted in manifest order because
 * positions must line up. Dropley enforces an unpublished extension allowlist, so model files are
 * treated as unsupported (UNVERIFIED) and the planner excludes Dropley for them.
 */

import { buildMultipart, randomBoundary, textOf } from '../common.mjs';
import { providerTtlSeconds } from './shared.mjs';
import * as identity from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, requestOrThrow, requireJson, requireUrl } from './shared.mjs';

export const id = 'dropley';

export const EXPIRY_OPTIONS = ['1d', '3d', '7d'];
const EXPIRY_SECONDS = { '1d': 86400, '3d': 259200, '7d': 604800 };

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const index = files.findIndex((file) => file.path === 'index.html');
  if (index === -1) {
    throw new ProviderError('capability', 'dropley: entry must be index.html at the artifact root and no index.html was found', { permanent: true });
  }

  const expiry = provider.expiry && EXPIRY_OPTIONS.includes(provider.expiry) ? provider.expiry : '7d';
  const manifestObject = {
    manifestVersion: 1,
    entry: 'index.html',
    files: files.map((file) => ({ path: file.path, size: file.bytes.length, contentType: file.mime }))
  };

  const parts = [
    { name: 'manifest', value: JSON.stringify(manifestObject) },
    { name: 'expiry', value: expiry },
    { name: 'source', value: identity.NAME }
  ];
  for (const file of files) {
    parts.push({ name: 'file', filename: file.path, contentType: file.mime, data: file.bytes });
  }

  // 422 is accepted by the transport so the unpublished-allowlist rejection can be reported with
  // its own guidance instead of the generic HTTP classification.
  const boundary = randomBoundary();
  const body = buildMultipart(parts, boundary);
  const response = await requestOrThrow(id, {
    url: provider.endpoint,
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      accept: 'application/json'
    },
    body,
    timeoutMs: 300000,
    successStatuses: [200, 201, 422]
  }, 'upload');

  if (response.status === 422) {
    throw new ProviderError('capability', `dropley: the service rejected the upload as an unsupported file type (${textOf(response).slice(0, 200).replace(/\s+/g, ' ')}). Dropley enforces an unpublished extension allowlist, so this cannot be predicted locally.`, {
      status: 422,
      permanent: true,
      nextHint: 'rebuild the artifact without the rejected file types or switch providers; dropley is only usable for artifacts whose extensions happen to be on its unpublished allowlist'
    });
  }

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');

  return {
    url: publicUrl,
    shortId: payload.shortId ?? null,
    expiresAt: expiresAtFrom(payload, EXPIRY_SECONDS[expiry]),
    persistence: 'temporary',
    fileCount: files.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: { expiry, entry: 'index.html' },
    transport: 'multipart-manifest'
  };
}
