/**
 * here.now — the only multi-step protocol.
 *
 * Live-verified contract (see `notes` in config/providers.json):
 *   1. POST https://here.now/api/v1/publish with
 *      `{ files: [{ path, size, contentType }] }` and read
 *      `upload.uploads[]`, `upload.versionId`, `upload.finalizeUrl`, `siteUrl`,
 *      `publishStatus.expiresAt`, `claimToken`, `claimUrl`.
 *   2. PUT every file to the presigned *.r2.cloudflarestorage.com URL using exactly the headers
 *      the service returned. Headers are passed through verbatim: re-encoding or reordering a
 *      presigned signature breaks it. Egress to both hosts is required.
 *   3. POST the returned finalizeUrl with `{ versionId }`.
 *
 * `upload.finalizeUrl` is used when the service supplies it; the documented
 * `/api/v1/publish/{slug}/finalize` shape is used as the fallback. A versionId is mandatory —
 * finalize with a null versionId is rejected with 400 `invalid_type`, so the deployment fails
 * before the network call instead of sending a request that cannot succeed.
 *
 * Finalize is idempotent by versionId, so a replayed finalize is accepted. A 409
 * `finalize_in_flight` carries `Retry-After` and is honoured exactly once, never busy-looped.
 */

import { sleep, textOf, trace } from '../common.mjs';
import { providerTtlSeconds } from './shared.mjs';
import * as identity from '../identity.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, jsonRequest, requestOrThrow, requireJson, requireUrl } from './shared.mjs';

export const id = 'here-now';

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const baseUrl = provider.endpoint; // https://here.now/api/v1/publish
  const origin = new URL(baseUrl).origin;

  const createResponse = await jsonRequest(id, baseUrl, {
    files: files.map((file) => ({ path: file.path, size: file.bytes.length, contentType: file.mime }))
  }, { successStatuses: [200, 201], context: 'create' });

  const created = requireJson(id, createResponse, 'create');
  const upload = created.upload && typeof created.upload === 'object' ? created.upload : created;
  const slug = created.slug || upload.slug || null;
  const versionId = upload.versionId || created.versionId || null;
  const uploads = collectUploads(upload, created);

  if (!slug) {
    throw new ProviderError('server', `${id}: the create response had no slug, so the public URL cannot be determined`, { permanent: false });
  }
  if (!versionId) {
    throw new ProviderError('server', `${id}: the create response carried no upload.versionId, which finalize requires. Nothing was uploaded.`, { permanent: false });
  }
  if (!uploads.length) {
    throw new ProviderError('server', `${id}: the create response carried no upload.uploads[] entries, so no file could be sent. Nothing was uploaded.`, { permanent: false });
  }

  const unmatched = files.filter((file) => !uploads.some((entry) => matches(entry, file)));
  if (unmatched.length) {
    // Uploading only part of an artifact would produce a silently incomplete site.
    throw new ProviderError('server', `${id}: the service returned upload URLs for ${uploads.length} of ${files.length} files (missing ${unmatched.slice(0, 3).map((file) => file.path).join(', ')}). Nothing was finalised.`, { permanent: false });
  }

  for (const entry of uploads) {
    const file = matchUpload(entry, files);
    const headers = normalizeHeaders(entry.headers || entry.signedHeaders || {});
    // The transport sets content-length itself; a stale signed length would break the PUT.
    delete headers['content-length'];
    delete headers.host;
    await putFile(origin, entry, file, headers);
  }

  const finalizeUrl = typeof upload.finalizeUrl === 'string' && upload.finalizeUrl
    ? new URL(upload.finalizeUrl, origin).toString()
    : `${origin}/api/v1/publish/${encodeURIComponent(slug)}/finalize`;

  const finalizePayload = await finalize(finalizeUrl, versionId, created);

  const urlValue = finalizePayload.siteUrl || finalizePayload.url || created.siteUrl || created.url || null;
  if (!urlValue) {
    throw new ProviderError('server', `${id}: no public URL was returned by the service. No URL is derived from the slug.`, { permanent: false });
  }
  const publicUrl = requireUrl(id, urlValue, provider.allowedHosts, 'siteUrl');

  const expirySource = finalizePayload.publishStatus || created.publishStatus || {};
  const claimSource = { ...created, ...finalizePayload };
  const ttlSeconds = providerTtlSeconds(provider, 86400);

  return {
    url: publicUrl,
    slug,
    versionId,
    expiresAt: expiresAtFrom({ expiresAt: expirySource.expiresAt ?? claimSource.expiresAt }, ttlSeconds),
    persistence: 'temporary',
    fileCount: files.length,
    uploadedCount: uploads.length,
    claim: buildClaim(provider.claim, claimSource),
    providerDetail: {
      publishStatus: expirySource.state ?? null,
      ownership: expirySource.ownership ?? null,
      persistenceKind: expirySource.persistence ?? null,
      addedToProfile: finalizePayload.addedToProfile === true,
      alreadyPresent: 0,
      r2Host: safeHost(uploads[0].uploadUrl || uploads[0].url)
    },
    transport: 'multistep'
  };
}

