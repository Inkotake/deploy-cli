/**
 * Tests for src/proxy.mjs: proxy environment resolution, NO_PROXY matching, CONNECT tunnelling.
 *
 * Every test stays on loopback; nothing here may touch the public internet. The end-to-end tunnel
 * test uses the throwaway self-signed pair in tests/fixtures/tls/, regenerated with an openssl that
 * supports SANs -- if those fixtures are missing, that test skips instead of failing:
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=localhost' \
 *     -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
 *     -keyout tests/fixtures/tls/key.pem -out tests/fixtures/tls/cert.pem
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import {
  resolveProxyEnv,
  shouldBypass,
  proxyFor,
  proxyAuthorization,
  connectViaProxy,
  createProxiedAgent,
} from '../src/proxy.mjs';

const TLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
const CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const KEY_PATH = path.join(TLS_DIR, 'key.pem');
const HAVE_TLS_FIXTURES = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);

const basic = (credentials) => 'Basic ' + Buffer.from(credentials, 'utf8').toString('base64');

/** Listen on an ephemeral loopback port. */
function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

/** Track a server's sockets: CONNECT-upgraded ones are detached from its own bookkeeping. */
function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
}

/** Close a server and force-destroy its sockets, so cleanup can never hang the suite. */
function close(server, sockets) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    for (const socket of sockets ?? []) socket.destroy();
    server.closeAllConnections?.();
    if (!server.listening) return resolve();
    server.close(() => resolve());
    setTimeout(resolve, 1500); // safety net only; the sockets above are already destroyed
  });
}

/** A loopback port that nothing is listening on (bound, then released). */
async function unusedPort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

/** Start an http server with `handler` on 'connect', run `run(port)`, then always clean up. */
async function withConnectServer(handler, run) {
  const server = http.createServer();
  const sockets = trackSockets(server);
  server.on('connect', handler);
  const port = await listen(server);
  try {
    return await run(port);
  } finally {
    await close(server, sockets);
  }
}

test('resolveProxyEnv reads every proxy variable, case-insensitively', () => {
  assert.deepEqual(resolveProxyEnv({}), { httpProxy: null, httpsProxy: null, allProxy: null, noProxy: null });
  const cases = [
    ['httpProxy', { HTTP_PROXY: 'http://p:3128' }], ['httpProxy', { http_proxy: 'http://p:3128' }],
    ['httpProxy', { Http_Proxy: 'http://p:3128' }], ['httpsProxy', { HTTPS_PROXY: 'http://s:8443' }],
    ['httpsProxy', { https_proxy: 'http://s:8443' }], ['allProxy', { ALL_PROXY: 'socks5://a:1080' }],
    ['allProxy', { all_proxy: 'socks5://a:1080' }], ['noProxy', { NO_PROXY: 'localhost,.corp.test' }],
    ['noProxy', { no_proxy: 'localhost,.corp.test' }],
  ];
  for (const [field, env] of cases) {
    assert.equal(resolveProxyEnv(env)[field], env[Object.keys(env)[0]], `${field} from ${Object.keys(env)[0]}`);
  }
  // Unrelated variables stay out, malformed values are kept verbatim, empties count as unset.
  assert.equal(resolveProxyEnv({ PATH: '/usr/bin' }).httpProxy, null);
  assert.equal(resolveProxyEnv({ HTTP_PROXY: 'not a url at all' }).httpProxy, 'not a url at all');
  assert.equal(resolveProxyEnv({ HTTP_PROXY: '' }).httpProxy, null);
});

test('proxyFor picks the right variable per target scheme', () => {
  const env = { HTTP_PROXY: 'http://plain:8080', HTTPS_PROXY: 'http://secure:8443', ALL_PROXY: 'http://all:1080' };
  const cases = [
    ['https://api.example.com/v1', env, 'http://secure:8443'], ['wss://api.example.com/socket', env, 'http://secure:8443'],
    ['http://api.example.com/v1', env, 'http://plain:8080'], ['ws://api.example.com/socket', env, 'http://plain:8080'],
    ['https://api.example.com/', { ALL_PROXY: 'http://all:1080' }, 'http://all:1080'],
    ['http://api.example.com/', { ALL_PROXY: 'http://all:1080' }, 'http://all:1080'],
    ['https://api.example.com/', {}, null], ['ftp://files.example.com/x', env, null], ['not a url', env, null],
    ['https://api.example.com/', { HTTP_PROXY: 'http://plain:8080' }, null], // http proxy never serves https
  ];
  for (const [url, environment, expected] of cases) {
    assert.equal(proxyFor(url, environment), expected, `${url} with ${JSON.stringify(environment)}`);
  }
});

