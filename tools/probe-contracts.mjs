#!/usr/bin/env node
/**
 * Live provider contract probe — NOT part of the CLI.
 *
 * Every claim in `config/providers.json` marked `verification.verifiedAt` was established with
 * this script against the live services. Run it when a provider changes its API, then update the
 * registry notes and the adapters. It uploads tiny probe artifacts and prints the raw shape of
 * each response; it never prints a claim token's value in full except through the CLI itself.
 *
 * Usage: node tools/probe-contracts.mjs [--dir <artifact>]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as identity from '../src/identity.mjs';
import {
  buildMultipart,
  createTar,
  createZip,
  gzip,
  httpRequest,
  md5Hex,
  mimeForPath,
  randomBoundary,
  textOf
} from '../src/common.mjs';

const SMALL_INDEX = '<!doctype html><html><head><title>probe</title></head><body>PROBE-MARKER</body></html>';
const dirArg = process.argv.indexOf('--dir');
const artifactDir = dirArg > -1 ? path.resolve(process.argv[dirArg + 1]) : null;

function log(label, value) {
  process.stdout.write(`\n=== ${label}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function post(url, headers, body) {
  return httpRequest({ url, method: 'POST', headers, body, timeoutMs: 300000 });
}

async function probeShipPage() {
  const zip = createZip([{ name: 'index.html', data: Buffer.from(SMALL_INDEX), mime: 'text/html; charset=utf-8' }]);
  const response = await post('https://ship.page/deploy?ttl=2592000', {
    'content-type': 'application/zip',
    accept: 'application/json',
    'content-length': String(zip.length)
  }, zip);
  const payload = JSON.parse(textOf(response));
  log('ship.page POST /deploy (application/zip)', {
    status: response.status,
    keys: Object.keys(payload),
    url: payload.url,
    slug: payload.slug,
    expires_at: payload.expires_at,
    claimTokenShape: payload.claim_token ? payload.claim_token.replace(/[a-z0-9]/g, 'x') : null
  });
}

async function probeShipStatic(fieldName) {
  const files = [{ path: 'index.html', bytes: Buffer.from(SMALL_INDEX) }];
  const parts = files.map((file) => ({ name: fieldName, filename: file.path, contentType: 'text/html', data: file.bytes }));
  parts.push({ name: 'checksums', value: JSON.stringify(files.map((file) => md5Hex(file.bytes))) });
  const boundary = randomBoundary();
  const body = buildMultipart(parts, boundary);
  const response = await post('https://api.shipstatic.com/deployments', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    accept: 'application/json',
    'content-length': String(body.length),
    'idempotency-key': `probe-${fieldName.replace(/\W/g, '')}-${Date.now()}`
  }, body);
  log(`shipstatic POST /deployments (field=${fieldName})`, { status: response.status, body: textOf(response).slice(0, 300).replace(/\s+/g, ' ') });
}

async function probeAftPage() {
  const parts = [
    { name: 'file0', filename: 'index.html', contentType: 'text/html', data: Buffer.from(SMALL_INDEX) },
    { name: 'file0_path', value: 'index.html' }
  ];
  const boundary = randomBoundary();
  const body = buildMultipart(parts, boundary);
  const response = await post('https://api.aft.page/v1/deploy', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    accept: 'application/json',
    'content-length': String(body.length)
  }, body);
  const payload = JSON.parse(textOf(response));
  log('aft.page POST /v1/deploy', { status: response.status, keys: Object.keys(payload), url: payload.url, files: payload.files, bytes: payload.bytes });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const served = await httpRequest({ url: payload.url.replace(/\/$/, '') + '/', method: 'GET', timeoutMs: 60000 });
  log('aft.page served index.html', {
    status: served.status,
    uploadedBytes: SMALL_INDEX.length,
    servedBytes: served.body.length,
    servedVerbatim: textOf(served).includes(SMALL_INDEX)
  });
}

async function probeHereNow() {
  const files = [{ path: 'index.html', bytes: Buffer.from(SMALL_INDEX), mime: 'text/html; charset=utf-8' }];
  const createBody = Buffer.from(JSON.stringify({ files: files.map((file) => ({ path: file.path, size: file.bytes.length, contentType: file.mime })) }), 'utf8');
  const created = JSON.parse(textOf(await post('https://here.now/api/v1/publish', {
    'content-type': 'application/json',
    accept: 'application/json',
    'content-length': String(createBody.length)
  }, createBody)));
  log('here.now POST /api/v1/publish', {
    keys: Object.keys(created),
    uploadKeys: Object.keys(created.upload || {}),
    siteUrl: created.siteUrl,
    versionIdShape: created.upload && created.upload.versionId ? 'present' : 'MISSING',
    finalizeUrl: created.upload && created.upload.finalizeUrl,
    claimUrlFields: { claimToken: Boolean(created.claimToken), claimUrl: created.claimUrl || null }
  });

  for (const entry of (created.upload && created.upload.uploads) || []) {
    const local = files.find((file) => file.path === entry.path);
    const headers = {};
    for (const [key, value] of Object.entries(entry.headers || {})) headers[key.toLowerCase()] = String(value);
    const put = await httpRequest({ url: entry.url, method: 'PUT', headers, body: local.bytes, timeoutMs: 300000 });
    if (put.status >= 300) log('here.now PUT failed', { status: put.status, body: textOf(put).slice(0, 200) });
  }

  const finalizeBody = Buffer.from(JSON.stringify({ versionId: created.upload.versionId }), 'utf8');
  const finalized = JSON.parse(textOf(await post(created.upload.finalizeUrl, {
    'content-type': 'application/json',
    accept: 'application/json',
    'content-length': String(finalizeBody.length)
  }, finalizeBody)));
  log('here.now finalize', { keys: Object.keys(finalized), success: finalized.success, siteUrl: finalized.siteUrl, publishStatus: finalized.publishStatus });

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const served = await httpRequest({ url: finalized.siteUrl, method: 'GET', timeoutMs: 60000 });
  log('here.now served index.html', {
    status: served.status,
    uploadedBytes: SMALL_INDEX.length,
    servedBytes: served.body.length,
    servedVerbatim: textOf(served).includes(SMALL_INDEX)
  });
}

async function probeShow() {
  const archive = gzip(createTar([{ name: 'index.html', data: Buffer.from(SMALL_INDEX) }]));
  const boundary = randomBoundary();
  const body = buildMultipart([
    { name: 'file', filename: 'probe.tar.gz', contentType: 'application/gzip', data: archive },
    { name: 'name', value: `${identity.NAME}-probe` }
  ], boundary);
  const response = await post('https://show.127.dev/upload', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    accept: 'application/json',
    'content-length': String(body.length)
  }, body);
  const payload = JSON.parse(textOf(response));
  log('show POST /upload (tar.gz)', { status: response.status, keys: Object.keys(payload), url: payload.url, mode: payload.mode, expiresAt: payload.expiresAt });
}

async function probeDropley() {
  const manifest = { manifestVersion: 1, entry: 'index.html', files: [{ path: 'index.html', size: SMALL_INDEX.length, contentType: 'text/html' }] };
  const boundary = randomBoundary();
  const body = buildMultipart([
    { name: 'manifest', value: JSON.stringify(manifest) },
    { name: 'expiry', value: '7d' },
    { name: 'file', filename: 'index.html', contentType: 'text/html', data: Buffer.from(SMALL_INDEX) }
  ], boundary);
  const response = await post('https://dropley.app/api/artifacts', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    accept: 'application/json',
    'content-length': String(body.length)
  }, body);
  log('dropley POST /api/artifacts', { status: response.status, body: textOf(response).slice(0, 400).replace(/\s+/g, ' ') });
}

/** Byte fidelity of the live hosts, when an artifact directory is supplied. */
async function probeFidelity(url, relative) {
  const local = fs.readFileSync(path.join(artifactDir, relative));
  const response = await httpRequest({ url: new URL(relative.split('/').map(encodeURIComponent).join('/'), url.endsWith('/') ? url : url + '/').toString(), method: 'GET', timeoutMs: 60000 });
  const same = crypto.createHash('sha256').update(local).digest('hex') === crypto.createHash('sha256').update(response.body).digest('hex');
  return { relative, status: response.status, localBytes: local.length, servedBytes: response.body.length, byteIdentical: same };
}

const selected = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && arg !== artifactDir);
const want = (name) => selected.length === 0 || selected.includes(name);

if (want('ship-page')) await probeShipPage();
if (want('shipstatic')) {
  await probeShipStatic('files[]');
  await probeShipStatic('files');
}
if (want('aft-page')) await probeAftPage();
if (want('here-now')) await probeHereNow();
if (want('show')) await probeShow();
if (want('dropley')) await probeDropley();
if (artifactDir) log('artifact for fidelity checks', { dir: artifactDir, files: fs.readdirSync(artifactDir).length, mimeOfIndex: mimeForPath('index.html') });
