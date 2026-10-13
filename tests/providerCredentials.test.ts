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
});
