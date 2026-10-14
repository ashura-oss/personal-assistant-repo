/** Same-origin password authentication for the Still web application. */

export type AuthenticatedSession = Readonly<{
  authenticated: true;
  workspaceId: string;
  privacyEpoch: number;
  csrfToken: string;
}>;

export type GuestSession = Readonly<{
  authenticated: false;
  csrfToken: string;
}>;

export type AuthSession = AuthenticatedSession | GuestSession;

export type AuthErrorKind = 'http' | 'network' | 'malformed';
export const AUTH_REQUEST_TIMEOUT_MS = 30_000;

export class AuthClientError extends Error {
  readonly kind: AuthErrorKind;
  readonly status?: number;
  readonly requiresSessionCheck: boolean;

  constructor(kind: AuthErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AuthClientError';
    this.kind = kind;
    this.status = status;
    this.requiresSessionCheck = kind !== 'http' || status === 408 || status === 425 || (status !== undefined && status >= 500);
  }
}

type FetchResponse = Pick<Response, 'ok' | 'status' | 'json'>;
type FetchLike = (input: string, init: RequestInit) => Promise<FetchResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): AuthSession {
  if (!isRecord(value) || typeof value.csrfToken !== 'string' || value.csrfToken.length === 0) {
    throw new AuthClientError('malformed', 'The sign-in response could not be confirmed. Check session.');
  }
  if (value.authenticated === false) return { authenticated: false, csrfToken: value.csrfToken };
  if (
    value.authenticated === true &&
    typeof value.workspaceId === 'string' && value.workspaceId.length > 0 &&
    typeof value.privacyEpoch === 'number' && Number.isSafeInteger(value.privacyEpoch) && value.privacyEpoch >= 0
  ) {
    return {
      authenticated: true,
      workspaceId: value.workspaceId,
      privacyEpoch: value.privacyEpoch,
      csrfToken: value.csrfToken,
    };
  }
  throw new AuthClientError('malformed', 'The sign-in response could not be confirmed. Check session.');
}

function statusMessage(status: number): string {
  if (status === 401) return 'That password was not accepted. Check session before trying again.';
  if (status === 403) return 'Sign-in is unavailable for this session. Check session before trying again.';
  if (status === 429) return 'Too many sign-in attempts. Wait a moment, then check session before trying again.';
  if (status === 408 || status === 425 || status >= 500) return 'Sign-in is busy. Check session before trying again.';
  return 'Sign-in could not be completed. Check session before trying again.';
}

async function requestSession(
  path: '/auth/session' | '/auth/login' | '/auth/logout',
  init: RequestInit,
  fetcher: FetchLike,
): Promise<AuthSession> {
  const internalController = new AbortController();
  const externalSignal = init.signal;
  const abortFromCaller = () => internalController.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    internalController.abort();
  }, AUTH_REQUEST_TIMEOUT_MS);
  if (externalSignal?.aborted) internalController.abort();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetcher(path, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      signal: internalController.signal,
    });
    if (!response.ok) throw new AuthClientError('http', statusMessage(response.status), response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AuthClientError('malformed', 'The sign-in response could not be confirmed. Check session.');
    }
    return parseSession(body);
  } catch (error) {
    if (timedOut) throw new AuthClientError('network', 'The request timed out. Check session.');
    if (internalController.signal.aborted && externalSignal?.aborted) {
      throw new AuthClientError('network', 'The connection was interrupted. Check session.');
    }
    // Preserve safe typed errors from HTTP and response validation paths.
    if (error instanceof AuthClientError) throw error;
    throw new AuthClientError('network', 'The connection was interrupted. Check session.');
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function browserFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    return async () => { throw new Error('Fetch is unavailable'); };
  }
  return globalThis.fetch.bind(globalThis) as FetchLike;
}

/** Reads current cookie state. The endpoint also issues the guest pre-auth cookie. */
export function getAuthSession(signal?: AbortSignal): Promise<AuthSession> {
  return requestSession('/auth/session', { method: 'GET', cache: 'no-store', signal }, browserFetch());
}

/** Submits a password only in a same-origin JSON body. */
export function loginWithPassword(password: string, csrfToken: string, signal?: AbortSignal): Promise<AuthSession> {
  return requestSession('/auth/login', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': csrfToken },
    body: JSON.stringify({ password }),
    signal,
  }, browserFetch());
}

/** Ends the session and returns the guest DTO with a fresh pre-auth cookie. */
export function logoutSession(csrfToken: string, signal?: AbortSignal): Promise<AuthSession> {
  return requestSession('/auth/logout', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': csrfToken },
    body: JSON.stringify({}),
    signal,
  }, browserFetch());
}
