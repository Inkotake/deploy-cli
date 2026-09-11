/**
 * Artifact discovery, manifest building, and the safety scan.
 *
 * The manifest is the single source of truth for planning (required extensions and sizes),
 * deployment (byte-identical uploads) and verification (remote SHA-256 comparison).
 */

import fs from 'node:fs';
import path from 'node:path';
import { error, formatBytes, listDirs, listFiles, log, mimeForPath, sha256Hex, toPosix, warn } from './common.mjs';
import { classifyBlock, classifyDirectory } from './safety.mjs';

/** Directory names that conventionally hold a built static artifact, most specific first. */
export const BUILD_DIR_NAMES = ['dist', 'build', 'public', 'out'];

const MODEL_EXTENSIONS = ['.glb', '.gltf'];
const WASM_EXTENSIONS = ['.wasm'];
const FONT_EXTENSIONS = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];
const SOURCE_MAP_EXTENSIONS = ['.map'];
const BINARY_EXTENSIONS = ['.glb', '.gltf', '.bin', '.wasm', '.woff', '.woff2', '.ttf', '.otf'];

/** Look for an index.html at or below `start`, bounded so a huge tree cannot stall the CLI. */
export function discoverArtifacts(start, options = {}) {
  const maxDepth = options.maxDepth ?? 3;
  const root = path.resolve(start);
  const found = [];
  const probe = (dir, depth, label) => {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) {
        found.push({ dir: path.resolve(dir), relative: label, depth });
        return true;
      }
    } catch {
      /* not a directory or unreadable */
    }
    return false;
  };

  if (!fs.existsSync(root)) return { root, artifacts: [] };

  if (probe(root, -1, '.')) return { root, artifacts: found };

  for (const name of BUILD_DIR_NAMES) {
    probe(path.join(root, name), 0, name);
  }
  if (found.length) return { root, artifacts: found };

  const descend = (dir, depth, prefix) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const next = path.join(dir, entry.name);
      const label = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const name of BUILD_DIR_NAMES) {
        probe(path.join(next, name), depth, `${label}/${name}`);
      }
      descend(next, depth + 1, label);
    }
  };
  descend(root, 1, '');
  return { root, artifacts: found };
}

export function resolveArtifact(start, options = {}) {
  const candidates = Array.isArray(start) ? start.filter(Boolean) : [start].filter(Boolean);
  for (const candidate of candidates) {
    const { artifacts } = discoverArtifacts(candidate, options);
    if (artifacts.length) {
      const explicit = artifacts.find((artifact) => artifact.relative === '.');
      return { artifact: explicit || artifacts[0], searched: candidate };
    }
  }
  return { artifact: null, searched: candidates.join(', ') || process.cwd() };
}

/* -------------------------------------------------------------- manifest ---- */

