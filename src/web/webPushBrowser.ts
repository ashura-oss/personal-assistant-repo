import type { AuthenticatedSession } from './authClient';

export type WebPushSafeStatus = Readonly<{ schemaVersion: 1; privacyEpoch: number; provisioned: boolean;
  activeKey?: Readonly<{ keyId: string; publicKey: string; createdAt: string }>; subscriptionCount: number }>;
export type WebPushPublicKey = Readonly<{ schemaVersion: 1; privacyEpoch: number; provisioned: false }> |
  Readonly<{ schemaVersion: 1; privacyEpoch: number; provisioned: true; keyId: string; publicKey: string; createdAt: string }>;
export type WebPushSubscriptionHead = Readonly<{ deviceId: string; generation: number; status: 'active' | 'revoked'; keyId: string; updatedAt: string }>;
export type WebPushReceipt = Readonly<{ schemaVersion: 1; commandId: string; operation: 'provision' | 'rotate';
  result: Readonly<{ keyId: string; publicKey: string; createdAt: string }>; createdAt: string }> |
  Readonly<{ schemaVersion: 1; commandId: string; operation: 'register' | 'revoke';
    result: WebPushSubscriptionHead; createdAt: string }>;
export type WebPushReconciliation = Readonly<{ schemaVersion: 1; privacyEpoch: number; deviceId: string; status: 'missing' }> |
  Readonly<{ schemaVersion: 1; privacyEpoch: number; deviceId: string; status: 'revoked'; generation: number; keyId: string }> |
  Readonly<{ schemaVersion: 1; privacyEpoch: number; deviceId: string; status: 'matched' | 'unmatched'; generation: number;
    keyId: string; publicKey: string }>;

export type BrowserPushSubscription = Readonly<{ endpoint: string; keys: Readonly<{ p256dh: string; auth: string }> }>;
export interface BrowserPushSubscriptionHandle {
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}
export interface BrowserPushManager {
  getSubscription(): Promise<BrowserPushSubscriptionHandle | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: ArrayBuffer }): Promise<BrowserPushSubscriptionHandle>;
}
export interface BrowserPushPort {
  readonly secureContext: boolean;
  readonly standaloneRequired: boolean;
  readonly standalone: boolean;
  readonly serviceWorkerAvailable: boolean;
  readonly pushAvailable: boolean;
  readonly notificationsAvailable: boolean;
  readonly locksAvailable: boolean;
  readonly permission: NotificationPermission | 'unsupported';
  requestPermission(): Promise<NotificationPermission>;
  serviceWorkerReady(): Promise<{ pushManager: BrowserPushManager }>;
  withExclusiveLock<T>(name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  randomUUID(): string;
  fetcher?: typeof fetch;
}

export type WebPushBrowserState = Readonly<{
  phase: 'loading' | 'unsupported' | 'unprovisioned' | 'disabled' | 'enabled' | 'unresolved_local' |
    'server_active_local_missing' | 'unmatched_local' | 'local_cleanup_pending' | 'registration_unknown' | 'disable_unknown' | 'error';
  message?: string;
  busy: boolean;
  permission: NotificationPermission | 'unsupported';
  deviceId?: string;
  generation?: number;
  activeKey?: Readonly<{ keyId: string; publicKey: string }>;
  subscriptionCount?: number;
  pending?: Readonly<{ commandId: string; action: 'provision' | 'register' | 'revoke' }>;
}>;

export interface WebPushBrowserCoordinator {
  readonly getSnapshot: () => WebPushBrowserState;
  readonly subscribe: (listener: () => void) => () => void;
  start(): Promise<void>;
  enable(): Promise<void>;
  provision(): Promise<void>;
  disable(): Promise<void>;
  inspectPending(): Promise<void>;
  clearLocalSubscription(): Promise<void>;
  dispose(): void;
}

export type WebPushBrowserOptions = Readonly<{ port?: BrowserPushPort; assertCurrent: () => void }>;

type PendingAction = Readonly<{ commandId: string; action: 'provision' | 'register' | 'revoke' }>;
type LocalScope = Readonly<{ deviceId?: string; pending?: PendingAction }>;
type ResponseLike = Pick<Response, 'ok' | 'status' | 'json'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ORIGIN_PUSH_LOCK = 'still:webpush:subscription';
const EMPTY_STATE: WebPushBrowserState = Object.freeze({ phase: 'loading', busy: false, permission: 'unsupported' });

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('invalid');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid');
    result[key] = descriptor.value;
  }
  return result;
}

function integer(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function publicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
  try {
    const bytes = encodeApplicationServerKey(value);
    return bytes.byteLength === 65 && new Uint8Array(bytes)[0] === 4;
  } catch { return false; }
}

function parseStatus(value: unknown, epoch: number): WebPushSafeStatus {
  const hasActiveKey = Boolean(value && typeof value === 'object' && Reflect.ownKeys(value).includes('activeKey'));
  const row = exactRecord(value, hasActiveKey ? ['schemaVersion', 'privacyEpoch', 'provisioned', 'activeKey', 'subscriptionCount'] :
    ['schemaVersion', 'privacyEpoch', 'provisioned', 'subscriptionCount']);
  if (row.schemaVersion !== 1 || row.privacyEpoch !== epoch || typeof row.provisioned !== 'boolean' || !integer(row.subscriptionCount)) throw new Error('invalid');
  if (!row.provisioned) {
    if (Object.hasOwn(row, 'activeKey')) throw new Error('invalid');
    return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, provisioned: false, subscriptionCount: row.subscriptionCount as number });
  }
  const key = exactRecord(row.activeKey, ['keyId', 'publicKey', 'createdAt']);
  if (!uuid(key.keyId) || !publicKey(key.publicKey) || !timestamp(key.createdAt)) throw new Error('invalid');
  return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, provisioned: true,
    activeKey: Object.freeze({ keyId: key.keyId.toLowerCase(), publicKey: key.publicKey, createdAt: key.createdAt }),
    subscriptionCount: row.subscriptionCount as number });
}