test('proxyFor honours NO_PROXY and lets an explicit proxy override it', () => {
  const env = {
    HTTPS_PROXY: 'http://secure:8443',
    HTTP_PROXY: 'http://plain:8080',
    NO_PROXY: 'internal.example.com,.corp.example.com,svc.example.com:8080,localhost,127.0.0.1,[::1]',
  };
  const direct = [
    'https://internal.example.com/',
    'https://deep.internal.example.com/x',
    'https://corp.example.com/',
    'https://a.corp.example.com/x',
    'http://localhost:3000/',
    'http://127.0.0.1:3000/',
    'https://[::1]:8443/',
    'http://svc.example.com:8080/',
  ];
  for (const url of direct) assert.equal(proxyFor(url, env), null, `${url} should be bypassed`);
  const proxied = [
    ['https://example.com/', 'http://secure:8443'],
    ['https://notinternal.example.com/', 'http://secure:8443'],
    ['http://svc.example.com:9090/', 'http://plain:8080'],
    ['https://svc.example.com/', 'http://secure:8443'],
  ];
  for (const [url, expected] of proxied) assert.equal(proxyFor(url, env), expected, url);
  // An explicit proxy wins unconditionally: NO_PROXY must not apply to it.
  for (const url of ['https://internal.example.com/', 'https://corp.example.com/x']) {
    assert.equal(proxyFor(url, env, 'http://explicit:9999'), 'http://explicit:9999', url);
  }
  assert.equal(proxyFor('https://example.com/', {}, 'http://explicit:9999'), 'http://explicit:9999');
  // '*' bypasses everything.
  assert.equal(proxyFor('https://example.com/', { ...env, NO_PROXY: '*' }), null);
  assert.equal(proxyFor('http://example.com/', { ...env, NO_PROXY: '*' }), null);
});

test('shouldBypass implements the NO_PROXY semantics matrix', () => {
  const cases = [
    ['example.com', null, null, false], ['example.com', '', null, false], ['example.com', ' , , ', null, false],
    ['example.com', '*', null, true], ['example.com', 'example.com', null, true], ['example.com', '.example.com', null, true],
    ['api.example.com', 'example.com', null, true], ['api.example.com', '.example.com', null, true],
    ['EXAMPLE.COM', 'example.com', null, true], ['api.example.com', 'EXAMPLE.com', null, true],
    ['notexample.com', 'example.com', null, false], ['example.com.evil.test', 'example.com', null, false],
    ['localhost', 'localhost', null, true], ['localhost.evil.test', 'localhost', null, false],
    ['127.0.0.1', '127.0.0.1', null, true], ['127.0.0.2', '127.0.0.1', null, false],
    ['[::1]', '[::1]', null, true], ['::1', '[::1]', null, true], ['[::2]', '[::1]', null, false],
    ['example.com', 'example.com:8080', 8080, true], ['example.com', 'example.com:8080', '8080', true],
    ['example.com', 'example.com:8080', 9090, false], ['example.com', 'example.com:8080', null, false],
    ['example.com:8080', 'example.com:8080', null, true], ['example.com', 'a.test, example.com ,b.test', null, true],
    ['other.test', 'a.test example.com', null, false],
  ];
  for (const [host, list, port, expected] of cases) {
    assert.equal(shouldBypass(host, list, port), expected, `${host} / ${list} / ${port}`);
  }
});

test('proxyAuthorization reads userinfo, percent-decoding it', () => {
  const cases = [
    ['http://proxy.local:3128', null], ['http://proxy.local:3128/ignored/path', null],
    ['http://user:secret@proxy.local:3128', basic('user:secret')],
    ['https://user:secret@proxy.local:3128', basic('user:secret')],
    ['http://user@proxy.local:3128', basic('user:')],
    ['http://us%40er:p%40ss%3Aword@proxy.local:3128', basic('us@er:p@ss:word')],
    ['user:secret@proxy.local:3128', basic('user:secret')],
    ['http://user:secret@', null], ['not a url', null], ['::::', null], ['', null], [null, null],
    ['socks5://user:secret@proxy.local:1080', null],
    ['http://u:%zz@proxy.local:3128', basic('u:%zz')], // undecodable escape is kept verbatim
  ];
  for (const [url, expected] of cases) {
    assert.equal(proxyAuthorization(url), expected, `authorization for ${JSON.stringify(url)}`);
  }
});