function collectUploads(upload, created) {
  const candidates = [];
  if (Array.isArray(upload.uploads)) candidates.push(...upload.uploads);
  if (Array.isArray(created.uploads)) candidates.push(...created.uploads);
  if (Array.isArray(created.files)) {
    for (const file of created.files) {
      if (file && (file.uploadUrl || file.url || file.presignedUrl)) candidates.push(file);
    }
  }
  return candidates.filter((entry) => entry && (entry.uploadUrl || entry.url || entry.presignedUrl));
}

function entryPath(entry) {
  const declared = entry.path || entry.filePath || entry.key || entry.name || null;
  return declared ? String(declared).replace(/^\/+/, '') : null;
}

function matches(entry, file) {
  const declared = entryPath(entry);
  return declared === file.path;
}

function matchUpload(entry, files) {
  const declared = entryPath(entry);
  if (!declared) {
    throw new ProviderError('server', `${id}: an upload entry has no path, so it cannot be matched to a local file`, { permanent: false });
  }
  const file = files.find((candidate) => candidate.path === declared);
  if (!file) {
    throw new ProviderError('server', `${id}: the service returned an upload URL for ${declared}, which is not part of this artifact`, { permanent: false });
  }
  return file;
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

async function putFile(origin, entry, file, headers) {
  const target = entry.uploadUrl || entry.url || entry.presignedUrl;
  let parsed;
  try {
    parsed = new URL(target, origin);
  } catch {
    throw new ProviderError('server', `${id}: the upload URL returned by the service is not a valid URL`, { permanent: false });
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'here.now' || host.endsWith('.here.now') || host === 'r2.cloudflarestorage.com' || host.endsWith('.r2.cloudflarestorage.com');
  if (!allowed) {
    throw new ProviderError('server', `${id}: the service asked to upload to an unexpected host (${host}), which is outside the documented R2 and here.now hosts`, { permanent: false });
  }

  const response = await requestOrThrow(id, {
    url: parsed.toString(),
    method: 'PUT',
    headers,
    body: file.bytes,
    timeoutMs: 300000,
    successStatuses: [200, 201, 204]
  }, `upload ${file.path}`);

  if (![200, 201, 204].includes(response.status)) {
    throw new ProviderError('server', `${id}: unexpected status ${response.status} uploading ${file.path}: ${textOf(response).slice(0, 200)}`, { status: response.status });
  }
}

async function finalize(finalizeUrl, versionId, created) {
  const body = { versionId };
  if (created.baseVersionId) body.baseVersionId = created.baseVersionId;
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      const response = await requestOrThrow(id, {
        url: finalizeUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: Buffer.from(JSON.stringify(body), 'utf8'),
        timeoutMs: 180000,
        successStatuses: [200, 201]
      }, 'finalize');
      return requireJson(id, response, 'finalize');
    } catch (cause) {
      if (!(cause instanceof ProviderError)) throw cause;
      const text = String(cause.detail || cause.message);
      const conflict = cause.status === 409;
      if (conflict && /version_conflict/i.test(text)) {
        throw new ProviderError('server', `${id}: the service reported a stale base version (version_conflict); a fresh create is required`, { permanent: false });
      }
      if (conflict && /finalize_in_flight/i.test(text) && attempt < 2) {
        // Honour Retry-After exactly once. Never busy-loop: a second 409 fails over to another host.
        const wait = cause.retryAfterMs != null ? cause.retryAfterMs : 5000;
        trace(`${id}: finalize already in flight; waiting exactly ${wait} ms as instructed by Retry-After`);
        await sleep(wait);
        continue;
      }
      throw cause;
    }
  }
  throw new ProviderError('server', `${id}: finalize did not complete`, { permanent: false });
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