function parsePublicKey(value: unknown, epoch: number): WebPushPublicKey {
  const hasPublicKey = Boolean(value && typeof value === 'object' && Reflect.ownKeys(value).includes('publicKey'));
  const row = exactRecord(value, hasPublicKey
    ? ['schemaVersion', 'privacyEpoch', 'provisioned', 'keyId', 'publicKey', 'createdAt']
    : ['schemaVersion', 'privacyEpoch', 'provisioned']);
  if (row.schemaVersion !== 1 || row.privacyEpoch !== epoch || typeof row.provisioned !== 'boolean') throw new Error('invalid');
  if (!row.provisioned) return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, provisioned: false });
  if (!uuid(row.keyId) || !publicKey(row.publicKey) || !timestamp(row.createdAt)) throw new Error('invalid');
  return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, provisioned: true,
    keyId: row.keyId.toLowerCase(), publicKey: row.publicKey, createdAt: row.createdAt });
}

function parseHead(value: unknown): WebPushSubscriptionHead {
  const row = exactRecord(value, ['deviceId', 'generation', 'status', 'keyId', 'updatedAt']);
  if (!uuid(row.deviceId) || !integer(row.generation, 1) || (row.status !== 'active' && row.status !== 'revoked') ||
      !uuid(row.keyId) || !timestamp(row.updatedAt)) throw new Error('invalid');
  return Object.freeze({ deviceId: row.deviceId.toLowerCase(), generation: row.generation as number, status: row.status,
    keyId: row.keyId.toLowerCase(), updatedAt: row.updatedAt });
}

function parseReceipt(value: unknown, expectedId: string): WebPushReceipt {
  const row = exactRecord(value, ['schemaVersion', 'commandId', 'operation', 'result', 'createdAt']);
  if (row.schemaVersion !== 1 || row.commandId !== expectedId || !timestamp(row.createdAt)) throw new Error('invalid');
  if (row.operation === 'provision' || row.operation === 'rotate') {
    const result = exactRecord(row.result, ['keyId', 'publicKey', 'createdAt']);
    if (!uuid(result.keyId) || !publicKey(result.publicKey) || !timestamp(result.createdAt)) throw new Error('invalid');
    return Object.freeze({ schemaVersion: 1, commandId: expectedId, operation: row.operation,
      result: Object.freeze({ keyId: result.keyId.toLowerCase(), publicKey: result.publicKey, createdAt: result.createdAt }), createdAt: row.createdAt });
  }
  if (row.operation === 'register' || row.operation === 'revoke') {
    const result = parseHead(row.result);
    if ((row.operation === 'register' && result.status !== 'active') || (row.operation === 'revoke' && result.status !== 'revoked')) throw new Error('invalid');
    return Object.freeze({ schemaVersion: 1, commandId: expectedId, operation: row.operation, result, createdAt: row.createdAt });
  }
  throw new Error('invalid');
}

function parseReconciliation(value: unknown, epoch: number, deviceId: string): WebPushReconciliation {
  const hasGeneration = Boolean(value && typeof value === 'object' && Reflect.ownKeys(value).includes('generation'));
  const statusDescriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'status') : undefined;
  if (statusDescriptor && !Object.hasOwn(statusDescriptor, 'value')) throw new Error('invalid');
  const status = statusDescriptor?.value;
  const row = exactRecord(value, hasGeneration
    ? (status === 'revoked'
      ? ['schemaVersion', 'privacyEpoch', 'deviceId', 'status', 'generation', 'keyId']
      : ['schemaVersion', 'privacyEpoch', 'deviceId', 'status', 'generation', 'keyId', 'publicKey'])
    : ['schemaVersion', 'privacyEpoch', 'deviceId', 'status']);
  if (row.schemaVersion !== 1 || row.privacyEpoch !== epoch || row.deviceId !== deviceId) throw new Error('invalid');
  if (row.status === 'missing') return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, deviceId, status: 'missing' });
  if (!integer(row.generation, 1) || !uuid(row.keyId)) throw new Error('invalid');
  if (row.status === 'revoked') return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, deviceId, status: 'revoked', generation: row.generation, keyId: row.keyId.toLowerCase() });
  if ((row.status !== 'matched' && row.status !== 'unmatched') || !publicKey(row.publicKey)) throw new Error('invalid');
  return Object.freeze({ schemaVersion: 1, privacyEpoch: epoch, deviceId, status: row.status, generation: row.generation,
    keyId: row.keyId.toLowerCase(), publicKey: row.publicKey });
}

