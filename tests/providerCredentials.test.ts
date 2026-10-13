import { describe, expect, it } from 'vitest';
import { createProviderCredentialService } from '../src/services/credentials';
import type { CredentialStore } from '../src/storage/credentials';

function memoryStore(): CredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('instance-scoped provider credential service', () => {
  it('invalidates a pending speech snapshot as soon as a mutation is requested', async () => {
    const store = memoryStore();
    let finish!: () => void;
    const rawSet = store.set.bind(store);
    store.set = async (key, value) => { await new Promise<void>((resolve) => { finish = resolve; }); await rawSet(key, value); };
    const service = createProviderCredentialService(store);
    const before = service.currentSpeechCredentialGeneration();
    const write = service.setCredentials({ speechSubscriptionKey: 'new-key' });
    expect(service.currentSpeechCredentialGeneration()).toBe(before + 1);
    let settled = false;
    const snapshot = service.readSpeechCredentialSnapshot().then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await write;
    await expect(snapshot).resolves.toMatchObject({ key: 'new-key', generation: before + 1 });
  });

  it('serializes overlapping speech-key writes in request order', async () => {
    const store = memoryStore();
    const rawSet = store.set.bind(store);
    let releaseFirst!: () => void;
    let call = 0;
    store.set = async (key, value) => {
      call += 1;
      if (call === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      await rawSet(key, value);
    };
    const service = createProviderCredentialService(store);
    const first = service.setCredentials({ speechSubscriptionKey: 'key-a' });
    await Promise.resolve();
    const second = service.setCredentials({ speechSubscriptionKey: 'key-b' });
    releaseFirst();
    await Promise.all([first, second]);
    await expect(service.readSpeechCredentialSnapshot()).resolves.toMatchObject({ key: 'key-b', generation: 2 });
  });

  it('generation-fences and serializes OpenRouter credentials independently from Azure keys', async () => {
    const store = memoryStore();
    const reads: string[] = [];
    const rawGet = store.get.bind(store);
    store.get = async (key) => { reads.push(key); return rawGet(key); };
    const service = createProviderCredentialService(store);
    const before = service.currentProviderCredentialGeneration('openrouter');
    const write = service.setCredentials({ openRouterApiKey: 'or-key' });
    expect(service.currentProviderCredentialGeneration('openrouter')).toBe(before + 1);
    await write;
    reads.splice(0, reads.length);
    await expect(service.readProviderCredentialSnapshot('openrouter')).resolves.toEqual({ key: 'or-key', generation: before + 1 });
    expect(reads).toContain('openrouter.api-key');
    expect(reads).not.toContain('azure.openai.api-key');
    expect(() => service.assertProviderCredentialGeneration('openrouter', before)).toThrow();
    expect(service.currentProviderCredentialGeneration('openai')).toBe(0);
    await expect(service.readProviderCredentialSnapshot('openai')).resolves.toEqual({ key: null, generation: 0 });
    expect(reads).toContain('azure.openai.api-key');
    await expect(service.readProviderCredential('openai')).resolves.toBeNull();
    await expect(service.getCredentials()).resolves.toMatchObject({ openRouterConfigured: true, openAiConfigured: false });
    await service.deleteCredentials('openrouter');
    await expect(service.readProviderCredentialSnapshot('openrouter')).resolves.toMatchObject({ key: null, generation: before + 2 });
  });

  it('drains all status reads before returning a sanitized error', async () => {
    const store = memoryStore();
    const speechStarted = deferred();
    const releaseSpeech = deferred<string | null>();
    store.get = async (key) => {
      if (key === 'azure.speech.subscription-key') {
        speechStarted.resolve();
        return releaseSpeech.promise;
      }
      if (key === 'azure.openai.api-key') throw new Error('secret native error');
      return null;
    };
    const service = createProviderCredentialService(store);
    let settled = false;
    const status = service.getCredentials().catch((error: unknown) => { settled = true; throw error; });
    await speechStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseSpeech.resolve(null);
    await expect(status).rejects.toThrow('Provider credentials could not be read or updated.');
    await expect(status).rejects.not.toThrow('secret native error');
  });

  it('drains sibling set and delete operations after one secure-store failure', async () => {
    for (const method of ['set', 'delete'] as const) {
      const store = memoryStore();
      const speechStarted = deferred();
      const releaseSpeech = deferred();
      if (method === 'set') {
        store.set = async (key) => {
          if (key === 'azure.speech.subscription-key') { speechStarted.resolve(); await releaseSpeech.promise; return; }
          if (key === 'azure.openai.api-key') throw new Error('private write failure');
        };
      } else {
        store.delete = async (key) => {
          if (key === 'azure.speech.subscription-key') { speechStarted.resolve(); await releaseSpeech.promise; return; }
          if (key === 'azure.openai.api-key') throw new Error('private delete failure');
        };
      }
      const service = createProviderCredentialService(store);
      let settled = false;
      const operation = (method === 'set'
        ? service.setCredentials({ speechSubscriptionKey: 'speech', openAiApiKey: 'openai', openRouterApiKey: 'router' })
        : service.deleteCredentials())
        .catch((error: unknown) => { settled = true; throw error; });
      await speechStarted.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseSpeech.resolve();
      await expect(operation).rejects.toThrow('Provider credentials could not be read or updated.');
      await expect(operation).rejects.not.toThrow('private');
    }
  });
});
