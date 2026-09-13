#!/usr/bin/env node
/**
 * Reader-side reachability probe — NOT part of the CLI.
 *
 * WHY: "the deployer can read it" is a statement about one network. The same tool is meant to run on
 * several vantage points (this machine, a mainland host, a CI runner), and each run produces the same
 * comparable evidence, so a provider can be classified instead of trusted.
 *
 * Input: a deployment list written by the harness/collector, shaped like
 *   { nonce, results: [ { provider, url, localHashes: { <relative path>: { sha256, bytes } } } ] }
 * Output: the same list annotated per vantage point, plus a verdict per deployment:
 *   reachable  — root and every listed asset answered 200 with the expected SHA-256
 *   partial    — the root answered but an asset did not match
 *   unreachable— the root could not be read
 *   absent     — the deployment has no URL (the deploy itself failed), so there is nothing to probe
 *
 * Usage: node tools/probe-reader.mjs <deployments.json> [--out <result.json>] [--label <name>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpRequest } from '../src/common.mjs';

const args = process.argv.slice(2);
const input = args[0];
const outIndex = args.indexOf('--out');
const labelIndex = args.indexOf('--label');
const output = outIndex > -1 ? args[outIndex + 1] : null;
const label = labelIndex > -1 ? args[labelIndex + 1] : os.hostname();

if (!input) {
  process.stderr.write('usage: node tools/probe-reader.mjs <deployments.json> [--out <result.json>] [--label <name>]\n');
  process.exit(2);
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function get(url) {
  try {
    const response = await httpRequest({ url, method: 'GET', headers: { accept: '*/*', 'cache-control': 'no-cache' }, timeoutMs: 30000 });
    return {
      status: response.status,
      contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
      bytes: response.body.length,
      sha256: sha256(response.body),
      markerFound: response.body.toString('utf8').includes(inputNonce),
      error: null
    };
  } catch (cause) {
    return { status: 0, contentType: null, bytes: 0, sha256: null, markerFound: false, error: cause.message };
  }
}

const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
const inputNonce = payload.nonce || '';
const results = [];

for (const entry of payload.results || []) {
  if (!entry.url) {
    results.push({ ...entry, verdict: 'absent', note: 'the deployment produced no URL', readings: {} });
    process.stdout.write(`${String(entry.provider).padEnd(14)} absent (no url)\n`);
    continue;
  }
  const readings = {};
  readings.root = await get(entry.url);
  // A base URL without a trailing slash loses its last path segment when a relative reference is
  // joined onto it (`/p/abc` + `assets/app.js` -> `/p/assets/app.js`). verify.mjs normalises this; the
  // probe must too, or it reports the provider as broken when the probe itself is.
  const base = entry.url.endsWith('/') ? entry.url : `${entry.url}/`;
  const expected = entry.localHashes || {};
  for (const rel of Object.keys(expected)) {
    if (!expected[rel] || !expected[rel].sha256) continue;
    readings[rel] = await get(new URL(rel, base).toString());
  }

  const rootOk = readings.root.status === 200;
  // A provider known to rewrite HTML cannot be hash-compared on the page: its assets decide, and the
  // page is only checked for reachability and for the nonce. Every other provider is compared in full.
  const htmlExact = entry.htmlExact !== false;
  const assetChecks = Object.entries(expected)
    .filter(([rel, value]) => value && value.sha256 && (htmlExact || rel !== 'index.html'))
    .map(([rel, value]) => ({ rel, expected: value.sha256, actual: readings[rel] ? readings[rel].sha256 : null, status: readings[rel] ? readings[rel].status : 0 }));
  const allAssetsOk = assetChecks.length > 0 && assetChecks.every((check) => check.actual === check.expected);
  const verdict = !rootOk ? 'unreachable' : allAssetsOk ? 'reachable' : 'partial';

  results.push({ ...entry, verdict, readings, assetChecks });
  process.stdout.write(`${String(entry.provider).padEnd(14)} ${verdict.padEnd(12)} root=${readings.root.status} marker=${readings.root.markerFound} assets=${assetChecks.filter((check) => check.actual === check.expected).length}/${assetChecks.length}\n`);
}

const summary = {
  vantage: label,
  probedAt: new Date().toISOString(),
  hostname: os.hostname(),
  platform: `${os.platform()}/${os.arch()}`,
  nonce: inputNonce,
  verdicts: Object.fromEntries(results.map((entry) => [entry.provider, entry.verdict])),
  results
};

if (output) fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', 'utf8');
process.stdout.write(`\nvantage "${label}": ${results.filter((entry) => entry.verdict === 'reachable').length}/${results.length} reachable${output ? ` -> ${output}` : ''}\n`);
