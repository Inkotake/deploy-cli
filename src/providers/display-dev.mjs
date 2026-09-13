/**
 * Display.dev — anonymous artifact publishing with a claim URL.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/display-dev.json`) and confirmed
 * from two egresses:
 *
 *   POST https://api.display.dev/v1/public/artifacts
 *     multipart/form-data, one `file` part holding the DOCUMENT TEXT (not an archive), optional `name`
 *     -> 201 { shortId, previewUrl, claimUrl, expiresAt }
 *
 * Two provider facts shape this adapter:
 *
 *  1. The preview is public but serves the provider's **own viewer page** — 43 KB for a 241-byte upload,
 *     with the uploaded document not present verbatim. The registry therefore declares
 *     `htmlExact: false`; the page is presence-checked and nothing is byte-comparable.
 *  2. The `file` part must carry text. Sending a zip makes the service answer
 *     `422 unsupported_source_encoding: Artifact source must be valid UTF-8`, which looks like a service
 *     failure and is a client error. This adapter sends `document.bytes` and nothing else.
 *
 * `claimUrl` is single-use and attaches the artifact to an account, so it goes to the claim store.
 */

import { USER_AGENT } from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, multipartRequest, requireJson, requireUrl } from './shared.mjs';
import { selectDocument, unreferencedAssets } from './meethtml.mjs';

export const id = 'display-dev';

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const document = selectDocument(files);
  if (!document) {
    throw new ProviderError('capability',
      `${id}: this provider publishes a single HTML document, and the artifact has ${files.length} files with no index.html`,
      { permanent: true });
  }

  const response = await multipartRequest(id, provider.endpoint, [{
    name: 'file',
    filename: document.path,
    contentType: 'text/html; charset=utf-8',
    data: document.bytes
  }], {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.previewUrl, provider.allowedHosts, 'previewUrl');

  return {
    url: publicUrl,
    shortId: payload.shortId ?? null,
    persistence: 'temporary',
    expiresAt: expiresAtFrom(payload, payload.expiresAt ? null : null),
    expiresAtSource: payload.expiresAt ? 'provider-response' : 'not-returned',
    fileCount: 1,
    bytes: document.bytes.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: {
      shortId: payload.shortId ?? null,
      document: document.path,
      // A disclosure, not an apology: the caller must know the bytes are not what a reader receives.
      servedAs: 'the provider viewer page; the uploaded bytes are not returned verbatim',
      referencedFilesNotUploaded: unreferencedAssets(files, document.bytes.toString('utf8'))
    },
    transport: 'multipart-single-document'
  };
}
