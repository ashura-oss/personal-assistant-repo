import { lookup } from 'node:dns/promises';
import https from 'node:https';
import tls, { type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import webPush, { type PushSubscription, type RequestDetails, type VapidKeys } from 'web-push';

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const FIXED_PAYLOAD = Buffer.from(JSON.stringify({ schemaVersion: 1, type: 'reminder', title: 'Reminder', body: 'You have a reminder.' }), 'utf8');
const IPV4_SPECIAL = ['0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map((range) => ipaddr.parseCIDR(range));
const IPV6_SPECIAL = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map((range) => ipaddr.parseCIDR(range));
const IPV6_GLOBAL = ipaddr.parseCIDR('2000::/3');

type DnsAddress = Readonly<{ address: string; family: number }>;
type PushSocket = Readonly<{
  remoteAddress?: string | undefined;
  authorized?: boolean | undefined;
  destroyed?: boolean | undefined;
  readyState?: string | undefined;
  once?: (event: 'close', listener: () => void) => unknown;
  destroy(error?: Error): unknown;
}>;
type SocketLifetime = { closed: boolean; closedPromise: Promise<void> };
const socketLifetimes = new WeakMap<object, SocketLifetime>();
type GeneratedRequest = Readonly<{ endpoint: URL; details: RequestDetails }>;
type RequestContext = Readonly<{
  socket: PushSocket;
  endpoint: URL;
  details: RequestDetails;
  signal: AbortSignal;
  beforeDispatch(): void;
}>;
export type WebPushTransportResult =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'expired'; statusCode: 404 | 410 }>
  | Readonly<{ kind: 'rejected'; statusCode: number }>
  | Readonly<{ kind: 'not_started'; reason: 'stopping' | 'invalid_request' | 'invalid_endpoint' | 'unsafe_destination' | 'dns_failure' | 'tls_failure' | 'authorization_changed' | 'cancelled' | 'timeout' | 'transport_failure' }>
  | Readonly<{ kind: 'ambiguous'; reason: 'cancelled' | 'timeout' | 'transport_failure' }>;

export type WebPushTransportInput = Readonly<{
  subscription: PushSubscription;
  vapidDetails: Readonly<{ subject: string; publicKey: string; privateKey: string }>;
  assertBeforeDispatch(): void;
  signal?: AbortSignal;
}>;

export type WebPushTransportPorts = Readonly<{
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly DnsAddress[]>;
  dial?: (hostname: string, address: string, signal: AbortSignal) => Promise<PushSocket>;
  request?: (context: RequestContext) => Promise<Readonly<{ statusCode: number }>>;
}>;

function closedRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error('invalid');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid');
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) throw new Error('invalid');
  return result;
}

function captureInput(value: unknown): Readonly<{ subscription: PushSubscription; vapidDetails: VapidKeys & { subject: string };
  assertBeforeDispatch: () => void; signal?: AbortSignal }> {
  const input = closedRecord(value, ['subscription', 'vapidDetails', 'assertBeforeDispatch', 'signal'], ['subscription', 'vapidDetails', 'assertBeforeDispatch']);
  const subscription = closedRecord(input.subscription, ['endpoint', 'expirationTime', 'keys'], ['endpoint', 'keys']);
  const keys = closedRecord(subscription.keys, ['p256dh', 'auth'], ['p256dh', 'auth']);
  const vapid = closedRecord(input.vapidDetails, ['subject', 'publicKey', 'privateKey'], ['subject', 'publicKey', 'privateKey']);
  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 4096 ||
      (subscription.expirationTime !== undefined && subscription.expirationTime !== null &&
        (typeof subscription.expirationTime !== 'number' || !Number.isSafeInteger(subscription.expirationTime) || subscription.expirationTime < 0)) ||
      typeof keys.p256dh !== 'string' || keys.p256dh.length > 256 || typeof keys.auth !== 'string' || keys.auth.length > 256 ||
      typeof vapid.subject !== 'string' || vapid.subject.length > 512 || typeof vapid.publicKey !== 'string' || vapid.publicKey.length > 256 ||
      typeof vapid.privateKey !== 'string' || vapid.privateKey.length > 256 || typeof input.assertBeforeDispatch !== 'function' ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw new Error('invalid');
  const copiedSubscription = Object.freeze({ endpoint: subscription.endpoint,
    ...(subscription.expirationTime === undefined ? {} : { expirationTime: subscription.expirationTime as number | null }),
    keys: Object.freeze({ p256dh: keys.p256dh, auth: keys.auth }) });
  const captured: { subscription: PushSubscription; vapidDetails: VapidKeys & { subject: string };
    assertBeforeDispatch: () => void; signal?: AbortSignal } = {
    subscription: copiedSubscription as PushSubscription,
    vapidDetails: Object.freeze({ subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }),
    assertBeforeDispatch: input.assertBeforeDispatch as () => void,
  };
  if (input.signal) captured.signal = input.signal as AbortSignal;
  return Object.freeze(captured);
}

