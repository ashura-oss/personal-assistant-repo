import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { bindExistingWorkspaceWriter, bindWorkspaceStorage } from '../src/privacy/workspaceStorage';
import type { PrivacyWriterScope } from '../src/privacy/types';
import type { PrivacyService } from '../src/privacy/service';

describe('privacy-bound workspace storage', () => {
  it('forwards pending-capture consumption options inside the state writer lease', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const revision = '00000000-0000-4000-8000-000000000002';
    const state = { notes: [] } as unknown as AppState;
    let owned = false;
    const save = vi.fn(async (_snapshot: AppState, _options?: Parameters<StateStore['save']>[1]) => {
      expect(owned).toBe(true);
    });
    const store = { load: vi.fn(), save, clear: vi.fn() } as unknown as StateStore;
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const privacy = {
      withWriter: vi.fn(async (_epoch, _descriptor, callback) => {
        await writerGate;
        owned = true;
        try { return await callback({} as never, {} as never); }
        finally { owned = false; }
      }),
    } as unknown as PrivacyService;
    const bound = bindWorkspaceStorage(store, privacy, { epoch: id, runtimeId: revision });
    const options = { consumePendingCapture: { id, revision, noteId: id } };

    const saving = bound.save(state, options);
    options.consumePendingCapture.id = revision;
    options.consumePendingCapture.noteId = revision;
    releaseWriter();
    await saving;

    expect(save).toHaveBeenCalledWith(state, { consumePendingCapture: { id, revision, noteId: id } });
    expect(privacy.withWriter).toHaveBeenCalledOnce();
  });

  it('admits child state operations through the issued scope and snapshots the binding and save input', async () => {
    const epoch = '00000000-0000-4000-8000-000000000011';
    const runtimeId = '00000000-0000-4000-8000-000000000012';
    const scope = Object.freeze({}) as PrivacyWriterScope;
    const session = { epoch, runtimeId };
    let finishAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { finishAdmission = resolve; });
    const store = {
      load: vi.fn(async () => ({ notes: [] } as unknown as AppState)),
      save: vi.fn(async (_state: AppState) => undefined),
      clear: vi.fn(async () => undefined),
      assertCurrent: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const withExistingWriter = vi.fn(async (_scope, _epoch, _descriptor, actualIO) => {
      await admission;
      return await actualIO();
    });
    const privacy = { withExistingWriter } as unknown as PrivacyService;
    const scoped = bindExistingWorkspaceWriter(store, privacy, session, scope);
    const mutable = { notes: [{ id: 'before' }] } as unknown as AppState;
    const saving = scoped.save(mutable);
    mutable.notes[0].id = 'after';
    session.epoch = runtimeId;
    finishAdmission();
    await saving;

    expect(withExistingWriter).toHaveBeenCalledWith(scope, epoch, { kind: 'app_state', namespace: 'state_database' }, expect.any(Function));
    expect(store.save).toHaveBeenCalledWith({ notes: [{ id: 'before' }] }, undefined);
    expect(Object.keys(scoped).sort()).toEqual(['assertCurrent', 'load', 'save']);
    expect('clear' in scoped).toBe(false);
    expect('recovery' in scoped).toBe(false);
  });

  it('does not reach raw state I/O when the issued child scope is rejected', async () => {
    const epoch = '00000000-0000-4000-8000-000000000021';
    const store = {
      load: vi.fn(async () => ({ notes: [] } as unknown as AppState)),
      save: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const privacy = {
      withExistingWriter: vi.fn(async () => { throw new Error('writer scope is closed'); }),
    } as unknown as PrivacyService;
    const scoped = bindExistingWorkspaceWriter(store, privacy, { epoch, runtimeId: epoch }, Object.freeze({}) as PrivacyWriterScope);

    await expect(scoped.load()).rejects.toThrow('writer scope is closed');
    await expect(scoped.save({ notes: [] } as unknown as AppState)).rejects.toThrow('writer scope is closed');
    expect(store.load).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});
