/**
 * BrewPage — anonymous multi-file static hosting.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/brewpage.json`) and confirmed
 * from two egresses:
 *
 *   POST https://brewpage.app/api/sites
 *     multipart/form-data, one `archive` part holding the zip, no credential
 *     -> 201 { id, namespace, entryFile, link, ownerLink, fileCount, totalSizeBytes, expiresAt,
 *              tags, ownerToken, result, visibilityNotice }
 *
 * Three provider facts shape this adapter:
 *
 *  1. **A User-Agent is required on every request** (`AgentName/version`). Without it the service
 *     rejects the call, so the shared request helpers are not enough on their own.
 *  2. The served HTML is **not** byte-exact: BrewPage injects its own top bar (`showTopBar`). Assets were
 *     byte-identical in the measurement, so the registry declares `htmlExact: false` for the page while
 *     every other file stays hash-compared.
 *  3. `ownerToken` is a capability-bearing credential (edit/delete) and `ownerLink` is the management
 *     URL. Both travel through the claim store, never through stdout by default.
 */

import { createZip } from '../common.mjs';
import { USER_AGENT } from '../identity.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, multipartRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'brewpage';

/** Documented default lifetime; the service also returns its own expiresAt, which wins. */
const DEFAULT_TTL_SECONDS = 15 * 24 * 60 * 60;

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const zip = createZip(files.map((file) => ({ name: file.path, data: file.bytes, mime: file.mime })));

  const response = await multipartRequest(id, provider.endpoint, [{
    name: 'archive',
    filename: 'site.zip',
    contentType: 'application/zip',
    data: zip
  }], {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.link, provider.allowedHosts, 'link');

  return {
    url: publicUrl,
    siteId: payload.id ?? null,
    namespace: payload.namespace ?? null,
    persistence: 'temporary',
    expiresAt: expiresAtFrom(payload, DEFAULT_TTL_SECONDS),
    expiresAtSource: payload.expiresAt ? 'provider-response' : 'documented-default-ttl',
    fileCount: typeof payload.fileCount === 'number' ? payload.fileCount : files.length,
    bytes: typeof payload.totalSizeBytes === 'number' ? payload.totalSizeBytes : null,
    claim: buildClaim(provider.claim, payload),
    providerDetail: {
      id: payload.id ?? null,
      namespace: payload.namespace ?? null,
      entryFile: payload.entryFile ?? null,
      ownerLink: payload.ownerLink ? 'present (stored with the claim, not printed)' : 'not returned',
      visibilityNotice: payload.visibilityNotice ?? null,
      tags: Array.isArray(payload.tags) ? payload.tags : []
    },
    transport: 'multipart-archive'
  };
}
