/**
 * ht-ml.app — anonymous single-document publishing.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/ht-ml-app.json`) and confirmed
 * from two egresses:
 *
 *   POST https://api.ht-ml.app/v1/sites
 *     JSON { "html_content": "..." }, no credential
 *     -> 200 { site_id, update_key, status, url, message }
 *
 * The served page was **byte-identical** with no injection, which no other anonymous host in this
 * project managed. Two consequences shape the adapter:
 *
 *  1. It publishes **one HTML document**. Referenced assets would have to be uploaded separately, under
 *     the update key, which this adapter deliberately does not do; instead it reports which referenced
 *     files were left behind, so a caller is never surprised by 404s.
 *  2. The service returns **no expiry**. `contentExpiresAt` is therefore null and labelled as
 *     "not-returned" rather than filled in from a marketing page. `update_key` is the capability
 *     credential and goes to the claim store.
 */

import { USER_AGENT } from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, jsonRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'ht-ml-app';

const INDEX = 'index.html';

/** Local files the document points at, which this adapter cannot publish. */
function unreferencedAssets(files, html) {
  const referenced = new Set();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"'#?:]+)["']/gi)) {
    const value = match[1].replace(/^\.?\//, '').replace(/^\/+/, '');
    if (value && !/^(?:https?:)?\/\//i.test(value) && !value.startsWith('data:')) referenced.add(value);
  }
  return files
    .map((file) => file.path)
    .filter((path) => path !== INDEX && referenced.has(path));
}

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  // The document must actually be HTML: a lone notes.txt is not "a single HTML document", and sending
  // it as html_content would publish the wrong thing under a URL the caller believes is a page.
  const single = files.length === 1 && /\.html?$/i.test(files[0].path) ? files[0] : null;
  const index = files.find((file) => file.path === INDEX) || single;

  if (!index) {
    throw new ProviderError('capability',
      `${id}: this provider publishes a single HTML document, and the artifact has ${files.length} files with no index.html`,
      { permanent: true });
  }

  const html = index.bytes.toString('utf8');
  const response = await jsonRequest(id, provider.endpoint, { html_content: html }, {
    headers: { 'user-agent': USER_AGENT },
    context: 'upload'
  });

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');
  const leftBehind = unreferencedAssets(files, html);

  return {
    url: publicUrl,
    siteId: payload.site_id ?? null,
    persistence: 'temporary',
    expiresAt: expiresAtFrom(payload, null),
    expiresAtSource: payload.expiresAt || payload.expires_at ? 'provider-response' : 'not-returned',
    fileCount: 1,
    bytes: index.bytes.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: {
      siteId: payload.site_id ?? null,
      status: payload.status ?? null,
      message: payload.message ?? null,
      document: INDEX,
      // Honest disclosure instead of a silent 404 later.
      referencedFilesNotUploaded: leftBehind
    },
    transport: 'json-single-page'
  };
}
