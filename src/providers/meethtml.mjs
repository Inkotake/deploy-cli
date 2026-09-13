/**
 * meethtml — anonymous single-document publishing.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/meethtml.json`) and confirmed from
 * two egresses:
 *
 *   POST https://api.meethtml.com/api/v1/publish
 *     JSON { "html": "<full document>" }, no credential
 *     -> 201 { url, slug, expires_at, edit_token }
 *
 * The document came back **byte-identical with no injection** from both networks — the cleanest result
 * in this project. Anonymous pages expire after 24 hours; the response carries `expires_at`, which wins
 * over the documented lifetime. `edit_token` updates or deletes the page, so it travels through the
 * claim store and never through stdout by default.
 *
 * One document per site: referenced assets cannot be published by this adapter, so it reports which
 * referenced files were left behind instead of letting a reader discover 404s.
 */

import { USER_AGENT } from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, jsonRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'meethtml';

const INDEX = 'index.html';
/** Documented anonymous lifetime, used only when the response omits its own expiry. */
const ANONYMOUS_TTL_SECONDS = 24 * 60 * 60;

/** Local files the document points at, which a single-document host never receives. */
export function unreferencedAssets(files, html) {
  const referenced = new Set();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"'#?:]+)["']/gi)) {
    const value = match[1].replace(/^\.?\//, '').replace(/^\/+/, '');
    if (value && !/^(?:https?:)?\/\//i.test(value) && !value.startsWith('data:')) referenced.add(value);
  }
  return files.map((file) => file.path).filter((path) => path !== INDEX && referenced.has(path));
}

/** The document must be HTML: a lone notes.txt is not "a single HTML document". */
export function selectDocument(files) {
  const index = files.find((file) => file.path === INDEX);
  if (index) return index;
  const single = files.length === 1 && /\.html?$/i.test(files[0].path) ? files[0] : null;
  return single;
}

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const document = selectDocument(files);
  if (!document) {
    throw new ProviderError('capability',
      `${id}: this provider publishes a single HTML document, and the artifact has ${files.length} files with no index.html`,
      { permanent: true });
  }

  const html = document.bytes.toString('utf8');
  const response = await jsonRequest(id, provider.endpoint, { html }, {
    headers: { 'user-agent': USER_AGENT },
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');

  return {
    url: publicUrl,
    slug: payload.slug ?? null,
    persistence: 'temporary',
    expiresAt: expiresAtFrom(payload, payload.expires_at ? null : ANONYMOUS_TTL_SECONDS),
    expiresAtSource: payload.expires_at ? 'provider-response' : 'documented-anonymous-lifetime',
    fileCount: 1,
    bytes: document.bytes.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: {
      slug: payload.slug ?? null,
      document: document.path,
      referencedFilesNotUploaded: unreferencedAssets(files, html)
    },
    transport: 'json-single-page'
  };
}
