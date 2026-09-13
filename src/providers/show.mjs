/**
 * Show — `POST https://show.127.dev/upload`, multipart with a tar.gz archive.
 *
 * Show is purely ephemeral: no claim value and no edit key are returned. The archive is built
 * from the exact bytes that were hashed locally so remote verification stays meaningful.
 */

import { createTar, gzip } from '../common.mjs';
import { providerTtlSeconds } from './shared.mjs';
import * as identity from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, artifactName, expiresAtFrom, multipartRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'show';

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const archive = gzip(createTar(files.map((file) => ({ name: file.path, data: file.bytes }))));

  const caps = provider.capabilities || {};
  if (typeof caps.maxTotalBytes === 'number' && archive.length > caps.maxTotalBytes) {
    throw new ProviderError('capability', `show: the tar.gz archive is ${archive.length} bytes, above the documented ${caps.maxTotalBytes} byte limit`, { permanent: true });
  }

  const parts = [
    { name: 'file', filename: `${artifactName(manifest)}.tar.gz`, contentType: 'application/gzip', data: archive },
    { name: 'name', value: artifactName(manifest) }
  ];
  if (manifest.files.every((file) => !file.path.includes('/'))) {
    // `spa` mode is optional in the protocol; it is only requested when the artifact is flat.
    parts.push({ name: 'mode', value: 'spa' });
  }

  const response = await multipartRequest(id, provider.endpoint, parts, {
    headers: { accept: 'application/json' },
    successStatuses: [200, 201],
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');

  return {
    url: publicUrl,
    deploymentId: payload.deploymentId ?? payload.requestId ?? null,
    expiresAt: expiresAtFrom(payload, providerTtlSeconds(provider, 172800)),
    persistence: 'temporary',
    fileCount: files.length,
    claim: null, // Show returns no ownership value at all.
    providerDetail: { mode: payload.mode ?? null, createdAt: payload.createdAt ?? null, archiveBytes: archive.length },
    transport: 'multipart-targz'
  };
}
