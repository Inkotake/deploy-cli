/**
 * Tests for src/snapshot.mjs — the immutable artifact snapshot handed to persistent providers.
 * Platform-dependent assertions are skipped, never silently weakened; every fixture lives in a temp
 * workspace removed by an `after` hook, so nothing is written outside os.tmpdir().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDirs, listFiles, sha256Hex, toPosix } from '../src/common.mjs';
import { createSnapshot, verifySnapshot } from '../src/snapshot.mjs';

const UNICODE_NAME = 'naïve page (1).txt';
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const APP_JS = 'console.log("hi");\n';

/** A temp workspace that is removed even when the test fails. */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** Fixture artifact: nested dirs, an empty dir, a 0-byte file, binary bytes, a unicode/space name. */
function makeTree(root) {
  fs.mkdirSync(path.join(root, 'assets', 'img'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><h1>snapshot</h1>\n');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), APP_JS);
  fs.writeFileSync(path.join(root, 'assets', 'img', 'zero.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(root, 'assets', 'img', 'bytes.bin'), BINARY);
  fs.writeFileSync(path.join(root, 'assets', UNICODE_NAME), 'unicode + space\n');
}

/** A built fixture artifact plus the snapshot rootDir to use with it. */
function fixture(t) {
  const tmp = workspace(t);
  const source = path.join(tmp, 'dist');
  makeTree(source);
  return { tmp, source, rootDir: path.join(tmp, 'snapshots') };
}

/** Sorted POSIX-relative paths of every file and directory (directories suffixed with `/`). */
function treePaths(root) {
  const relative = (entry) => toPosix(path.relative(root, entry.path));
  return [...listDirs(root).map((dir) => dir + '/'), ...listFiles(root).map(relative)].sort();
}

/** Assert the snapshot carries every source file byte-for-byte. */
function assertMirrors(source, snapshotDir) {
  for (const entry of listFiles(source)) {
    const rel = toPosix(path.relative(source, entry.path));
    const actual = fs.readFileSync(path.join(snapshotDir, ...rel.split('/')));
    assert.equal(sha256Hex(actual), sha256Hex(fs.readFileSync(entry.path)), `content differs: ${rel}`);
  }
}

/** A manifest-shaped object, matching what inspect.mjs buildManifest produces. */
function manifestFor(root) {
  const files = [];
  const byRelative = new Map();
  for (const entry of listFiles(root)) {
    const rel = toPosix(path.relative(root, entry.path));
    const bytes = fs.readFileSync(entry.path);
    const record = { path: rel, bytes: bytes.length, sha256: sha256Hex(bytes) };
    files.push(record);
    byRelative.set(rel, { record, bytes });
  }
  return { dir: path.resolve(root), files, byRelative };
}

/** Any `snapshot-*` entry left under a rootDir. */
function leftovers(rootDir) {
  return fs.existsSync(rootDir) ? fs.readdirSync(rootDir).filter((name) => name.startsWith('snapshot-')) : [];
}

/** A writable temp dir on another device than `from`, or null. Hardlinks cannot cross devices. */
function otherDeviceRoot(from) {
  const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const candidates = process.platform === 'win32'
    ? letters.flatMap((letter) => [`${letter}:\\Temp`, `${letter}:\\tmp`])
    : ['/dev/shm', '/run/shm'];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).dev === fs.statSync(from).dev) continue;
      return fs.mkdtempSync(path.join(candidate, 'verp-snapshot-crossdev-'));
    } catch {
      continue;
    }
  }
  return null;
}

test('happy path mirrors the tree exactly, including the empty directory', async (t) => {
  const { source, rootDir } = fixture(t);

  const warnings = [];
  const snapshot = await createSnapshot(source, { rootDir, onWarn: (msg) => warnings.push(msg) });
  t.after(() => snapshot.cleanup());

  assert.ok(path.isAbsolute(snapshot.dir));
  assert.ok(snapshot.dir.startsWith(path.resolve(rootDir) + path.sep));
  assert.ok(['hardlink', 'copy', 'mixed'].includes(snapshot.strategy));
  assert.equal(snapshot.fileCount, listFiles(source).length);
  assert.equal(snapshot.bytes, listFiles(source).reduce((sum, e) => sum + fs.statSync(e.path).size, 0));
  assert.ok(Number.isFinite(Date.parse(snapshot.createdAt)));
  assert.deepEqual(warnings, []);

  // Same relative path set, empty directory included.
  assert.deepEqual(treePaths(snapshot.dir), treePaths(source));
  assert.ok(treePaths(snapshot.dir).includes('empty-dir/'), 'empty directory must be mirrored');
  assertMirrors(source, snapshot.dir);
  assert.equal(fs.statSync(path.join(snapshot.dir, 'assets', 'img', 'zero.bin')).size, 0);
  assert.deepEqual(fs.readFileSync(path.join(snapshot.dir, 'assets', 'img', 'bytes.bin')), BINARY);
  assert.ok(fs.existsSync(path.join(snapshot.dir, 'assets', UNICODE_NAME)));

  // The default rootDir is the tool's temp directory, and its cleanup still removes the tree.
  const fallback = await createSnapshot(source);
  try {
    assert.ok(path.resolve(fallback.dir).startsWith(path.join(os.tmpdir(), 'verified-publish', 'snapshots') + path.sep));
  } finally {
    fallback.cleanup();
  }
  assert.equal(fs.existsSync(fallback.dir), false);
});

