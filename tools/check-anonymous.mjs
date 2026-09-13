#!/usr/bin/env node
/**
 * Anonymous-compliance harness — NOT part of the CLI.
 *
 * WHY: "it uploaded" is not "a reader can open it". Every login-free candidate is judged here by the
 * same procedure, so candidates can be compared instead of argued about:
 *
 *   1. build a fixture with a nonce (index.html + assets/app.js + assets/app.css) and hash it locally
 *   2. package it the way the candidate accepts it and upload it anonymously
 *   3. capture the response, masking anything that looks like a credential
 *   4. read the result back — root, HTML and both assets — and compare SHA-256 with the local bytes
 *   5. write a record that follows research/received-anonymous-provider-evidence.schema.json
 *
 * Classification (from the received research package):
 *   independent-public      upload + independent reads of HTML and assets all pass
 *   partial-preview         the root loads but a required asset does not
 *   network-bound-preview   readable only from the deploying egress
 *   login-free-upload-only  upload works, no reader can open the result
 *
 * A candidate may only be enabled in the registry at `independent-public`, which requires a read from
 * a second network. This harness records `crossEgressRead: null` when that was not possible, and the
 * conservative verdict stands.
 *
 * Usage: node tools/check-anonymous.mjs <candidate-id> [...]
 *        node tools/check-anonymous.mjs --list
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildMultipart, createZip, httpRequest } from '../src/common.mjs';
import { inspectArtifact } from '../src/inspect.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'research', 'anonymous-compliance');
const CHECKED_AT = new Date().toISOString().slice(0, 10);

/**
 * One row per candidate. `endpoint` + `field` are what makes it automatable at all; a candidate whose
 * anonymous upload is browser-only does not belong here (it belongs in the research matrix).
 */
