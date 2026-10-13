import { credentialStore, type CredentialStore } from '../storage/credentials';

const SPEECH_KEY = 'azure.speech.subscription-key';
const OPENAI_KEY = 'azure.openai.api-key';
const OPENROUTER_KEY = 'openrouter.api-key';

export type ProviderCredentialKind = 'speech' | 'openai' | 'openrouter';
const KEY_BY_KIND: Record<ProviderCredentialKind, string> = {
  speech: SPEECH_KEY,
  openai: OPENAI_KEY,
  openrouter: OPENROUTER_KEY,
};

export class SpeechCredentialChangedError extends Error {
  readonly name = 'SpeechCredentialChangedError';
  constructor() { super('The Azure Speech credential changed while the request was being prepared.'); }
}

class ProviderCredentialOperationError extends Error {
  readonly name = 'ProviderCredentialOperationError';
  constructor() { super('Provider credentials could not be read or updated.'); }
}

async function settleCredentialOperations<T>(operations: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  if (results.some((result) => result.status === 'rejected')) throw new ProviderCredentialOperationError();
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export interface ProviderCredentialStatus {
  speechConfigured: boolean;
  openAiConfigured: boolean;
  openRouterConfigured?: boolean;
}

export interface ProviderCredentialInput {
  speechSubscriptionKey?: string;
  openAiApiKey?: string;
  openRouterApiKey?: string;
}

export interface ProviderCredentialSnapshot {
  readonly key: string | null;
  readonly generation: number;
}

export interface SpeechCredentialSnapshot {
  readonly key: string | null;
  readonly generation: number;
}

export interface ProviderCredentialService {
  currentSpeechCredentialGeneration(): number;
  assertSpeechCredentialGeneration(expected: number): void;
  readSpeechCredentialSnapshot(): Promise<SpeechCredentialSnapshot>;
  currentProviderCredentialGeneration(kind: ProviderCredentialKind): number;
  assertProviderCredentialGeneration(kind: ProviderCredentialKind, expected: number): void;
  readProviderCredentialSnapshot(kind: ProviderCredentialKind): Promise<ProviderCredentialSnapshot>;
  getCredentials(): Promise<ProviderCredentialStatus>;
  readProviderCredential(kind: ProviderCredentialKind): Promise<string | null>;
  setCredentials(input: ProviderCredentialInput): Promise<ProviderCredentialStatus>;
  deleteCredentials(kind?: ProviderCredentialKind): Promise<ProviderCredentialStatus>;
}

/** Creates an isolated credential service; callers should pass an epoch-bound store in production. */
export function createProviderCredentialService(store: CredentialStore): ProviderCredentialService {
  const generations: Record<ProviderCredentialKind, number> = { speech: 0, openai: 0, openrouter: 0 };
  const mutationQueues: Record<ProviderCredentialKind, Promise<void>> = { speech: Promise.resolve(), openai: Promise.resolve(), openrouter: Promise.resolve() };
  const enqueueMutation = (kind: ProviderCredentialKind, operation: () => Promise<void>): Promise<void> => {
    const queued = mutationQueues[kind].then(operation, operation);
    mutationQueues[kind] = queued.catch(() => undefined);
    return queued;
  };
  const assertGeneration = (kind: ProviderCredentialKind, expected: number) => {
    if (!Number.isSafeInteger(expected) || expected !== generations[kind]) throw new SpeechCredentialChangedError();
  };
  const readSnapshot = async (kind: ProviderCredentialKind): Promise<ProviderCredentialSnapshot> => {
    const generation = generations[kind];
    await mutationQueues[kind];
    const key = await store.get(KEY_BY_KIND[kind]);
    assertGeneration(kind, generation);
    return Object.freeze({ key, generation });
  };
  const readSpeech = async (): Promise<SpeechCredentialSnapshot> => readSnapshot('speech');
  const status = async (): Promise<ProviderCredentialStatus> => {
    const [speech, openAi, openRouter] = await settleCredentialOperations([readSpeech(), readSnapshot('openai'), readSnapshot('openrouter')]);
    return { speechConfigured: Boolean(speech.key), openAiConfigured: Boolean(openAi.key), openRouterConfigured: Boolean(openRouter.key) };
  };
  return Object.freeze({
    currentSpeechCredentialGeneration: () => generations.speech,
    assertSpeechCredentialGeneration: (expected: number) => assertGeneration('speech', expected),
    readSpeechCredentialSnapshot: readSpeech,
    currentProviderCredentialGeneration: (kind: ProviderCredentialKind) => generations[kind],
    assertProviderCredentialGeneration: assertGeneration,
    readProviderCredentialSnapshot: readSnapshot,
    getCredentials: status,
    async readProviderCredential(kind: ProviderCredentialKind) {
      return (await readSnapshot(kind)).key;
    },
    async setCredentials(input: ProviderCredentialInput) {
      if (input.speechSubscriptionKey !== undefined && input.speechSubscriptionKey.trim().length > 512) throw new Error('Speech key is too long.');
      if (input.openAiApiKey !== undefined && input.openAiApiKey.trim().length > 512) throw new Error('OpenAI key is too long.');
      if (input.openRouterApiKey !== undefined && input.openRouterApiKey.trim().length > 512) throw new Error('OpenRouter key is too long.');
      const operations: Promise<void>[] = [];
      const values: Partial<Record<ProviderCredentialKind, string>> = {
        ...(input.speechSubscriptionKey !== undefined ? { speech: input.speechSubscriptionKey.trim() } : {}),
        ...(input.openAiApiKey !== undefined ? { openai: input.openAiApiKey.trim() } : {}),
        ...(input.openRouterApiKey !== undefined ? { openrouter: input.openRouterApiKey.trim() } : {}),
      };
      for (const kind of Object.keys(values) as ProviderCredentialKind[]) {
        generations[kind] += 1;
        const value = values[kind]!;
        operations.push(enqueueMutation(kind, () => value ? store.set(KEY_BY_KIND[kind], value) : store.delete(KEY_BY_KIND[kind])));
      }
      await settleCredentialOperations(operations);
      return status();
    },
    async deleteCredentials(kind?: ProviderCredentialKind) {
      const operations: Promise<void>[] = [];
      for (const current of (kind ? [kind] : ['speech', 'openai', 'openrouter'] as const)) {
        generations[current] += 1;
        operations.push(enqueueMutation(current, () => store.delete(KEY_BY_KIND[current])));
      }
      await settleCredentialOperations(operations);
      return status();
    },
  });
}

// Module-level helpers are retained for tests and the privileged erasure adapter only.
const rawCredentialService = createProviderCredentialService(credentialStore);
export const currentSpeechCredentialGeneration = rawCredentialService.currentSpeechCredentialGeneration;
export const assertSpeechCredentialGeneration = rawCredentialService.assertSpeechCredentialGeneration;
export const readSpeechCredentialSnapshot = rawCredentialService.readSpeechCredentialSnapshot;
export const getCredentials = rawCredentialService.getCredentials;
export const readProviderCredential = rawCredentialService.readProviderCredential;
export const setCredentials = rawCredentialService.setCredentials;
export const deleteCredentials = rawCredentialService.deleteCredentials;
