import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import tls, { createServer as createTlsServer, connect as connectTls, checkServerIdentity } from 'node:tls';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import webPush from 'web-push';
import { createWebPushTransport } from '../dist/webPushTransport.js';

const require = createRequire(import.meta.url);
const ece = require('http_ece');
const fixtureDirectory = new URL('./fixtures/', import.meta.url);
const testCert = await readFile(new URL('web-push-test-cert.fixture', fixtureDirectory));
const testKey = await readFile(new URL('web-push-test-key.fixture', fixtureDirectory));
const wrongHostCert = await readFile(new URL('web-push-wrong-cert.fixture', fixtureDirectory));
const wrongHostKey = await readFile(new URL('web-push-wrong-key.fixture', fixtureDirectory));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function listenTlsServer(onRequest, onBytes = () => {}, credentials = { key: testKey, cert: testCert }) {
  const server = createTlsServer(credentials, (socket) => {
    let buffered = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk) => {
      onBytes(chunk, socket);
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headerText = buffered.subarray(0, headerEnd).toString('latin1');
      const contentLength = Number(/^content-length:\s*(\d+)\s*$/im.exec(headerText)?.[1] ?? 0);
      if (buffered.length < headerEnd + 4 + contentLength) return;
      handled = true;
      onRequest({ socket, bytes: buffered.subarray(0, headerEnd + 4 + contentLength), headers: headerText });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

async function localTlsDial(hostname, address, signal, port, observeSecure = () => {}) {
  const socket = connectTls({ host: '127.0.0.1', port, servername: hostname, ca: testCert, rejectUnauthorized: true,
    minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'], checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert), signal });
  await once(socket, 'secureConnect');
  Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: address });
  observeSecure(socket);
  return socket;
}

async function withProductionDialRedirect(port, callback, ca = testCert) {
  const originalConnect = tls.connect;
  const optionsSeen = [];
  const clientSockets = [];
  const clientClosed = [];
  const clientErrors = [];
  tls.connect = (options, ...rest) => {
    optionsSeen.push(options);
    const socket = originalConnect({ ...options, host: '127.0.0.1', port, ca }, ...rest);
    const index = clientSockets.push(socket) - 1;
    clientClosed[index] = false;
    socket.once('close', () => { clientClosed[index] = true; });
    socket.on('error', (error) => { clientErrors.push(error); });
    Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: options.host });
    return socket;
  };
  try { return await callback(optionsSeen, clientSockets, clientClosed, clientErrors); }
  finally { tls.connect = originalConnect; }
}

function makeFixture(options = {}) {
  const recipient = createECDH('prime256v1');
  recipient.generateKeys();
  const authSecret = randomBytes(16);
  const vapidDetails = { subject: 'mailto:push-test@example.invalid', ...webPush.generateVAPIDKeys() };
  const endpoint = options.endpoint ?? 'https://push.example.test/send/opaque-token';
  const calls = { resolve: 0, dial: 0, request: 0, fence: 0, destroyed: 0, details: undefined, sockets: [] };
  const transport = createWebPushTransport({
    resolve: async (hostname, signal) => {
      calls.resolve += 1;
      assert.equal(hostname, 'push.example.test');
      assert.equal(signal.aborted, false);
      return options.addresses ?? [{ address: '8.8.8.8', family: 4 }];
    },
    dial: async (_hostname, address, signal) => {
      calls.dial += 1;
      assert.equal(address, options.selectedAddress ?? '8.8.8.8');
      assert.equal(signal.aborted, false);
      const socket = {
        remoteAddress: options.peerAddress ?? address,
        authorized: options.authorized ?? true,
        destroy() { calls.destroyed += 1; },
      };
      calls.sockets.push(socket);
      return socket;
    },
    request: async (context) => {
      calls.request += 1;
      calls.details = context.details;
      context.beforeDispatch();
      return { statusCode: options.statusCode ?? 201 };
    },
  });
  const input = {
    subscription: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: recipient.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    },
    vapidDetails,
    assertBeforeDispatch() {
      calls.fence += 1;
      if (options.rejectDispatch) throw new Error('session_revoked');
    },
  };
  return {
    transport, input, calls,
    decryptPayload(body = calls.details.body) {
      return ece.decrypt(body, { version: 'aes128gcm', privateKey: recipient, authSecret: authSecret.toString('base64url') });
    },
  };
}