function parseEndpoint(value: string): URL {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value) || value.includes('#')) throw new Error('invalid_endpoint');
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority === undefined || authority.includes('@')) throw new Error('invalid_endpoint');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !url.hostname) throw new Error('invalid_endpoint');
  return url;
}

function normalizedHost(url: URL): string {
  const value = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  return value.toLowerCase().replace(/\.$/, '');
}

function publicAddress(address: string, family?: number): string {
  if (typeof address !== 'string' || address.length > 64 || address.includes('%') || !ipaddr.isValid(address)) throw new Error('unsafe');
  let parsed = ipaddr.parse(address);
  const parsedFamily = parsed.kind() === 'ipv4' ? 4 : 6;
  if (family !== undefined && family !== parsedFamily) throw new Error('unsafe');
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
  }
  const normalized = parsed.kind() === 'ipv6' ? (parsed as ipaddr.IPv6).toRFC5952String() : parsed.toString();
  if (parsed.kind() === 'ipv4') {
    if (parsed.range() !== 'unicast' || IPV4_SPECIAL.some(([network, prefix]) => parsed.match(network, prefix))) throw new Error('unsafe');
  } else {
    if (parsed.range() !== 'unicast' || !parsed.match(IPV6_GLOBAL[0], IPV6_GLOBAL[1]) ||
        IPV6_SPECIAL.some(([network, prefix]) => parsed.match(network, prefix))) throw new Error('unsafe');
  }
  return normalized;
}

function safeEndpoint(value: string): Readonly<{ url: URL; hostname: string }> {
  const url = parseEndpoint(value);
  const hostname = normalizedHost(url);
  if (!hostname || hostname.length > 253 || /[\u0000-\u0020\u007f]/.test(hostname)) throw new Error('invalid_endpoint');
  if (isIP(hostname)) publicAddress(hostname);
  return Object.freeze({ url, hostname });
}

function defaultResolve(hostname: string): Promise<readonly DnsAddress[]> {
  if (isIP(hostname)) return Promise.resolve([Object.freeze({ address: hostname, family: isIP(hostname) })]);
  return lookup(hostname, { all: true, verbatim: true });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
}

async function destroySocket(socket: PushSocket | undefined): Promise<void> {
  if (!socket) return;
  try {
    let lifetime = socketLifetimes.get(socket as object);
    if (!lifetime && typeof socket.once === 'function') {
      let markClosed!: () => void;
      const closedPromise = new Promise<void>((resolve) => { markClosed = resolve; });
      lifetime = { closed: false, closedPromise };
      socket.once('close', () => { lifetime!.closed = true; markClosed(); });
      socketLifetimes.set(socket as object, lifetime);
    }
    if (typeof socket.once !== 'function') {
      const result = socket.destroy();
      if (result && typeof (result as { then?: unknown }).then === 'function') await result;
      return;
    }
    if (lifetime?.closed) return;
    socket.destroy();
    await lifetime?.closedPromise;
  } catch { /* Cleanup errors are not surfaced. */ }
}

