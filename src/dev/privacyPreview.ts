import { Platform } from 'react-native';
import type { AppState, AppController } from '../core';
import { AppControllerImpl } from '../services/controller';
import { AzureOpenAIClient, AzureSpeechClient } from '../services/azure';
import type { StateStore } from '../storage/contracts';
import { bindWorkspaceStorage } from '../privacy/workspaceStorage';
import { createPrivacyBoundController } from '../privacy/controllerBoundary';
import { createPrivacyService, type PrivacyService, type PrivacyWorkspaceSession } from '../privacy/service';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from '../privacy/schema';
import type { PrivacyControlState, PrivacyControlStore, PrivacyWriterArbitration, PrivacyEraseAdapter, PrivacyOwner, PrivacyNamespace } from '../privacy/types';

const CASES = new Set(['success', 'failed-step', 'lost-confirm', 'paused-startup', 'unknown-confirm-status']);

function assertPreviewEnabled() {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || Platform.OS !== 'web' ||
      process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== 'privacy-cleanup') {
    throw new Error('The privacy cleanup sample is available only in its isolated development browser scenario.');
  }
  const selected = process.env.EXPO_PUBLIC_PREVIEW_PRIVACY_CASE;
  if (selected && !CASES.has(selected)) throw new Error('The selected privacy sample case is unavailable.');
}

const denyNetwork: typeof fetch = async () => { throw new Error('External requests are disabled in the privacy sample.'); };
const denyKeys = async (): Promise<string | null> => { throw new Error('Provider credentials are disabled in the privacy sample.'); };

class MemoryControlStore implements PrivacyControlStore {
  private serializedValue?: string;
  private tail: Promise<void> = Promise.resolve();

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }

  read(): Promise<PrivacyControlState> {
    return this.exclusive(async () => {
      if (this.serializedValue === undefined) {
        this.serializedValue = JSON.stringify(createEmptyPrivacyControlState());
      }
      let parsed: unknown;
      try { parsed = JSON.parse(this.serializedValue); }
      catch { throw new Error('The sample privacy control record is invalid.'); }
      return validatePrivacyControlState(parsed);
    });
  }

  compareAndSwap(expectedRevision: string, next: PrivacyControlState): Promise<void> {
    return this.exclusive(async () => {
      const current = this.serializedValue === undefined
        ? createEmptyPrivacyControlState()
        : validatePrivacyControlState(JSON.parse(this.serializedValue));
      if (current.revision !== expectedRevision) throw new Error('Sample privacy control revision changed.');
      this.serializedValue = JSON.stringify(validatePrivacyControlState(structuredClone(next)));
    });
  }
}

/** The sample controller and the erase adapter operate on this same serialized value. */
class MemoryAppStatePersistence {
  private serializedValue?: string;

  async load(): Promise<AppState | undefined> {
    if (this.serializedValue === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(this.serializedValue); }
    catch { throw new Error('Sample app data is invalid.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Sample app data is invalid.');
    return structuredClone(parsed as AppState);
  }

  async save(state: AppState): Promise<void> {
    this.serializedValue = JSON.stringify(structuredClone(state));
  }

  async clear(): Promise<void> {
    this.serializedValue = undefined;
  }

  async isEmpty(): Promise<boolean> {
    return (await this.load()) === undefined;
  }
}

class MemoryStateStore implements StateStore {
  constructor(private readonly persistence: MemoryAppStatePersistence) {}
  load() { return this.persistence.load(); }
  save(state: AppState) { return this.persistence.save(state); }
  clear() { return this.persistence.clear(); }
}

function createMemoryArbitration(): PrivacyWriterArbitration {
  let tail: Promise<void> = Promise.resolve();
  const owner: PrivacyOwner = {
    platform: 'web',
    runtimeId: 'a3d6d7f4-bb15-4d73-9f70-1a6d7c948502',
  };
  const locked = async <T,>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  };
  return { getRuntimeOwner: async () => owner, withWriterLock: locked, withCleanupLock: locked };
}

const id = (tail: string) => `00000000-0000-4000-8000-00000000${tail}`;

function sampleAppState(base: AppState): AppState {
  const state = structuredClone(base);
  const noteOne = id('0101');
  const noteTwo = id('0102');
  state.notes = [
    { id: noteOne, title: 'Sample meeting notes', transcript: 'Discuss the fictional project timeline.', durationSeconds: 0, createdAt: '2026-10-13T00:00:00.000Z', capturedAt: '2026-10-13T00:00:00.000Z', captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 1 },
    { id: noteTwo, title: 'Sample grocery reminder', transcript: 'Buy apples and tea.', durationSeconds: 0, createdAt: '2026-10-12T00:00:00.000Z', capturedAt: '2026-10-12T00:00:00.000Z', captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 1 },
  ];
  state.tasks = [{ id: id('0201'), title: 'Review fictional timeline', body: 'Check the proposed dates.', status: 'open', createdAt: '2026-10-13T00:01:00.000Z', sourceNoteId: noteOne, sourceRevision: 1, proposalId: id('0301') }];
  state.documents = [{ path: 'memory/RULES.md', content: '# Sample rules\n\nFictional local preview data.\n', revision: 1, updatedAt: '2026-10-13T00:00:00.000Z' }];
  return state;
}

