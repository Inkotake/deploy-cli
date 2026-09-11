/**
 * Shared helpers: stream discipline, state paths, HTTP, archives, process spawning.
 *
 * Output contract: `log` writes to stdout, `warn`/`error`/`trace` go to stderr, so `--json` mode can
 * reserve stdout for exactly one JSON document that a caller can pipe straight into a parser.
 *
 * Only `node:` builtins and relative modules are used: the tool has no dependencies and no install
 * step, which is why it can run from a tarball or a single-file bundle.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as identity from './identity.mjs';
import { createProxiedAgent, proxyAuthorization, proxyFor } from './proxy.mjs';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = path.resolve(__dirname, '..');
export const PACKAGE_ROOT = path.resolve(CLI_ROOT, '..');
export const LOG_PREFIX = identity.LOG_PREFIX;

export function log(msg) {
  process.stdout.write(msg + '\n');
}

export function warn(msg) {
  process.stderr.write(LOG_PREFIX + 'WARN ' + msg + '\n');
}

export function error(msg) {
  process.stderr.write(LOG_PREFIX + 'ERROR ' + msg + '\n');
}

export function trace(msg) {
  process.stderr.write(LOG_PREFIX + msg + '\n');
}

/** Emit exactly one JSON document on stdout. This is the only stdout writer in `--json` mode. */
export function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function firstDirectory(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Mutable state (provider health, stored claims, the availability overlay) lives here and never in
 * the installation directory, which may be read-only or shared between users.
 * Falls back to a dot-directory in the user's home when no environment variable is set.
 */
export function resolveStateHome(env = process.env) {
  const explicit = identity.pickEnv(env, identity.ENV.home);
  const base = explicit ? path.resolve(explicit) : path.join(os.homedir(), identity.DEFAULT_STATE_DIR);
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (cause) {
    warn(`Cannot create state directory ${base}: ${cause.message}`);
  }
  return base;
}

export function statePath(name, env = process.env) {
  return path.join(resolveStateHome(env), name);
}

/**
 * Where the optional persistent-provider CLIs (netlify / wrangler / vercel) live, if the user
 * vendored them next to this package or unpacked a bundle.
 *
 * The tool never installs them: when no directory is found the bare command name is used and the
 * operating system's PATH decides, so a user who already has `vercel` on PATH needs nothing else.
 */
export function resolveDeployBinRoot(env = process.env) {
  const deployBin = identity.pickEnv(env, identity.ENV.deployBin);
  const deployHome = identity.pickEnv(env, identity.ENV.deployHome);
  return firstDirectory([
    deployBin,
    deployHome && path.join(deployHome, 'node_modules', '.bin'),
    deployHome && path.join(deployHome, '.bin'),
    // A bundle unpacked beside the package: <package>/deploy/node_modules/.bin
    path.join(PACKAGE_ROOT, 'deploy', 'node_modules', '.bin'),
    path.join(PACKAGE_ROOT, 'vendor', 'deploy', 'node_modules', '.bin')
  ]);
}

/**
 * Resolve a bundled CLI executable. Returns an absolute path into the bundled tree when it
 * exists, otherwise the bare name so the OS PATH can still satisfy it. Never installs anything.
 */
export function resolveBundledBin(name, env = process.env) {
  const root = resolveDeployBinRoot(env);
  if (root) {
    const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['', '.cmd'];
    for (const suffix of suffixes) {
      const candidate = path.join(root, name + suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/**
 * Turn a resolved binary into a spawn plan that never needs a shell.
 *
 * On Windows a bundled CLI is a `.cmd` shim, and spawning it with `shell: true` makes Node
 * concatenate the arguments (DEP0190) — a real injection risk for a path taken from user input.
 * The shim itself contains the entry script, so the script is extracted and run with the current
 * Node executable instead. No shell, and arguments are passed as an argv array.
 */
export function describeSpawnTarget(binary) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(binary)) {
    return { command: binary, prefixArgs: [], shell: false };
  }
  const entry = extractCmdEntry(binary);
  if (entry) {
    return { command: process.execPath, prefixArgs: [entry], shell: false };
  }
  // Unrecognised shim: fall back to the shell, which is what the shim needs.
  return { command: binary, prefixArgs: [], shell: true };
}

function extractCmdEntry(shimPath) {
  try {
    const text = fs.readFileSync(shimPath, 'utf8');
    const matches = [...text.matchAll(/"([^"]*%dp0%[^"]*\.(?:js|cjs|mjs))"/gi)];
    if (!matches.length) return null;
    const raw = matches[matches.length - 1][1];
    const resolved = raw.replace(/%dp0%/gi, path.dirname(shimPath) + path.sep).replace(/[\\/]+/g, path.sep);
    return fs.existsSync(resolved) ? path.resolve(resolved) : null;
  } catch {
    return null;
  }
}

export function readJsonFile(file, fallback = null) {
  try {
    // A UTF-8 BOM (PowerShell `Set-Content -Encoding utf8` writes one) makes JSON.parse throw.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Recursive entry walk. Symlinks are not followed, so a link loop cannot hang the walk. */
export function walkEntries(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
      warn(`Cannot read ${dir}: ${cause.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push({ path: full, name: entry.name, type: 'dir' });
        visit(full);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        out.push({ path: full, name: entry.name, type: 'file', bytes: size });
      }
      // Symlinks and special files are skipped deliberately: a publish must be reproducible.
    }
  };
  visit(root);
  return out;
}

export function listFiles(root) {
  return walkEntries(root).filter((entry) => entry.type === 'file');
}

/** Directory names present anywhere under `root`, relative and POSIX-separated. */
export function listDirs(root) {
  return walkEntries(root)
    .filter((entry) => entry.type === 'dir')
    .map((entry) => toPosix(path.relative(root, entry.path)));
}

export function mimeForPath(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/** Types worth storing uncompressed inside a zip: deflate would only add work. */
export function isAlreadyCompressed(mime) {
  return /^(image\/(png|jpeg|gif|webp|avif)|font\/|application\/(zip|gzip|pdf|wasm|octet-stream))/i.test(mime);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.webxr': 'application/octet-stream'
};

/* ------------------------------------------------------------------ HTTP ---- */

export const USER_AGENT = identity.USER_AGENT;
const MAX_REDIRECTS = 5;

/**
 * Minimal HTTP(S) request helper. Redirects are followed with a POST->GET downgrade for 303
 * only; 301/302/307/308 keep the method and body so provider redirects do not silently drop
 * the upload. The body is always buffered as a Buffer.
 */
export function httpRequest(options) {
  const {
    url: target,
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 60000,
    redirects = MAX_REDIRECTS,
    maxBytes = 64 * 1024 * 1024,
    proxy = null,
    env = process.env
  } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (cause) {
      reject(Object.assign(new Error(`Invalid URL: ${target}`), { code: 'EINVALIDURL' }));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(Object.assign(new Error(`Unsupported protocol: ${parsed.protocol}`), { code: 'EPROTOCOL' }));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    // A proxy changes both the transport and the request target: an HTTPS origin is reached through
    // CONNECT and keeps origin-form paths, while plain HTTP is sent to the proxy in absolute form.
    const proxyUrl = proxyFor(target, env, proxy);
    let transport = isHttps ? https : http;
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers }
    };
    if (proxyUrl) {
      const proxyTarget = new URL(proxyUrl);
      if (isHttps) {
        requestOptions.agent = createProxiedAgent(proxyUrl, parsed, { timeoutMs });
      } else {
        transport = proxyTarget.protocol === 'https:' ? https : http;
        requestOptions.protocol = proxyTarget.protocol;
        requestOptions.hostname = proxyTarget.hostname;
        requestOptions.port = proxyTarget.port || (proxyTarget.protocol === 'https:' ? 443 : 80);
        requestOptions.path = parsed.toString();
        requestOptions.headers = { ...requestOptions.headers, host: parsed.host };
      }
      const authorization = proxyAuthorization(proxyUrl);
      if (authorization) {
        requestOptions.headers = { ...requestOptions.headers, 'proxy-authorization': authorization };
      }
    }
    const request = transport.request(
      requestOptions,
      (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            request.destroy(Object.assign(new Error('Response body too large'), { code: 'EBODYTOOLARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode || 0;
          const responseHeaders = lowerHeaders(response.headers);
          const bodyBuffer = Buffer.concat(chunks);
          const location = responseHeaders.location;
          if (location && status >= 300 && status < 400 && redirects > 0) {
            let next;
            try {
              next = new URL(location, parsed).toString();
            } catch {
              resolve({ status, headers: responseHeaders, body: bodyBuffer, url: parsed.toString(), redirects: 0 });
              return;
            }
            const nextMethod = status === 303 ? 'GET' : method;
            const nextBody = nextMethod === method ? body : null;
            httpRequest({ ...options, url: next, method: nextMethod, body: nextBody, redirects: redirects - 1, proxy, env })
              .then((inner) => resolve({ ...inner, redirects: (inner.redirects || 0) + 1 }))
              .catch(reject);
            return;
          }
          resolve({ status, headers: responseHeaders, body: bodyBuffer, url: parsed.toString(), redirects: MAX_REDIRECTS - redirects });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error(`Request timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    });
    request.on('error', reject);
    if (body) {
      if (typeof body.pipe === 'function') body.pipe(request);
      else request.end(body);
    } else {
      request.end();
    }
  });
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function textOf(response) {
  return response.body ? response.body.toString('utf8') : '';
}

export function jsonOf(response) {
  try {
    return JSON.parse(textOf(response));
  } catch {
    return null;
  }
}

/** Content-Type without parameters, lowercased. */
export function baseContentType(response) {
  const raw = response.headers['content-type'] || '';
  return String(raw).split(';')[0].trim().toLowerCase();
}

/**
 * Decode a response body when the origin compressed it.
 *
 * The tool's own requests do not advertise compression, so this matters in two places: a host that
 * compresses regardless of what was asked for, and the browser-representation probe, which asks for
 * compression on purpose to see what a browser would actually receive.
 */
export function decompressBody(buffer, contentEncoding) {
  const encoding = String(contentEncoding || '').toLowerCase();
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return { body: zlib.gunzipSync(buffer), decoded: true, encoding };
    if (encoding === 'br') return { body: zlib.brotliDecompressSync(buffer), decoded: true, encoding };
    if (encoding === 'deflate') return { body: zlib.inflateSync(buffer), decoded: true, encoding };
  } catch {
    return { body: buffer, decoded: false, encoding };
  }
  return { body: buffer, decoded: false, encoding };
}

export function retryAfterMs(response) {
  const raw = response.headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(String(raw).trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(String(raw));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/* --------------------------------------------------------- multipart form ---- */

export function buildMultipart(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    if (part.value !== undefined) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        'utf8'
      ));
      continue;
    }
    const filename = part.filename ?? part.name;
    const headers = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${part.name}"; filename="${filename}"`,
      `Content-Type: ${part.contentType || 'application/octet-stream'}`,
      '',
      ''
    ].join('\r\n');
    chunks.push(Buffer.from(headers, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

export function randomBoundary() {
  return identity.BOUNDARY_PREFIX + crypto.randomBytes(16).toString('hex');
}

/* ------------------------------------------------------------- archives ---- */

/**
 * Minimal zip writer (deflate or stored). Returns the raw zip bytes.
 * `entries`: [{ name, data }] with POSIX-style forward-slash names.
 */
export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const source = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const mime = entry.mime || mimeForPath(entry.name);
    const store = isAlreadyCompressed(mime) || source.length === 0;
    const compressed = store ? source : zlib.deflateRawSync(source, { level: 9 });
    const useDeflate = !store && compressed.length < source.length;
    const payload = useDeflate ? compressed : source;
    const crc = zlib.crc32(source) >>> 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(useDeflate ? 20 : 10, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(0, 10); // fixed DOS date/time keeps the archive byte-stable
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(source.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, nameBuffer, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4); // unix, zip 3.0
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(useDeflate ? 8 : 0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(source.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer);

    offset += header.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuffer, end]);
}

/**
 * Minimal ustar writer, normally combined with gzip for the Show provider.
 * `entries`: [{ name, data }] with POSIX-style names.
 */
export function createTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 0);
    header.write('        ', 148, 8, 'utf8'); // checksum placeholder
    header.write('0', 156, 1, 'utf8');
    header.write('ustar', 257, 5, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeTarString(buffer, offset, length, value) {
  const text = Buffer.from(String(value), 'utf8');
  text.copy(buffer, offset, 0, Math.min(text.length, length));
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0') + '\0';
  buffer.write(text, offset, length, 'utf8');
}

export function gzip(buffer) {
  return zlib.gzipSync(buffer, { level: 9 });
}

/* --------------------------------------------------------------- process ---- */

export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.stdio || 'inherit',
    shell: options.shell ?? false,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs,
    windowsHide: true
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runCapture(cmd, args, options = {}) {
  const target = options.rawCommand ? { command: cmd, prefixArgs: [], shell: false } : describeSpawnTarget(cmd);
  const result = spawnSync(target.command, [...target.prefixArgs, ...args], {
    stdio: 'pipe',
    shell: options.shell ?? target.shell,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs ?? 120000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ? result.stdout.toString('utf8') : '',
    stderr: result.stderr ? result.stderr.toString('utf8') : '',
    error: result.error || null
  };
}

export function runCaptureAsync(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const target = options.rawCommand ? { command: cmd, prefixArgs: [], shell: false } : describeSpawnTarget(cmd);
    let child;
    try {
      child = spawn(target.command, [...target.prefixArgs, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: options.shell ?? target.shell,
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true
      });
    } catch (cause) {
      resolve({ status: 1, stdout: '', stderr: '', error: cause });
      return;
    }
    const stdout = [];
    const stderr = [];
    let timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (cause) => {
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), error: cause });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), error: null });
    });
  });
}

