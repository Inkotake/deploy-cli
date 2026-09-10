/**
 * Remote verification.
 *
 * An HTTP 2xx from an upload is only a *candidate* success. Nothing is reported as deployed until
 * the bytes served from the public URL match the local manifest.
 *
 * Rules enforced here:
 *  - the root URL must answer with a successful status and an HTML document;
 *  - every deployed resource is fetched with GET (never HEAD alone) and compared by SHA-256;
 *  - when the artifact is at most 20 MiB every file is compared, otherwise index.html, all JS,
 *    all CSS, all .glb/.gltf/.bin and the three largest remaining files are compared — the result
 *    reports `filesExpected` (all files) next to `filesRequired` (what this run actually compared)
 *    so a partial check can never be read as a complete one; `--verify-all` forces every file;
 *  - a resource that answers with HTML when JS/CSS/GLB/JSON was expected is a failure even at 200.
 *
 * HTML policy (`htmlPolicy`), taken from the provider's registry entry:
 *  - `strict` (default, and the only policy for providers that serve bytes exactly): HTML is
 *    compared byte for byte like everything else.
 *  - `presence-only`: the provider may rewrite HTML on the wire (ShipStatic appends a
 *    cache-busting query to asset URLs, here.now injects Open Graph meta tags, aft.page injects a
 *    whole wrapper page). The served HTML must still be HTML with a successful status and must
 *    not be an error page, and when it happens to match byte for byte it is counted; otherwise it
 *    is recorded in `htmlNotCompared` as not hash-verified. Non-HTML resources stay strictly
 *    SHA-256 compared, and a host that serves an HTML fallback for a non-HTML resource still fails.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { baseContentType, httpRequest } from './common.mjs';

export const FULL_VERIFY_LIMIT_BYTES = 20 * 1024 * 1024;
export const BINARY_EXTENSIONS = ['.glb', '.gltf', '.bin', '.wasm'];
export const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css'];
export const JSON_EXTENSIONS = ['.json', '.webmanifest'];
export const HTML_POLICIES = ['strict', 'presence-only'];
const HTML_EXTENSIONS = ['.html', '.htm'];
const LARGE_TIMEOUT_MS = 180000;
const SMALL_TIMEOUT_MS = 60000;

export function isHtmlPath(relativePath) {
  return HTML_EXTENSIONS.includes(path.extname(relativePath).toLowerCase());
}

export function selectVerificationTargets(manifest, options = {}) {
  const limit = options.fullLimitBytes ?? FULL_VERIFY_LIMIT_BYTES;
  if (options.full === true || manifest.totalBytes <= limit) {
    return { strategy: 'all-files', limitBytes: limit, targets: manifest.files.map((file) => file.path) };
  }
  const targets = new Set();
  const isExt = (file, list) => list.includes(path.extname(file).toLowerCase());
  for (const file of manifest.files) {
    if (file.path === 'index.html') targets.add(file.path);
    else if (isExt(file.path, CODE_EXTENSIONS)) targets.add(file.path);
    else if (isExt(file.path, BINARY_EXTENSIONS)) targets.add(file.path);
    else if (isHtmlPath(file.path)) targets.add(file.path);
  }
  const ranked = [...manifest.files]
    .filter((file) => !targets.has(file.path))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);
  for (const file of ranked) targets.add(file.path);
  return { strategy: 'selective', limitBytes: limit, targets: [...targets] };
}

function joinUrl(base, relative) {
  const root = base.endsWith('/') ? base : base + '/';
  return new URL(relative.split('/').map(encodeURIComponent).join('/'), root).toString();
}

function stronglyTyped(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return CODE_EXTENSIONS.includes(ext) || BINARY_EXTENSIONS.includes(ext) || JSON_EXTENSIONS.includes(ext) || ext === '.svg' || ext === '.map';
}

function looksLikeHtml(contentType, bodyBuffer) {
  if (/^text\/html/.test(contentType)) return true;
  if (!contentType || contentType === 'application/octet-stream') {
    const head = bodyBuffer.subarray(0, 512).toString('utf8').trimStart().slice(0, 200).toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html');
  }
  return false;
}

/** An HTML error page served with 200 is a failure; this catches the common SPA-fallback case. */
export function htmlFallbackDetected(relativePath, status, contentType, bodyBuffer) {
  if (isHtmlPath(relativePath)) return null;
  if (status < 200 || status >= 300) return null;
  if (!looksLikeHtml(contentType, bodyBuffer)) return null;
  if ([...JSON_EXTENSIONS, '.map'].includes(path.extname(relativePath).toLowerCase()) && /^\s*[[{]/.test(bodyBuffer.toString('utf8').slice(0, 64))) {
    return null;
  }
  return `served an HTML document for ${relativePath}, which is not an HTML resource (content-type ${contentType || 'unknown'})`;
}

/** Detect a host-authored error page inside an HTML resource. */
function errorPageMessage(bodyBuffer) {
  const text = bodyBuffer.toString('utf8').slice(0, 4000);
  if (/ENOTFOUND|404 Not Found|Deployment not found|This site can’t be reached|This site can't be reached|No such deployment/i.test(text)) {
    return 'the served HTML looks like a host error page';
  }
  return null;
}

export async function fetchResource(url, options = {}) {
  return httpRequest({
    url,
    method: 'GET',
    headers: { accept: '*/*', 'cache-control': 'no-cache' },
    timeoutMs: options.timeoutMs ?? SMALL_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? 512 * 1024 * 1024
  });
}

/**
 * Verify a deployment. `manifest` is the local artifact manifest and `publicUrl` must be the URL
 * exactly as the provider returned it.
 */
export async function verifyDeployment({ publicUrl, manifest, options = {} }) {
  const started = Date.now();
  const htmlPolicy = HTML_POLICIES.includes(options.htmlPolicy) ? options.htmlPolicy : 'strict';
  const rootResponse = await fetchResource(publicUrl, { timeoutMs: LARGE_TIMEOUT_MS });
  const rootContentType = baseContentType(rootResponse);
  const rootBody = rootResponse.body || Buffer.alloc(0);
  const rootIsHtml = looksLikeHtml(rootContentType, rootBody);

  const problems = [];
  if (rootResponse.status < 200 || rootResponse.status >= 300) {
    problems.push(`the root URL answered HTTP ${rootResponse.status}`);
  }
  if (!rootIsHtml) {
    problems.push(`the root URL did not answer with HTML (content-type ${rootContentType || 'unknown'})`);
  }
  if (problems.length) {
    return finish({
      passed: false,
      strategy: 'root',
      htmlPolicy,
      publicUrl,
      problems,
      filesExpected: manifest.fileCount,
      filesVerified: 0,
      bytesVerified: 0,
      rootStatus: rootResponse.status,
      rootContentType,
      startedAt: started
    });
  }

  const selection = selectVerificationTargets(manifest, options);
  let filesVerified = 0;
  let bytesVerified = 0;
  let htmlPresenceChecked = 0;
  const mismatches = [];
  const failures = [];
  const htmlNotCompared = [];

  for (const relative of selection.targets) {
    const record = manifest.byRelative.get(relative);
    if (!record) continue;
    const isHtml = isHtmlPath(relative);
    let response;
    try {
      response = await fetchResource(joinUrl(publicUrl, relative), {
        timeoutMs: isHtml || record.record.bytes > 10 * 1024 * 1024 ? LARGE_TIMEOUT_MS : SMALL_TIMEOUT_MS
      });
    } catch (cause) {
      failures.push({ path: relative, kind: 'fetch', detail: cause && cause.message ? cause.message : String(cause) });
      continue;
    }
    const contentType = baseContentType(response);
    const body = response.body || Buffer.alloc(0);
    if (response.status === 404) {
      failures.push({ path: relative, kind: 'missing', detail: 'HTTP 404', status: response.status });
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      failures.push({ path: relative, kind: 'status', detail: `HTTP ${response.status}`, status: response.status });
      continue;
    }
    const fallback = htmlFallbackDetected(relative, response.status, contentType, body);
    if (fallback) {
      failures.push({ path: relative, kind: 'html-fallback', detail: fallback, status: response.status, contentType });
      continue;
    }

    const remoteHash = hashOf(body);
    const hashMatches = remoteHash === record.record.sha256;

    if (isHtml) {
      const errorPage = errorPageMessage(body);
      if (errorPage) {
        failures.push({ path: relative, kind: 'error-page', detail: errorPage, status: response.status, contentType });
        continue;
      }
      if (!looksLikeHtml(contentType, body)) {
        failures.push({ path: relative, kind: 'wrong-content-type', detail: `expected HTML for ${relative} but the host served ${contentType || 'unknown'}`, status: response.status, contentType });
        continue;
      }
      if (hashMatches) {
        filesVerified += 1;
        bytesVerified += body.length;
      } else if (htmlPolicy === 'presence-only') {
        // Presence, status and content type are confirmed above; the bytes are recorded but not
        // counted as a verified hash, so the result can never claim the HTML was byte-verified.
        htmlPresenceChecked += 1;
        htmlNotCompared.push({ path: relative, localBytes: record.record.bytes, remoteBytes: body.length, detail: 'served HTML differs from the uploaded bytes (the provider rewrites HTML on the wire) and was not hash-verified under the presence-only policy' });
      } else {
        mismatches.push({
          path: relative,
          kind: 'sha256',
          detail: `local ${record.record.sha256.slice(0, 16)}… (${record.record.bytes} bytes) vs remote ${remoteHash.slice(0, 16)}… (${body.length} bytes)`,
          status: response.status,
          contentType
        });
      }
      continue;
    }

    if (!hashMatches) {
      mismatches.push({
        path: relative,
        kind: 'sha256',
        detail: `local ${record.record.sha256.slice(0, 16)}… (${record.record.bytes} bytes) vs remote ${remoteHash.slice(0, 16)}… (${body.length} bytes)`,
        status: response.status,
        contentType
      });
      continue;
    }
    filesVerified += 1;
    bytesVerified += body.length;
  }

  const passed = mismatches.length === 0 && failures.length === 0;

  return finish({
    passed,
    strategy: selection.strategy,
    htmlPolicy,
    publicUrl,
    problems: [],
    mismatches,
    failures,
    htmlNotCompared,
    htmlPresenceChecked,
    filesExpected: manifest.fileCount,
    filesRequired: selection.targets.length,
    filesVerified,
    bytesVerified,
    rootStatus: rootResponse.status,
    rootContentType,
    startedAt: started
  });
}

function hashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function finish(result) {
  const expected = result.filesExpected || 0;
  const verified = result.filesVerified || 0;
  const required = result.filesRequired ?? expected;
  const presenceChecked = result.htmlPresenceChecked || 0;
  const htmlNotCompared = result.htmlNotCompared || [];
  return {
    passed: result.passed === true,
    method: 'http-sha256',
    strategy: result.strategy,
    htmlPolicy: result.htmlPolicy,
    url: result.publicUrl,
    rootStatus: result.rootStatus,
    rootContentType: result.rootContentType,
    filesExpected: expected,
    filesRequired: required,
    filesVerified: verified,
    filesPresenceChecked: presenceChecked,
    bytesVerified: result.bytesVerified || 0,
    // Only true when every required resource was hash-compared, so a presence-only HTML check can
    // never be mistaken for a byte-complete verification.
    hashComplete: verified >= required,
    htmlExact: htmlNotCompared.length === 0,
    htmlNotCompared,
    mismatches: result.mismatches || [],
    failures: result.failures || [],
    problems: result.problems || [],
    durationMs: Date.now() - (result.startedAt || Date.now()),
    browserVerified: false,
    note: verificationNote(result, { verified, required, presenceChecked, htmlNotCompared })
  };
}

/**
 * The human sentence attached to every result. It must never let a partial check read as a
 * complete one: above the fast-verification threshold only a subset of files is compared, and the
 * note says so instead of leaving that fact buried in two numeric fields.
 */
function verificationNote(result, counts) {
  const parts = [];
  if (result.strategy === 'selective') {
    parts.push(`only ${counts.required} of ${result.filesExpected} files were compared (the artifact is above the ${FULL_VERIFY_LIMIT_BYTES} byte full-verification threshold; pass --verify-all to compare every file)`);
  } else {
    parts.push(`${counts.verified} of ${counts.required} required resources were hash-compared`);
  }
  if (counts.htmlNotCompared.length) {
    parts.push(`${counts.presenceChecked} HTML resource(s) were presence-checked only (htmlPolicy=${result.htmlPolicy})`);
  }
  parts.push('no browser rendering was performed');
  return `${parts.join('; ')}.`;
}

/** Human-readable one-liner used outside --json mode. */
export function describeVerification(verification) {
  if (verification.passed) {
    return `verified ${verification.filesVerified} of ${verification.filesRequired} required resources by ${verification.method} (${verification.bytesVerified} bytes)${verification.htmlExact === false ? `; ${verification.filesPresenceChecked} HTML resource(s) were presence-checked only (htmlPolicy=${verification.htmlPolicy})` : ''}`;
  }
  const reasons = [
    ...verification.problems,
    ...verification.failures.map((failure) => `${failure.path}: ${failure.detail}`),
    ...verification.mismatches.map((mismatch) => `${mismatch.path}: sha256 mismatch (${mismatch.detail})`)
  ];
  return `verification failed: ${reasons.slice(0, 5).join('; ')}${reasons.length > 5 ? ` (+${reasons.length - 5} more)` : ''}`;
}

export function targetSelectionNote(manifest) {
  const selection = selectVerificationTargets(manifest);
  return selection.strategy === 'all-files'
    ? `all ${manifest.fileCount} files (artifact is at or below the 20 MiB full-verification limit)`
    : `${selection.targets.length} of ${manifest.fileCount} files (index.html, JS, CSS, model files and the three largest remaining files)`;
}