test("strategy 'copy' never hardlinks and stays byte-identical", async (t) => {
  const { source, rootDir } = fixture(t);

  const snapshot = await createSnapshot(source, { strategy: 'copy', rootDir });
  t.after(() => snapshot.cleanup());

  assert.equal(snapshot.strategy, 'copy');
  const sourceFile = path.join(source, 'assets', 'app.js');
  const snapFile = path.join(snapshot.dir, 'assets', 'app.js');
  assert.deepEqual(fs.readFileSync(snapFile), fs.readFileSync(sourceFile));

  // Windows inode reporting is not reliable enough to prove non-linking; the edit below is.
  if (process.platform === 'win32') assert.equal(fs.statSync(snapFile).size, fs.statSync(sourceFile).size);
  else assert.notEqual(fs.statSync(snapFile).ino, fs.statSync(sourceFile).ino);

  // Platform-independent proof of independence: editing the source cannot touch the snapshot.
  fs.appendFileSync(sourceFile, '// edited after the snapshot was taken\n');
  assert.equal(sha256Hex(fs.readFileSync(snapFile)), sha256Hex(Buffer.from(APP_JS)));
});

test('cleanup removes the tree, is idempotent, and keep:true disables it', async (t) => {
  const { source, rootDir } = fixture(t);

  const snapshot = await createSnapshot(source, { rootDir, strategy: 'copy' });
  assert.ok(fs.existsSync(snapshot.dir));
  snapshot.cleanup();
  assert.equal(fs.existsSync(snapshot.dir), false);
  assert.doesNotThrow(() => snapshot.cleanup());
  assert.doesNotThrow(() => snapshot.cleanup());

  const kept = await createSnapshot(source, { rootDir, strategy: 'copy', keep: true });
  kept.cleanup();
  kept.cleanup();
  assert.ok(fs.existsSync(kept.dir), 'keep:true must leave the snapshot on disk');
  fs.rmSync(kept.dir, { recursive: true, force: true, maxRetries: 3 });
  assert.equal(fs.existsSync(kept.dir), false);
});

test('a read-only source directory still snapshots', async (t) => {
  if (process.platform === 'win32') return t.skip('win32 cannot express POSIX read-only directory permissions');
  const { source, rootDir } = fixture(t);

  fs.chmodSync(source, 0o500);
  try {
    const snapshot = await createSnapshot(source, { rootDir, strategy: 'copy' });
    try {
      assert.equal(snapshot.fileCount, listFiles(source).length);
      assertMirrors(source, snapshot.dir);
    } finally {
      snapshot.cleanup();
    }
  } finally {
    fs.chmodSync(source, 0o700);
  }
});

test('verifySnapshot accepts a fresh snapshot and detects tampering, deletion and extras', async (t) => {
  const { source, rootDir } = fixture(t);
  const manifest = manifestFor(source);

  const fresh = await createSnapshot(source, { rootDir });
  t.after(() => fresh.cleanup());
  assert.deepEqual(verifySnapshot(fresh.dir, manifest), { ok: true, mismatches: [], missing: [], extra: [] });

  // Tampered byte -> mismatch with both digests reported.
  const tampered = await createSnapshot(source, { rootDir, strategy: 'copy' });
  t.after(() => tampered.cleanup());
  fs.writeFileSync(path.join(tampered.dir, 'assets', 'app.js'), 'console.log("tampered");\n');
  const mismatch = verifySnapshot(tampered.dir, manifest);
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.mismatches.map((m) => m.path), ['assets/app.js']);
  assert.equal(mismatch.mismatches[0].expectedSha256, manifest.byRelative.get('assets/app.js').record.sha256);
  assert.equal(mismatch.mismatches[0].actualBytes, 'console.log("tampered");\n'.length);
  assert.deepEqual([mismatch.missing, mismatch.extra], [[], []]);

  // Deleted file -> missing.
  const deleted = await createSnapshot(source, { rootDir, strategy: 'copy' });
  t.after(() => deleted.cleanup());
  fs.rmSync(path.join(deleted.dir, 'assets', 'img', 'bytes.bin'));
  const missing = verifySnapshot(deleted.dir, manifest);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['assets/img/bytes.bin']);
  assert.deepEqual([missing.mismatches, missing.extra], [[], []]);

  // Extra file -> extra.
  const extra = await createSnapshot(source, { rootDir, strategy: 'copy' });
  t.after(() => extra.cleanup());
  fs.writeFileSync(path.join(extra.dir, 'rogue.txt'), 'never inspected\n');
  const surplus = verifySnapshot(extra.dir, manifest);
  assert.equal(surplus.ok, false);
  assert.deepEqual(surplus.extra, ['rogue.txt']);
  assert.deepEqual([surplus.mismatches, surplus.missing], [[], []]);

  // A vanished snapshot directory reports every manifest file as missing, never as ok.
  const gone = await createSnapshot(source, { rootDir, strategy: 'copy' });
  gone.cleanup();
  const vanished = verifySnapshot(gone.dir, manifest);
  assert.deepEqual([vanished.ok, vanished.missing.length], [false, manifest.files.length]);
});