test('builds a fixed encrypted aes128gcm request and reports service acceptance', async () => {
  const { transport, input, calls, decryptPayload } = makeFixture();
  assert.deepEqual(await transport.send(input), { kind: 'accepted' });
  assert.equal(calls.resolve, 1);
  assert.equal(calls.dial, 1);
  assert.equal(calls.request, 1);
  assert.equal(calls.fence, 1);
  assert.equal(calls.destroyed, 1);
  assert.equal(calls.details.method, 'POST');
  assert.equal(calls.details.headers['Content-Encoding'], 'aes128gcm');
  assert.match(calls.details.headers.Authorization, /^vapid t=/);
  assert.equal(calls.details.headers.TTL, 60);
  assert.ok(Buffer.isBuffer(calls.details.body));
  assert.deepEqual(JSON.parse(decryptPayload().toString('utf8')), {
    schemaVersion: 1, type: 'reminder', title: 'Reminder', body: 'You have a reminder.',
  });
});

test('rejects malformed endpoints before DNS or TLS', async () => {
  for (const endpoint of [
    'http://push.example.test/send/token',
    'https://user:pass@push.example.test/send/token',
    'https://@push.example.test/send/token',
    'https://push.example.test:444/send/token',
    'https://push.example.test/send/token#fragment',
    'https://push.example.test/send/token#',
    'https://127.0.0.1/send/token',
    'https://[::ffff:127.0.0.1]/send/token',
  ]) {
    const { transport, input, calls } = makeFixture({ endpoint });
    assert.deepEqual(await transport.send(input), { kind: 'not_started', reason: endpoint.includes('127.0.0.1') ? 'unsafe_destination' : 'invalid_endpoint' });
    assert.equal(calls.resolve, 0);
    assert.equal(calls.dial, 0);
    assert.equal(calls.request, 0);
  }
});

test('keeps percent-encoded hash path data distinct from a URL fragment', async () => {
  const { transport, input, calls } = makeFixture({ endpoint: 'https://push.example.test/send/a%23b' });
  assert.deepEqual(await transport.send(input), { kind: 'accepted' });
  assert.equal(calls.resolve, 1);
  assert.equal(calls.request, 1);
});

test('validates every DNS answer and rejects private, mapped-private, and special-use results', async () => {
  for (const address of ['127.0.0.1', '::ffff:10.0.0.1', '192.0.2.8', '2001:db8::1', 'fc00::1']) {
    const family = address.includes(':') ? 6 : 4;
    const { transport, input, calls } = makeFixture({ addresses: [
      { address: '8.8.8.8', family: 4 }, { address, family },
    ] });
    assert.deepEqual(await transport.send(input), { kind: 'not_started', reason: 'unsafe_destination' });
    assert.equal(calls.dial, 0);
    assert.equal(calls.request, 0);
  }
});

test('distinguishes resolver failure from an unsafe DNS answer', async () => {
  const fixture = makeFixture();
  const failedResolver = createWebPushTransport({ resolve: async () => { throw new Error('synthetic resolver failure'); } });
  assert.deepEqual(await failedResolver.send(fixture.input), { kind: 'not_started', reason: 'dns_failure' });
  const emptyResolver = createWebPushTransport({ resolve: async () => [] });
  assert.deepEqual(await emptyResolver.send(fixture.input), { kind: 'not_started', reason: 'unsafe_destination' });
});

test('normalizes a public IPv4-mapped resolver result before pinning', async () => {
  const { transport, input, calls } = makeFixture({
    addresses: [{ address: '::ffff:8.8.8.8', family: 6 }],
    selectedAddress: '8.8.8.8',
  });
  assert.deepEqual(await transport.send(input), { kind: 'accepted' });
  assert.equal(calls.request, 1);
});

