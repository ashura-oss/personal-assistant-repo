import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { bindWorkspaceStorage } from '../src/privacy/workspaceStorage';
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
});
