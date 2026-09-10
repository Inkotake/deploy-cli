/**
 * Immutable artifact snapshots for persistent providers.
 *
 * WHY: anonymous providers upload straight from the manifest's in-memory bytes, so what was
 * inspected is exactly what gets published. Persistent providers instead hand the artifact
 * *directory* to a third-party CLI (`netlify deploy --dir`, `wrangler pages deploy`,
 * `vercel deploy`, `git` + cpSync for GitHub Pages), which re-reads it from disk: a file changed
 * between hashing and upload would be published without ever being verified. `createSnapshot`
 * freezes the artifact first (hardlink where possible, copy otherwise) and `verifySnapshot`
 * re-hashes the frozen tree, so a publish can refuse bytes that no longer match the manifest.
 * The source directory is only ever read, so a read-only artifact is fine.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles, sha256Hex, toPosix } from './common.mjs';

const TOOL_NAME = 'verified-publish';
const STRATEGIES = new Set(['auto', 'hardlink', 'copy']);

/** Join a snapshot root and a POSIX-relative path with the platform separator. */
const at = (root, relative) => path.join(root, ...relative.split('/'));

/** Collect one source tree, keeping empty directories and reporting (never following) symlinks. */
function walkSource(root) {
  const dirs = [];
  const files = [];
  const symlinks = [];
  const visit = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) symlinks.push(rel);
      else if (entry.isDirectory()) { dirs.push(rel); visit(abs, rel); }
      else if (entry.isFile()) files.push({ rel, abs, bytes: fs.statSync(abs).size });
      // Sockets, FIFOs and devices are skipped: they cannot be part of a static publish.
    }
  };
  visit(root, '');
  return { dirs, files, symlinks };
}

/** Create an immutable, byte-identical snapshot of a publish artifact directory. */
export async function createSnapshot(sourceDir, options = {}) {
  const strategy = options.strategy || 'auto';
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`snapshot: unknown strategy '${strategy}' (expected auto, hardlink or copy)`);
  }
  const rootDir = path.resolve(options.rootDir || path.join(os.tmpdir(), TOOL_NAME, 'snapshots'));
  const keep = options.keep === true;
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};

  const source = path.resolve(sourceDir);
  let stat;
  try {
    stat = fs.statSync(source);
  } catch (cause) {
    // Nothing has been created yet, so a bad source can never leave a partial tree behind.
    throw new Error(`snapshot: cannot read source directory ${source}: ${cause.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`snapshot: not a directory: ${source}`);

  const { dirs, files, symlinks } = walkSource(source);
  for (const rel of symlinks) onWarn(`snapshot: skipping symlink ${rel} (a publish snapshot never follows links)`);

  // Unique and collision-proof: two snapshots in the same millisecond cannot share a path.
  const dir = path.join(rootDir, `snapshot-${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });

  let cleaned = false;
  const cleanup = () => {
    if (keep || cleaned) return;
    cleaned = true;
    // Best effort: cleanup must never throw and never mask the real result.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the tree is already gone or permanently locked */
    }
  };

  try {
    for (const rel of dirs) fs.mkdirSync(at(dir, rel), { recursive: true });

    let linked = 0;
    let copied = 0;
    let bytes = 0;
    const warned = new Set();
    for (const file of files) {
      bytes += file.bytes;
      const target = at(dir, file.rel);
      if (strategy !== 'copy') {
        try {
          fs.linkSync(file.abs, target);
          linked += 1;
          continue;
        } catch (cause) {
          // EXDEV, EPERM, EMLINK, EACCES, or a filesystem that cannot hardlink at all.
          const reason = cause.code || cause.message || 'unknown';
          if (!warned.has(reason)) {
            warned.add(reason);
            onWarn(`snapshot: hardlink unavailable (${reason}); falling back to byte copies`);
          }
        }
      }
      try {
        fs.copyFileSync(file.abs, target);
        copied += 1;
      } catch (cause) {
        throw new Error(`snapshot: cannot copy ${file.rel}: ${cause.message}`);
      }
    }

    const actual = strategy === 'copy' || (copied > 0 && linked === 0) ? 'copy' : copied > 0 ? 'mixed' : 'hardlink';
    return { dir, strategy: actual, fileCount: files.length, bytes, createdAt: new Date().toISOString(), cleanup };
  } catch (cause) {
    // A partial tree is worse than none: the caller must never publish from it.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    throw cause;
  }
}

/** Re-hash a snapshot directory and compare it against a manifest-shaped object. */
export function verifySnapshot(dir, manifest) {
  const root = path.resolve(dir);
  const expected = new Map();
  const byRelative = manifest && manifest.byRelative;
  if (byRelative instanceof Map && byRelative.size) {
    for (const [rel, value] of byRelative) {
      const record = (value && value.record) || value || {};
      expected.set(toPosix(rel), { sha256: record.sha256, bytes: record.bytes });
    }
  } else if (manifest && Array.isArray(manifest.files)) {
    for (const record of manifest.files) expected.set(toPosix(record.path), record);
  }

  // Directories carry no bytes, so they are neither missing nor extra; symlinks are skipped.
  const actual = new Map();
  if (fs.existsSync(root)) {
    for (const entry of listFiles(root)) actual.set(toPosix(path.relative(root, entry.path)), entry.path);
  }

  const mismatches = [];
  const missing = [];
  const extra = [];
  for (const [rel, record] of expected) {
    let bytes = null;
    try {
      bytes = actual.has(rel) ? fs.readFileSync(actual.get(rel)) : null;
    } catch {
      bytes = null;
    }
    if (!bytes) {
      missing.push(rel);
      continue;
    }
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== record.sha256 || (Number.isFinite(record.bytes) && record.bytes !== bytes.length)) {
      mismatches.push({
        path: rel,
        expectedSha256: record.sha256 ?? null,
        actualSha256,
        expectedBytes: record.bytes ?? null,
        actualBytes: bytes.length
      });
    }
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) extra.push(rel);
  }

  mismatches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  missing.sort();
  extra.sort();
  const ok = !mismatches.length && !missing.length && !extra.length && actual.size === expected.size;
  return { ok, mismatches, missing, extra };
}