test('checks the TLS peer and authorization fence before request dispatch', async () => {
  for (const config of [{ peerAddress: '1.1.1.1' }, { authorized: false }, { rejectDispatch: true }]) {
    const { transport, input, calls } = makeFixture(config);
    const result = await transport.send(input);
    assert.deepEqual(result, { kind: 'not_started', reason: config.rejectDispatch ? 'authorization_changed' : 'tls_failure' });
    assert.equal(calls.request, config.rejectDispatch ? 1 : 0);
    assert.equal(calls.destroyed, 1);
  }
});

test('maps push-service statuses without following redirects or claiming delivery', async () => {
  for (const [statusCode, expected] of [
    [201, { kind: 'accepted' }],
    [404, { kind: 'expired', statusCode: 404 }],
    [410, { kind: 'expired', statusCode: 410 }],
    [302, { kind: 'rejected', statusCode: 302 }],
    [503, { kind: 'rejected', statusCode: 503 }],
  ]) {
    const { transport, input, calls } = makeFixture({ statusCode });
    assert.deepEqual(await transport.send(input), expected);
    assert.equal(calls.request, 1);
  }
});

test('rejects accessors and symbol properties without invoking them or doing network work', async () => {
  const { transport, input, calls } = makeFixture();
  let getterCalls = 0;
  const bad = { ...input, subscription: Object.defineProperty({}, 'endpoint', {
    enumerable: true, get() { getterCalls += 1; return input.subscription.endpoint; },
  }) };
  assert.deepEqual(await transport.send(bad), { kind: 'not_started', reason: 'invalid_request' });
  assert.equal(getterCalls, 0);
  assert.equal(calls.resolve, 0);
  const withSymbol = { ...input, [Symbol('extra')]: true };
  assert.deepEqual(await transport.send(withSymbol), { kind: 'not_started', reason: 'invalid_request' });
  assert.equal(calls.resolve, 0);
});

test('waits for late dial sockets, closes them, and drains stopped admission', async () => {
  const fixture = makeFixture();
  const pendingDial = deferred();
  const dialStarted = deferred();
  const controller = new AbortController();
  fixture.input.signal = controller.signal;
  let destroyed = 0;
  let closed = false;
  const socketEvents = new EventEmitter();
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: () => { dialStarted.resolve(); return pendingDial.promise; },
  });
  const sending = transport.send(fixture.input);
  await dialStarted.promise;
  transport.stopAdmission();
  assert.deepEqual(await transport.send(fixture.input), { kind: 'not_started', reason: 'stopping' });
  let drained = false;
  const draining = transport.drain().then(() => { drained = true; });
  controller.abort(new Error('caller_cancelled'));
  await Promise.resolve();
  assert.equal(drained, false);
  pendingDial.resolve({
    remoteAddress: '8.8.8.8', authorized: true,
    once(event, callback) { socketEvents.once(event, callback); },
    destroy() {
      destroyed += 1;
      queueMicrotask(() => { closed = true; socketEvents.emit('close'); });
    },
  });
  assert.deepEqual(await sending, { kind: 'not_started', reason: 'cancelled' });
  await draining;
  assert.equal(drained, true);
  assert.equal(closed, true);
  assert.equal(destroyed, 1);
});

test('drain remains pending through the active HTTPS request and socket close', async () => {
  const requestReceived = deferred();
  let serverConnections = 0;
  const harness = await listenTlsServer(({ socket }) => {
    serverConnections += 1;
    requestReceived.resolve(socket);
  });
  const fixture = makeFixture();
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, harness.port),
  });
  try {
    const sending = transport.send(fixture.input);
    const serverSocket = await requestReceived.promise;
    let drained = false;
    const draining = transport.drain().then(() => { drained = true; });
    assert.deepEqual(await transport.send(fixture.input), { kind: 'not_started', reason: 'stopping' });
    assert.equal(drained, false);
    serverSocket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    assert.deepEqual(await sending, { kind: 'accepted' });
    await draining;
    assert.equal(drained, true);
    assert.equal(serverConnections, 1);
  } finally {
    await new Promise((resolve) => harness.server.close(resolve));
  }
});

test('captures transport ports as closed data and rejects getters before use', () => {
  let getterCalls = 0;
  const ports = Object.defineProperty({}, 'resolve', { enumerable: true, get() { getterCalls += 1; return async () => []; } });
  assert.throws(() => createWebPushTransport(ports), /web_push_transport_ports_invalid/);
  assert.equal(getterCalls, 0);
  assert.throws(() => createWebPushTransport({ resolve() {}, [Symbol('extra')]: true }), /web_push_transport_ports_invalid/);
});

