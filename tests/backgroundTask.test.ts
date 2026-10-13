import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAIL_REFRESH_MINIMUM_INTERVAL_MINUTES,
  MAIL_REFRESH_TASK_NAME,
  type NativeBackgroundTaskApi,
} from '../src/background/backend.types';
import { createNativeBackgroundTaskBackend, isNativeTaskRegistered } from '../src/background/backend.native';
import { backgroundTaskBackend as webBackgroundTaskBackend } from '../src/background/backend.web';

const taskDefinitionMocks = vi.hoisted(() => ({
  definitions: [] as { name: string; handler: (body?: { error?: unknown }) => Promise<number> }[],
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-task-manager', () => ({
  defineTask: (name: string, handler: () => Promise<number>) => taskDefinitionMocks.definitions.push({ name, handler }),
}));

function api(overrides: Partial<NativeBackgroundTaskApi> = {}) {
  const calls: unknown[][] = [];
  let registered = false;
  const stub: NativeBackgroundTaskApi = {
    platform: 'ios',
    async isAvailable() { return true; },
    async getAvailability() { return 'available'; },
    async isRegistered(name) { calls.push(['isRegistered', name]); return registered; },
    async register(name, interval) { calls.push(['register', name, interval]); registered = true; },
    async unregister(name, beforeMutation) { await beforeMutation?.(); calls.push(['unregister', name]); registered = false; },
    async addExpirationListener(listener) { calls.push(['expiration']); return { remove: listener }; },
    ...overrides,
  };
  return { stub, calls, isRegistered: () => registered };
}

describe('native background task backend', () => {
  it('checks persisted registration even when the current JS definition is missing', async () => {
    let definitionChecked = false;
    const taskManager = {
      async isTaskRegisteredAsync(name: string) { expect(name).toBe(MAIL_REFRESH_TASK_NAME); return true; },
      isTaskDefined() { definitionChecked = true; return false; },
    };
    const result = await isNativeTaskRegistered(taskManager, MAIL_REFRESH_TASK_NAME);
    expect(result).toBe(true);
    expect(definitionChecked).toBe(false);
  });

  it('uses one fixed task name and the SDK minimum interval without claiming a schedule', async () => {
    const fake = api();
    const backend = createNativeBackgroundTaskBackend({ api: fake.stub });
    const status = await backend.register();
    expect(fake.calls).toContainEqual(['register', MAIL_REFRESH_TASK_NAME, MAIL_REFRESH_MINIMUM_INTERVAL_MINUTES]);
    expect(status).toMatchObject({ state: 'registered', registered: true });
    expect(status.message).toContain('iOS chooses when it runs');
    await backend.unregister();
    expect(fake.calls).toContainEqual(['unregister', MAIL_REFRESH_TASK_NAME]);
    expect(fake.isRegistered()).toBe(false);
  });

  it('rechecks cleanup authority immediately before the exact native unregister call', async () => {
    const fake = api();
    await fake.stub.register(MAIL_REFRESH_TASK_NAME, MAIL_REFRESH_MINIMUM_INTERVAL_MINUTES);
    const backend = createNativeBackgroundTaskBackend({ api: fake.stub });
    let checked = false;
    await backend.unregister(async () => { checked = true; });
    expect(checked).toBe(true);
    expect(fake.calls.at(-1)).toEqual(['unregister', MAIL_REFRESH_TASK_NAME]);
  });

  it('still removes the exact TaskManager registration when background execution is restricted', async () => {
    const fake = api({
      async isAvailable() { return false; },
      async isRegistered(name) { expect(name).toBe(MAIL_REFRESH_TASK_NAME); return true; },
    });
    const backend = createNativeBackgroundTaskBackend({ api: fake.stub });
    let checked = false;
    await backend.unregister(async () => { checked = true; });
    expect(checked).toBe(true);
    expect(fake.calls).toContainEqual(['unregister', MAIL_REFRESH_TASK_NAME]);
  });

  it('reports restricted or unsupported platforms without registration attempts', async () => {
    const restricted = api({ async getAvailability() { return 'restricted'; } });
    const restrictedBackend = createNativeBackgroundTaskBackend({ api: restricted.stub });
    expect(await restrictedBackend.getStatus()).toMatchObject({ state: 'restricted', registered: false });
    expect((await restrictedBackend.register()).state).toBe('restricted');
    expect(restricted.calls.some(([method]) => method === 'register')).toBe(false);

    const android = api({ platform: 'android' });
    const androidBackend = createNativeBackgroundTaskBackend({ api: android.stub });
    expect(await androidBackend.getStatus()).toMatchObject({ state: 'unsupported', registered: false });
    expect((await androidBackend.register()).state).toBe('unsupported');
  });

  it('fails safely when capability inspection rejects', async () => {
    const broken = api({ async isAvailable() { throw new Error('native unavailable'); } });
    const backend = createNativeBackgroundTaskBackend({ api: broken.stub });
    expect(await backend.getStatus()).toMatchObject({ state: 'unavailable', registered: false });
  });
});