function createController(persistence: MemoryAppStatePersistence, privacy: PrivacyService, session: PrivacyWorkspaceSession): AppController {
  const store = bindWorkspaceStorage(new MemoryStateStore(persistence), privacy, session);
  const inner = new AppControllerImpl(store, {
    speech: new AzureSpeechClient({ fetcher: denyNetwork, readKey: denyKeys }),
    openAi: new AzureOpenAIClient(denyNetwork, denyKeys),
  }, {
    privacySession: { epoch: session.epoch, assertCurrent: () => privacy.assertWorkspaceEpoch(session.epoch) },
    writeDocument: async () => undefined,
  });
  return createPrivacyBoundController(inner, privacy, session);
}

export interface PrivacyCleanupPreview {
  privacy: PrivacyService;
  controller: AppController;
  session: PrivacyWorkspaceSession;
  caseName: string;
  /** Reopens a blank controller over the same cleared store and privacy journal. */
  openFreshWorkspace(): Promise<{ controller: AppController; session: PrivacyWorkspaceSession }>;
  readPersistedState(): Promise<AppState | undefined>;
}

/** Uses the real privacy engine and epoch-bound controller over isolated serialized memory only. */
export async function createPrivacyCleanupPreview(): Promise<PrivacyCleanupPreview> {
  assertPreviewEnabled();
  const caseName = process.env.EXPO_PUBLIC_PREVIEW_PRIVACY_CASE || 'success';
  const controlStore = new MemoryControlStore();
  const persistence = new MemoryAppStatePersistence();
  const resources = new Map<PrivacyNamespace, Map<string, string>>();
  for (const namespace of ['browser_audio', 'native_recordings', 'recovery_audio', 'speech_staging', 'picker_cache', 'markdown_mirrors', 'internal_export', 'provider_credentials', 'notifications'] as const) {
    resources.set(namespace, new Map([[`sample:${namespace}`, 'fictional sample data']]));
  }
  resources.get('markdown_mirrors')?.set('memory/RULES.md', '# Sample rules');
  const tokens = new Map<string, string>([[id('0019'), 'fictional token payload']]);
  let failOnce = caseName === 'failed-step' || caseName === 'paused-startup';
  const adapter: PrivacyEraseAdapter = {
    async erase(target) {
      if (failOnce) { failOnce = false; throw new Error('Fictional local cleanup failure.'); }
      if (target.kind === 'namespace' && target.namespace === 'state_database') await persistence.clear();
      else if (target.kind === 'namespace') resources.get(target.namespace)?.clear();
      else if (target.kind === 'oauth_token') tokens.delete(target.tokenRef);
      else resources.get('markdown_mirrors')?.delete(target.path);
    },
    async verifyGone(target) {
      if (target.kind === 'namespace' && target.namespace === 'state_database') return await persistence.isEmpty();
      if (target.kind === 'namespace') return (resources.get(target.namespace)?.size ?? 0) === 0;
      if (target.kind === 'oauth_token') return !tokens.has(target.tokenRef);
      return !resources.get('markdown_mirrors')?.has(target.path);
    },
  };
  const service = createPrivacyService({ controlStore, arbitration: createMemoryArbitration(), eraseAdapter: adapter });
  const session = await service.openWorkspace();
  for (const namespace of ['state_database', 'browser_audio', 'native_recordings', 'recovery_audio', 'speech_staging', 'picker_cache', 'markdown_mirrors', 'internal_export', 'provider_credentials', 'notifications'] as const) {
    await service.registerNamespace(session.epoch, namespace);
  }
  await service.registerOAuthTokenRef(session.epoch, id('0019'));
  await service.registerLegacyMarkdownPath(session.epoch, 'memory/RULES.md');

  const blank = new AppControllerImpl(new MemoryStateStore(persistence), {
    speech: new AzureSpeechClient({ fetcher: denyNetwork, readKey: denyKeys }),
    openAi: new AzureOpenAIClient(denyNetwork, denyKeys),
  });
  await blank.load();
  await persistence.save(sampleAppState(blank.getSnapshot()));
  await blank.disposeForPrivacy().catch(() => undefined);

  let lostCommitResponse = caseName === 'lost-confirm' || caseName === 'unknown-confirm-status';
  let lostStatusReadsAfterCommit = caseName === 'unknown-confirm-status' ? 1 : 0;
  let committed = false;
  const privacy: PrivacyService = {
    ...service,
    async commitErase(input) {
      await service.commitErase(input);
      committed = true;
      if (lostCommitResponse) {
        lostCommitResponse = false;
        throw new Error('Fictional confirmation response was lost after commit.');
      }
    },
    async getStatus() {
      if (committed && lostStatusReadsAfterCommit > 0) {
        lostStatusReadsAfterCommit -= 1;
        throw new Error('Fictional deletion status response was lost.');
      }
      return service.getStatus();
    },
  };

  let activeController: AppController;
  const makeWorkspace = async () => {
    await activeController?.disposeForPrivacy?.().catch(() => undefined);
    const nextSession = await privacy.openWorkspace();
    for (const namespace of ['state_database', 'browser_audio', 'native_recordings', 'recovery_audio', 'speech_staging', 'picker_cache', 'markdown_mirrors', 'internal_export', 'provider_credentials', 'notifications'] as const) {
      await privacy.registerNamespace(nextSession.epoch, namespace);
    }
    activeController = createController(persistence, privacy, nextSession);
    return { controller: activeController, session: nextSession };
  };

  activeController = createController(persistence, privacy, session);
  if (caseName === 'paused-startup') {
    const plan = await privacy.prepareErase();
    await privacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    await privacy.runCleanupPass();
  }
  return {
    privacy,
    get controller() { return activeController; },
    session,
    caseName,
    openFreshWorkspace: makeWorkspace,
    readPersistedState: () => persistence.load(),
  };
}
