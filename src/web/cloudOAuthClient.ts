import type { AuthenticatedSession } from './authClient';

export type OAuthProvider = 'google' | 'microsoft';
export type OAuthCapability = 'mail.read' | 'mail.draft' | 'mail.send' | 'calendar.read' | 'calendar.write';
export type OAuthStageStatus = Readonly<{
  attemptId: string;
  registrationId: string;
  provider: OAuthProvider;
  status: 'authorization_pending' | 'exchange_claimed' | 'verified' | 'denied' | 'inspect_required' | 'expired' | 'consumed';
  payloadGeneration: number;
  createdAt: number;
  expiresAt: number;
  consumption?: Readonly<{ commandId: string; accountId: string; accountGeneration: number }>;
}>;
export type OAuthAttemptMetadata = Readonly<{
  startAttemptId: string;
  provider: OAuthProvider;
  status: OAuthStageStatus['status'] | 'superseded' | 'building' | 'restart_required';
  stageId: string;
  createdAt: number;
  expiresAt: number;
  consumption?: OAuthStageStatus['consumption'];
}>;
export type OAuthAvailability = Readonly<{ google: boolean; microsoft: boolean }>;
export type OAuthStartResponse = Readonly<{ kind: 'started' | 'existing'; status: OAuthStageStatus; authorizationUrl?: string }>;
export type OAuthVerifiedAccountPreview = Readonly<{
  displayName: string;
  email?: string;
  requestedCapabilities: readonly OAuthCapability[];
  capabilities: readonly OAuthCapability[];
  reconnectAccountId?: string;
}>;
export type OAuthStageInspection = Readonly<{ stage: OAuthStageStatus; verifiedAccount?: OAuthVerifiedAccountPreview }>;
export type OAuthStartInput = Readonly<{
  startAttemptId: string;
  requestedCapabilities: readonly OAuthCapability[];
  expectedRevision: number;
  expectedPrivacyEpoch: number;
  reconnectAccountId?: string;
  restartOfStartAttemptId?: string;
}>;

export type OAuthClient = Readonly<{
  availability(signal?: AbortSignal): Promise<OAuthAvailability>;
  listStarts(signal?: AbortSignal): Promise<readonly OAuthAttemptMetadata[]>;
  inspectStart(provider: OAuthProvider, attemptId: string, signal?: AbortSignal): Promise<OAuthAttemptMetadata>;
  inspectStage(stageId: string, signal?: AbortSignal): Promise<OAuthStageInspection>;
  start(provider: OAuthProvider, input: OAuthStartInput, signal?: AbortSignal): Promise<OAuthStartResponse>;
  dispose(): void;
}>;

export type OAuthClientErrorKind = 'http' | 'not_admitted' | 'not_started' | 'network' | 'timeout' | 'malformed' | 'disposed' | 'stale';
export class OAuthClientError extends Error {
  constructor(readonly kind: OAuthClientErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'OAuthClientError';
  }
}

