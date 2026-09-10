/**
 * HTTP(S) forward-proxy support for verified-publish.
 *
 * WHY: the CLI reaches artifact hosts and deploy APIs from machines behind corporate or regional
 * forward proxies, and Node's http/https/fetch ignore the conventional proxy environment variables
 * -- so without this module every publish from such a network fails with an opaque connect timeout.
 * It resolves HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY case-insensitively (like curl and Go),
 * decides which hosts bypass the proxy, and opens CONNECT tunnels for https targets. Only `node:`
 * builtins are used; nothing here touches the network at import time.
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** Environment variable pairs, in precedence order, backing each `resolveProxyEnv` field. */
const PROXY_ENV_KEYS = {
  httpProxy: ['HTTP_PROXY', 'http_proxy'],
  httpsProxy: ['HTTPS_PROXY', 'https_proxy'],
  allProxy: ['ALL_PROXY', 'all_proxy'],
  noProxy: ['NO_PROXY', 'no_proxy'],
};

/** Effective port per URL scheme, used when a NO_PROXY rule is port-qualified. */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

/** Case-insensitive first non-empty value among `names`; empty values count as unset. */
function readEnvValue(env, names) {
  const lowered = new Map(Object.keys(env ?? {}).map((key) => [key.toLowerCase(), env[key]]));
  for (const name of names) {
    const value = String(lowered.get(name.toLowerCase()) ?? '').trim();
    if (value !== '') return value;
  }
  return null;
}

/** Split `host`, `host:port` and `[v6]:port` into a lower-cased host plus an optional port. */
function splitHostPort(value) {
  const text = String(value ?? '').trim();
  const match = /^\[(.+)\](?::(\d+))?$/.exec(text) ?? /^([^:]+):(\d+)$/.exec(text);
  if (match) return { host: match[1].toLowerCase(), port: match[2] ?? null };
  return { host: text.toLowerCase(), port: null };
}

/** True when a host matches the rule exactly or as a subdomain; `*` matches everything. */
function hostMatches(host, rule) {
  if (rule === '*') return true;
  const bare = (value) => value.replace(/^\.+/, '');
  const wanted = bare(host);
  const pattern = bare(rule);
  return pattern !== '' && wanted !== '' && (wanted === pattern || wanted.endsWith('.' + pattern));
}

/** Error factory carrying the short stable `code` that callers switch on. */
function proxyError(code, message, cause) {
  return Object.assign(new Error(message), { code }, cause === undefined ? {} : { cause });
}

