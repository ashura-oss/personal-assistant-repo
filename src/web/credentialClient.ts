import type {
  ProviderCredentialInput,
  ProviderCredentialKind,
  ProviderCredentialService,
  ProviderCredentialSnapshot,
  ProviderCredentialStatus,
  SpeechCredentialSnapshot,
} from '../services/credentials';
import type { AuthenticatedSession } from './authClient';

export type WebCredentialKind = 'speech' | 'openrouter';

export type WebCredentialMetadata = Readonly<{
  workspaceId: string;
  privacyEpoch: number;
  credentials: Readonly<{
    speech: Readonly<{ configured: boolean; generation: number }>;
    openrouter: Readonly<{ configured: boolean; generation: number }>;
  }>;
}>;

export type CredentialCommandStatus = Readonly<{
  status: 'finished' | 'inspect_required' | 'claimed';
  metadata?: WebCredentialMetadata;
}>;

export type CredentialCommandUnknownReason = 'network' | 'timeout' | 'invalid_acknowledgement' | 'server_error';

export class WebCredentialError extends Error {
  readonly kind: 'http' | 'network' | 'timeout' | 'malformed' | 'busy' | 'disposed' | 'unsupported' | 'generation';
  readonly status?: number;

  constructor(
    kind: WebCredentialError['kind'],
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'WebCredentialError';
    this.kind = kind;
    this.status = status;
  }
}

export class CredentialCommandUnknownError extends Error {
  readonly name = 'CredentialCommandUnknownError';
  constructor(readonly commandId: string, readonly reason: CredentialCommandUnknownReason) {
    super('Credential update outcome is unknown. Check its receipt before trying again.');
  }
}

export const CREDENTIAL_REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = (input: string, init: RequestInit) => Promise<SafeResponse>;
type GenerationCache = Record<WebCredentialKind, number>;
type SafeResponse = Pick<Response, 'ok' | 'status' | 'json'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new WebCredentialError('malformed', 'Credential command body is invalid.');
  return encoded;
}

function fixedHttpMessage(status: number): string {
  if (status === 401 || status === 403) return 'Your session could not update credentials. Check session and try again.';
  if (status === 409) return 'Credential settings changed. Refresh them before trying again.';
  if (status === 429) return 'Credential updates are temporarily limited. Try again later.';
  if (status >= 500) return 'The credential service is busy. Try again later.';
  return 'The credential request could not be completed.';
}

function makeCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') throw new WebCredentialError('network', 'A secure command identifier is unavailable.');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseMetadata(value: unknown, workspaceId: string, privacyEpoch: number, previous?: GenerationCache): WebCredentialMetadata {
  if (!isRecord(value) || value.workspaceId !== workspaceId || value.privacyEpoch !== privacyEpoch || !isRecord(value.credentials)) {
    throw new WebCredentialError('malformed', 'Credential metadata could not be confirmed.');
  }
  const speech = value.credentials.speech;
  const openrouter = value.credentials.openrouter;
  if (
    !isRecord(speech) || typeof speech.configured !== 'boolean' || !isGeneration(speech.generation) ||
    !isRecord(openrouter) || typeof openrouter.configured !== 'boolean' || !isGeneration(openrouter.generation)
  ) {
    throw new WebCredentialError('malformed', 'Credential metadata could not be confirmed.');
  }
  if (
    previous &&
    (speech.generation < previous.speech || openrouter.generation < previous.openrouter)
  ) {
    throw new WebCredentialError('generation', 'Credential metadata is older than the current view. Refresh credentials.');
  }
  return Object.freeze({
    workspaceId,
    privacyEpoch,
    credentials: Object.freeze({
      speech: Object.freeze({ configured: speech.configured, generation: speech.generation }),
      openrouter: Object.freeze({ configured: openrouter.configured, generation: openrouter.generation }),
    }),
  });
}