test('failures leave no partial snapshot behind', async (t) => {
  const { tmp, source, rootDir } = fixture(t);

  // Source missing, source not a directory, and an unknown strategy are all refused up front.
  await assert.rejects(() => createSnapshot(path.join(tmp, 'nope'), { rootDir }), /cannot read source directory/);
  const plain = path.join(tmp, 'plain.txt');
  fs.writeFileSync(plain, 'not a directory\n');
  await assert.rejects(() => createSnapshot(plain, { rootDir }), /not a directory/);
  await assert.rejects(() => createSnapshot(source, { rootDir, strategy: 'bogus' }), /unknown strategy/);

  assert.deepEqual(leftovers(rootDir), []);
});

test('a copy failure after the snapshot directory exists removes the partial tree', async (t) => {
  if (process.platform === 'win32') return t.skip('win32 has no plain POSIX mode bits to make a file unreadable');
  const { source, rootDir } = fixture(t);
  const locked = path.join(source, 'locked.txt');
  fs.writeFileSync(locked, 'cannot be copied\n');
  fs.chmodSync(locked, 0o000);
  try {
    let readable = true;
    try {
      fs.readFileSync(locked);
    } catch {
      readable = false;
    }
    if (readable) return t.diagnostic('running as a user that ignores file modes; partial-tree removal not exercised');
    await assert.rejects(() => createSnapshot(source, { rootDir, strategy: 'copy' }), /cannot copy locked\.txt/);
    assert.deepEqual(leftovers(rootDir), []);
  } finally {
    fs.chmodSync(locked, 0o600);
  }
});

test('symlinks are skipped and reported through onWarn', async (t) => {
  const { source, rootDir } = fixture(t);

  try {
    fs.symlinkSync(path.join(source, 'index.html'), path.join(source, 'linked.html'), 'file');
  } catch (cause) {
    return t.skip(`symlink creation not permitted here: ${cause.code || cause.message}`);
  }

  const warnings = [];
  const snapshot = await createSnapshot(source, { rootDir, onWarn: (msg) => warnings.push(msg) });
  t.after(() => snapshot.cleanup());

  assert.deepEqual(treePaths(snapshot.dir), treePaths(source));
  assert.equal(fs.existsSync(path.join(snapshot.dir, 'linked.html')), false);
  assert.equal(snapshot.fileCount, listFiles(source).length);
  assert.ok(warnings.some((msg) => msg.includes('linked.html')), `expected a warning naming the symlink: ${warnings}`);
});

test('a cross-device rootDir falls back to copies and warns once per reason', async (t) => {
  const { tmp, source } = fixture(t);
  const crossRoot = otherDeviceRoot(tmp);
  if (!crossRoot) return t.skip('no writable filesystem other than the source device is available');
  t.after(() => fs.rmSync(crossRoot, { recursive: true, force: true, maxRetries: 3 }));

  const warnings = [];
  const snapshot = await createSnapshot(source, { rootDir: crossRoot, onWarn: (msg) => warnings.push(msg) });
  t.after(() => snapshot.cleanup());

  assert.equal(snapshot.strategy, 'copy');
  assert.equal(snapshot.fileCount, listFiles(source).length);
  assert.equal(warnings.length, 1, `one distinct fallback reason must warn exactly once: ${warnings}`);
  assert.match(warnings[0], /hardlink unavailable/);
  assert.deepEqual(treePaths(snapshot.dir), treePaths(source));
  assertMirrors(source, snapshot.dir);
});
