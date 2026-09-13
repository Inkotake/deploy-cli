/**
 * shiply.now — anonymous three-step publishing.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/shiply.json`) and confirmed from
 * two egresses, documented in the service's own agent index (`https://shiply.now/llms.txt`):
 *
 *   1. POST https://shiply.now/api/v1/publish  { agentName, files: [{path, size, contentType, hash}] }
 *        -> { siteUrl, slug, siteId, upload: { versionId, uploads: [{path, url, ...}], finalizeUrl },
 *             claimToken, claimUrl, expiresAt, anonymous, toUpdate, ... }
 *   2. PUT each file's raw bytes to its pre-signed upload URL
 *   3. POST upload.finalizeUrl  { "versionId": ... }   <- the site is live only after THIS call
 *
 * The third step is treated as mandatory: a create-only flow returns a URL that 404s, and reporting that
 * as a deployment would be the exact failure this project exists to prevent.
 *
 * `agentName` is required for anonymous publishes. Assets came back byte-identical; the page is not
 * byte-exact because shiply injects a claim banner and OG tags until the site is claimed — which its
 * documentation states and the measurement confirmed. Anonymous sites expire after 24 hours.
 */

import { httpRequest } from '../common.mjs';
import { USER_AGENT } from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, jsonRequest, requireJson, requireUrl } from './shared.mjs';

export const id = 'shiply';

const ANONYMOUS_TTL_SECONDS = 24 * 60 * 60;

function uploadEntryPath(entry) {
  const declared = entry.path || entry.filePath || entry.key || entry.name || null;
  return declared ? String(declared).replace(/^\/+/, '') : null;
}

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const created = await jsonRequest(id, provider.endpoint, {
    agentName: USER_AGENT,
    files: files.map((file) => ({ path: file.path, size: file.bytes.length, contentType: file.mime, hash: file.sha256 }))
  }, {
    headers: { 'user-agent': USER_AGENT },
    context: 'create'
  });

  const payload = requireJson(id, created, 'create');
  const upload = payload.upload && typeof payload.upload === 'object' ? payload.upload : payload;
  const entries = Array.isArray(upload.uploads) ? upload.uploads : [];

  if (entries.length !== files.length) {
    throw new ProviderError('server',
      `${id}: the create call returned upload URLs for ${entries.length} of ${files.length} files. Nothing was finalised.`,
      { permanent: false });
  }

  for (const entry of entries) {
    const path = uploadEntryPath(entry);
    const file = path ? files.find((candidate) => candidate.path === path) : null;
    const target = entry.url || entry.uploadUrl || entry.presignedUrl;
    if (!file || !target) {
      throw new ProviderError('server',
        `${id}: an upload entry (path ${path || 'unset'}) could not be matched to a local file or carried no upload URL. Nothing was finalised.`,
        { permanent: false });
    }
    // Pre-signed upload URLs are short-lived and host-specific, so they are not allowlist-checked — but
    // they must be HTTPS, except on loopback, where the offline test stubs live.
    const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(String(target));
    if (!loopback && !/^https:\/\//i.test(String(target))) {
      throw new ProviderError('server', `${id}: refusing to upload to a non-HTTPS url`, { permanent: false });
    }
    await httpRequest({
      url: target,
      method: 'PUT',
      headers: { 'content-type': entry.contentType || file.mime, 'content-length': String(file.bytes.length) },
      body: file.bytes,
      timeoutMs: 180000
    });
  }

  const finalizeUrl = typeof upload.finalizeUrl === 'string' && upload.finalizeUrl
    ? new URL(upload.finalizeUrl, provider.endpoint).toString()
    : null;
  if (!finalizeUrl) {
    throw new ProviderError('server', `${id}: the create call returned no upload.finalizeUrl, so the site could never go live`, { permanent: false });
  }

  const finalized = requireJson(id, await jsonRequest(id, finalizeUrl, { versionId: upload.versionId || payload.versionId }, {
    headers: { 'user-agent': USER_AGENT },
    context: 'finalize'
  }), 'finalize');

  // The finalize response owns the live state; the create response owns the credentials.
  const merged = { ...payload, ...finalized };
  for (const key of ['claimToken', 'claimUrl']) {
    if (!merged[key] && payload[key]) merged[key] = payload[key];
  }
  if (finalized.success === false) {
    throw new ProviderError('server', `${id}: finalize reported failure`, { permanent: false });
  }

  const urlValue = merged.siteUrl || merged.url;
  const publicUrl = requireUrl(id, urlValue, provider.allowedHosts, 'siteUrl');

  return {
    url: publicUrl,
    slug: merged.slug ?? payload.slug ?? null,
    siteId: payload.siteId ?? null,
    versionId: merged.currentVersionId || upload.versionId || payload.versionId || null,
    persistence: 'temporary',
    expiresAt: expiresAtFrom(merged, merged.expiresAt ? null : ANONYMOUS_TTL_SECONDS),
    expiresAtSource: merged.expiresAt ? 'provider-response' : 'documented-anonymous-lifetime',
    fileCount: files.length,
    claim: buildClaim(provider.claim, merged),
    providerDetail: {
      slug: merged.slug ?? payload.slug ?? null,
      siteId: payload.siteId ?? null,
      versionId: merged.currentVersionId || upload.versionId || null,
      finalize: { called: true, success: merged.success !== false },
      // Following the provider's own update path avoids littering a new subdomain per change.
      toUpdate: payload.toUpdate ?? null,
      injectedPage: 'the served page carries shiply\'s claim banner and OG tags until the site is claimed'
    },
    transport: 'three-step-manifest'
  };
}
