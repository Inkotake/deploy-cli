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
  const multipart = buildMultipart([{
    name: candidate.field,
    filename: candidate.filename,
    contentType: candidate.contentType || 'application/zip',
    data: bodyStyle === 'raw' && candidate.field === 'files' ? manifest.byRelative.get('index.html').bytes : zip
  }], boundary);
  // Two body styles are common: multipart/form-data with a named file part, and the archive sent as the
  // raw request body. Both are documented contracts; sending the wrong one looks like a service failure.
  const uploadBody = bodyStyle === 'raw' ? zip : multipart;
  const uploadHeaders = bodyStyle === 'raw'
    ? { 'content-type': 'application/zip', 'content-length': String(uploadBody.length), accept: 'application/json' }
    : { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(uploadBody.length), accept: 'application/json' };

  const platform = await liveness(candidate);

  const upload = await httpRequest({
    url: candidate.endpoint,
    method: 'POST',
    headers: uploadHeaders,
    body: uploadBody,
    timeoutMs: 180000
  });

  let payload = null;
  try {
    payload = JSON.parse(upload.body.toString('utf8'));
  } catch {
    payload = null;
  }

  const url = payload && (payload.url || payload.siteUrl || payload.link);
  const reads = { root: null, html: null, assets: {} };
  if (url) {
    reads.root = await readRootWithRetry(url);
    const htmlRead = await readResource(new URL('index.html', url).toString());
    reads.html = htmlRead;
    for (const rel of ['assets/app.js', 'assets/app.css']) {
      reads.assets[rel] = await readResource(new URL(rel, url).toString());
    }
  }

  const uploadRejected = upload.status === 401 || upload.status === 403;
  const markerInRoot = reads.root ? reads.root.body.toString('utf8').includes(nonce) : false;
  const htmlMatches = reads.html && reads.html.sha256 === local.get('index.html').sha256;
  // An injected/wrapped HTML is a disclosure, not a failure: assets decide whether the site works.
  const htmlTransform = htmlMatches ? 'none'
    : markerInRoot ? 'injected'
      : reads.html && /^text\/html/.test(reads.html.contentType || '') ? 'wrapped' : 'unknown';
  const assetsVerified = Object.entries(reads.assets).every(([rel, read]) => read.sha256 === local.get(rel).sha256);
  const rootOk = reads.root && reads.root.status === 200 && markerInRoot;

  const classification = uploadRejected ? 'auth-required'
    : !url ? 'login-free-upload-only'
      : rootOk && assetsVerified ? 'independent-public'
        : rootOk ? 'partial-preview'
          : 'login-free-upload-only';

  const evidence = {
    id,
    publisherAuth: candidate.publisherAuth,
    viewerAccess: url ? 'public' : 'unknown',
    artifactModel: candidate.artifactModel,
    // `independent-public` additionally requires a read from a second network, which was not available.
    shareability: classification === 'independent-public' ? 'unverified'
      : classification === 'auth-required' ? 'not-applicable' : 'owner-preview',
    lifecycle: {
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