function parseCommandStatus(value: unknown, workspaceId: string, privacyEpoch: number, generations?: GenerationCache): CredentialCommandStatus {
  if (!isRecord(value) || !['finished', 'inspect_required', 'claimed'].includes(String(value.status))) {
    throw new WebCredentialError('malformed', 'Credential command status could not be confirmed.');
  }
  if (value.metadata === undefined) return { status: value.status as CredentialCommandStatus['status'] };
  return {
    status: value.status as CredentialCommandStatus['status'],
    metadata: parseMetadata(value.metadata, workspaceId, privacyEpoch, generations),
  };
}

function toStatus(metadata: WebCredentialMetadata): ProviderCredentialStatus {
  return {
    speechConfigured: metadata.credentials.speech.configured,
    openAiConfigured: false,
    openRouterConfigured: metadata.credentials.openrouter.configured,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Browser credential facade. It holds presence and generation metadata only;
 * server-owned provider keys are never read back into the browser.
 */
export function createWebProviderCredentialService(
  session: AuthenticatedSession,
  currentCsrfToken: () => string,
): ProviderCredentialService & {
  checkCredentialCommand(commandId: string): Promise<CredentialCommandStatus>;
  dispose(): void;
} {
  if (!session.authenticated || !session.workspaceId || !isGeneration(session.privacyEpoch)) {
    throw new WebCredentialError('malformed', 'An authenticated workspace session is required.');
  }
  const workspaceId = session.workspaceId;
  const privacyEpoch = session.privacyEpoch;
  const generations: GenerationCache = { speech: 0, openrouter: 0 };
  let metadata: WebCredentialMetadata | null = null;
  let metadataRevision = 0;
  let unresolvedCommandId: string | null = null;
  let mutationOwner: symbol | null = null;
  let disposed = false;
  const controllers = new Set<AbortController>();
  const fetcher = (() => {
    if (typeof globalThis.fetch !== 'function') return async () => { throw new Error('Fetch is unavailable'); };
    return globalThis.fetch.bind(globalThis) as FetchLike;
  })();

  const assertUsable = () => {
    if (disposed) throw new WebCredentialError('disposed', 'Credential service is no longer available.');
  };

  const requestJson = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    assertUsable();
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      rejectAbort(disposed
        ? new WebCredentialError('disposed', 'Credential service is no longer available.')
        : new WebCredentialError('timeout', 'The credential request timed out.'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CREDENTIAL_REQUEST_TIMEOUT_MS);
    const operation = (async () => {
      const response = await fetcher(path, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new WebCredentialError('http', fixedHttpMessage(response.status), response.status);
      try {
        return await response.json();
      } catch {
        throw new WebCredentialError('malformed', 'Credential response could not be confirmed.');
      }
    })();
    // Keep a rejection handler attached if timeout/disposal wins the race and the transport settles later.
    void operation.catch(() => undefined);
    try {
      const body = await Promise.race([operation, aborted]);
      assertUsable();
      return body;
    } catch (error) {
      if (disposed) throw new WebCredentialError('disposed', 'Credential service is no longer available.');
      if (error instanceof WebCredentialError) throw error;
      if (timedOut) throw new WebCredentialError('timeout', 'The credential request timed out.');
      throw new WebCredentialError('network', 'The credential service could not be reached.');
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  };

  const syncMetadata = (value: unknown): WebCredentialMetadata => {
    assertUsable();
    const next = parseMetadata(value, workspaceId, privacyEpoch, metadata ? generations : undefined);
    generations.speech = next.credentials.speech.generation;
    generations.openrouter = next.credentials.openrouter.generation;
    metadata = next;
    metadataRevision += 1;
    return next;
  };

  const readMetadata = async (): Promise<WebCredentialMetadata> => {
    return syncMetadata(await requestJson('/api/credentials', { method: 'GET' }));
  };

  const csrfHeader = (): string => {
    let csrfToken: string;
    try {
      csrfToken = currentCsrfToken();
    } catch {
      throw new WebCredentialError('malformed', 'A current session token is required.');
    }
    if (typeof csrfToken !== 'string' || csrfToken.length === 0) {
      throw new WebCredentialError('malformed', 'A current session token is required.');
    }
    return csrfToken;
  };

  const admitMutation = (): symbol => {
    assertUsable();
    if (unresolvedCommandId) throw new WebCredentialError('busy', 'Check the pending credential command before making another change.');
    if (mutationOwner) throw new WebCredentialError('busy', 'A credential update is already in progress.');
    const owner = Symbol('credential-mutation');
    mutationOwner = owner;
    return owner;
  };

  const releaseMutation = (owner: symbol) => {
    if (mutationOwner === owner) mutationOwner = null;
  };

  const expectedGenerations = (kinds: readonly WebCredentialKind[]): Partial<GenerationCache> => {
    if (!metadata) throw new WebCredentialError('malformed', 'Credential metadata is required before updating.');
    const result: Partial<GenerationCache> = {};
    for (const kind of kinds) result[kind] = generations[kind];
    return result;
  };

  const putMutation = async (commandId: string, body: Record<string, unknown>): Promise<ProviderCredentialStatus> => {
    let bodyText = canonicalJson(body);
    try {
      const csrfToken = csrfHeader();
      let ack: unknown;
      try {
        ack = await requestJson('/api/credentials', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': csrfToken, 'X-Still-Command': commandId },
          body: bodyText,
        });
      } catch (error) {
        if (error instanceof WebCredentialError && error.kind === 'http' && (error.status ?? 0) < 500) throw error;
        const reason: CredentialCommandUnknownReason = error instanceof WebCredentialError && error.kind === 'timeout'
          ? 'timeout'
          : error instanceof WebCredentialError && error.kind === 'http'
            ? 'server_error'
            : error instanceof WebCredentialError && error.kind === 'malformed'
              ? 'invalid_acknowledgement'
            : 'network';
        unresolvedCommandId = commandId;
        throw new CredentialCommandUnknownError(commandId, reason);
      }
      try {
        return toStatus(syncMetadata(ack));
      } catch {
        unresolvedCommandId = commandId;
        throw new CredentialCommandUnknownError(commandId, 'invalid_acknowledgement');
      }
    } finally {
      bodyText = '';
    }
  };

  const deleteMutation = async (commandId: string, body: Record<string, unknown>): Promise<ProviderCredentialStatus> => {
    let bodyText = canonicalJson(body);
    try {
      const csrfToken = csrfHeader();
      let ack: unknown;
      try {
        ack = await requestJson('/api/credentials', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': csrfToken, 'X-Still-Command': commandId },
          body: bodyText,
        });
      } catch (error) {
        if (error instanceof WebCredentialError && error.kind === 'http' && (error.status ?? 0) < 500) throw error;
        const reason: CredentialCommandUnknownReason = error instanceof WebCredentialError && error.kind === 'timeout'
          ? 'timeout'
          : error instanceof WebCredentialError && error.kind === 'http'
            ? 'server_error'
            : error instanceof WebCredentialError && error.kind === 'malformed'
              ? 'invalid_acknowledgement'
            : 'network';
        unresolvedCommandId = commandId;
        throw new CredentialCommandUnknownError(commandId, reason);
      }
      try {
        return toStatus(syncMetadata(ack));
      } catch {
        unresolvedCommandId = commandId;
        throw new CredentialCommandUnknownError(commandId, 'invalid_acknowledgement');
      }
    } finally {
      bodyText = '';
    }
  };

  const rawReadError = () => new WebCredentialError('unsupported', 'Credentials are server-owned and cannot be read by the browser.');

  const assertGeneration = (kind: ProviderCredentialKind, expected: number) => {
    assertUsable();
    if (kind === 'openai') {
      if (expected === 0) return;
      throw new WebCredentialError('generation', 'Credential generation changed.');
    }
    if (!metadata || !isGeneration(expected) || expected !== generations[kind]) {
      throw new WebCredentialError('generation', 'Credential generation changed.');
    }
  };

  const currentGeneration = (kind: ProviderCredentialKind): number => {
    assertUsable();
    return kind === 'openai' ? 0 : generations[kind];
  };

  const service: ProviderCredentialService & {
    checkCredentialCommand(commandId: string): Promise<CredentialCommandStatus>;
    dispose(): void;
  } = {
    currentSpeechCredentialGeneration: () => {
      assertUsable();
      return generations.speech;
    },
    assertSpeechCredentialGeneration: (expected) => assertGeneration('speech', expected),
    readSpeechCredentialSnapshot: async (): Promise<SpeechCredentialSnapshot> => { throw rawReadError(); },
    currentProviderCredentialGeneration: currentGeneration,
    assertProviderCredentialGeneration: assertGeneration,
    readProviderCredentialSnapshot: async (_kind: ProviderCredentialKind): Promise<ProviderCredentialSnapshot> => { throw rawReadError(); },
    readProviderCredential: async (_kind: ProviderCredentialKind): Promise<string | null> => { throw rawReadError(); },
    async getCredentials() {
      return toStatus(await readMetadata());
    },
    async setCredentials(input: ProviderCredentialInput) {
      if (input.openAiApiKey !== undefined) {
        throw new WebCredentialError('unsupported', 'OpenAI credentials are unavailable in web batch mode.');
      }
      const kinds: WebCredentialKind[] = [];
      const keys: Partial<Record<WebCredentialKind, string>> = {};
      let speechKey: string | undefined;
      let openrouterKey: string | undefined;
      if (input.speechSubscriptionKey !== undefined) {
        speechKey = input.speechSubscriptionKey.trim();
        if (speechKey.length === 0 || speechKey.length > 512) throw new WebCredentialError('malformed', 'Speech credential is empty or too long.');
        keys.speech = speechKey;
        kinds.push('speech');
      }
      if (input.openRouterApiKey !== undefined) {
        openrouterKey = input.openRouterApiKey.trim();
        if (openrouterKey.length === 0 || openrouterKey.length > 512) throw new WebCredentialError('malformed', 'OpenRouter credential is empty or too long.');
        keys.openrouter = openrouterKey;
        kinds.push('openrouter');
      }
      if (kinds.length === 0) throw new WebCredentialError('malformed', 'No supported credential was provided.');
      const owner = admitMutation();
      try {
        if (!metadata) await readMetadata();
        assertUsable();
        const commandId = makeCommandId();
        const expected = expectedGenerations(kinds);
        const body = { expectedPrivacyEpoch: privacyEpoch, expectedGenerations: expected, keys };
        return await putMutation(commandId, body);
      } finally {
        speechKey = undefined;
        openrouterKey = undefined;
        keys.speech = undefined;
        keys.openrouter = undefined;
        releaseMutation(owner);
      }
    },
    async deleteCredentials(kind?: ProviderCredentialKind) {
      if (kind === 'openai') throw new WebCredentialError('unsupported', 'OpenAI credentials are unavailable in web batch mode.');
      const kinds: WebCredentialKind[] = kind ? [kind] : ['openrouter', 'speech'];
      const owner = admitMutation();
      try {
        if (!metadata) await readMetadata();
        assertUsable();
        const commandId = makeCommandId();
        const body = { expectedPrivacyEpoch: privacyEpoch, expectedGenerations: expectedGenerations(kinds), kinds };
        return await deleteMutation(commandId, body);
      } finally {
        releaseMutation(owner);
      }
    },
    async checkCredentialCommand(commandId: string) {
      assertUsable();
      if (!isUuid(commandId)) throw new WebCredentialError('malformed', 'Credential command identifier is invalid.');
      if (unresolvedCommandId && commandId !== unresolvedCommandId) {
        throw new WebCredentialError('busy', 'Check the pending credential command before another receipt.');
      }
      const capturedRevision = metadataRevision;
      const value = await requestJson(`/api/credential-commands/${commandId}`, { method: 'GET' });
      assertUsable();
      if (metadataRevision !== capturedRevision) {
        throw new WebCredentialError('generation', 'Credential metadata changed during the receipt check. Check again.');
      }
      const status = parseCommandStatus(value, workspaceId, privacyEpoch);
      if (unresolvedCommandId === commandId && status.status === 'finished') {
        // A terminal receipt can include old metadata; only a fresh metadata GET
        // from this explicit user action may release the mutation hold.
        const fresh = await readMetadata();
        assertUsable();
        if (unresolvedCommandId === commandId) unresolvedCommandId = null;
        return { status: status.status, metadata: fresh };
      }
      return status;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      mutationOwner = null;
      metadata = null;
    },
  };
  return service;
}