function defaultPort(): BrowserPushPort {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { standalone?: boolean };
  const notification = typeof Notification === 'undefined' ? undefined : Notification;
  const sw = nav && 'serviceWorker' in nav ? nav.serviceWorker : undefined;
  const lockManager = nav && 'locks' in nav ? nav.locks : undefined;
  let storage: Storage | undefined;
  try { storage = typeof localStorage === 'undefined' ? undefined : localStorage; } catch { storage = undefined; }
  const isIOSStandaloneApi = Boolean(nav && 'standalone' in nav);
  return {
    secureContext: typeof isSecureContext !== 'undefined' && isSecureContext,
    standaloneRequired: isIOSStandaloneApi,
    standalone: nav?.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches),
    serviceWorkerAvailable: Boolean(sw), pushAvailable: typeof PushManager !== 'undefined', notificationsAvailable: Boolean(notification),
    locksAvailable: Boolean(lockManager),
    get permission() { return notification?.permission ?? 'unsupported'; },
    requestPermission: () => notification ? notification.requestPermission() : Promise.resolve('denied'),
    serviceWorkerReady: () => sw ? sw.ready : Promise.reject(new Error('service_worker_unavailable')),
    withExclusiveLock: <T,>(name: string, signal: AbortSignal, work: () => Promise<T>) => lockManager
      ? lockManager.request(name, { mode: 'exclusive', signal }, work)
      : Promise.reject(new Error('origin_lock_unavailable')),
    storage: storage ?? { getItem: () => null, setItem: () => { throw new Error('storage_unavailable'); }, removeItem: () => undefined },
    randomUUID: () => crypto.randomUUID(),
  };
}

function storageKey(session: AuthenticatedSession): string { return `still:webpush:${session.workspaceId}:${session.privacyEpoch}`; }
function parseLocalScope(storage: BrowserPushPort['storage'], key: string): LocalScope {
  const raw = storage.getItem(key);
  if (raw === null) return Object.freeze({});
  try {
    const parsed: unknown = JSON.parse(raw);
    const own = parsed && typeof parsed === 'object' ? Reflect.ownKeys(parsed) : [];
    const hasPending = own.includes('pending');
    const hasDeviceId = own.includes('deviceId');
    const row = exactRecord(parsed, hasPending ? (hasDeviceId ? ['deviceId', 'pending'] : ['pending']) : ['deviceId']);
    let deviceId: string | undefined;
    if (Object.hasOwn(row, 'deviceId')) { if (!uuid(row.deviceId)) throw new Error('invalid'); deviceId = row.deviceId.toLowerCase(); }
    let pending: PendingAction | undefined;
    if (Object.hasOwn(row, 'pending')) {
      const p = exactRecord(row.pending, ['commandId', 'action']);
      if (!uuid(p.commandId) || (p.action !== 'provision' && p.action !== 'register' && p.action !== 'revoke')) throw new Error('invalid');
      pending = Object.freeze({ commandId: p.commandId.toLowerCase(), action: p.action });
    }
    if (!deviceId && pending?.action !== 'provision') throw new Error('invalid');
    return Object.freeze({ ...(deviceId ? { deviceId } : {}), ...(pending ? { pending } : {}) });
  } catch { throw new Error('The saved notification recovery marker is invalid. Clear site data only if you intend to reset this device.'); }
}