/** Parse a proxy URL; a bare `host:port` is assumed to be an http proxy. */
function parseProxyUrl(proxyUrl) {
  const text = String(proxyUrl ?? '').trim();
  if (text === '') throw proxyError('E_PROXY_URL', 'proxy URL is empty');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch (cause) {
    throw proxyError('E_PROXY_URL', `invalid proxy URL: ${text}`, cause);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw proxyError('E_PROXY_URL', `unsupported proxy protocol "${url.protocol}" in ${url.href}`);
  if (url.hostname === '') throw proxyError('E_PROXY_URL', `proxy URL has no host: ${url.href}`);
  return url;
}

/** Read the proxy environment (case-insensitively) into a plain, never-throwing record. */
export function resolveProxyEnv(env = process.env) {
  const resolved = {};
  for (const [field, names] of Object.entries(PROXY_ENV_KEYS)) resolved[field] = readEnvValue(env, names);
  return resolved;
}

/** True when `hostname` matches a NO_PROXY list; an empty or empty-entry-only list bypasses nothing. */
export function shouldBypass(hostname, noProxy, port = null) {
  if (noProxy === null || noProxy === undefined) return false;
  const entries = String(noProxy).split(/[\s,]+/).filter((entry) => entry !== '');
  if (entries.length === 0) return false;
  const target = splitHostPort(hostname);
  const targetPort = port === null || port === undefined || port === '' ? target.port : String(port);
  for (const entry of entries) {
    const rule = splitHostPort(entry);
    if (!hostMatches(target.host, rule.host)) continue;
    if (rule.port !== null && rule.port !== targetPort) continue;
    return true;
  }
  return false;
}

/** Proxy URL to use for `targetUrl`, or null when the request should go direct. */
export function proxyFor(targetUrl, env = process.env, explicitProxy = null) {
  const explicit = explicitProxy === null || explicitProxy === undefined ? '' : String(explicitProxy).trim();
  if (explicit !== '') return explicit; // explicit wins unconditionally: NO_PROXY must not apply.
  let url;
  try {
    url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  } catch {
    return null;
  }
  const { httpProxy, httpsProxy, allProxy, noProxy } = resolveProxyEnv(env);
  let proxy = null;
  if (url.protocol === 'https:' || url.protocol === 'wss:') proxy = httpsProxy ?? allProxy;
  else if (url.protocol === 'http:' || url.protocol === 'ws:') proxy = httpProxy ?? allProxy;
  if (!proxy) return null;
  const port = url.port !== '' ? url.port : DEFAULT_PORTS[url.protocol] ?? null;
  return shouldBypass(url.hostname, noProxy, port) ? null : proxy;
}

/** `Basic <base64>` proxy header value decoded from the URL userinfo, or null without credentials. */
export function proxyAuthorization(proxyUrl) {
  let url;
  try {
    url = parseProxyUrl(proxyUrl);
  } catch {
    return null;
  }
  const decode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const username = url.username ?? '';
  const password = url.password ?? '';
  if (username === '' && password === '') return null;
  return `Basic ${Buffer.from(`${decode(username)}:${decode(password)}`, 'utf8').toString('base64')}`;
}

/**
 * Open a CONNECT tunnel and TLS-connect over it; resolves the ready TLSSocket. Also accepts `ca`,
 * `alpnProtocols` and `proxyRejectUnauthorized` (verification of an https proxy's own cert).
 */
export async function connectViaProxy(proxyUrl, target, options = {}) {
  const {
    timeoutMs = 30000,
    servername = target instanceof URL ? target.hostname : undefined,
    rejectUnauthorized = true,
    proxyRejectUnauthorized = true,
    alpnProtocols = ['http/1.1'],
    ca,
  } = options;
  if (!(target instanceof URL) || target.protocol !== 'https:') {
    throw proxyError('E_PROXY_URL', `connectViaProxy tunnels https targets only, got ${target?.protocol ?? 'no URL'}`);
  }
  const proxy = parseProxyUrl(proxyUrl);
  const authority = `${target.hostname}:${Number(target.port || 443)}`;
  const headers = { host: authority, connection: 'keep-alive' };
  const authorization = proxyAuthorization(proxy.href);
  if (authorization) headers['proxy-authorization'] = authorization;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let tunnel = null;
    const timer = setTimeout(() => {
      settle(proxyError('E_PROXY_TIMEOUT', `proxy CONNECT to ${authority} via ${proxy.host} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    /** Settle once: on error destroy the tunnel/request, on success hand the socket over. */
    function settle(error, socket) {
      if (settled) return void socket?.destroy();
      settled = true;
      clearTimeout(timer);
      if (!error) return resolve(socket);
      (tunnel ?? request).destroy();
      reject(error);
    }

    const isTls = proxy.protocol === 'https:';
    const request = (isTls ? https : http).request({
      host: proxy.hostname,
      port: Number(proxy.port || (isTls ? 443 : 80)),
      method: 'CONNECT',
      path: authority, // any path on the proxy URL is ignored: CONNECT goes to the authority
      headers,
      agent: false,
      ...(isTls ? { servername: proxy.hostname, rejectUnauthorized: proxyRejectUnauthorized } : {}),
    });
    request.on('connect', (response, socket) => {
      tunnel = socket;
      if (response.statusCode !== 200) {
        const status = response.statusMessage ? `${response.statusCode} ${response.statusMessage}` : response.statusCode;
        settle(proxyError('E_PROXY_CONNECT_STATUS', `proxy CONNECT to ${authority} failed with status ${status}`));
        return;
      }
      const secure = tls.connect({ socket, servername, rejectUnauthorized, ca, ALPNProtocols: alpnProtocols });
      const onError = (cause) => {
        secure.destroy();
        settle(proxyError('E_PROXY_TLS', `TLS handshake with ${authority} through proxy failed: ${cause.message}`, cause));
      };
      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.removeListener('error', onError);
        settle(null, secure);
      });
    });
    request.on('error', (cause) => {
      settle(proxyError('E_PROXY_SOCKET', `proxy connection to ${proxy.host} failed: ${cause.message}`, cause));
    });
    request.end();
  });
}

/** https.Agent that CONNECT-tunnels every connection to one fixed target through `proxyUrl`. */
export function createProxiedAgent(proxyUrl, target, options = {}) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (requestOptions = {}, callback) => {
    const tunnel = {
      timeoutMs: options.timeoutMs,
      alpnProtocols: options.alpnProtocols,
      proxyRejectUnauthorized: options.proxyRejectUnauthorized,
      servername: options.servername ?? requestOptions.servername ?? target.hostname,
      rejectUnauthorized: requestOptions.rejectUnauthorized ?? options.rejectUnauthorized ?? true,
      ca: requestOptions.ca ?? options.ca,
    };
    connectViaProxy(proxyUrl, target, tunnel).then(
      (socket) => callback(null, socket),
      (error) => callback(error),
    );
    return undefined; // asynchronous: the agent gets the socket through the callback
  };
  return agent;
}