describe('web background-task fallback', () => {
  it('reports unsupported without registering or scheduling native work', async () => {
    expect(await webBackgroundTaskBackend.getStatus()).toMatchObject({ platform: 'web', state: 'unsupported', registered: false });
    expect((await webBackgroundTaskBackend.register()).state).toBe('unsupported');
    expect(await webBackgroundTaskBackend.isRegistered()).toBe(false);
  });
});

describe('global task definition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__DEV__', false);
    taskDefinitionMocks.definitions.length = 0;
  });

  it('defines one inert iOS handler and returns failure until a runtime is explicitly bound', async () => {
    taskDefinitionMocks.definitions.length = 0;
    const { defineMailRefreshTaskIfSupported } = await import('../src/background/taskDefinition.native');
    expect(taskDefinitionMocks.definitions).toHaveLength(0);
    expect(defineMailRefreshTaskIfSupported('ios', true, true, (name, handler) => taskDefinitionMocks.definitions.push({ name, handler }))).toBe(true);
    expect(defineMailRefreshTaskIfSupported('android', true, true, () => { throw new Error('must not define'); })).toBe(false);
    expect(defineMailRefreshTaskIfSupported('ios', true, false, () => { throw new Error('must not define'); })).toBe(false);
    const { setMailRefreshTaskRunner, executeMailRefreshWithExpiration } = await import('../src/background/taskDefinition.native');
    expect(taskDefinitionMocks.definitions).toHaveLength(1);
    expect(taskDefinitionMocks.definitions[0].name).toBe(MAIL_REFRESH_TASK_NAME);
    expect(await taskDefinitionMocks.definitions[0].handler()).toBe(2);
    setMailRefreshTaskRunner(async () => true);
    const result = await executeMailRefreshWithExpiration(async (signal) => !signal.aborted, async () => ({ remove() {} }));
    expect(result).toBe(1);
    setMailRefreshTaskRunner(undefined);
  });

  it('forwards native expiration as an abort signal and waits for the runner to settle', async () => {
    const { executeMailRefreshWithExpiration } = await import('../src/background/taskDefinition.native');
    let expire!: () => void;
    let finish!: () => void;
    let finished = false;
    const execution = executeMailRefreshWithExpiration(async (signal) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      finished = true;
      return signal.aborted;
    }, async (listener) => { expire = listener; return { remove() {} }; });
    await Promise.resolve();
    expire();
    await Promise.resolve();
    expect(finished).toBe(false);
    // The task owns the callback until its actual work settles, even after expiration.
    finish();
    expect(await execution).toBe(2);
    expect(finished).toBe(true);
  });

  it('fails callback errors before resolving the headless runtime', async () => {
    const { createMailRefreshTaskHandler } = await import('../src/background/taskDefinition.native');
    let resolved = false;
    let listenerAdded = false;
    const handler = createMailRefreshTaskHandler(async () => {
      resolved = true;
      return async () => true;
    }, async () => {
      listenerAdded = true;
      return { remove() {} };
    });
    expect(await handler({ error: new Error('native callback error') })).toBe(2);
    expect(resolved).toBe(false);
    expect(listenerAdded).toBe(false);
  });

  it('single-flights the full expiration-listener and headless-runner lifetime', async () => {
    const { createMailRefreshTaskHandler } = await import('../src/background/taskDefinition.native');
    let runnerCount = 0;
    let listenerCount = 0;
    let expire!: () => void;
    let finish!: () => void;
    const handler = createMailRefreshTaskHandler(async () => {
      runnerCount += 1;
      return async (signal) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        return signal.aborted;
      };
    }, async (listener) => {
      listenerCount += 1;
      expire = listener;
      return { remove() {} };
    });
    const first = handler();
    const second = handler();
    expect(second).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expire();
    finish();
    expect(await first).toBe(2);
    expect(runnerCount).toBe(1);
    expect(listenerCount).toBe(1);
  });

  it('starts the cooperative budget before lazy bootstrap and does not invoke a late runner', async () => {
    const { createMailRefreshTaskHandler } = await import('../src/background/taskDefinition.native');
    vi.useFakeTimers();
    try {
      let resolveRunner!: (runner: (signal: AbortSignal) => Promise<boolean>) => void;
      let invoked = false;
      const handler = createMailRefreshTaskHandler(
        () => new Promise((resolve) => { resolveRunner = resolve; }),
        async () => ({ remove() {} }),
        10,
      );
      const pending = handler();
      await vi.advanceTimersByTimeAsync(10);
      resolveRunner(async () => { invoked = true; return true; });
      expect(await pending).toBe(2);
      expect(invoked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