test('rechecks cancellation after the final synchronous authority fence', async () => {
  const controller = new AbortController();
  const { transport, input, calls } = makeFixture();
  input.signal = controller.signal;
  input.assertBeforeDispatch = () => { calls.fence += 1; controller.abort(); };
  const result = await transport.send(input);
  assert.deepEqual(result, { kind: 'not_started', reason: 'cancelled' });
  assert.equal(calls.request, 1);
  assert.equal(calls.destroyed, 1);
});

test('requires one synchronous final authority check before dispatch', async () => {
  let authorityCalls = 0;
  const fixture = makeFixture();
  fixture.input.assertBeforeDispatch = () => { authorityCalls += 1; };
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: async () => ({ remoteAddress: '8.8.8.8', authorized: true, destroy() {} }),
    request: async (context) => {
      context.beforeDispatch();
      context.beforeDispatch();
      return { statusCode: 201 };
    },
  });
  assert.deepEqual(await transport.send(fixture.input), { kind: 'ambiguous', reason: 'transport_failure' });
  assert.equal(authorityCalls, 1);

  const asynchronousFence = makeFixture();
  asynchronousFence.input.assertBeforeDispatch = () => Promise.reject(new Error('not synchronous'));
  assert.deepEqual(await asynchronousFence.transport.send(asynchronousFence.input), {
    kind: 'not_started', reason: 'authorization_changed',
  });
});

test('default HTTPS request adopts a verified original-host TLS socket only after the final fence', async () => {
  const received = [];
  const observedSni = [];
  let authorityPassed = false;
  let responseServer;
  let responsePort;
  const tlsHarness = await listenTlsServer(({ socket, bytes, headers }) => {
    received.push({ bytes, headers });
    socket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }, (_chunk, socket) => {
    assert.equal(authorityPassed, true, 'no HTTP bytes may precede the last synchronous authority check');
    observedSni.push(socket.servername);
  });
  responseServer = tlsHarness.server;
  responsePort = tlsHarness.port;
  const fixture = makeFixture();
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, responsePort),
  });
  fixture.input.assertBeforeDispatch = () => { fixture.calls.fence += 1; authorityPassed = true; };
  try {
    assert.deepEqual(await transport.send(fixture.input), { kind: 'accepted' });
    assert.equal(received.length, 1);
    assert.equal(observedSni[0], 'push.example.test');
    assert.match(received[0].headers, /^POST \/send\/opaque-token HTTP\/1\.1/im);
    assert.match(received[0].headers, /^host: push\.example\.test/im);
    assert.match(received[0].headers, /^content-encoding: aes128gcm/im);
    assert.equal(fixture.calls.fence, 1);
  } finally {
    await new Promise((resolve) => responseServer.close(resolve));
  }
});

test('production TLS dial pins the resolver IP while retaining original SNI and certificate identity', async () => {
  const received = [];
  const observedSni = [];
  let authorityPassed = false;
  const harness = await listenTlsServer(({ socket, headers }) => {
    received.push(headers);
    socket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }, (_chunk, socket) => {
    assert.equal(authorityPassed, true);
    observedSni.push(socket.servername);
  });
  const fixture = makeFixture();
  const transport = createWebPushTransport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] });
  fixture.input.assertBeforeDispatch = () => { authorityPassed = true; };
  try {
    await withProductionDialRedirect(harness.port, async (optionsSeen) => {
      assert.deepEqual(await transport.send(fixture.input), { kind: 'accepted' });
      assert.equal(optionsSeen.length, 1);
      assert.equal(optionsSeen[0].host, '8.8.8.8');
      assert.equal(optionsSeen[0].port, 443);
      assert.equal(optionsSeen[0].servername, 'push.example.test');
      assert.equal(optionsSeen[0].rejectUnauthorized, true);
      assert.equal(optionsSeen[0].minVersion, 'TLSv1.2');
      assert.deepEqual(optionsSeen[0].ALPNProtocols, ['http/1.1']);
      assert.equal(typeof optionsSeen[0].checkServerIdentity, 'function');
      assert.equal(received.length, 1);
      assert.equal(observedSni[0], 'push.example.test');
      assert.match(received[0], /^host: push\.example\.test/im);
    });
  } finally {
    await new Promise((resolve) => harness.server.close(resolve));
  }
});