export const CANDIDATES = {
  flypod: {
    label: 'flypod',
    docs: 'https://docs.flypod.dev/docs/api/http',
    endpoint: 'https://flypod.dev/sites',
    liveness: 'https://flypod.dev/healthz',
    bodyStyle: 'raw',
    artifactModel: 'archive',
    publisherAuth: 'generated-secret',
    notes: 'POST the zip as the raw request body with content-type application/zip; anonymous unless an account session is sent; returns url, site_id, version_id, expires_at (epoch ms when anonymous), manage_token and claim_token; anonymous sites expire after 14 days'
  },
  dropcat: {
    label: 'DropCat',
    docs: 'https://drop.cat/help/',
    endpoint: 'https://api.drop.cat/deploy',
    liveness: 'https://drop.cat/',
    field: 'site',
    filename: 'site.zip',
    bodyStyle: 'multipart',
    artifactModel: 'archive',
    publisherAuth: 'generated-secret',
    notes: 'ZIP or TAR.GZ with index.html at the root; anonymous deploy returns a one-time API key; documented 7-day anonymous lifetime, 3 sites / 50 MB / 1000 files / 5 deploys per hour per IP'
  },
  sitebin: {
    label: 'Sitebin',
    docs: 'https://sitebin.io/',
    endpoint: 'https://app.sitebin.io/api/sites',
    liveness: 'https://sitebin.io/',
    field: 'files',
    filename: 'index.html',
    contentType: 'text/html; charset=utf-8',
    bodyStyle: 'multipart',
    artifactModel: 'directory',
    publisherAuth: 'none',
    notes: 'the documented curl example sends a single index.html as the `files` field; the page also says that call is for signed-in users, so whether the anonymous tier accepts it is exactly what this probe answers; anonymous sites expire after 24 hours'
  },
  brewpage: {
    label: 'BrewPage',
    docs: 'https://brewpage.app/api',
    endpoint: 'https://brewpage.app/api/sites',
    liveness: 'https://brewpage.app/api/help',
    field: 'archive',
    filename: 'site.zip',
    bodyStyle: 'multipart',
    artifactModel: 'archive',
    publisherAuth: 'generated-secret',
    headers: { 'user-agent': 'vpublish-compliance/0.1 (+https://github.com/Inkotake/deploy-cli)' },
    notes: 'multi-file site: POST /api/sites with the archive as the `archive` part; publish auth is none and every POST returns an ownerToken; User-Agent is required on every request; TTL is 15 days by default and 30 days maximum, overridable with a ttl parameter'
  },
  'ht-ml-app': {
    label: 'ht-ml.app',
    docs: 'https://api.ht-ml.app/v1/help',
    endpoint: 'https://api.ht-ml.app/v1/sites',
    liveness: 'https://api.ht-ml.app/v1/help',
    bodyStyle: 'json-html',
    artifactModel: 'single-html',
    publisherAuth: 'generated-secret',
    assetExpectations: 'none',
    notes: 'POST /v1/sites with {"html_content": ...} and no auth returns site_id, update_key and url; the page warns that everything published is public and may be crawled; a single HTML document per site, with referenced assets uploaded separately under the update key'
  },
  meethtml: {
    label: 'meethtml',
    docs: 'https://meethtml.com/docs',
    endpoint: 'https://api.meethtml.com/api/v1/publish',
    liveness: 'https://meethtml.com/docs',
    field: 'html',
    bodyStyle: 'json-doc',
    artifactModel: 'single-html',
    publisherAuth: 'generated-secret',
    assetExpectations: 'none',
    notes: 'POST /api/v1/publish with the full HTML document in a `html` field and no account: returns url, slug, expires_at and edit_token. Anonymous pages expire after 24 hours, the page limit is 5 MB, and anonymous publishing is rate limited to 200 requests/hour per IP'
  },
  'display-dev': {
    label: 'Display.dev',
    docs: 'https://display.dev/docs/claimable',
    endpoint: 'https://api.display.dev/v1/public/artifacts',
    liveness: 'https://display.dev/docs/claimable',
    field: 'file',
    filename: 'index.html',
    contentType: 'text/html; charset=utf-8',
    partSource: 'index.html',
    bodyStyle: 'multipart',
    artifactModel: 'single-html',
    publisherAuth: 'generated-secret',
    assetExpectations: 'none',
    notes: 'POST /v1/public/artifacts with the document as the `file` part and an optional `name`: returns shortId, previewUrl, claimUrl and expiresAt. Unclaimed artifacts serve the preview URL for 0-30 days; anonymous artifacts are noindex; 50 MB limit'
  },
  shiply: {
    label: 'shiply.now',
    docs: 'https://shiply.now/llms.txt',
    endpoint: 'https://shiply.now/api/v1/publish',
    liveness: 'https://shiply.now/docs',
    bodyStyle: 'three-step',
    agentName: 'vpublish-compliance/0.1',
    artifactModel: 'directory',
    publisherAuth: 'generated-secret',
    notes: 'POST a file manifest to /api/v1/publish with no account, PUT each file to the returned upload URL, then POST upload.finalizeUrl with the versionId: the site is live only after finalize. Anonymous sites expire after 24h and the response carries claimUrl + claimToken; until claimed, the provider documents that it injects a claim banner and OG tags into the page'
  },
  shippage: {
    label: 'shippage.ai',
    docs: 'https://shippage.ai/llms.txt',
    endpoint: 'https://shippage.ai/v1/publish',
    liveness: 'https://shippage.ai/docs',
    field: 'html',
    bodyStyle: 'json-doc',
    artifactModel: 'single-html',
    publisherAuth: 'generated-secret',
    assetExpectations: 'none',
    notes: 'POST /v1/publish with {"html": ...}: the agent auto-registers on the first call. Free tier is 20 publishes per month, 14-day retention and 500 KB per page. This is a different service from ship.page/shipped.page, which the registry already has as ship-page'
  }
};

function fixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anon-${label}-`));
  const nonce = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>anon compliance ${nonce}</title>`
    + '<link rel="stylesheet" href="assets/app.css"></head><body>'
    + `<h1>${nonce}</h1><script src="assets/app.js"></script></body></html>\n`);
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), `window.__anonNonce = "${nonce}";\n`);
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), `body::after { content: "${nonce}"; }\n`);
  return { dir, nonce };
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Mask credential-shaped values while keeping their shape, so an evidence file is safe to commit. */
function redact(value, key = '') {
  if (typeof value === 'string') {
    if (/key|token|secret|password|credential/i.test(key) && value.length > 6) {
      return `${value.slice(0, 3)}…(${value.length} chars)`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

async function readResource(url) {
  try {
    const response = await httpRequest({ url, method: 'GET', headers: { accept: '*/*', 'cache-control': 'no-cache' }, timeoutMs: 30000 });
    return {
      status: response.status,
      contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
      bytes: response.body.length,
      sha256: sha256(response.body),
      body: response.body
    };
  } catch (cause) {
    return { status: 0, error: cause.message, bytes: 0, sha256: null, body: Buffer.alloc(0) };
  }
}

/**
 * Read the root, retrying briefly: a brand-new subdomain may not be routable the instant the upload
 * returns, and classifying that as "unreadable" would be a measurement error rather than a finding.
 */
async function readRootWithRetry(url, delays = [0, 5000, 15000]) {
  let last = null;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    last = await readResource(url);
    if (last.status === 200) return { ...last, attempts: delays.indexOf(delay) + 1 };
  }
  return { ...last, attempts: delays.length };
}

/** Is the platform itself alive? An upload that "succeeds" against a dead platform is not a service. */
async function liveness(candidate) {
  if (!candidate.liveness) return null;
  const response = await readResource(candidate.liveness);
  return {
    url: candidate.liveness,
    status: response.status,
    bytes: response.bytes,
    text: response.body ? response.body.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : null
  };
}

/**
 * Three-step publish: declare a manifest, PUT each file to the pre-signed URL the service returns, then
 * finalize. The site is not live until the third call — a probe that stops after two would report a
 * failure the service never had, and one that trusts the create response would report a URL that 404s.
 */
async function runThreeStep(candidate, manifest, nonce) {
  const files = [...manifest.byRelative.entries()].map(([rel, entry]) => ({
    path: rel,
    size: entry.record.bytes,
    contentType: entry.record.mime,
    hash: entry.record.sha256
  }));
  const body = Buffer.from(JSON.stringify({ agentName: candidate.agentName || 'vpublish-compliance/0.1', files, ...(candidate.extraBody || {}) }), 'utf8');
  const created = await httpRequest({
    url: candidate.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(body.length), ...(candidate.headers || {}) },
    body,
    timeoutMs: 120000
  });

  let payload = null;
  try {
    payload = JSON.parse(created.body.toString('utf8'));
  } catch {
    payload = null;
  }
  const steps = [{ step: 'create', status: created.status, fields: payload ? Object.keys(payload) : [] }];
  if (!payload) return { upload: created, payload: null, steps };

  const upload = payload.upload && typeof payload.upload === 'object' ? payload.upload : payload;
  const entries = Array.isArray(upload.uploads) ? upload.uploads : [];
  const puts = [];
  for (const entry of entries) {
    const rel = entry.path || entry.filePath || entry.key || entry.name || null;
    const local = rel ? manifest.byRelative.get(String(rel).replace(/^\/+/, '')) : null;
    const target = entry.url || entry.uploadUrl || entry.presignedUrl;
    if (!local || !target) {
      puts.push({ path: rel, status: 0, error: 'no matching local file or no upload url' });
      continue;
    }
    const put = await httpRequest({
      url: target,
      method: 'PUT',
      headers: { 'content-type': entry.contentType || local.record.mime, 'content-length': String(local.bytes.length) },
      body: local.bytes,
      timeoutMs: 120000
    });
    puts.push({ path: rel, status: put.status });
  }
  steps.push({ step: 'upload', puts });

  const finalizeUrl = typeof upload.finalizeUrl === 'string' && upload.finalizeUrl
    ? new URL(upload.finalizeUrl, candidate.endpoint).toString()
    : null;
  let finalized = null;
  if (finalizeUrl) {
    const finalBody = Buffer.from(JSON.stringify({ versionId: upload.versionId || payload.versionId }), 'utf8');
    const response = await httpRequest({
      url: finalizeUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(finalBody.length) },
      body: finalBody,
      timeoutMs: 120000
    });
    try {
      finalized = JSON.parse(response.body.toString('utf8'));
    } catch {
      finalized = null;
    }
    steps.push({ step: 'finalize', status: response.status, fields: finalized ? Object.keys(finalized) : [] });
  }

  // The finalize response owns the live URL; the create response owns the credentials, so merge both and
  // never let a missing field in one erase a present field in the other.
  const merged = { ...(finalized || {}), ...payload, ...(finalized || {}) };
  for (const key of ['claimToken', 'claimUrl', 'expiresAt', 'siteUrl', 'url']) {
    if (merged[key] === undefined && payload[key] !== undefined) merged[key] = payload[key];
  }
  return { upload: created, payload: merged, steps };
}

