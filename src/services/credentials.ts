import { credentialStore } from '../storage/credentials';

const SPEECH_KEY = 'azure.speech.subscription-key';
const OPENAI_KEY = 'azure.openai.api-key';

let speechCredentialGeneration = 0;
let speechMutationQueue: Promise<void> = Promise.resolve();

function enqueueSpeechMutation(operation: () => Promise<void>): Promise<void> {
  const queued = speechMutationQueue.then(operation, operation);
  speechMutationQueue = queued.catch(() => undefined);
  return queued;
}

export class SpeechCredentialChangedError extends Error {
  readonly name = 'SpeechCredentialChangedError';
  constructor() { super('The Azure Speech credential changed while the request was being prepared.'); }
}

export function currentSpeechCredentialGeneration(): number { return speechCredentialGeneration; }

export function assertSpeechCredentialGeneration(expected: number): void {
  if (!Number.isSafeInteger(expected) || expected !== speechCredentialGeneration) throw new SpeechCredentialChangedError();
}

/** Read a secret and capture the ephemeral generation that fences its later use. */
export async function readSpeechCredentialSnapshot(): Promise<{ key: string | null; generation: number }> {
  const generation = speechCredentialGeneration;
  await speechMutationQueue;
  const key = await credentialStore.get(SPEECH_KEY);
  assertSpeechCredentialGeneration(generation);
  return Object.freeze({ key, generation });
}

export interface ProviderCredentialStatus {
  speechConfigured: boolean;
  openAiConfigured: boolean;
}

export interface ProviderCredentialInput {
  speechSubscriptionKey?: string;
  openAiApiKey?: string;
}

/** Provider credentials never enter app state, exports, or browser persistent storage. */
export async function getCredentials(): Promise<ProviderCredentialStatus> {
  const [speech, openAi] = await Promise.all([credentialStore.get(SPEECH_KEY), credentialStore.get(OPENAI_KEY)]);
  return { speechConfigured: Boolean(speech), openAiConfigured: Boolean(openAi) };
}

export async function readProviderCredential(kind: 'speech' | 'openai'): Promise<string | null> {
  if (kind === 'speech') return (await readSpeechCredentialSnapshot()).key;
  return credentialStore.get(OPENAI_KEY);
}

export async function setCredentials(input: ProviderCredentialInput): Promise<ProviderCredentialStatus> {
  if (input.speechSubscriptionKey !== undefined && input.speechSubscriptionKey.trim().length > 512) throw new Error('Speech key is too long.');
  if (input.openAiApiKey !== undefined && input.openAiApiKey.trim().length > 512) throw new Error('OpenAI key is too long.');
  const operations: Promise<void>[] = [];
  if (input.speechSubscriptionKey !== undefined) {
    speechCredentialGeneration += 1;
    const value = input.speechSubscriptionKey.trim();
    operations.push(enqueueSpeechMutation(() => value ? credentialStore.set(SPEECH_KEY, value) : credentialStore.delete(SPEECH_KEY)));
  }
  if (input.openAiApiKey !== undefined) {
    const value = input.openAiApiKey.trim();
    operations.push(value ? credentialStore.set(OPENAI_KEY, value) : credentialStore.delete(OPENAI_KEY));
  }
  await Promise.all(operations);
  return getCredentials();
}

export async function deleteCredentials(kind?: 'speech' | 'openai'): Promise<ProviderCredentialStatus> {
  const operations: Promise<void>[] = [];
  if (!kind || kind === 'speech') { speechCredentialGeneration += 1; operations.push(enqueueSpeechMutation(() => credentialStore.delete(SPEECH_KEY))); }
  if (!kind || kind === 'openai') operations.push(credentialStore.delete(OPENAI_KEY));
  await Promise.all(operations);
  return getCredentials();
}
