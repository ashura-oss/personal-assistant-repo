import { Platform } from 'react-native';
import type { AppState, AppController } from '../core';
import { AppControllerImpl } from '../services/controller';
import { AzureOpenAIClient, AzureSpeechClient } from '../services/azure';
import type { StateStore } from '../storage/contracts';
import {
  createStartupRecoveryBackend,
  type StartupRecoveryArchiveRecord,
  type StartupRecoveryBackend,
  type StartupRecoveryPersistence,
  type StartupRecoveryReceiptRecord,
  type StartupRecoverySnapshot,
  type StartupRecoverySnapshotMetadata,
  type StartupRecoveryTransaction,
} from '../storage/startupRecovery';

function assertPreviewEnabled() {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || Platform.OS !== 'web' ||
      process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== 'startup-recovery') {
    throw new Error('Startup recovery preview is available only in its isolated development browser scenario.');
  }
}

const denyNetwork: typeof fetch = async () => {
  throw new Error('Network access is disabled in the startup recovery preview.');
};
const denyKeys = async (): Promise<string | null> => {
  throw new Error('Provider keys are disabled in the startup recovery preview.');
};

const SNAPSHOT_GENERATION = 'd81b23e4-71ce-4fc2-ae72-63215e4ad9fc';

class MemoryRecoveryPersistence implements StartupRecoveryPersistence {
  private snapshot?: StartupRecoverySnapshot;
  private generation?: string;
  private archives: StartupRecoveryArchiveRecord[] = [];
  private receipts: StartupRecoveryReceiptRecord[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly oversize: boolean;
  private readonly archiveFailure: boolean;
  private afterCommit?: () => void;

  constructor(fault: string, onCommit: () => void) {
    this.oversize = fault === 'too-large';
    this.archiveFailure = fault === 'archive-failure';
    if (fault !== 'empty') {
      this.snapshot = Object.freeze({
        raw: '{"savedState":',
        schemaVersion: fault === 'newer-version' ? 2 : 1,
        generation: SNAPSHOT_GENERATION,
      });
      this.generation = SNAPSHOT_GENERATION;
    }
    if (fault === 'archive-full') {
      // Metadata-only prior archives exercise the real helper's limit checks.
      this.archives = Array.from({ length: 8 }, (_, index) => ({
        archiveId: fixtureUuid(index + 10),
        sessionId: fixtureUuid(index + 20),
        raw: '',
        schemaVersion: 1,
        generation: SNAPSHOT_GENERATION,
        archivedAt: new Date(0).toISOString(),
        evidenceBytes: 1,
        sha256: '0'.repeat(64),
      }));
    }
    if (fault === 'post-commit-failure') this.afterCommit = onCommit;
  }

  async withTransaction<T>(work: (transaction: StartupRecoveryTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      let snapshot = this.snapshot ? { ...this.snapshot } : undefined;
      let generation = this.generation;
      let archives = this.archives.map((record) => ({ ...record }));
      let receipts = this.receipts.map((record) => structuredClone(record));
      let archived = false;
      const memory = this;
      const clonedReceipt = (record: StartupRecoveryReceiptRecord | undefined) => record ? structuredClone(record) : undefined;
      const transaction: StartupRecoveryTransaction = {
        async readSnapshotMetadata(): Promise<StartupRecoverySnapshotMetadata | undefined> {
          if (!snapshot) return undefined;
          const evidenceBytes = memory.oversize ? 40 * 1024 * 1024 : new TextEncoder().encode(snapshot.raw).byteLength;
          return { schemaVersion: snapshot.schemaVersion, generation: snapshot.generation, evidenceBytes };
        },
        async readSnapshot(maxBytes) {
          if (!snapshot || memory.oversize || new TextEncoder().encode(snapshot.raw).byteLength > maxBytes) return undefined;
          return { ...snapshot };
        },
        async readGeneration() { return generation; },
        async readArchiveMetadata() { return archives.map(({ evidenceBytes }) => ({ evidenceBytes })); },
        async readPendingReceipt() { return clonedReceipt(receipts.find((record) => !record.opened)); },
        async findReceipt(sessionId, planHash) { return clonedReceipt(receipts.find((record) => record.sessionId === sessionId && record.planHash === planHash)); },
        async findReceiptByOperationId(operationId) { return clonedReceipt(receipts.find((record) => record.receipt.operationId === operationId)); },
        async writeSnapshot(raw, schemaVersion) { snapshot = { raw, schemaVersion, generation: generation ?? SNAPSHOT_GENERATION }; },
        async writeGeneration(value) { generation = value; if (snapshot) snapshot = { ...snapshot, generation: value }; },
        async insertArchive(record) {
          if (memory.archiveFailure) throw new Error('Fictional recovery archive write failure.');
          archives.push(structuredClone(record));
          archived = true;
        },
        async insertReceipt(record) { receipts.push(structuredClone(record)); },
        async markReceiptOpened(operationId) {
          receipts = receipts.map((record) => record.receipt.operationId === operationId ? { ...record, opened: true } : record);
        },
      };
      const value = await work(transaction);
      this.snapshot = snapshot;
      this.generation = generation;
      this.archives = archives;
      this.receipts = receipts;
      if (archived) this.afterCommit?.();
      return value;
    } finally {
      release();
    }
  }

  async loadState(onOpened?: (generation: string | undefined) => void): Promise<AppState | undefined> {
    return this.withTransaction(async (tx) => {
      const metadata = await tx.readSnapshotMetadata();
      if (!metadata) return undefined;
      if (metadata.schemaVersion > 1) throw new Error('This sample snapshot belongs to a newer app version.');
      if (metadata.evidenceBytes > 32 * 1024 * 1024) throw new Error('This sample snapshot exceeds the recovery size limit.');
      const snapshot = await tx.readSnapshot(32 * 1024 * 1024);
      if (!snapshot) throw new Error('This sample snapshot could not be opened.');
      try {
        const state = JSON.parse(snapshot.raw) as AppState;
        onOpened?.(metadata.generation);
        return state;
      }
      catch { throw new Error('Fictional saved snapshot could not be opened.'); }
    });
  }

  async saveState(state: AppState, expectedGeneration?: string): Promise<string> {
    await this.withTransaction(async (tx) => {
      const actual = await tx.readGeneration();
      if (actual !== expectedGeneration) throw new Error('Saved data changed in another workspace. Reload before saving.');
      await tx.writeSnapshot(JSON.stringify(state), 1);
      const generation = nextFixtureUuid();
      await tx.writeGeneration(generation);
      expectedGeneration = generation;
    });
    return expectedGeneration!;
  }

  async clearState(expectedGeneration?: string): Promise<string> {
    await this.withTransaction(async (tx) => {
      const actual = await tx.readGeneration();
      if (actual !== expectedGeneration) throw new Error('Saved data changed in another workspace. Reload before clearing.');
      await tx.writeSnapshot('{}', 1);
      const generation = nextFixtureUuid();
      await tx.writeGeneration(generation);
      expectedGeneration = generation;
    });
    return expectedGeneration!;
  }

  async readGeneration(): Promise<string | undefined> {
    return this.withTransaction((tx) => tx.readGeneration());
  }
}

let fixtureUuidCounter = 100;
function fixtureUuid(seed = ++fixtureUuidCounter) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}
function nextFixtureUuid() { return fixtureUuid(++fixtureUuidCounter); }