function encodeApplicationServerKey(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

function serializeSubscription(subscription: BrowserPushSubscriptionHandle): BrowserPushSubscription {
  const json = subscription.toJSON();
  if (typeof json.endpoint !== 'string' || !json.keys || typeof json.keys.p256dh !== 'string' || typeof json.keys.auth !== 'string') {
    throw new Error('The browser could not read its notification subscription.');
  }
  return Object.freeze({ endpoint: json.endpoint, keys: Object.freeze({ p256dh: json.keys.p256dh, auth: json.keys.auth }) });
}

export function createWebPushBrowserCoordinator(session: AuthenticatedSession, options: WebPushBrowserOptions): WebPushBrowserCoordinator {
  if (!session.authenticated || !uuid(session.workspaceId) || !integer(session.privacyEpoch) || !session.csrfToken) throw new Error('authenticated_workspace_required');
  const port = options.port ?? defaultPort();
  const fetcher = port.fetcher ?? fetch.bind(globalThis);
  const key = storageKey(session);
  let state: WebPushBrowserState = EMPTY_STATE;
  let disposed = false;
  let operation = 0;
  let activeTicket: number | undefined;
  const lockAbortController = new AbortController();
  let local: LocalScope = Object.freeze({});
  let status: WebPushSafeStatus | undefined;
  let publicKey: WebPushPublicKey | undefined;
  let registration: Awaited<ReturnType<BrowserPushPort['serviceWorkerReady']>> | undefined;
  let browserSubscription: BrowserPushSubscriptionHandle | null = null;
  let permission: NotificationPermission | 'unsupported' = port.permission;
  const listeners = new Set<() => void>();

  const assertCurrent = () => { if (disposed) throw new Error('notification_workspace_changed'); options.assertCurrent(); };
  const assertOperation = (ticket: number) => { assertCurrent(); if (ticket !== operation) throw new Error('notification_operation_superseded'); };
  const publish = (next: WebPushBrowserState) => { if (!disposed) { state = Object.freeze(activeTicket === undefined ? next : { ...next, busy: true }); for (const listener of listeners) listener(); } };
  const writeLocal = (next: LocalScope, ticket: number) => { assertOperation(ticket); port.storage.setItem(key, JSON.stringify(next)); local = Object.freeze(next); };
  const clearLocal = (ticket: number) => { assertOperation(ticket); port.storage.removeItem(key); local = Object.freeze({}); };
  const savePending = (action: PendingAction, ticket: number, deviceId = local.deviceId) => writeLocal({ ...(deviceId ? { deviceId } : {}), pending: action }, ticket);
  const busyState = (phase = state.phase) => publish({ ...state, phase, busy: true, message: undefined });
  const request = async (path: string, method: 'GET' | 'POST', ticket: number, body?: unknown): Promise<unknown> => {
    assertOperation(ticket);
    const response: ResponseLike = await fetcher(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken }, body: JSON.stringify(body) } : {}) });
    assertOperation(ticket);
    if (!response.ok) throw Object.assign(new Error('The notification service could not confirm this action.'), { status: response.status });
    const json = await response.json();
    assertOperation(ticket);
    return json;
  };
  const readStatus = async (ticket: number) => parseStatus(await request('/api/web-push/status', 'GET', ticket), session.privacyEpoch);
  const readKey = async (ticket: number) => parsePublicKey(await request('/api/web-push/vapid-key', 'GET', ticket), session.privacyEpoch);
  const readHead = async (deviceId: string, ticket: number): Promise<WebPushSubscriptionHead | undefined> => {
    let cursor: string | undefined;
    let previousCursor: string | undefined;
    let previousDeviceId: string | undefined;
    do {
      const raw = await request(`/api/web-push/subscriptions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', ticket);
      const hasNextCursor = Boolean(raw && typeof raw === 'object' && Reflect.ownKeys(raw).includes('nextCursor'));
      const page = exactRecord(raw, hasNextCursor ? ['schemaVersion', 'privacyEpoch', 'subscriptions', 'nextCursor'] :
        ['schemaVersion', 'privacyEpoch', 'subscriptions']);
      if (page.schemaVersion !== 1 || page.privacyEpoch !== session.privacyEpoch || !Array.isArray(page.subscriptions)) throw new Error('invalid');
      let lastPageDeviceId: string | undefined;
      for (const item of page.subscriptions) {
        const head = parseHead(item);
        if (previousDeviceId && head.deviceId <= previousDeviceId) throw new Error('invalid_subscription_order');
        previousDeviceId = head.deviceId;
        lastPageDeviceId = head.deviceId;
        if (head.deviceId === deviceId) return head;
      }
      if (Object.hasOwn(page, 'nextCursor')) {
        if (!uuid(page.nextCursor) || page.nextCursor !== lastPageDeviceId || page.nextCursor === cursor || (previousCursor && page.nextCursor <= previousCursor)) throw new Error('invalid_subscription_cursor');
        previousCursor = page.nextCursor as string;
        cursor = page.nextCursor as string;
      }
      else cursor = undefined;
    } while (cursor);
    return undefined;
  };
  const inspect = async (commandId: string, ticket: number): Promise<WebPushReceipt | undefined> => {
    assertOperation(ticket);
    const response = await fetcher(`/api/web-push/commands/${commandId}`, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    assertOperation(ticket);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('The notification receipt could not be checked.');
    const json = await response.json();
    assertOperation(ticket);
    return parseReceipt(json, commandId);
  };
  const unsupportedReason = (): string | undefined => {
    if (!port.secureContext) return 'Notifications require a secure HTTPS connection.';
    if (port.standaloneRequired && !port.standalone) return 'On this device, add Still to your Home Screen and open the installed app to enable notifications.';
    if (!port.serviceWorkerAvailable || !port.pushAvailable || !port.notificationsAvailable) return 'This browser does not support web notifications. Open Still in a supported browser or installed web app.';
    if (!port.locksAvailable) return 'This browser does not support the cross-tab safety needed for notifications. Update it or use a supported browser.';
    return undefined;
  };
  const capabilityState = (phase: WebPushBrowserState['phase'], message?: string): WebPushBrowserState => ({ phase, busy: false,
    permission, ...(local.deviceId ? { deviceId: local.deviceId } : {}), ...(message ? { message } : {}),
    ...(status ? { subscriptionCount: status.subscriptionCount } : {}),
    ...(status?.activeKey ? { activeKey: { keyId: status.activeKey.keyId, publicKey: status.activeKey.publicKey } } : {}) });

  const reconcileCurrent = async (deviceId: string, subscription: BrowserPushSubscriptionHandle, ticket: number): Promise<WebPushReconciliation> => {
    assertOperation(ticket);
    const body = { expectedPrivacyEpoch: session.privacyEpoch, deviceId, subscription: serializeSubscription(subscription) };
    return parseReconciliation(await request('/api/web-push/subscriptions/reconcile', 'POST', ticket, body), session.privacyEpoch, deviceId);
  };
  const setFromReconciliation = (result: WebPushReconciliation, ticket: number) => {
    assertOperation(ticket);
    if (result.status === 'matched') publish({ ...capabilityState('enabled'), deviceId: result.deviceId, generation: result.generation,
      activeKey: { keyId: result.keyId, publicKey: result.publicKey }, message: 'This browser is registered for generic reminders.' });
    else if (result.status === 'revoked') publish({ ...capabilityState(browserSubscription ? 'local_cleanup_pending' : 'disabled'), deviceId: result.deviceId,
      generation: result.generation, message: browserSubscription ? 'This device is disabled on the server. Remove its remaining browser subscription to finish cleanup.' : 'Notifications are disabled for this browser.' });
    else if (result.status === 'unmatched') publish({ ...capabilityState('unmatched_local'), deviceId: result.deviceId,
      generation: result.generation, activeKey: { keyId: result.keyId, publicKey: result.publicKey },
      message: 'This workspace has a saved device registration, but it does not match the browser subscription. Disable the saved registration before clearing this browser.' });
    else publish({ ...capabilityState('unresolved_local'), deviceId: result.deviceId,
      message: 'A browser subscription exists but no matching workspace device record was found. It will not be transferred or registered automatically.' });
  };
  const recoverPending = async (ticket: number) => {
    const pending = local.pending;
    if (!pending) return false;
    try {
      const receipt = await inspect(pending.commandId, ticket);
      assertOperation(ticket);
      if (!receipt) {
        const phase = pending.action === 'register' ? 'registration_unknown' : pending.action === 'revoke' ? 'disable_unknown' : 'unprovisioned';
        publish({ ...capabilityState(phase), pending, message: 'The exact notification command has no receipt yet. Check that receipt before starting another action.' });
        return true;
      }
      if (pending.action === 'provision') {
        if (receipt.operation !== 'provision') throw new Error('notification_receipt_operation_mismatch');
        local = Object.freeze({});
        clearLocal(ticket);
        status = await readStatus(ticket);
        assertOperation(ticket);
        publicKey = await readKey(ticket);
        assertOperation(ticket);
        publish({ ...capabilityState('disabled'), message: 'Notification keys are ready. You can enable this browser when you choose.' });
        return true;
      }
      if (pending.action === 'register' && receipt.operation === 'register') {
        local = Object.freeze({ deviceId: receipt.result.deviceId });
        writeLocal(local, ticket);
      } else if (pending.action === 'revoke' && receipt.operation === 'revoke') {
        local = Object.freeze({ ...(local.deviceId ? { deviceId: local.deviceId } : {}) });
        writeLocal(local, ticket);
      } else throw new Error('notification_receipt_operation_mismatch');
      local = Object.freeze({ ...(local.deviceId ? { deviceId: local.deviceId } : {}) });
      writeLocal(local, ticket);
      if (!registration) {
        registration = await port.serviceWorkerReady();
        assertOperation(ticket);
      }
      assertOperation(ticket);
      const current = await registration.pushManager.getSubscription();
      assertOperation(ticket);
      browserSubscription = current ?? null;
      if (pending.action === 'revoke' && receipt.operation === 'revoke') {
        publish({ ...capabilityState(browserSubscription ? 'local_cleanup_pending' : 'disabled'), deviceId: receipt.result.deviceId,
          generation: receipt.result.generation, message: browserSubscription ? 'The server has disabled this device. Finish removing its browser subscription below.' : 'Notifications are disabled for this browser.' });
      } else if (browserSubscription && pending.action === 'register' && receipt.operation === 'register') setFromReconciliation(await reconcileCurrent(receipt.result.deviceId, browserSubscription, ticket), ticket);
      else if (pending.action === 'register' && receipt.operation === 'register') publish({ ...capabilityState('server_active_local_missing'), deviceId: receipt.result.deviceId, generation: receipt.result.generation,
        message: 'The server has a registration but this browser no longer has its subscription. Disable the server registration before enabling again.' });
      return true;
    } catch (error) {
      assertOperation(ticket);
      publish({ ...capabilityState('error'), pending, message: safeMessage(error) });
      return true;
    }
  };
  const refresh = async (ticket: number) => {
    assertOperation(ticket);
    permission = port.permission;
    const reason = unsupportedReason();
    if (reason) { publish({ phase: 'unsupported', busy: false, permission, message: reason }); return; }
    local = parseLocalScope(port.storage, key);
    assertOperation(ticket);
    status = await readStatus(ticket);
    assertOperation(ticket);
    publicKey = await readKey(ticket);
    if (status.privacyEpoch !== session.privacyEpoch || publicKey.privacyEpoch !== session.privacyEpoch) throw new Error('workspace_epoch_changed');
    assertOperation(ticket);
    registration = await port.serviceWorkerReady();
    assertOperation(ticket);
    browserSubscription = await registration.pushManager.getSubscription();
    assertOperation(ticket);
    if (await recoverPending(ticket)) return;
    assertOperation(ticket);
    if (!status.provisioned || !publicKey.provisioned) { publish(capabilityState('unprovisioned', 'Set up the workspace notification key before enabling this browser.')); return; }
    if (browserSubscription) {
      if (!local.deviceId) { publish(capabilityState('unresolved_local', 'A browser subscription already exists without a workspace device record. It will not be transferred. Clear it locally to start fresh.')); return; }
      setFromReconciliation(await reconcileCurrent(local.deviceId, browserSubscription, ticket), ticket);
      return;
    }
    if (local.deviceId) {
      const head = await readHead(local.deviceId, ticket);
      assertOperation(ticket);
      if (head?.status === 'active') publish({ ...capabilityState('server_active_local_missing'), deviceId: local.deviceId, generation: head.generation,
        message: 'The server has an active registration but this browser subscription is missing. Disable it before enrolling this browser again.' });
      else if (head?.status === 'revoked') { clearLocal(ticket); publish(capabilityState('disabled', 'Notifications are disabled for this browser.')); }
      else publish(capabilityState('disabled', 'Notifications are off for this browser.'));
      return;
    }
    publish(capabilityState('disabled', 'Notifications are off for this browser.'));
  };

  const requireIdle = () => { assertCurrent(); if (state.busy) throw new Error('A notification action is already in progress.'); };
  const run = async (phase: WebPushBrowserState['phase'], work: (ticket: number) => Promise<void>, reservedTicket?: number, recoverExistingPending = true) => {
    if (reservedTicket === undefined) requireIdle();
    const ticket = reservedTicket ?? ++operation;
    assertOperation(ticket); activeTicket = ticket; busyState(phase);
    try {
      await port.withExclusiveLock(ORIGIN_PUSH_LOCK, lockAbortController.signal, async () => {
        assertOperation(ticket);
        // A different tab or workspace may have changed the browser-global subscription or this scoped marker.
        local = parseLocalScope(port.storage, key);
        assertOperation(ticket);
        if (local.pending && recoverExistingPending) {
          if (!registration && local.pending.action !== 'provision') {
            registration = await port.serviceWorkerReady();
            assertOperation(ticket);
          }
          await recoverPending(ticket);
          assertOperation(ticket);
          return;
        }
        await work(ticket);
        assertOperation(ticket);
      });
      assertOperation(ticket);
    }
    catch (error) {
      if (!disposed && ticket === operation) {
        try { assertCurrent(); } catch { return; }
        publish({ ...state, phase: state.phase === 'local_cleanup_pending' || state.phase === 'unmatched_local' ? state.phase : 'error',
          busy: false, message: safeMessage(error) });
      }
    }
    finally { if (activeTicket === ticket) activeTicket = undefined; if (!disposed && ticket === operation && state.busy) publish({ ...state, busy: false }); }
  };

  const coordinator: WebPushBrowserCoordinator = {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => {
      requireIdle();
      const reason = unsupportedReason();
      if (reason) { operation += 1; publish({ phase: 'unsupported', busy: false, permission: port.permission, message: reason }); return; }
      return run('loading', async (ticket) => {
        publish({ ...EMPTY_STATE, busy: true, permission });
        await refresh(ticket);
      }, undefined, false);
    },
    provision: async () => run('unprovisioned', async (ticket) => {
      if (local.pending) throw new Error('Check the exact pending notification command before starting another action.');
      status = await readStatus(ticket);
      if (status.provisioned) {
        assertOperation(ticket);
        publicKey = await readKey(ticket);
        assertOperation(ticket);
        publish({ ...capabilityState('disabled'), message: 'The workspace notification key is already set up. No new key was created.' });
        return;
      }
      const pending: PendingAction = Object.freeze({ commandId: port.randomUUID(), action: 'provision' });
      savePending(pending, ticket);
      const raw = await request('/api/web-push/provision', 'POST', ticket, { commandId: pending.commandId, expectedPrivacyEpoch: session.privacyEpoch });
      assertOperation(ticket);
      const receipt = parseReceipt(raw, pending.commandId);
      if (receipt.operation !== 'provision') throw new Error('notification_receipt_operation_mismatch');
      clearLocal(ticket); local = Object.freeze({}); status = await readStatus(ticket);
      assertOperation(ticket);
      publicKey = await readKey(ticket);
      assertOperation(ticket);
      publish({ ...capabilityState('disabled'), activeKey: { keyId: receipt.result.keyId, publicKey: receipt.result.publicKey },
        message: 'The workspace notification key is ready. Choose Enable on this device when you are ready.' });
    }),
    enable: async () => {
      requireIdle();
      const reason = unsupportedReason();
      if (reason) { publish({ phase: 'unsupported', busy: false, permission, message: reason }); return; }
      if (local.pending || state.phase === 'registration_unknown' || state.phase === 'disable_unknown') {
        throw new Error('Check the exact pending notification command before enabling this browser.');
      }
      // This call must remain before the first await to preserve the user gesture.
      let permissionPromise: Promise<NotificationPermission>;
      try { permissionPromise = port.requestPermission(); }
      catch (error) { publish({ ...capabilityState('error'), message: safeMessage(error) }); return; }
      return run('loading', async (ticket) => {
        const grantedPermission = await permissionPromise;
        assertOperation(ticket);
        permission = grantedPermission;
        if (grantedPermission !== 'granted') { publish({ ...capabilityState('disabled'), message: grantedPermission === 'denied'
          ? 'Notification permission is blocked. Allow it in this browser’s site settings, then try again.'
          : 'Notification permission was not granted.' }); return; }
        if (!publicKey?.provisioned || !publicKey.publicKey || !publicKey.keyId) { publish({ ...capabilityState('unprovisioned'),
          message: 'Set up the workspace notification key first. No browser subscription was created.' }); return; }
        status = await readStatus(ticket);
        assertOperation(ticket);
        publicKey = await readKey(ticket);
        assertOperation(ticket);
        if (!status.provisioned || !publicKey.provisioned || publicKey.keyId !== status.activeKey?.keyId) {
          publish({ ...capabilityState('unprovisioned'), message: 'The workspace notification key changed. Review it before enabling this browser.' }); return;
        }
        registration ??= await port.serviceWorkerReady();
        assertOperation(ticket);
        browserSubscription = await registration.pushManager.getSubscription();
        assertOperation(ticket);
        if (browserSubscription) {
          if (!local.deviceId) { publish({ ...capabilityState('unresolved_local'),
            message: 'A browser subscription already exists without a workspace device record. Clear it locally before creating a new one.' }); return; }
          setFromReconciliation(await reconcileCurrent(local.deviceId, browserSubscription, ticket), ticket);
          return;
        }
        let expectedPreviousGeneration = 0;
        if (local.deviceId) {
          const knownHead = await readHead(local.deviceId, ticket);
          assertOperation(ticket);
          if (knownHead?.status === 'active') {
            publish({ ...capabilityState('server_active_local_missing'), deviceId: local.deviceId, generation: knownHead.generation,
              message: 'The server already has an active registration, but this browser subscription is missing. Disable it before enrolling again.' }); return;
          }
          if (knownHead?.status === 'revoked') expectedPreviousGeneration = knownHead.generation;
        }
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true,
          applicationServerKey: encodeApplicationServerKey(publicKey.publicKey) });
        assertOperation(ticket);
        browserSubscription = subscription;
        const deviceId = local.deviceId ?? port.randomUUID();
        writeLocal({ deviceId }, ticket);
        const pending = Object.freeze({ commandId: port.randomUUID(), action: 'register' as const });
        savePending(pending, ticket, deviceId);
        const current = serializeSubscription(subscription);
        try {
          const raw = await request('/api/web-push/subscriptions/register', 'POST', ticket, {
            commandId: pending.commandId, expectedPrivacyEpoch: session.privacyEpoch, deviceId, keyId: publicKey.keyId,
            expectedPreviousGeneration, subscription: current,
          });
          assertOperation(ticket);
          const receipt = parseReceipt(raw, pending.commandId);
          if (receipt.operation !== 'register') throw new Error('notification_receipt_operation_mismatch');
          writeLocal({ deviceId }, ticket);
          setFromReconciliation(await reconcileCurrent(deviceId, subscription, ticket), ticket);
        } catch (error) {
          assertOperation(ticket);
          if (isAmbiguous(error)) publish({ ...capabilityState('registration_unknown'), pending, deviceId,
            message: 'The registration response was not confirmed. Check its exact receipt; do not create another registration.' });
          else { writeLocal({ deviceId }, ticket); publish({ ...capabilityState('unresolved_local'), deviceId,
            message: 'The browser subscription was created, but the workspace did not accept its registration. Clear it locally before trying again.' }); }
        }
      });
    },
    disable: async () => {
      const originalPhase = state.phase;
      if (originalPhase !== 'enabled' && originalPhase !== 'unmatched_local' && originalPhase !== 'server_active_local_missing') {
        throw new Error('Resolve the current notification state before disabling this browser.');
      }
      return run(originalPhase, async (ticket) => {
      if (local.pending || state.phase === 'registration_unknown' || state.phase === 'disable_unknown') {
        throw new Error('Check the exact pending notification command before disabling this browser.');
      }
      if (!local.deviceId) { if (browserSubscription) publish({ ...capabilityState('unresolved_local'), message: 'This browser subscription has no workspace device record. Clear it locally to disable notifications.' }); return; }
      registration ??= await port.serviceWorkerReady();
      assertOperation(ticket);
      browserSubscription = await registration.pushManager.getSubscription();
      assertOperation(ticket);
      let matchedSubscriptionProof: string | undefined;
      let matchedGeneration: number | undefined;
      let subscriptionWasUnmatched = false;
      if (browserSubscription) {
        const reconciliation = await reconcileCurrent(local.deviceId, browserSubscription, ticket);
        assertOperation(ticket);
        subscriptionWasUnmatched = reconciliation.status === 'unmatched';
        if (reconciliation.status === 'matched') {
          matchedSubscriptionProof = JSON.stringify(serializeSubscription(browserSubscription));
          matchedGeneration = reconciliation.generation;
        }
      }
      assertOperation(ticket);
      const head = await readHead(local.deviceId, ticket);
      assertOperation(ticket);
      if (!head || head.status === 'revoked') { publish({ ...capabilityState(browserSubscription ? 'local_cleanup_pending' : 'disabled'), deviceId: local.deviceId,
        ...(head ? { generation: head.generation } : {}), message: browserSubscription ? 'The server is already disabled. Finish local browser cleanup.' : 'Notifications are disabled for this browser.' }); return; }
      const pending = Object.freeze({ commandId: port.randomUUID(), action: 'revoke' as const });
      savePending(pending, ticket);
      let unknown = false;
      try {
        const raw = await request('/api/web-push/subscriptions/revoke', 'POST', ticket, { commandId: pending.commandId,
          expectedPrivacyEpoch: session.privacyEpoch, deviceId: local.deviceId, expectedGeneration: head.generation });
        assertOperation(ticket);
        const receipt = parseReceipt(raw, pending.commandId);
        if (receipt.operation !== 'revoke') throw new Error('notification_receipt_operation_mismatch');
        writeLocal({ deviceId: local.deviceId }, ticket);
        local.pending && clearLocalPending(ticket);
      } catch (error) {
        if (isAmbiguous(error)) { unknown = true; publish({ ...capabilityState('disable_unknown'), pending, deviceId: local.deviceId,
          generation: head.generation, message: 'The server disable response was not confirmed. Check its exact receipt before removing the browser subscription.' }); }
        else throw error;
      }
      if (unknown) return;
      if (subscriptionWasUnmatched) {
        clearLocal(ticket);
        publish({ ...capabilityState('unresolved_local'), message: 'The saved workspace registration is disabled. A different browser subscription remains and was left untouched; clear it locally only if you want to remove it.' });
        return;
      }
      if (matchedSubscriptionProof !== undefined && head.status === 'active' && head.generation === matchedGeneration) {
        browserSubscription = await registration.pushManager.getSubscription();
        assertOperation(ticket);
        if (!browserSubscription || JSON.stringify(serializeSubscription(browserSubscription)) !== matchedSubscriptionProof) {
          clearLocal(ticket);
          publish({ ...capabilityState(browserSubscription ? 'unresolved_local' : 'disabled'),
            message: browserSubscription ? 'The saved registration is disabled. A replacement browser subscription was left untouched; clear it locally only if you want to remove it.' : 'Notifications are disabled for this browser.' });
          return;
        }
      } else if (browserSubscription) {
        clearLocal(ticket);
        publish({ ...capabilityState('unresolved_local'), message: 'The saved registration is disabled. The current browser subscription was not verified as that device, so it was left untouched.' });
        return;
      }
      publish({ ...capabilityState('local_cleanup_pending'), deviceId: local.deviceId, generation: head.generation,
        message: 'The server has disabled notifications. Remove this browser subscription to finish.' });
      await localCleanup(ticket);
      });
    },
    inspectPending: async () => run(state.phase, async (ticket) => {
      if (!local.pending) { await refresh(ticket); return; }
      const pending = local.pending;
      const receipt = await inspect(pending.commandId, ticket);
      assertOperation(ticket);
      if (receipt) {
        if (pending.action === 'provision') {
          if (receipt.operation !== 'provision') throw new Error('notification_receipt_operation_mismatch');
          clearLocal(ticket); local = Object.freeze({}); status = await readStatus(ticket);
          assertOperation(ticket);
          publicKey = await readKey(ticket);
          assertOperation(ticket);
          publish({ ...capabilityState('disabled'), message: 'The workspace notification key is ready. Choose Enable on this device when you are ready.' }); return; }
        if (pending.action === 'register' && receipt.operation === 'register') writeLocal({ deviceId: receipt.result.deviceId }, ticket);
        else if (pending.action === 'revoke' && receipt.operation === 'revoke' && local.deviceId) writeLocal({ deviceId: local.deviceId }, ticket);
        else throw new Error('notification_receipt_operation_mismatch');
        local = Object.freeze({ ...(local.deviceId ? { deviceId: local.deviceId } : {}) });
        if (pending.action === 'revoke') clearLocalPending(ticket);
        if (pending.action === 'revoke') {
          assertOperation(ticket);
          browserSubscription = await registration?.pushManager.getSubscription() ?? null;
          assertOperation(ticket);
          publish({ ...capabilityState(browserSubscription ? 'local_cleanup_pending' : 'disabled'), deviceId: receipt.result.deviceId,
            generation: receipt.result.generation, message: browserSubscription ? 'The server is disabled. Finish local browser cleanup.' : 'Notifications are disabled for this browser.' }); return;
        }
        assertOperation(ticket);
        browserSubscription = await registration?.pushManager.getSubscription() ?? null;
        assertOperation(ticket);
        if (browserSubscription && receipt.operation === 'register') setFromReconciliation(await reconcileCurrent(receipt.result.deviceId, browserSubscription, ticket), ticket);
        else publish({ ...capabilityState('server_active_local_missing'), deviceId: receipt.result.deviceId,
          ...(receipt.operation === 'register' ? { generation: receipt.result.generation } : {}), message: 'The server registration exists but the browser subscription is missing.' });
        return;
      }
      publish({ ...capabilityState(pending.action === 'register' ? 'registration_unknown' : pending.action === 'revoke' ? 'disable_unknown' : 'unprovisioned'),
        pending, message: 'No receipt is available for this exact command yet. It will not be replaced automatically.' });
    }),
    clearLocalSubscription: async () => {
      requireIdle();
      if (state.phase !== 'local_cleanup_pending' && state.phase !== 'unresolved_local') {
        throw new Error('Disable an owned workspace registration before clearing this browser subscription.');
      }
      return run(state.phase, async (ticket) => { await localCleanup(ticket); });
    },
    dispose: () => { disposed = true; operation += 1; lockAbortController.abort(); activeTicket = undefined; listeners.clear(); registration = undefined; browserSubscription = null; },
  };

  function clearLocalPending(ticket: number): void {
    assertOperation(ticket);
    if (local.deviceId) writeLocal({ deviceId: local.deviceId }, ticket);
    else clearLocal(ticket);
  }

  async function localCleanup(ticket: number): Promise<void> {
    assertOperation(ticket);
    if (local.pending) throw new Error('Check the exact pending notification command before local cleanup.');
    if (state.phase !== 'local_cleanup_pending' && state.phase !== 'unresolved_local') throw new Error('Resolve the server registration before removing this browser subscription.');
    if (!registration) throw new Error('The browser notification service is not ready to verify local cleanup.');
    assertOperation(ticket);
    browserSubscription = await registration.pushManager.getSubscription();
    assertOperation(ticket);
    if (local.deviceId) {
      const head = await readHead(local.deviceId, ticket);
      assertOperation(ticket);
      if (head?.status === 'active') {
        publish({ ...capabilityState('unmatched_local'), deviceId: local.deviceId, generation: head.generation,
          message: 'This workspace still has an active device registration. Disable it before clearing this browser subscription.' });
        throw new Error('Disable the saved workspace registration before local cleanup.');
      }
    }
    if (browserSubscription) {
      const removed = await browserSubscription.unsubscribe();
      assertOperation(ticket);
      if (!removed) throw new Error('The browser did not confirm subscription removal.');
    }
    browserSubscription = null;
    clearLocal(ticket);
    publish(capabilityState('disabled', 'Notifications are off for this browser.'));
  }
  return Object.freeze(coordinator);
}

function isAmbiguous(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error) || typeof (error as { status?: unknown }).status !== 'number') return true;
  const status = (error as { status: number }).status;
  return status === 408 || status >= 500;
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'Notification settings could not be confirmed.'; }