test('production TLS dial rejects a trusted but wrong-host certificate before HTTP bytes', async () => {
  let requestBytes = 0;
  const harness = await listenTlsServer(({ socket }) => {
    socket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }, (chunk) => { requestBytes += chunk.length; }, { key: wrongHostKey, cert: wrongHostCert });
  const fixture = makeFixture();
  const transport = createWebPushTransport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] });
  try {
    await withProductionDialRedirect(harness.port, async (optionsSeen, _clientSockets, _clientClosed, clientErrors) => {
      assert.deepEqual(await transport.send(fixture.input), { kind: 'not_started', reason: 'tls_failure' });
      assert.equal(optionsSeen.length, 1);
      assert.equal(optionsSeen[0].servername, 'push.example.test');
      assert.ok(clientErrors.some((error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID'),
        'a trusted wrong-host certificate must fail hostname identity validation');
      assert.equal(requestBytes, 0);
    }, wrongHostCert);
  } finally {
    await new Promise((resolve) => harness.server.close(resolve));
  }
});

test('production TLS handshake abort closes the connection before drain completes', async () => {
  const connected = deferred();
  const closed = deferred();
  const tcpServer = createTcpServer((socket) => {
    connected.resolve(socket);
    socket.once('close', () => closed.resolve());
  });
  tcpServer.listen(0, '127.0.0.1');
  await once(tcpServer, 'listening');
  const fixture = makeFixture();
  const controller = new AbortController();
  fixture.input.signal = controller.signal;
  const transport = createWebPushTransport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] });
  try {
    await withProductionDialRedirect(tcpServer.address().port, async (optionsSeen, _clientSockets, clientClosed) => {
      const sending = transport.send(fixture.input);
      await connected.promise;
      let drained = false;
      const draining = transport.drain().then(() => { drained = true; });
      controller.abort(new Error('synthetic handshake cancellation'));
      assert.deepEqual(await sending, { kind: 'not_started', reason: 'cancelled' });
      assert.equal(clientClosed[0], true, 'the returned client TLS socket must close before send settles');
      await draining;
      assert.equal(clientClosed[0], true, 'drain must not resolve before the returned client socket closes');
      assert.equal(drained, true);
      assert.equal(optionsSeen.length, 1);
      assert.equal(optionsSeen[0].host, '8.8.8.8');
      assert.equal(optionsSeen[0].port, 443);
    });
    await closed.promise;
  } finally {
    await new Promise((resolve) => tcpServer.close(resolve));
  }
});

test('default HTTPS request does not send bytes when the final authority callback revokes the session', async () => {
  let requestBytes = 0;
  let server;
  const harness = await listenTlsServer(({ socket }) => {
    socket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }, (chunk) => { requestBytes += chunk.length; });
  server = harness.server;
  const fixture = makeFixture();
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, harness.port),
  });
  fixture.input.assertBeforeDispatch = () => { throw new Error('revoked'); };
  try {
    assert.deepEqual(await transport.send(fixture.input), { kind: 'not_started', reason: 'authorization_changed' });
    assert.equal(requestBytes, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('default HTTPS transport does not follow redirects and bounds oversized responses', async () => {
  let redirects = 0;
  const redirectHarness = await listenTlsServer(({ socket }) => {
    redirects += 1;
    socket.end('HTTP/1.1 302 Found\r\nLocation: https://other.example.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const redirectFixture = makeFixture();
  const redirectTransport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, redirectHarness.port),
  });
  try {
    assert.deepEqual(await redirectTransport.send(redirectFixture.input), { kind: 'rejected', statusCode: 302 });
    assert.equal(redirects, 1);
  } finally {
    await new Promise((resolve) => redirectHarness.server.close(resolve));
  }

  const oversizedHarness = await listenTlsServer(({ socket }) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 20000\r\nConnection: close\r\n\r\n');
    socket.write(Buffer.alloc(20000, 65));
  });
  const oversizedFixture = makeFixture();
  const oversizedTransport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, oversizedHarness.port),
  });
  try {
    assert.deepEqual(await oversizedTransport.send(oversizedFixture.input), { kind: 'ambiguous', reason: 'transport_failure' });
  } finally {
    await new Promise((resolve) => oversizedHarness.server.close(resolve));
  }
});