export function buildManifest(dir) {
  const root = path.resolve(dir);
  const entries = listFiles(root);
  const files = [];
  const byRelative = new Map();

  for (const entry of entries) {
    const rel = toPosix(path.relative(root, entry.path));
    let bytes = Buffer.alloc(0);
    try {
      bytes = fs.readFileSync(entry.path);
    } catch (cause) {
      warn(`Cannot read ${rel}: ${cause.message}`);
      continue;
    }
    const record = {
      path: rel,
      bytes: bytes.length,
      mime: mimeForPath(rel),
      sha256: sha256Hex(bytes)
    };
    files.push(record);
    byRelative.set(rel, { record, bytes });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const extensions = [...new Set(files.map((file) => path.extname(file.path).toLowerCase()).filter(Boolean))].sort();
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  let largest = null;
  for (const file of files) {
    if (!largest || file.bytes > largest.bytes) largest = file;
  }

  const hasExtension = (list) => files.some((file) => list.includes(path.extname(file.path).toLowerCase()));

  return {
    dir: root,
    files,
    byRelative,
    fileCount: files.length,
    totalBytes,
    largest: largest ? { path: largest.path, bytes: largest.bytes } : null,
    extensions,
    features: {
      models: hasExtension(MODEL_EXTENSIONS),
      wasm: hasExtension(WASM_EXTENSIONS),
      fonts: hasExtension(FONT_EXTENSIONS),
      video: hasExtension(VIDEO_EXTENSIONS),
      audio: hasExtension(AUDIO_EXTENSIONS),
      sourceMaps: hasExtension(SOURCE_MAP_EXTENSIONS),
      binaries: hasExtension(BINARY_EXTENSIONS),
      hasIndexHtml: files.some((file) => file.path === 'index.html'),
      emptyFiles: files.some((file) => file.bytes === 0),
      singlePageOnly: files.every((file) => !file.path.includes('/')),
      // Layout facts some hosts document as hard limits (Dropley: 5 levels, 255-character paths).
      // The registry can only be enforced if the artifact reports them, so they are measured here.
      maxDirectoryDepth: files.reduce((max, file) => Math.max(max, file.path.split('/').length - 1), 0),
      longestPathLength: files.reduce((max, file) => Math.max(max, file.path.length), 0)
    }
  };
}

/* ---------------------------------------------------------- reference scan ---- */

const REFERENCE_ATTRIBUTES = ['src', 'href', 'poster', 'data-src'];
const SKIP_PREFIXES = ['http:', 'https:', '//', 'data:', 'mailto:', 'tel:', 'javascript:', 'blob:', '#', 'about:'];

/** Extract local references from an HTML document. */
export function extractReferences(html) {
  const refs = [];
  const attributePattern = new RegExp(`(?:^|[\\s"'<(])(${REFERENCE_ATTRIBUTES.join('|')})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'gi');
  let match;
  while ((match = attributePattern.exec(html)) !== null) {
    refs.push({ attribute: match[1].toLowerCase(), raw: match[2].replace(/^["']|["']$/g, '') });
  }
  const cssPattern = /url\(\s*("[^"]*"|'[^']*'|[^)"']+)\s*\)/gi;
  while ((match = cssPattern.exec(html)) !== null) {
    refs.push({ attribute: 'css-url', raw: match[1].replace(/^["']|["']$/g, '') });
  }
  return refs;
}

function normalizeReference(raw, fromPath) {
  let value = String(raw || '').trim();
  if (!value) return null;
  for (const prefix of SKIP_PREFIXES) {
    if (value.toLowerCase().startsWith(prefix)) return null;
  }
  value = value.split('#')[0].split('?')[0];
  if (!value) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw value when it is not valid percent-encoding */
  }
  const baseDir = path.posix.dirname(fromPath);
  const joined = value.startsWith('/') ? value.slice(1) : path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, value));
  if (joined.startsWith('..')) return null; // resolves outside the artifact
  return joined;
}

/**
 * Scan HTML for local references.
 *
 * Two different findings come out of this. `missing` is a broken link to a file that should exist —
 * always a problem. `routes` are extensionless or directory-style references (`/dashboard`,
 * `./about/`): normal in a single-page app, where the host is expected to serve the root document
 * for an unknown path. They are not errors; they are evidence that the artifact wants a host with
 * SPA fallback, which the plan reports instead of silently guessing.
 */
export function scanReferences(manifest) {
  const present = new Set(manifest.files.map((file) => file.path));
  const missing = [];
  const routes = [];
  const checked = new Set();

  for (const file of manifest.files) {
    if (!/\.html?$/i.test(file.path)) continue;
    const data = manifest.byRelative.get(file.path);
    if (!data) continue;
    const html = data.bytes.toString('utf8');
    for (const ref of extractReferences(html)) {
      const target = normalizeReference(ref.raw, file.path);
      if (!target) continue;
      const key = `${file.path}\u0000${target}`;
      if (checked.has(key)) continue;
      checked.add(key);
      if (present.has(target)) continue;
      if (!path.posix.extname(target) || target.endsWith('/')) {
        routes.push({ from: file.path, attribute: ref.attribute, reference: ref.raw, resolved: target });
        continue;
      }
      missing.push({ from: file.path, attribute: ref.attribute, reference: ref.raw, resolved: target });
    }
  }
  return { missing, routes };
}

/* ------------------------------------------------------------------ scan ---- */

export function inspectArtifact(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: `Not a directory: ${root}` };
  }
  const manifest = buildManifest(root);
  if (!manifest.fileCount) {
    return { ok: false, error: `No files found in ${root}` };
  }

  const blocked = [];
  const warnings = [];
  for (const file of manifest.files) {
    const verdict = classifyBlock(file.path);
    if (!verdict) continue;
    if (verdict.severity === 'blocked') {
      blocked.push({ path: file.path, bytes: file.bytes, rules: verdict.rules, reasons: verdict.reasons });
    } else {
      warnings.push({ path: file.path, rules: verdict.rules, reasons: verdict.reasons });
    }
  }

  const directories = listDirs(root);
  for (const dirName of directories) {
    const rule = classifyDirectory(dirName);
    if (rule) {
      blocked.push({ path: dirName + '/', bytes: 0, rules: [rule], reasons: ['sensitive directory present in the artifact'] });
    }
  }

  const { missing: missingReferences, routes } = scanReferences(manifest);
  manifest.features.spaRouting = routes.length > 0;

  return {
    ok: true,
    manifest,
    safety: {
      blocked,
      warnings,
      missingReferences,
      routes,
      clean: blocked.length === 0 && missingReferences.length === 0
    },
    // Secrets themselves are never echoed; only their location and rule ids.
    findings: {
      blockedCount: blocked.length,
      warningCount: warnings.length,
      missingReferenceCount: missingReferences.length,
      routeCount: routes.length
    }
  };
}

/* ------------------------------------------------------------------ output ---- */

export function summarizeInspect(result) {
  const manifest = result.manifest;
  return {
    dir: manifest.dir,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    largestFile: manifest.largest,
    extensions: manifest.extensions,
    features: manifest.features,
    manifest: manifest.files,
    blocked: result.safety.blocked,
    warnings: result.safety.warnings,
    missingReferences: result.safety.missingReferences,
    routes: result.safety.routes || [],
    clean: result.safety.clean
  };
}

export function printInspect(summary, options = {}) {
  const write = options.write || log;
  write('Artifact: ' + summary.dir);
  write(`  files:  ${summary.fileCount} (${formatBytes(summary.totalBytes)})`);
  if (summary.largestFile) write(`  largest: ${summary.largestFile.path} (${formatBytes(summary.largestFile.bytes)})`);
  write('  extensions: ' + (summary.extensions.join(' ') || '(none)'));
  const flags = Object.entries(summary.features).filter(([, value]) => value === true).map(([key]) => key);
  write('  present: ' + (flags.join(' ') || '(nothing notable)'));
  if (summary.blocked.length) {
    write('  BLOCKED:');
    for (const item of summary.blocked) write(`    ${item.path} - ${item.reasons.join('; ')}`);
  } else {
    write('  safety scan: no hard-blocked files');
  }
  if (summary.warnings.length) {
    write('  warnings:');
    for (const item of summary.warnings) write(`    ${item.path} - ${item.reasons.join('; ')}`);
  }
  if (summary.missingReferences.length) {
    write('  missing referenced files:');
    for (const item of summary.missingReferences) write(`    ${item.from} -> ${item.reference}`);
  }
  if (summary.routes.length) {
    write(`  client-side routes needing host SPA fallback: ${summary.routes.length} (${summary.routes.slice(0, 3).map((route) => route.resolved).join(', ')}${summary.routes.length > 3 ? ', …' : ''})`);
  }
  write(summary.clean ? '  result: clean' : '  result: NOT clean');
  return summary;
}

export function inspectFailure(message) {
  error(message);
  return { ok: false, error: message };
}