class MemoryStateStore implements StateStore {
  private failNextRead = false;
  private generationBaseline = false;
  private originGeneration?: string;
  private currentGeneration?: string;
  readonly recovery: StartupRecoveryBackend;
  private readonly persistence: MemoryRecoveryPersistence;

  constructor(fault: string) {
    this.persistence = new MemoryRecoveryPersistence(fault, () => { this.failNextRead = true; });
    let id = 0;
    this.recovery = createStartupRecoveryBackend({
      persistence: this.persistence,
      randomId: () => fixtureUuid(500 + ++id),
      getOpenedGeneration: async (currentGeneration) => this.generationBaseline
        ? { originGeneration: this.originGeneration, currentGeneration: this.currentGeneration === currentGeneration ? currentGeneration : this.currentGeneration }
        : undefined,
    });
  }

  async load() {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('Fictional fresh snapshot open failure.');
    }
    return this.persistence.loadState((generation) => {
      this.generationBaseline = true;
      this.originGeneration = generation;
      this.currentGeneration = generation;
    });
  }
  async save(state: AppState) {
    if (!this.generationBaseline) {
      const actual = await this.persistence.readGeneration();
      if (actual !== undefined) throw new Error('Load the current workspace before saving.');
      this.generationBaseline = true;
      this.originGeneration = undefined;
      this.currentGeneration = undefined;
    }
    this.currentGeneration = await this.persistence.saveState(state, this.currentGeneration);
  }
  async clear() {
    if (!this.generationBaseline) {
      const actual = await this.persistence.readGeneration();
      if (actual !== undefined) throw new Error('Load the current workspace before clearing.');
      this.generationBaseline = true;
      this.originGeneration = undefined;
      this.currentGeneration = undefined;
    }
    this.currentGeneration = await this.persistence.clearState(this.currentGeneration);
  }
  async assertCurrent(): Promise<void> {
    const actual = await this.persistence.readGeneration();
    if (!this.generationBaseline || actual !== this.currentGeneration) {
      throw new Error('Saved data changed in another workspace. Reload before continuing.');
    }
  }
}

/** Isolated controller with the production recovery backend over an atomic in-memory adapter. */
export function createStartupRecoveryPreview(): AppController {
  assertPreviewEnabled();
  const fault = process.env.EXPO_PUBLIC_PREVIEW_RECOVERY_CASE ?? 'corrupt';
  const store = new MemoryStateStore(fault);
  const providers = {
    speech: new AzureSpeechClient({ fetcher: denyNetwork, readKey: denyKeys }),
    openAi: new AzureOpenAIClient(denyNetwork, denyKeys),
  };
  return new AppControllerImpl(store, providers);
}