/**
 * Remove anything credential-shaped from text that is about to be logged, stored in the health
 * cache, or printed in a --json document. Provider error bodies can echo a presigned URL or a
 * token, and neither may ever reach a user-visible surface.
 */
export function redact(value) {
  if (value == null) return value;
  let text = String(value);
  text = text.replace(
    /([?&](?:token|access_token|api_key|apikey|key|password|signature|sig|claim|editToken|artifactToken|claimToken|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"']+/gi,
    '$1<redacted>'
  );
  text = text.replace(/\b(spc|sst|nfc|vcp|dpk|aft_edit)_[A-Za-z0-9_-]{8,}/g, '$1_<redacted>');
  text = text.replace(/\b(bearer)\s+[A-Za-z0-9._\-+/=]{12,}/gi, '$1 <redacted>');
  // Field names that carry credentials, e.g. X-Amz-Signature, api_key, access_token, claimToken.
  // The match is deliberately broad: over-redacting a diagnostic line costs nothing, while
  // under-redacting can leak a presigned URL or an ownership token into a log or JSON document.
  text = text.replace(/((?:^|[^\w-])[A-Za-z][A-Za-z0-9_-]*(?:token|secret|key|signature|credential|password)\s*[:=]\s*)["']?[A-Za-z0-9._\-/+%]{12,}["']?/gi, '$1<redacted>');
  text = text.replace(/\/c\/([A-Za-z0-9_-]{12,})/g, '/c/<redacted>');
  return text;
}
