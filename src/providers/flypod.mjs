/**
 * flypod — a zero-auth deploy primitive: `POST` a zip, get a live URL.
 *
 * Protocol measured live on 2026-09-13 (`research/anonymous-compliance/flypod.json`):
 *   POST https://flypod.dev/sites, `content-type: application/zip`, the archive as the RAW request
 *   body, no credential  ->  200
 *   { site_id, slug, url, version_id, expires_at, manage_token, claim_token, healed, warnings,
 *     render, next_actions }
 *
 * Three properties shape this adapter:
 *
 *  1. `expires_at` is epoch **milliseconds** for an anonymous deploy and `null` once the site is owned,
 *     so it is read from the response and never assumed. Documented anonymous lifetime is 14 days.
 *  2. The served HTML is **not** byte-identical: flypod injects its own render instrumentation
 *     (`render.status: pending`, +~1070 bytes on the probe page). The registry therefore declares
 *     `htmlExact: false` for this provider and verification presence-checks the HTML while every other
 *     resource stays strictly hash-compared. Assets were byte-identical in the measurement.
 *  3. The response carries **two** capability-bearing credentials: `claim_token` (attach the deployment
 *     to an account later) and `manage_token` (redeploy, rollback, read). Both are secrets: the claim is
 *     stored like every other claim and never printed, and the manage token is deliberately **not**
 *     persisted by this adapter yet — see `providerDetail.manageToken` for the honest note. Persisting
 *     several credentials for one deployment is a claims-store change, tracked separately rather than
 *     half-done here.
 */

import { createZip } from '../common.mjs';
import { ProviderError } from './errors.mjs';
import { artifactFiles, buildClaim, expiresAtFrom, requestOrThrow, requireJson, requireUrl } from './shared.mjs';

export const id = 'flypod';

/** Anonymous lifetime documented by the provider, used only when the response omits `expires_at`. */
const ANONYMOUS_TTL_SECONDS = 14 * 24 * 60 * 60;

export async function deploy({ provider, manifest }) {
  const files = artifactFiles(manifest);
  const zip = createZip(files.map((file) => ({ name: file.path, data: file.bytes, mime: file.mime })));

  const response = await requestOrThrow(id, {
    url: provider.endpoint,
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      accept: 'application/json',
      'content-length': String(zip.length)
    },
    body: zip,
    timeoutMs: 180000
  }, 'upload');

  const payload = requireJson(id, response, 'upload');
  const publicUrl = requireUrl(id, payload.url, provider.allowedHosts, 'url');

  return {
    url: publicUrl,
    siteId: payload.site_id ?? null,
    versionId: payload.version_id ?? null,
    expiresAt: expiresAtFrom(payload, ANONYMOUS_TTL_SECONDS),
    // The provider reports when the expiry came from the response rather than the documented default.
    expiresAtSource: payload.expires_at ? 'provider-response' : 'documented-anonymous-lifetime',
    persistence: 'temporary',
    fileCount: Array.isArray(payload.files) ? payload.files.length : files.length,
    claim: buildClaim(provider.claim, payload),
    providerDetail: {
      siteId: payload.site_id ?? null,
      versionId: payload.version_id ?? null,
      slug: payload.slug ?? null,
      urlSource: 'provider-response',
      renderStatus: payload.render && payload.render.status ? payload.render.status : null,
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      nextActions: Array.isArray(payload.next_actions) ? payload.next_actions.map((action) => action && action.name).filter(Boolean) : [],
      manageToken: payload.manage_token
        ? 'present but NOT stored by this adapter: redeploy and rollback of this site are unavailable until the claims store can hold several credentials per deployment'
        : 'not returned'
    },
    transport: 'http-raw-zip'
  };
}

/** Exported for tests: the provider documents a 14-day anonymous lifetime. */
export function documentedAnonymousTtlSeconds() {
  return ANONYMOUS_TTL_SECONDS;
}

/** A response that claims success but carries no URL is a server failure, not a deployment. */
export function assertUsablePayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.url) {
    throw new ProviderError('server', `${id}: the response carried no url field`, { permanent: false });
  }
  return payload;
}
