import { credentialStore } from '../storage/credentials';

const SPEECH_KEY = 'azure.speech.subscription-key';
const OPENAI_KEY = 'azure.openai.api-key';

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
  return credentialStore.get(kind === 'speech' ? SPEECH_KEY : OPENAI_KEY);
}

export async function setCredentials(input: ProviderCredentialInput): Promise<ProviderCredentialStatus> {
  if (input.speechSubscriptionKey !== undefined && input.speechSubscriptionKey.trim().length > 512) throw new Error('Speech key is too long.');
  if (input.openAiApiKey !== undefined && input.openAiApiKey.trim().length > 512) throw new Error('OpenAI key is too long.');
  const operations: Promise<void>[] = [];
  if (input.speechSubscriptionKey !== undefined) {
    const value = input.speechSubscriptionKey.trim();
    operations.push(value ? credentialStore.set(SPEECH_KEY, value) : credentialStore.delete(SPEECH_KEY));
  }
  if (input.openAiApiKey !== undefined) {
    const value = input.openAiApiKey.trim();
    operations.push(value ? credentialStore.set(OPENAI_KEY, value) : credentialStore.delete(OPENAI_KEY));
  }
  await Promise.all(operations);
  return getCredentials();
}

export async function deleteCredentials(kind?: 'speech' | 'openai'): Promise<ProviderCredentialStatus> {
  if (!kind || kind === 'speech') await credentialStore.delete(SPEECH_KEY);
  if (!kind || kind === 'openai') await credentialStore.delete(OPENAI_KEY);
  return getCredentials();
}
