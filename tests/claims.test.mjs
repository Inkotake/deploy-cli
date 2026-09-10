/**
 * Ownership credentials: stored privately, never printed by default.
 *
 * A claim token or URL is the only thing that proves ownership of an anonymous deployment, and it
 * is routinely captured by whatever consumes `--json`. These tests pin the two halves of the
 * policy: the secret reaches the private store, and the default result does not contain it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLAIM_WARNING,
  claimForOutput,
  claimsPath,
  findClaim,
  formatClaim,
  previewSecret,
  readClaims,
  storeClaim
} from '../src/claims.mjs';

const SECRET = `spc_${'a'.repeat(24)}`;
const CLAIM = { kind: 'claim_token', field: 'claim_token', value: SECRET, claimUrl: null, warning: 'shown once' };
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best effort */
    }
  }
});

function stateEnv(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-claim-${label}-`));
  tempDirs.push(dir);
  return { VERIFIED_PUBLISH_HOME: dir };
}

test('a claim with no secret is not stored at all', () => {
  const env = stateEnv('empty');
  assert.equal(storeClaim(null, { url: 'https://example.test/' }, env), null);
  assert.equal(storeClaim({ kind: 'x' }, { url: 'https://example.test/' }, env), null);
  assert.equal(fs.existsSync(claimsPath(env)), false, 'no secret means no store file');
  assert.deepEqual(readClaims(env).claims, []);
});

test('storing replaces the entry for the same deployment and keeps different ones', () => {
  const env = stateEnv('store');
  const first = storeClaim(CLAIM, { url: 'https://a.test/', provider: 'ship-page' }, env);
  assert.ok(first && first.entry.capturedAt, 'the entry records when it was captured');
  assert.ok(fs.readFileSync(first.file, 'utf8').includes(SECRET), 'the secret must actually be stored');

  storeClaim({ ...CLAIM, value: `spc_${'b'.repeat(24)}` }, { url: 'https://a.test/', provider: 'ship-page' }, env);
  storeClaim({ kind: 'artifact_token', field: 'artifactToken', value: `dpk_${'c'.repeat(24)}` }, { url: 'https://b.test/', provider: 'dropley' }, env);

  const { claims } = readClaims(env);
  assert.equal(claims.length, 2, 'the same URL must be replaced, not appended');
  assert.equal(claims.filter((entry) => entry.url === 'https://a.test/').length, 1);

  assert.equal(findClaim('https://a.test/', env).entry.value, `spc_${'b'.repeat(24)}`);
  assert.equal(findClaim('latest', env).entry.url, 'https://b.test/');
  assert.equal(findClaim('dropley', env).entry.url, 'https://b.test/');
  assert.equal(findClaim('nothing-like-this', env), null);
});

test('the default output never contains the secret', () => {
  const output = claimForOutput(CLAIM, { storedIn: '/tmp/claims.json' });
  assert.equal(output.value, null);
  assert.equal(output.claimUrl, null);
  assert.equal(output.hidden, true);
  assert.equal(output.available, true);
  assert.equal(output.secretStored, '/tmp/claims.json');
  assert.ok(!JSON.stringify(output).includes(SECRET), 'the secret must not appear anywhere in the payload');
  assert.match(output.valuePreview, /^spc_…\(\d+ chars\)$/);
  assert.match(output.warning, /ownership/i);

  const revealed = claimForOutput(CLAIM, { reveal: true, storedIn: '/tmp/claims.json' });
  assert.equal(revealed.value, SECRET);
  assert.equal(revealed.hidden, false);
});

test('previewSecret never reveals the middle of a secret', () => {
  assert.equal(previewSecret(SECRET), `spc_…(${SECRET.length} chars)`);
  const preview = previewSecret('0123456789abcdefghij');
  assert.ok(!preview.includes('56789'), 'no part of the secret body may survive the preview');
});

test('the human form is explicit about a hidden secret and always warns', () => {
  const entry = { url: 'https://a.test/', provider: 'ship-page', kind: 'claim_token', field: 'claim_token', value: SECRET, claimUrl: null, capturedAt: '2026-01-01T00:00:00.000Z' };
  const hidden = formatClaim(entry, {}).join('\n');
  assert.match(hidden, /stored, hidden/i);
  assert.ok(!hidden.includes(SECRET), 'the hidden form must not print the secret');
  assert.ok(hidden.includes(CLAIM_WARNING));

  const revealed = formatClaim(entry, { reveal: true }).join('\n');
  assert.ok(revealed.includes(SECRET));
  assert.ok(revealed.includes(CLAIM_WARNING), 'even the revealed form must warn');
});

test('a damaged store degrades instead of throwing', () => {
  const env = stateEnv('damaged');
  fs.writeFileSync(claimsPath(env), 'this is not json', 'utf8');
  const read = readClaims(env);
  assert.deepEqual(read.claims, []);
  assert.equal(read.problems.length, 1);
  assert.match(read.problems[0], /not valid JSON/);

  fs.writeFileSync(claimsPath(env), JSON.stringify({ version: 1 }), 'utf8');
  assert.deepEqual(readClaims(env).claims, [], 'a store without a claims array reads as empty');
});

test('the store is created owner-only where the filesystem supports it', { skip: process.platform === 'win32' ? 'win32 has no POSIX mode bits' : false }, () => {
  const env = stateEnv('mode');
  storeClaim(CLAIM, { url: 'https://a.test/', provider: 'ship-page' }, env);
  const mode = fs.statSync(claimsPath(env)).mode & 0o777;
  assert.equal(mode, 0o600);
});