async function checkCandidate(id) {
  const candidate = CANDIDATES[id];
  if (!candidate) throw new Error(`unknown candidate ${id} (see --list)`);

  const { dir, nonce } = fixture(id);
  const inspected = inspectArtifact(dir);
  if (!inspected.ok) throw new Error(`fixture inspection failed: ${inspected.error}`);
  const manifest = inspected.manifest;
  const local = new Map([...manifest.byRelative].map(([rel, entry]) => [rel, { sha256: entry.record.sha256, bytes: entry.record.bytes, mime: entry.record.mime }]));

  const zip = createZip(manifest.files.map((file) => ({ name: file.path, data: manifest.byRelative.get(file.path).bytes, mime: file.mime })));
  const bodyStyle = candidate.bodyStyle || 'multipart';
  const boundary = '----anoncompliance' + crypto.randomBytes(12).toString('hex');
  // Three request shapes cover every candidate so far: the archive as a raw body, a JSON single-page
  // publish, and multipart with a named part. A probe that speaks the wrong one reports a service
  // failure that is really a test failure.
  let uploadBody;
  let uploadHeaders;
  if (bodyStyle === 'raw') {
    uploadBody = zip;
    uploadHeaders = { 'content-type': 'application/zip' };
  } else if (bodyStyle === 'json-doc') {
    // Same idea as json-html, but the document goes under a provider-specific field name.
    uploadBody = Buffer.from(JSON.stringify({ [candidate.field || 'html']: manifest.byRelative.get('index.html').bytes.toString('utf8') }), 'utf8');
    uploadHeaders = { 'content-type': 'application/json' };
  } else if (bodyStyle === 'json-html') {
    uploadBody = Buffer.from(JSON.stringify({ html_content: manifest.byRelative.get('index.html').bytes.toString('utf8') }), 'utf8');
    uploadHeaders = { 'content-type': 'application/json' };
  } else {
    // `partSource` decides what the part carries: a zip archive (multi-file hosts) or the raw document
    // (single-document hosts). Sending a zip to a host that decodes the part as text is a probe error
    // that looks like a service error - display.dev answered "must be valid UTF-8" for exactly that.
    const partData = candidate.partSource === 'index.html'
      ? manifest.byRelative.get('index.html').bytes
      : zip;
    uploadBody = buildMultipart([{
      name: candidate.field,
      filename: candidate.filename,
      contentType: candidate.contentType || 'application/zip',
      data: partData
    }], boundary);
    uploadHeaders = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  }
  uploadHeaders = {
    accept: 'application/json',
    'content-length': String(uploadBody.length),
    ...uploadHeaders,
    ...(candidate.headers || {})
  };

  const platform = await liveness(candidate);

  let upload;
  let payload = null;
  let steps = null;
  if (bodyStyle === 'three-step') {
    ({ upload, payload, steps } = await runThreeStep(candidate, manifest, nonce));
  } else {
    upload = await httpRequest({
      url: candidate.endpoint,
      method: 'POST',
      headers: uploadHeaders,
      body: uploadBody,
      timeoutMs: 180000
    });
    try {
      payload = JSON.parse(upload.body.toString('utf8'));
    } catch {
      payload = null;
    }
  }

  const url = payload && (payload.url || payload.siteUrl || payload.link || payload.previewUrl);
  const reads = { root: null, html: null, assets: {} };
  if (url) {
    // Normalise the base the way verify.mjs does: without a trailing slash a relative join drops the
    // last path segment (`/public/abc` + `assets/app.js` -> `/public/assets/app.js`).
    const base = url.endsWith('/') ? url : `${url}/`;
    reads.root = await readRootWithRetry(url);
    reads.html = await readResource(new URL('index.html', base).toString());
    for (const rel of candidate.assetExpectations === 'none' ? [] : ['assets/app.js', 'assets/app.css']) {
      reads.assets[rel] = await readResource(new URL(rel, base).toString());
    }
  }

  const uploadRejected = upload.status === 401 || upload.status === 403;
  const markerInRoot = reads.root ? reads.root.body.toString('utf8').includes(nonce) : false;
  const htmlMatches = reads.html && reads.html.sha256 === local.get('index.html').sha256;
  // An injected page still contains the uploaded HTML verbatim, with additions around it; a wrapped one
  // serves the provider's own viewer page with the content re-rendered inside it. Deciding this by
  // byte-comparison above was wrong twice (display.dev, shippage.ai), so it is decided by containment.
  const servedHtml = reads.html && reads.html.status === 200 ? reads.html.body.toString('utf8') : '';
  const containsOriginal = servedHtml ? servedHtml.includes(manifest.byRelative.get('index.html').bytes.toString('utf8')) : false;
  const htmlTransform = htmlMatches ? 'none' : containsOriginal ? 'injected' : (servedHtml ? 'wrapped' : 'unknown');
  const assetsVerified = candidate.assetExpectations === 'none'
    ? (reads.html ? reads.html.status === 200 && reads.html.sha256 === local.get('index.html').sha256 : false)
    : Object.entries(reads.assets).every(([rel, read]) => read.sha256 === local.get(rel).sha256);
  const rootOk = reads.root && reads.root.status === 200 && markerInRoot;

  // A single-document host that serves the document inside its own viewer page is neither byte-exact nor
  // broken: the content is public, wrapped. That is a distinct outcome from a missing asset.
  const wrapped = candidate.assetExpectations === 'none' && rootOk && !assetsVerified;
  const classification = uploadRejected ? 'auth-required'
    : !url ? 'login-free-upload-only'
      : rootOk && assetsVerified ? 'independent-public'
        : wrapped ? 'wrapped-preview'
          : rootOk ? 'partial-preview'
            : 'login-free-upload-only';

  const evidence = {
    id,
    publisherAuth: candidate.publisherAuth,
    viewerAccess: url ? 'public' : 'unknown',
    artifactModel: candidate.artifactModel,
    // `independent-public` additionally requires a read from a second network, which was not available.
    shareability: classification === 'independent-public' ? 'unverified'
      : classification === 'auth-required' ? 'not-applicable' : 'owner-preview',    lifecycle: {
      contentExpiresAt: payload && (payload.expiresAt || payload.expires_at || payload.expiry) ? String(payload.expiresAt || payload.expires_at || payload.expiry) : null,
      claimDeadline: null,
      previewAccessExpiresAt: null,
      idleExpiry: null
    },
    verification: {
      uploadSucceeded: upload.status >= 200 && upload.status < 300,
      sameEgressRead: reads.root ? reads.root.status === 200 : null,
      crossEgressRead: null,
      independentReaderVerified: classification === 'independent-public' && false,
      assetsVerified,
      htmlTransform,
      testedAt: new Date().toISOString()
    },
    evidence: {
      level: 'A-live',
      sourceUrl: candidate.docs,
      checkedAt: CHECKED_AT,
      testCommit: null,
      reason: classification === 'independent-public'
        ? 'upload and every read succeeded from this network; a second network was not available, so independent readership stays unconfirmed'
        : classification === 'auth-required'
          ? `the anonymous endpoint rejected the upload with HTTP ${upload.status}; automation needs an account`
          : `upload status ${upload.status}; reads: root ${reads.root ? reads.root.status : 'n/a'}, html ${reads.html ? reads.html.status : 'n/a'}`
    },
    measured: {
      candidate: candidate.label,
      endpoint: candidate.endpoint,
      bodyStyle,
      steps,
      platformAlive: platform,
      nonce,
      uploadStatus: upload.status,
      uploadResponse: redact(payload),
      responseHeaders: redact(Object.fromEntries(Object.entries(upload.headers).filter(([key]) => /content-type|server|date/.test(key)))),
      url: url || null,
      localFiles: Object.fromEntries([...local].map(([rel, entry]) => [rel, { sha256: entry.sha256, bytes: entry.bytes }])),
      reads: Object.fromEntries(Object.entries({ root: reads.root, html: reads.html, ...reads.assets }).map(([key, read]) => [key, read ? {
        status: read.status, contentType: read.contentType, bytes: read.bytes, sha256: read.sha256, error: read.error || null
      } : null])),
      classification,
      testedAt: new Date().toISOString(),
      crossEgressAvailable: false
    }
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  process.stdout.write(`\n=== ${candidate.label} (${id}) ===\n`);
  process.stdout.write(`  upload      : HTTP ${upload.status}${payload ? ` — fields ${Object.keys(payload).join(', ')}` : ' (no JSON)'}\n`);
  process.stdout.write(`  url         : ${url || '(none)'}\n`);
  process.stdout.write(`  root read   : ${reads.root ? `${reads.root.status} ${reads.root.contentType} ${reads.root.bytes}b marker=${markerInRoot}` : 'n/a'}\n`);
  process.stdout.write(`  html        : ${reads.html ? `${reads.html.status} matches local=${htmlMatches}` : 'n/a'}\n`);
  for (const [rel, read] of Object.entries(reads.assets)) {
    process.stdout.write(`  ${rel.padEnd(11)} : ${read.status} matches local=${read.sha256 === local.get(rel).sha256}\n`);
  }
  process.stdout.write(`  classification: ${classification} (cross-egress read not measured)\n`);
  process.stdout.write(`  wrote research/anonymous-compliance/${id}.json\n`);
  return evidence;
}

const args = process.argv.slice(2);
if (!args.length || args[0] === '--list') {
  process.stdout.write('candidates:\n');
  for (const [id, candidate] of Object.entries(CANDIDATES)) {
    process.stdout.write(`  ${id.padEnd(10)} ${candidate.label.padEnd(10)} ${candidate.endpoint}\n`);
  }
  process.exit(args.length ? 0 : 2);
}
for (const id of args) await checkCandidate(id);