test('connectViaProxy fails cleanly for bad URLs, refused ports and non-200 CONNECT', async () => {
  const target = new URL('https://localhost:8443/');
  await assert.rejects(connectViaProxy('::::', target), (error) => {
    assert.equal(error.code, 'E_PROXY_URL');
    return /invalid proxy URL/.test(error.message);
  });
  await assert.rejects(connectViaProxy('http://proxy.local:3128', new URL('http://plain.test/')), (error) => {
    assert.equal(error.code, 'E_PROXY_URL');
    return /https targets only/.test(error.message);
  });

  // Nothing is listening on this loopback port, so the tunnel cannot even start.
  const deadPort = await unusedPort();
  await assert.rejects(
    connectViaProxy(`http://127.0.0.1:${deadPort}`, target, { timeoutMs: 5000 }),
    /proxy connection to 127\.0\.0\.1:\d+ failed/,
  );

  // A proxy that refuses the tunnel with 403.
  await withConnectServer(
    (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'),
    async (port) => {
      await assert.rejects(connectViaProxy(`http://127.0.0.1:${port}`, target, { timeoutMs: 5000 }), (error) => {
        assert.equal(error.code, 'E_PROXY_CONNECT_STATUS');
        assert.match(error.message, /403/);
        assert.match(error.message, /localhost:8443/);
        return true;
      });
    },
  );

  // A proxy that accepts the connection but never answers CONNECT must time out.
  await withConnectServer(
    () => {},
    async (port) => {
      await assert.rejects(connectViaProxy(`http://127.0.0.1:${port}`, target, { timeoutMs: 250 }), (error) => {
        assert.equal(error.code, 'E_PROXY_TIMEOUT');
        return /timed out after 250ms/.test(error.message);
      });
    },
  );
});

test('createProxiedAgent tunnels real https requests through local CONNECT proxies', async (t) => {
  if (!HAVE_TLS_FIXTURES) {
    t.skip('no openssl to mint a test certificate');
    return;
  }
  const key = fs.readFileSync(KEY_PATH);
  const cert = fs.readFileSync(CERT_PATH);
  const origin = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tunnel-ok');
  });
  const originSockets = trackSockets(origin);
  const originPort = await listen(origin);

  let connects = 0;
  const tunnelHandler = (req, clientSocket, head) => {
    connects += 1;
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  };
  const plain = http.createServer();
  const plainSockets = trackSockets(plain);
  plain.on('connect', tunnelHandler);
  const plainPort = await listen(plain);
  const secure = https.createServer({ key, cert }); // https: proxy, so TLS comes before CONNECT
  const secureSockets = trackSockets(secure);
  secure.on('connect', tunnelHandler);
  const securePort = await listen(secure);

  const agents = [];
  // The local proxy is always passed explicitly, so NO_PROXY (and every other proxy variable) is
  // irrelevant: the bypass logic must never make these requests skip the proxy.
  const fetchThrough = (proxyUrl, agentOptions) =>
    new Promise((resolve, reject) => {
      const agent = createProxiedAgent(proxyUrl, new URL(`https://localhost:${originPort}/`), agentOptions);
      agents.push(agent);
      // Verifying the origin's self-signed cert via `ca` proves the tunnel TLS is really configured.
      const request = https.request(
        { host: 'localhost', port: originPort, path: '/', agent, ca: cert, servername: 'localhost' },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });

  try {
    assert.deepEqual(await fetchThrough(`http://127.0.0.1:${plainPort}`, {}), { status: 200, body: 'tunnel-ok' });
    // The fixture CA is not in the system store, so the proxy's own TLS is not verified here.
    const viaTls = await fetchThrough(`https://localhost:${securePort}`, { proxyRejectUnauthorized: false });
    assert.deepEqual(viaTls, { status: 200, body: 'tunnel-ok' });
    assert.equal(connects, 2);
    assert.ok(agents[0] instanceof https.Agent);
    assert.equal(agents[0].keepAlive, false);
  } finally {
    for (const agent of agents) agent.destroy();
    await close(plain, plainSockets);
    await close(secure, secureSockets);
    await close(origin, originSockets);
  }
});

test('createProxiedAgent rejects when the proxy is unreachable', async () => {
  const deadPort = await unusedPort();
  const agent = createProxiedAgent(`http://127.0.0.1:${deadPort}`, new URL('https://example.com/'), {
    timeoutMs: 5000,
  });
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          agent.createConnection({}, (error, socket) => (error ? reject(error) : resolve(socket)));
        }),
      (error) => {
        assert.equal(error.code, 'E_PROXY_SOCKET');
        return /proxy connection to 127\.0\.0\.1:\d+ failed/.test(error.message);
      },
    );
  } finally {
    agent.destroy();
  }
});