function trackSocket(socket: PushSocket): void {
  if (socketLifetimes.has(socket as object) || typeof socket.once !== 'function') return;
  let markClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { markClosed = resolve; });
  const lifetime: SocketLifetime = { closed: false, closedPromise };
  socket.once('close', () => { lifetime.closed = true; markClosed(); });
  socketLifetimes.set(socket as object, lifetime);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

async function defaultDial(hostname: string, address: string, signal: AbortSignal): Promise<TLSSocket> {
  const socket = tls.connect({ host: address, port: 443, servername: isIP(hostname) ? undefined : hostname,
    rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
    checkServerIdentity: (_serverName, certificate) => tls.checkServerIdentity(hostname, certificate) });
  trackSocket(socket);
  const onAbort = () => socket.destroy(abortError(signal));
  // Keep an error listener for the complete socket lifetime, including the gap
  // between TLS establishment and HTTPS Agent adoption.
  socket.on('error', () => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      const onSecure = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { socket.off('secureConnect', onSecure); socket.off('error', onError); signal.removeEventListener('abort', onAbort); };
      socket.once('secureConnect', onSecure);
      socket.once('error', onError);
    }), signal);
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    await destroySocket(socket);
    throw error;
  }
  if (!socket.authorized) { await destroySocket(socket); throw new Error('tls_peer_unverified'); }
  return socket;
}

function samePeerAddress(remoteAddress: string | undefined, selectedAddress: string): boolean {
  if (!remoteAddress) return false;
  try { return publicAddress(remoteAddress) === selectedAddress; } catch { return false; }
}

function defaultRequest(context: RequestContext): Promise<Readonly<{ statusCode: number }>> {
  return new Promise((resolve, reject) => {
    const socket = context.socket as TLSSocket;
    const socketSafetyListener = () => {};
    socket.on('error', socketSafetyListener);
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 0, maxCachedSessions: 0 });
    const agentPort = agent as unknown as { createConnection(options: unknown, callback: (error: Error | null, socket: Duplex) => void): Duplex | undefined };
    agentPort.createConnection = (_options, callback) => {
      try {
        if (context.signal.aborted) throw abortError(context.signal);
        context.beforeDispatch();
        callback(null, socket);
      } catch (error) {
        callback(error instanceof Error ? error : new Error('dispatch_rejected'), undefined as unknown as Duplex);
      }
      return undefined;
    };
    let settled = false;
    const settle = (error?: Error, statusCode?: number) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener('abort', onAbort);
      agent.destroy();
      socket.off('error', socketSafetyListener);
      if (error) reject(error);
      else resolve(Object.freeze({ statusCode: statusCode ?? 0 }));
    };
    const onAbort = () => request.destroy(abortError(context.signal));
    const headers = { ...context.details.headers, Host: context.endpoint.host, Connection: 'close' };
    const request = https.request({ protocol: 'https:', hostname: normalizedHost(context.endpoint), port: 443,
      path: `${context.endpoint.pathname}${context.endpoint.search}`, method: 'POST', headers, agent });
    request.once('response', (response) => {
      const statusCode = response.statusCode ?? 0;
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        request.destroy(Object.assign(new Error('response_limit'), { code: 'ERESPONSELIMIT' }));
        return;
      }
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        received += Buffer.byteLength(chunk);
        if (received > MAX_RESPONSE_BYTES) request.destroy(Object.assign(new Error('response_limit'), { code: 'ERESPONSELIMIT' }));
      });
      response.once('end', () => settle(undefined, statusCode));
      response.once('error', (error) => settle(error));
      response.once('aborted', () => settle(Object.assign(new Error('incomplete_response'), { code: 'EINCOMPLETERESPONSE' })));
      response.once('close', () => {
        if (!response.complete) settle(Object.assign(new Error('incomplete_response'), { code: 'EINCOMPLETERESPONSE' }));
      });
    });
    request.once('error', (error) => settle(error));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    request.end(context.details.body ?? undefined);
  });
}

