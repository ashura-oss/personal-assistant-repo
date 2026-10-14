import { describe, expect, it, vi } from 'vitest';
import type { ChatTranscriptTransferPlan } from '../src/chat/types';
import { VoiceChatTransferOwnership } from '../src/ui/voiceChatTransferOwnership';

const note = (id: string, revision = 1) => ({ id, revision });
const plan = (planId: string, noteId: string, noteRevision = 1): ChatTranscriptTransferPlan => ({
  planId, noteId, noteRevision, transcript: `Saved words for ${noteId}.`,
  capturedAt: '2026-10-13T10:00:00.000Z', captureTimeZone: 'Asia/Singapore',
  expiresAt: '2026-10-13T10:05:00.000Z',
});

describe('voice transcript transfer ownership', () => {
  it('skips controller prepare when the note closes during credential lookup', async () => {
    const ownership = new VoiceChatTransferOwnership();
    const savedNote = note('note-a');
    ownership.publishOwner(savedNote);
    const capturedOwner = ownership.captureOwner(savedNote)!;
    let releaseCredentials!: () => void;
    const credentials = new Promise<void>((resolve) => { releaseCredentials = resolve; });
    const prepareControllerPlan = vi.fn(async () => plan('late-plan', savedNote.id));

    const prepare = ownership.prepareOwnedPlan({
      owner: capturedOwner,
      readReadiness: () => credentials,
      prepare: () => prepareControllerPlan(),
      cancelLatePlan: vi.fn(),
    });

    ownership.publishOwner(null);
    releaseCredentials();
    await expect(prepare).resolves.toEqual({ kind: 'stale' });
    expect(prepareControllerPlan).not.toHaveBeenCalled();
    expect(ownership.getPlan('late-plan')).toBeUndefined();
  });

  it('cancels the exact controller plan that returns after its note owner changes', async () => {
    const ownership = new VoiceChatTransferOwnership();
    const savedNote = note('note-a');
    ownership.publishOwner(savedNote);
    const capturedOwner = ownership.captureOwner(savedNote)!;
    let releaseController!: (value: ChatTranscriptTransferPlan) => void;
    const pendingControllerPlan = new Promise<ChatTranscriptTransferPlan>((resolve) => { releaseController = resolve; });
    const latePlan = plan('late-plan', savedNote.id);
    const cancelLatePlan = vi.fn(async (_planId: string) => undefined);
    const prepare = ownership.prepareOwnedPlan({
      owner: capturedOwner,
      readReadiness: async () => ({ keyReady: true }),
      prepare: async () => pendingControllerPlan,
      cancelLatePlan: (prepared) => cancelLatePlan(prepared.planId),
    });

    await Promise.resolve();
    ownership.publishOwner(note('note-b'));
    releaseController(latePlan);
    await expect(prepare).resolves.toEqual({ kind: 'stale' });
    expect(cancelLatePlan).toHaveBeenCalledExactlyOnceWith(latePlan.planId);
    expect(ownership.publishPlan(latePlan, capturedOwner)).toBe(false);
  });

  it('keeps callbacks from an older review from creating, sending, or cancelling a newer review', () => {
    const ownership = new VoiceChatTransferOwnership();
    const firstNote = note('note-a');
    ownership.publishOwner(firstNote);
    const firstOwner = ownership.captureOwner(firstNote)!;
    const firstPlan = plan('plan-a', firstNote.id);
    expect(ownership.publishPlan(firstPlan, firstOwner)).toBe(true);

    ownership.publishOwner(note('note-b'));
    const secondOwner = ownership.captureOwner(note('note-b'))!;
    const secondPlan = plan('plan-b', 'note-b');
    expect(ownership.publishPlan(secondPlan, secondOwner)).toBe(true);

    expect(ownership.getPlan(firstPlan.planId)).toBeUndefined();
    expect(ownership.clearPlan(firstPlan.planId)).toBeUndefined();
    expect(ownership.getPlan(secondPlan.planId)).toBe(secondPlan);
  });

  it('invalidates a captured review across close and reopen of the same note revision', () => {
    const ownership = new VoiceChatTransferOwnership();
    const savedNote = note('note-a', 4);
    ownership.publishOwner(savedNote);
    const oldOwner = ownership.captureOwner(savedNote)!;
    const oldPlan = plan('old-plan', savedNote.id, savedNote.revision);
    ownership.publishPlan(oldPlan, oldOwner);

    ownership.publishOwner(null);
    ownership.publishOwner(savedNote);
    const reopenedOwner = ownership.captureOwner(savedNote)!;
    const freshPlan = plan('fresh-plan', savedNote.id, savedNote.revision);
    ownership.publishPlan(freshPlan, reopenedOwner);

    expect(ownership.owns(oldOwner)).toBe(false);
    expect(ownership.getPlan(oldPlan.planId)).toBeUndefined();
    expect(ownership.clearPlan(oldPlan.planId)).toBeUndefined();
    expect(ownership.getPlan(freshPlan.planId)).toBe(freshPlan);
  });
});
