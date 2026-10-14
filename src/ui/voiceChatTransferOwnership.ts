import type { ChatTranscriptTransferPlan } from '../chat/types';

export type VoiceTransferOwner = Readonly<{
  noteId: string;
  revision: number;
  generation: number;
}>;

/** Synchronous ownership gate for async review work and callbacks from an older modal render. */
export class VoiceChatTransferOwnership {
  private owner: VoiceTransferOwner | undefined;
  private plan: { value: ChatTranscriptTransferPlan; owner: VoiceTransferOwner } | undefined;

  publishOwner(note: { id: string; revision: number } | null): boolean {
    if (this.owner?.noteId === note?.id && this.owner?.revision === note?.revision) return false;
    this.owner = note ? {
      noteId: note.id,
      revision: note.revision,
      generation: (this.owner?.generation ?? 0) + 1,
    } : undefined;
    this.plan = undefined;
    return true;
  }

  captureOwner(note: { id: string; revision: number }): VoiceTransferOwner | undefined {
    const owner = this.owner;
    return owner?.noteId === note.id && owner.revision === note.revision ? owner : undefined;
  }

  owns(owner: VoiceTransferOwner): boolean {
    return this.owner === owner;
  }

  async prepareOwnedPlan<TPlan, TReadiness>(input: {
    owner: VoiceTransferOwner;
    readReadiness: () => Promise<TReadiness>;
    prepare: (readiness: TReadiness) => Promise<TPlan>;
    cancelLatePlan: (plan: TPlan) => Promise<unknown> | unknown;
  }): Promise<{ kind: 'stale' } | { kind: 'prepared'; readiness: TReadiness; plan: TPlan }> {
    if (!this.owns(input.owner)) return { kind: 'stale' };
    const readiness = await input.readReadiness();
    if (!this.owns(input.owner)) return { kind: 'stale' };
    const plan = await input.prepare(readiness);
    if (!this.owns(input.owner)) {
      await Promise.resolve(input.cancelLatePlan(plan)).catch(() => undefined);
      return { kind: 'stale' };
    }
    return { kind: 'prepared', readiness, plan };
  }

  publishPlan(plan: ChatTranscriptTransferPlan, owner: VoiceTransferOwner): boolean {
    if (!this.owns(owner) || plan.noteId !== owner.noteId || plan.noteRevision !== owner.revision) return false;
    this.plan = { value: plan, owner };
    return true;
  }

  getPlan(expectedPlanId: string): ChatTranscriptTransferPlan | undefined {
    const live = this.plan;
    return live?.value.planId === expectedPlanId && this.owns(live.owner) ? live.value : undefined;
  }

  clearPlan(expectedPlanId?: string): ChatTranscriptTransferPlan | undefined {
    const live = this.plan;
    if (!live || (expectedPlanId && live.value.planId !== expectedPlanId)) return undefined;
    this.plan = undefined;
    return live.value;
  }
}
