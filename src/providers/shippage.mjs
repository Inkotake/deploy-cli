/**
 * shippage.ai — anonymous single-page publishing that auto-registers the caller.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/shippage.json`) and confirmed from
 * two egresses:
 *
 *   POST https://shippage.ai/v1/publish
 *     JSON { "html": "<full document>" }, no account, no key
 *     -> 201 { ok, url, slug, expires_at, password_protected, _registration, _skill_update }
 *
 * Two provider facts shape this adapter:
 *
 *  1. The page is **rendered by the provider** at `/p/<slug>` inside its own viewer: a 241-byte upload
 *     came back as a 750-byte page and `/index.html` was 404, so nothing is byte-comparable and the
 *     registry declares `htmlExact: false`.
 *  2. The service auto-registers the calling agent on the first call and reports it in `_registration`.
 *     Those fields are the provider's own bookkeeping and are **not** a documented claim credential, so
 *     this adapter records only their PRESENCE and never treats them as a claim. Declaring a claim from
 *     an undocumented field would hand a caller something the service never promised.
 *
 * Note: this is not ship.page / shipped.page, which is a separate provider in this registry.
 */

import { USER_AGENT } from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, jsonRequest, requireJson, requireUrl } from './shared.mjs';
import { selectDocument, unreferencedAssets } from './meethtml.mjs';

export const id = 'shippage';

/** Free-tier retention documented by the provider; the response's own expires_at wins. */
const RETENTION_SECONDS = 14 * 24 * 60 * 60;

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const document = selectDocument(files);
  if (!document) {
    throw new ProviderError('capability',
      `${id}: this provider publishes a single HTML page, and the artifact has ${files.length} files with no index.html`,
      { permanent: true });
  }

  const html = document.bytes.toString('utf8');
  const response = await jsonRequest(id, provider.endpoint, { html }, {
    headers: { 'user-agent': USER_AGENT },
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  if (payload.ok === false) {
    throw new ProviderError('server', `${id}: the service reported ok=false`, { permanent: false });
  }
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');

  return {
    url: publicUrl,
    slug: payload.slug ?? null,
    persistence: 'temporary',
    expiresAt: expiresAtFrom(payload, payload.expires_at ? null : RETENTION_SECONDS),
    expiresAtSource: payload.expires_at ? 'provider-response' : 'documented-retention',
    fileCount: 1,
    bytes: document.bytes.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: {
      slug: payload.slug ?? null,
      document: document.path,
      passwordProtected: payload.password_protected === true,
      // Presence and field names only: never the values, which may be a credential.
      agentRegistration: payload._registration
        ? { present: true, fields: Object.keys(payload._registration), treatedAsClaim: false }
        : { present: false, fields: [], treatedAsClaim: false },
      servedAs: 'rendered by the provider at /p/<slug> inside its own viewer',
      referencedFilesNotUploaded: unreferencedAssets(files, html)
    },
    transport: 'json-single-page'
  };
}