test('default HTTPS response bounds chunked bodies and rejects incomplete responses', async () => {
  const chunkedHarness = await listenTlsServer(({ socket }) => {
    socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
    socket.write(`5000\r\n${'A'.repeat(0x5000)}\r\n0\r\n\r\n`);
  });
  const chunkedFixture = makeFixture();
  const chunkedTransport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, chunkedHarness.port),
  });
  try {
    assert.deepEqual(await chunkedTransport.send(chunkedFixture.input), { kind: 'ambiguous', reason: 'transport_failure' });
  } finally {
    await new Promise((resolve) => chunkedHarness.server.close(resolve));
  }

  const incompleteHarness = await listenTlsServer(({ socket }) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nX');
    socket.destroy();
  });
  const incompleteFixture = makeFixture();
  const incompleteTransport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: (hostname, address, signal) => localTlsDial(hostname, address, signal, incompleteHarness.port),
  });
  try {
    assert.deepEqual(await incompleteTransport.send(incompleteFixture.input), { kind: 'ambiguous', reason: 'transport_failure' });
  } finally {
    await new Promise((resolve) => incompleteHarness.server.close(resolve));
  }
});

test('deadline after dispatch is ambiguous timeout and the transport still drains the socket', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const fixture = makeFixture();
  let destroyed = 0;
  const events = new EventEmitter();
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: async () => ({ remoteAddress: '8.8.8.8', authorized: true,
      once(event, callback) { events.once(event, callback); },
      destroy() { destroyed += 1; queueMicrotask(() => events.emit('close')); } }),
    request: (context) => {
      context.beforeDispatch();
      started.resolve();
      return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    },
  });
  const sending = transport.send(fixture.input);
  await started.promise;
  await t.mock.timers.tick(12_000);
  assert.deepEqual(await sending, { kind: 'ambiguous', reason: 'timeout' });
  await transport.drain();
  assert.equal(destroyed, 1);
  t.mock.timers.reset();
});

test('TLS failure during HTTPS Agent adoption is contained and never accepted', async () => {
  let requestBytes = 0;
  let server;
  const harness = await listenTlsServer(({ socket }) => {
    socket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }, (chunk) => { requestBytes += chunk.length; });
  server = harness.server;
  const fixture = makeFixture();
  const transport = createWebPushTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: async (hostname, address, signal) => {
      const socket = await localTlsDial(hostname, address, signal, harness.port);
      setImmediate(() => socket.destroy(Object.assign(new Error('synthetic TLS adoption fault'), { code: 'ECONNRESET' })));
      return socket;
    },
  });
  try {
    const result = await transport.send(fixture.input);
    assert.ok(result.kind === 'ambiguous' || result.kind === 'not_started');
    assert.notEqual(result.kind, 'accepted');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(requestBytes >= 0);
});

test('two sends use independent VAPID assertions and distinct one-shot sockets', async () => {
  const fixture = makeFixture();
  const first = await fixture.transport.send(fixture.input);
  const firstAuthorization = fixture.calls.details.headers.Authorization;
  const firstBody = Buffer.from(fixture.calls.details.body);
  fixture.input.vapidDetails = { subject: 'mailto:second@example.invalid', ...webPush.generateVAPIDKeys() };
  const second = await fixture.transport.send(fixture.input);
  assert.deepEqual(first, { kind: 'accepted' });
  assert.deepEqual(second, { kind: 'accepted' });
  assert.equal(fixture.calls.request, 2);
  assert.notEqual(fixture.calls.details.headers.Authorization, firstAuthorization);
  assert.notDeepEqual(fixture.calls.details.body, firstBody);
  assert.notEqual(fixture.calls.sockets[0], fixture.calls.sockets[1]);
  assert.equal(fixture.calls.destroyed, 2);
});