function resultForError(error: unknown, dispatched: boolean, signal: AbortSignal, deadlineSignal: AbortSignal): WebPushTransportResult {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const reason = deadlineSignal.aborted || code === 'ETIMEDOUT' ? 'timeout' : signal.aborted || code === 'ABORT_ERR' ? 'cancelled' : 'transport_failure';
  return dispatched ? Object.freeze({ kind: 'ambiguous', reason }) : Object.freeze({ kind: 'not_started', reason });
}

export function createWebPushTransport(ports: WebPushTransportPorts = {}) {
  let capturedPorts: Record<string, unknown>;
  try { capturedPorts = closedRecord(ports, ['resolve', 'dial', 'request'], []); }
  catch { throw new TypeError('web_push_transport_ports_invalid'); }
  const resolve = capturedPorts.resolve ?? ((hostname: string) => defaultResolve(hostname));
  const dial = capturedPorts.dial ?? defaultDial;
  const request = capturedPorts.request ?? defaultRequest;
  if (typeof resolve !== 'function' || typeof dial !== 'function' || typeof request !== 'function') throw new TypeError('web_push_transport_ports_invalid');
  let accepting = true;
  const active = new Set<Promise<void>>();

  const performSend = async (input: WebPushTransportInput): Promise<WebPushTransportResult> => {
      let captured: ReturnType<typeof captureInput>;
      try { captured = captureInput(input); } catch { return Object.freeze({ kind: 'not_started', reason: 'invalid_request' }); }
      let destination: ReturnType<typeof safeEndpoint>;
      let generated: GeneratedRequest;
      try {
        destination = safeEndpoint(captured.subscription.endpoint);
        const details = webPush.generateRequestDetails(captured.subscription, FIXED_PAYLOAD,
          { vapidDetails: captured.vapidDetails, contentEncoding: 'aes128gcm', TTL: 60, urgency: 'normal' });
        if (details.method !== 'POST' || !Buffer.isBuffer(details.body) || details.endpoint !== captured.subscription.endpoint || details.proxy) {
          return Object.freeze({ kind: 'not_started', reason: 'invalid_request' });
        }
        generated = Object.freeze({ endpoint: destination.url, details });
      } catch (error) {
        return Object.freeze({ kind: 'not_started', reason: error instanceof Error && error.message === 'unsafe' ? 'unsafe_destination' : 'invalid_endpoint' });
      }

      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), REQUEST_TIMEOUT_MS);
      const signal = captured.signal ? AbortSignal.any([captured.signal, deadline.signal]) : deadline.signal;
      let socket: PushSocket | undefined;
      let dispatched = false;
      try {
        if (signal.aborted) throw abortError(signal);
        let records: readonly DnsAddress[];
        try { records = await abortable(resolve(destination.hostname, signal), signal); }
        catch (error) {
          if (signal.aborted) throw error;
          throw Object.assign(new Error('dns_resolution_failed'), { code: 'EDNSRESOLVE' });
        }
        if (!Array.isArray(records) || records.length === 0 || records.length > 64) throw Object.assign(new Error('dns'), { code: 'EDNS' });
        const normalized = records.map((record) => {
          if (!record || typeof record !== 'object') throw Object.assign(new Error('dns'), { code: 'EDNS' });
          try { return publicAddress(record.address, record.family); }
          catch { throw Object.assign(new Error('unsafe_dns_answer'), { code: 'EDNS' }); }
        });
        const unique = [...new Set(normalized)];
        if (unique.length !== normalized.length) throw Object.assign(new Error('dns'), { code: 'EDNS' });
        const selectedAddress = normalized[0]!;
        // Do not race dial against abort: a late socket must remain owned here
        // so it can be destroyed before this send settles or drain completes.
        try { socket = await Promise.resolve((dial as NonNullable<WebPushTransportPorts['dial']>)(destination.hostname, selectedAddress, signal)); }
        catch (error) {
          if (signal.aborted) throw error;
          throw Object.assign(new Error('tls_connection_failed'), { code: 'ETLSPEER' });
        }
        if (socket) trackSocket(socket);
        if (signal.aborted) throw abortError(signal);
        if (!socket || !samePeerAddress(socket.remoteAddress, selectedAddress) || socket.authorized !== true) {
          throw Object.assign(new Error('tls'), { code: 'ETLSPEER' });
        }
        const beforeDispatch = () => {
          if (dispatched) throw Object.assign(new Error('dispatch_already_authorized'), { code: 'EAUTHFENCE' });
          if (signal.aborted) throw abortError(signal);
          let result: unknown;
          try { result = (captured.assertBeforeDispatch as () => unknown)(); }
          catch { throw Object.assign(new Error('authorization_changed'), { code: 'EAUTHFENCE' }); }
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            Promise.resolve(result).catch(() => {});
            throw Object.assign(new Error('authorization_must_be_synchronous'), { code: 'EAUTHFENCE' });
          }
          if (signal.aborted) throw abortError(signal);
          dispatched = true;
        };
        const response = await Promise.resolve((request as NonNullable<WebPushTransportPorts['request']>)(Object.freeze({ socket, endpoint: generated.endpoint, details: generated.details, signal, beforeDispatch })));
        if (!dispatched) throw Object.assign(new Error('dispatch_fence_not_called'), { code: 'EAUTHFENCE' });
        if (!response || !Number.isSafeInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
          throw Object.assign(new Error('transport'), { code: 'ETRANSPORT' });
        }
        if (response.statusCode === 404 || response.statusCode === 410) return Object.freeze({ kind: 'expired', statusCode: response.statusCode });
        if (response.statusCode >= 200 && response.statusCode <= 299) return Object.freeze({ kind: 'accepted' });
        return Object.freeze({ kind: 'rejected', statusCode: response.statusCode });
      } catch (error) {
        if (!dispatched && error instanceof Error && 'code' in error && error.code === 'EAUTHFENCE') {
          return Object.freeze({ kind: 'not_started', reason: 'authorization_changed' });
        }
        if (!dispatched && signal.aborted) return Object.freeze({ kind: 'not_started', reason: deadline.signal.aborted ? 'timeout' : 'cancelled' });
        if (!dispatched && error instanceof Error && 'code' in error && error.code === 'EDNS') return Object.freeze({ kind: 'not_started', reason: 'unsafe_destination' });
        if (!dispatched && error instanceof Error && 'code' in error && error.code === 'EDNSRESOLVE') return Object.freeze({ kind: 'not_started', reason: 'dns_failure' });
        if (!dispatched && error instanceof Error && 'code' in error && error.code === 'ETLSPEER') return Object.freeze({ kind: 'not_started', reason: 'tls_failure' });
        if (!dispatched && error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') return Object.freeze({ kind: 'not_started', reason: 'timeout' });
        return resultForError(error, dispatched, signal, deadline.signal);
      } finally {
        clearTimeout(timer);
        await destroySocket(socket);
      }
  };

  const send = (input: WebPushTransportInput): Promise<WebPushTransportResult> => {
    if (!accepting) return Promise.resolve(Object.freeze({ kind: 'not_started', reason: 'stopping' }));
    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
    active.add(done);
    const task = performSend(input);
    return task.catch(() => Object.freeze({ kind: 'not_started', reason: 'transport_failure' }) as WebPushTransportResult)
      .finally(() => { active.delete(done); finish(); });
  };
  const stopAdmission = (): void => { accepting = false; };
  const drain = async (): Promise<void> => {
    stopAdmission();
    while (active.size > 0) await Promise.all([...active]);
  };

  return Object.freeze({ send, stopAdmission, drain });
}

export const webPushTransport = createWebPushTransport();
