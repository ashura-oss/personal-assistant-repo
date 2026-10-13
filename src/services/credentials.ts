import { credentialStore, type CredentialStore } from '../storage/credentials';

const SPEECH_KEY = 'azure.speech.subscription-key';
const OPENAI_KEY = 'azure.openai.api-key';

export class SpeechCredentialChangedError extends Error {
  readonly name = 'SpeechCredentialChangedError';
  constructor() { super('The Azure Speech credential changed while the request was being prepared.'); }
}

export interface ProviderCredentialStatus {
  speechConfigured: boolean;
  openAiConfigured: boolean;
}

export interface ProviderCredentialInput {
  speechSubscriptionKey?: string;
  openAiApiKey?: string;
}

export interface SpeechCredentialSnapshot {
  readonly key: string | null;
  readonly generation: number;
}

export interface ProviderCredentialService {
  currentSpeechCredentialGeneration(): number;
  assertSpeechCredentialGeneration(expected: number): void;
  readSpeechCredentialSnapshot(): Promise<SpeechCredentialSnapshot>;
  getCredentials(): Promise<ProviderCredentialStatus>;
  readProviderCredential(kind: 'speech' | 'openai'): Promise<string | null>;
  setCredentials(input: ProviderCredentialInput): Promise<ProviderCredentialStatus>;
  deleteCredentials(kind?: 'speech' | 'openai'): Promise<ProviderCredentialStatus>;
}

/** Creates an isolated credential service; callers should pass an epoch-bound store in production. */
export function createProviderCredentialService(store: CredentialStore): ProviderCredentialService {
  let speechGeneration = 0;
  let speechMutationQueue: Promise<void> = Promise.resolve();
  const enqueueSpeechMutation = (operation: () => Promise<void>): Promise<void> => {
    const queued = speechMutationQueue.then(operation, operation);
    speechMutationQueue = queued.catch(() => undefined);
    return queued;
  };
  const assertGeneration = (expected: number) => {
    if (!Number.isSafeInteger(expected) || expected !== speechGeneration) throw new SpeechCredentialChangedError();
  };
  const readSpeech = async (): Promise<SpeechCredentialSnapshot> => {
    const generation = speechGeneration;
    await speechMutationQueue;
    const key = await store.get(SPEECH_KEY);
    assertGeneration(generation);
    return Object.freeze({ key, generation });
  };
  const status = async (): Promise<ProviderCredentialStatus> => {
    const [speech, openAi] = await Promise.all([readSpeech(), store.get(OPENAI_KEY)]);
    return { speechConfigured: Boolean(speech.key), openAiConfigured: Boolean(openAi) };
  };
  return Object.freeze({
    currentSpeechCredentialGeneration: () => speechGeneration,
    assertSpeechCredentialGeneration: assertGeneration,
    readSpeechCredentialSnapshot: readSpeech,
    getCredentials: status,
    async readProviderCredential(kind: 'speech' | 'openai') {
      return kind === 'speech' ? (await readSpeech()).key : store.get(OPENAI_KEY);
    },
    async setCredentials(input: ProviderCredentialInput) {
      if (input.speechSubscriptionKey !== undefined && input.speechSubscriptionKey.trim().length > 512) throw new Error('Speech key is too long.');
      if (input.openAiApiKey !== undefined && input.openAiApiKey.trim().length > 512) throw new Error('OpenAI key is too long.');
      const operations: Promise<void>[] = [];
      if (input.speechSubscriptionKey !== undefined) {
        speechGeneration += 1;
        const value = input.speechSubscriptionKey.trim();
        operations.push(enqueueSpeechMutation(() => value ? store.set(SPEECH_KEY, value) : store.delete(SPEECH_KEY)));
      }
      if (input.openAiApiKey !== undefined) {
        const value = input.openAiApiKey.trim();
        operations.push(value ? store.set(OPENAI_KEY, value) : store.delete(OPENAI_KEY));
      }
      await Promise.all(operations);
      return status();
    },
    async deleteCredentials(kind?: 'speech' | 'openai') {
      const operations: Promise<void>[] = [];
      if (!kind || kind === 'speech') {
        speechGeneration += 1;
        operations.push(enqueueSpeechMutation(() => store.delete(SPEECH_KEY)));
      }
      if (!kind || kind === 'openai') operations.push(store.delete(OPENAI_KEY));
      await Promise.all(operations);
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