type SafeResponse = Pick<Response, 'ok' | 'status' | 'text' | 'headers'>;
type FetchLike = (input: string, init: RequestInit) => Promise<SafeResponse>;
type OAuthClientOptions = Readonly<{ fetcher?: FetchLike; timeoutMs?: number }>;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITIES = new Set<OAuthCapability>(['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write']);
const STATUSES = new Set<OAuthStageStatus['status']>(['authorization_pending', 'exchange_claimed', 'verified', 'denied', 'inspect_required', 'expired', 'consumed']);
const ATTEMPT_STATUSES = new Set<OAuthAttemptMetadata['status']>([...STATUSES, 'superseded', 'building', 'restart_required']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function isSafeInteger(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function isText(value: unknown, max = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function isOpaqueId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).byteLength <= 1024;
}
function provider(value: unknown): value is OAuthProvider { return value === 'google' || value === 'microsoft'; }
function parseConsumption(value: unknown): OAuthStageStatus['consumption'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !exactKeys(value, ['commandId', 'accountId', 'accountGeneration']) ||
      typeof value.commandId !== 'string' || !UUID_V4.test(value.commandId) || !isOpaqueId(value.accountId) || !isSafeInteger(value.accountGeneration, 1)) {
    throw malformed();
  }
  return Object.freeze({ commandId: value.commandId, accountId: value.accountId, accountGeneration: value.accountGeneration });
}
function parseStage(value: unknown): OAuthStageStatus {
  if (!isRecord(value) || !exactKeys(value, ['attemptId', 'registrationId', 'provider', 'status', 'payloadGeneration', 'createdAt', 'expiresAt'], ['consumption']) ||
      typeof value.attemptId !== 'string' || !UUID_V4.test(value.attemptId) || !isText(value.registrationId, 128) || !provider(value.provider) ||
      typeof value.status !== 'string' || !STATUSES.has(value.status as OAuthStageStatus['status']) || !isSafeInteger(value.payloadGeneration) ||
      !isSafeInteger(value.createdAt) || !isSafeInteger(value.expiresAt)) throw malformed();
  return Object.freeze({ attemptId: value.attemptId, registrationId: value.registrationId, provider: value.provider,
    status: value.status as OAuthStageStatus['status'], payloadGeneration: value.payloadGeneration, createdAt: value.createdAt,
    expiresAt: value.expiresAt, ...(value.consumption === undefined ? {} : { consumption: parseConsumption(value.consumption)! }) });
}
function parseAttempt(value: unknown): OAuthAttemptMetadata {
  if (!isRecord(value) || !exactKeys(value, ['startAttemptId', 'provider', 'status', 'stageId', 'createdAt', 'expiresAt'], ['consumption']) ||
      typeof value.startAttemptId !== 'string' || !UUID_V4.test(value.startAttemptId) || !provider(value.provider) ||
      typeof value.status !== 'string' || !ATTEMPT_STATUSES.has(value.status as OAuthAttemptMetadata['status']) ||
      typeof value.stageId !== 'string' || !UUID.test(value.stageId) || !isSafeInteger(value.createdAt) || !isSafeInteger(value.expiresAt)) throw malformed();
  const consumption = parseConsumption(value.consumption);
  return Object.freeze({ startAttemptId: value.startAttemptId, provider: value.provider, status: value.status as OAuthAttemptMetadata['status'],
    stageId: value.stageId, createdAt: value.createdAt, expiresAt: value.expiresAt, ...(consumption ? { consumption } : {}) });
}
function parseAuthorizationUrl(value: unknown, expectedProvider: OAuthProvider): string {
  if (!isText(value, 4096)) throw malformed();
  let url: URL;
  try { url = new URL(value); } catch { throw malformed(); }
  const valid = url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
    (expectedProvider === 'google' ? url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth' :
      url.origin === 'https://login.microsoftonline.com' && url.pathname === '/common/oauth2/v2.0/authorize');
  if (!valid) throw malformed();
  return url.toString();
}
function parseAvailability(value: unknown): OAuthAvailability {
  if (!isRecord(value) || !exactKeys(value, ['google', 'microsoft']) || typeof value.google !== 'boolean' || typeof value.microsoft !== 'boolean') throw malformed();
  return Object.freeze({ google: value.google, microsoft: value.microsoft });
}
function parseCapabilityList(value: unknown): readonly OAuthCapability[] {
  if (!Array.isArray(value) || value.length > CAPABILITIES.size || value.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item as OAuthCapability)) || new Set(value).size !== value.length ||
      value.includes('calendar.write') && !value.includes('calendar.read')) throw malformed();
  return Object.freeze([...value] as OAuthCapability[]);
}
function parseStageInspection(value: unknown): OAuthStageInspection {
  if (!isRecord(value) || !exactKeys(value, ['stage'], ['verifiedAccount'])) throw malformed();
  const stage = parseStage(value.stage);
  if (value.verifiedAccount === undefined) {
    if (stage.status === 'verified') throw malformed();
    return Object.freeze({ stage });
  }
  const account = value.verifiedAccount;
  if (!isRecord(account) || !exactKeys(account, ['displayName', 'requestedCapabilities', 'capabilities'], ['email', 'reconnectAccountId']) ||
      !isText(account.displayName, 512) || account.email !== undefined && !isText(account.email, 512) ||
      account.reconnectAccountId !== undefined && !isOpaqueId(account.reconnectAccountId)) throw malformed();
  const requestedCapabilities = parseCapabilityList(account.requestedCapabilities);
  const capabilities = parseCapabilityList(account.capabilities);
  if (stage.status !== 'verified' || capabilities.some((item) => !requestedCapabilities.includes(item))) throw malformed();
  return Object.freeze({ stage, verifiedAccount: Object.freeze({ displayName: account.displayName,
    ...(account.email !== undefined ? { email: account.email } : {}), requestedCapabilities, capabilities,
    ...(account.reconnectAccountId !== undefined ? { reconnectAccountId: account.reconnectAccountId } : {}) }) });
}
function parseStart(value: unknown, expectedProvider: OAuthProvider): OAuthStartResponse {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'status'], ['authorizationUrl']) || (value.kind !== 'started' && value.kind !== 'existing')) throw malformed();
  const status = parseStage(value.status);
  if (status.provider !== expectedProvider) throw malformed();
  const authorizationUrl = value.authorizationUrl === undefined ? undefined : parseAuthorizationUrl(value.authorizationUrl, expectedProvider);
  if (value.kind === 'started' && !authorizationUrl || value.kind === 'existing' && authorizationUrl) throw malformed();
  return Object.freeze({ kind: value.kind, status, ...(authorizationUrl ? { authorizationUrl } : {}) });
}
function malformed(): OAuthClientError { return new OAuthClientError('malformed', 'The connection response could not be confirmed. Inspect its status before continuing.'); }
function messageFor(status: number): string {
  if (status === 401 || status === 403) return 'Your workspace session needs to be checked before continuing.';
  if (status === 404) return 'That connection request is no longer available.';
  if (status === 409) return 'The workspace changed. Refresh it before starting another connection.';
  if (status === 429) return 'The connection service is temporarily limited. Try again later.';
  if (status >= 500 || status === 408 || status === 425) return 'The connection service is busy. Inspect the original request before continuing.';
  return 'The connection request could not be completed.';
}
function browserFetch(): FetchLike { return globalThis.fetch.bind(globalThis) as FetchLike; }
export function createCloudOAuthClient(session: AuthenticatedSession, options: OAuthClientOptions = {}): OAuthClient {
  const fetcher = options.fetcher ?? browserFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let active = true;
  const controllers = new Set<AbortController>();
  const request = async (path: string, method: 'GET' | 'POST', body?: OAuthStartInput, signal?: AbortSignal): Promise<unknown> => {
    if (!active) throw new OAuthClientError('disposed', 'This connection session is no longer active.');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetcher(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken }, body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        if (method === 'POST' && response.status === 409 && /^\/api\/oauth\/(google|microsoft)\/start$/.test(path)) {
          const length = Number(response.headers.get('content-length'));
          if (!Number.isFinite(length) || length <= MAX_RESPONSE_BYTES) {
            const body = await response.text();
            if (new TextEncoder().encode(body).byteLength <= MAX_RESPONSE_BYTES) {
              try {
                const parsed: unknown = JSON.parse(body);
                if (isRecord(parsed) && exactKeys(parsed, ['error']) && parsed.error === 'oauth_start_not_admitted') {
                  throw new OAuthClientError('not_admitted', 'The request was not started because the workspace changed. Refresh it before trying again.', response.status);
                }
              } catch (error) {
                if (error instanceof OAuthClientError) throw error;
              }
            }
          }
        }
        throw new OAuthClientError('http', messageFor(response.status), response.status);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw malformed();
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw malformed();
      try { return JSON.parse(raw) as unknown; } catch { throw malformed(); }
    } catch (error) {
      if (error instanceof OAuthClientError) throw error;
      if (timedOut) throw new OAuthClientError('timeout', 'The connection request timed out. Inspect the original request before continuing.');
      if (!active) throw new OAuthClientError('disposed', 'This connection session is no longer active.');
      if (controller.signal.aborted && signal?.aborted) throw new OAuthClientError('stale', 'The connection session changed.');
      throw new OAuthClientError('network', 'The connection service could not be reached. Inspect the original request before continuing.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller);
    }
  };
  return Object.freeze({
    async availability(signal) { return parseAvailability(await request('/api/oauth/availability', 'GET', undefined, signal)); },
    async listStarts(signal) {
      const value = await request('/api/oauth/starts', 'GET', undefined, signal);
      if (!Array.isArray(value) || value.length > 256) throw malformed();
      return Object.freeze(value.map(parseAttempt));
    },
    async inspectStart(providerName, attemptId, signal) {
      if (!UUID_V4.test(attemptId)) throw malformed();
      const value = parseAttempt(await request(`/api/oauth/${providerName}/starts/${attemptId}`, 'GET', undefined, signal));
      if (value.provider !== providerName || value.startAttemptId !== attemptId) throw malformed();
      return value;
    },
    async inspectStage(stageId, signal) {
      if (!UUID.test(stageId)) throw malformed();
      const inspection = parseStageInspection(await request(`/api/oauth/stages/${stageId}`, 'GET', undefined, signal));
      if (inspection.stage.attemptId !== stageId) throw malformed();
      return inspection;
    },
    async start(providerName, input, signal) {
      const id = input.startAttemptId;
      if (!UUID_V4.test(id) || input.requestedCapabilities.length > CAPABILITIES.size || input.requestedCapabilities.some((cap) => !CAPABILITIES.has(cap)) ||
          new Set(input.requestedCapabilities).size !== input.requestedCapabilities.length || input.requestedCapabilities.includes('calendar.write') && !input.requestedCapabilities.includes('calendar.read') ||
          !isSafeInteger(input.expectedRevision) || !isSafeInteger(input.expectedPrivacyEpoch) || input.reconnectAccountId !== undefined && !isOpaqueId(input.reconnectAccountId) ||
          input.restartOfStartAttemptId !== undefined && !UUID_V4.test(input.restartOfStartAttemptId)) {
        throw new OAuthClientError('not_started', 'The connection request details are invalid. No request was sent.');
      }
      const result = parseStart(await request(`/api/oauth/${providerName}/start`, 'POST', { ...input, startAttemptId: id }, signal), providerName);
      return result;
    },
    dispose() { active = false; for (const controller of controllers) controller.abort(); controllers.clear(); },
  });
}
