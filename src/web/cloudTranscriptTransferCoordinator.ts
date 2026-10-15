import type { ChatTranscriptTransferPlan } from '../chat/types';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';

type TransferCommand = Extract<WorkspaceCommand, { kind: `chat.transcript.${string}` }>;
type TransferReceipt = NonNullable<WorkspaceCommandResponse['receipt']>;

export type CloudTranscriptTransferState = Readonly<{
  plan?: ChatTranscriptTransferPlan;
  planOwner?: string;
  held?: Readonly<{ commandId: string; kind: TransferCommand['kind']; owner: string; noteId: string; noteRevision: number; planId?: string; conversationId?: string }>;
  busy: boolean;
  notice?: string;
}>;

export type CloudTranscriptTransferResult = Readonly<{ kind: 'accepted'; conversationId: string }>;

type WorkspacePort = Readonly<{
  readSnapshot(): WorkspaceSnapshotDTO | undefined;
  readOperation(): Readonly<{ busy: boolean; pending: boolean; refreshRequired: boolean; pendingCommandId?: string }>;
  execute(command: TransferCommand, onAdmitted?: (commandId: string) => void): Promise<WorkspaceCommandResponse>;
  inspect(commandId: string): Promise<WorkspaceCommandResponse>;
  refresh(): Promise<WorkspaceSnapshotDTO | undefined>;
}>;

function receiptFor<K extends TransferCommand['kind']>(response: WorkspaceCommandResponse, kind: K): Extract<TransferReceipt, { kind: K }> | undefined {
  if (response.status !== 'finished' || response.receipt?.kind !== kind || response.receipt.commandId !== response.commandId) return undefined;
  return response.receipt as Extract<TransferReceipt, { kind: K }>;
}

function ownerOf(snapshot: WorkspaceSnapshotDTO | undefined): string | undefined {
  return snapshot ? `${snapshot.workspaceId}:${snapshot.privacyEpoch}` : undefined;
}

/** Keeps a one-use paid transcript review and its exact ambiguous command in the authenticated session. */
export class CloudTranscriptTransferCoordinator {
  private value: CloudTranscriptTransferState = Object.freeze({ busy: false });
  private readonly listeners = new Set<() => void>();
  private active = true;
  private operationLock = false;
  private generation = 0;

  constructor(private readonly workspace: WorkspacePort) {}

  readonly getSnapshot = (): CloudTranscriptTransferState => this.value;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: CloudTranscriptTransferState): void {
    if (!this.active) return;
    this.value = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }

  private ownerCurrent(owner: string): boolean { return this.active && ownerOf(this.workspace.readSnapshot()) === owner; }

  private source(noteId: string, revision: number, capturedAt: string, captureTimeZone: string, owner: string) {
    const snapshot = this.workspace.readSnapshot();
    if (!snapshot || ownerOf(snapshot) !== owner) return undefined;
    const note = snapshot.state.notes.find((item) => item.id === noteId && item.revision === revision);
    if (!note || note.origin === 'assistant_chat' || note.capturedAt !== capturedAt || note.captureTimeZone !== captureTimeZone ||
        note.importOrigin?.originalTimeZoneUnknown === true || !note.transcript.trim()) return undefined;
    return note;
  }

  private publishPrepared(receipt: Extract<TransferReceipt, { kind: 'chat.transcript.prepare' }> | undefined, held: NonNullable<CloudTranscriptTransferState['held']>): boolean {
    if (!receipt || receipt.kind !== 'chat.transcript.prepare' || receipt.commandId !== held.commandId ||
        receipt.noteId !== held.noteId || receipt.noteRevision !== held.noteRevision || !this.ownerCurrent(held.owner)) return false;
    const note = this.source(receipt.noteId, receipt.noteRevision, receipt.capturedAt, receipt.captureTimeZone, held.owner);
    if (!note || Date.parse(receipt.expiresAt) <= Date.now()) return false;
    const plan: ChatTranscriptTransferPlan = Object.freeze({ planId: receipt.planId, noteId: receipt.noteId,
      noteRevision: receipt.noteRevision, transcript: note.transcript, capturedAt: receipt.capturedAt,
      captureTimeZone: receipt.captureTimeZone, expiresAt: receipt.expiresAt });
    this.publish({ ...this.value, plan, planOwner: `${held.owner}:${note.id}:${note.revision}`, held: undefined,
      notice: 'The saved transcript is ready for review. Sending it to Chat happens only when you choose Send.' });
    return true;
  }

  async prepare(noteId: string, noteRevision: number): Promise<void> {
    const snapshot = this.workspace.readSnapshot();
    const owner = ownerOf(snapshot);
    const operation = this.workspace.readOperation();
    const note = snapshot?.state.notes.find((item) => item.id === noteId && item.revision === noteRevision);
    if (!snapshot || !owner || operation.busy || operation.pending || operation.refreshRequired || this.operationLock || this.value.held ||
        !note || note.origin === 'assistant_chat' || note.importOrigin?.originalTimeZoneUnknown === true || !note.capturedAt || !note.captureTimeZone || !note.transcript.trim()) {
      this.publish({ ...this.value, notice: 'Refresh the current saved note before reviewing its transcript for Chat.' });
      return;
    }
    const generation = ++this.generation;
    const held = { commandId: '', kind: 'chat.transcript.prepare' as const, owner, noteId, noteRevision };
    this.operationLock = true;
    this.publish({ ...this.value, busy: true, notice: undefined });
    try {
      const response = await this.workspace.execute({ kind: 'chat.transcript.prepare', noteId, expectedNoteRevision: noteRevision }, (commandId) => {
        held.commandId = commandId;
        this.publish({ ...this.value, held: Object.freeze({ ...held }) });
      });
      if (generation !== this.generation || !this.ownerCurrent(owner)) return;
      const receipt = receiptFor(response, 'chat.transcript.prepare');
      if (!this.publishPrepared(receipt, Object.freeze({ ...held }))) {
        this.publish({ ...this.value, notice: 'The exact transcript review is not confirmed for the current saved note. Inspect its command before trying again.' });
      }
    } catch (error) {
      if (generation === this.generation && this.ownerCurrent(owner)) this.publish({ ...this.value,
        notice: error instanceof Error ? error.message : 'The transcript review could not be confirmed. Inspect its exact command before trying again.' });
    } finally {
      if (generation === this.generation) { this.operationLock = false; this.publish({ ...this.value, busy: false }); }
    }
  }

  async cancel(planId: string): Promise<void> {
    const plan = this.value.plan;
    const planOwner = this.value.planOwner;
    if (!plan || plan.planId !== planId || !planOwner || this.operationLock || this.value.held) return;
    const snapshot = this.workspace.readSnapshot();
    const workspaceOwner = ownerOf(snapshot);
    const operation = this.workspace.readOperation();
    if (!snapshot || !workspaceOwner || !planOwner.startsWith(`${workspaceOwner}:`) || operation.busy || operation.pending || operation.refreshRequired) {
      this.publish({ ...this.value, notice: 'Resolve the current workspace request before canceling this transcript review.' });
      return;
    }
    const generation = ++this.generation;
    const held = { commandId: '', kind: 'chat.transcript.cancel' as const, owner: workspaceOwner,
      noteId: plan.noteId, noteRevision: plan.noteRevision, planId };
    this.operationLock = true;
    this.publish({ ...this.value, busy: true });
    try {
      const response = await this.workspace.execute({ kind: 'chat.transcript.cancel', planId }, (commandId) => {
        held.commandId = commandId;
        this.publish({ ...this.value, held: Object.freeze({ ...held }) });
      });
      const receipt = receiptFor(response, 'chat.transcript.cancel');
      if (generation === this.generation && this.ownerCurrent(workspaceOwner) && receipt?.planId === planId && receipt.objectId === planId) {
        this.publish({ busy: false, notice: 'Transcript review canceled. No Chat request was sent.' });
      } else if (generation === this.generation) this.publish({ ...this.value, notice: 'The exact transcript cancellation is still being checked. No Chat request was sent.' });
    } catch (error) {
      if (generation === this.generation && this.ownerCurrent(workspaceOwner)) this.publish({ ...this.value, notice: error instanceof Error ? error.message : 'The exact transcript cancellation is still being checked.' });
    } finally { if (generation === this.generation) { this.operationLock = false; this.publish({ ...this.value, busy: false }); } }
  }

  async submit(planId: string, conversationId: string): Promise<CloudTranscriptTransferResult | undefined> {
    const plan = this.value.plan;
    const planOwner = this.value.planOwner;
    if (!plan || plan.planId !== planId || !planOwner || this.operationLock || this.value.held || Date.parse(plan.expiresAt) <= Date.now()) {
      this.publish({ ...this.value, notice: 'This transcript review expired or changed. Review the saved transcript again before sending.' });
      return undefined;
    }
    const snapshot = this.workspace.readSnapshot();
    const owner = ownerOf(snapshot);
    const operation = this.workspace.readOperation();
    const note = owner && this.source(plan.noteId, plan.noteRevision, plan.capturedAt, plan.captureTimeZone, owner);
    if (!snapshot || !owner || !planOwner.startsWith(`${owner}:`) || operation.busy || operation.pending || operation.refreshRequired || !note ||
        !snapshot.state.assistantChatConversations.some((item) => item.id === conversationId)) {
      this.publish({ ...this.value, notice: 'The saved note or conversation changed. Refresh and review the transcript again before sending.' });
      return undefined;
    }
    const generation = ++this.generation;
    const held = { commandId: '', kind: 'chat.transcript.submit' as const, owner, noteId: plan.noteId,
      noteRevision: plan.noteRevision, planId, conversationId };
    this.operationLock = true;
    this.publish({ ...this.value, busy: true, notice: undefined });
    try {
      const response = await this.workspace.execute({ kind: 'chat.transcript.submit', planId, conversationId }, (commandId) => {
        held.commandId = commandId;
        this.publish({ ...this.value, held: Object.freeze({ ...held }) });
      });
      const receipt = receiptFor(response, 'chat.transcript.submit');
      if (generation !== this.generation || !this.ownerCurrent(owner) || receipt?.planId !== planId || receipt.conversationId !== conversationId || receipt.objectId !== conversationId) {
        if (generation === this.generation && this.ownerCurrent(owner)) this.publish({ ...this.value, notice: 'The exact Chat submission is still being checked. Do not send it again.' });
        return undefined;
      }
      this.publish({ busy: false, notice: 'The saved transcript was added to Chat. Check its saved request status when you choose.' });
      if (!response.snapshot) void this.workspace.refresh().catch(() => undefined);
      return { kind: 'accepted', conversationId };
    } catch (error) {
      if (generation === this.generation && this.ownerCurrent(owner)) this.publish({ ...this.value, notice: error instanceof Error ? error.message : 'The exact Chat submission is still being checked.' });
      return undefined;
    } finally { if (generation === this.generation) { this.operationLock = false; this.publish({ ...this.value, busy: false }); } }
  }

  async inspect(commandId: string): Promise<CloudTranscriptTransferResult | undefined> {
    const held = this.value.held;
    if (!held || held.commandId !== commandId || this.operationLock || !commandId) return undefined;
    const generation = ++this.generation;
    this.operationLock = true;
    this.publish({ ...this.value, busy: true, notice: undefined });
    try {
      const response = await this.workspace.inspect(commandId);
      if (generation !== this.generation || !this.ownerCurrent(held.owner)) return undefined;
      if (response.commandId !== commandId || response.status !== 'finished' || response.receipt?.commandId !== commandId || response.receipt.kind !== held.kind) {
        this.publish({ ...this.value, notice: `The exact ${held.kind} command is not confirmed yet. It was not sent again.` });
        return undefined;
      }
      if (held.kind === 'chat.transcript.prepare' && response.receipt.kind === 'chat.transcript.prepare') {
        await this.workspace.refresh();
        if (generation !== this.generation || !this.ownerCurrent(held.owner)) return undefined;
        if (!this.publishPrepared(response.receipt, held)) {
          this.publish({ ...this.value, held: undefined, notice: 'The exact review request finished, but its saved note changed or the review expired. Review the current note again.' });
        }
        return undefined;
      }
      if (held.kind === 'chat.transcript.cancel' && response.receipt.kind === 'chat.transcript.cancel' && response.receipt.planId === held.planId && response.receipt.objectId === held.planId) {
        this.publish({ busy: false, notice: 'Transcript review canceled. No Chat request was sent.' });
        return undefined;
      }
      if (held.kind === 'chat.transcript.submit' && response.receipt.kind === 'chat.transcript.submit' && response.receipt.planId === held.planId && response.receipt.conversationId === held.conversationId && response.receipt.objectId === held.conversationId) {
        this.publish({ busy: false, notice: 'The exact Chat submission is confirmed. Refreshing saved messages; no request was resent.' });
        await this.workspace.refresh();
        if (generation !== this.generation || !this.ownerCurrent(held.owner)) return undefined;
        return { kind: 'accepted', conversationId: held.conversationId! };
      }
      this.publish({ ...this.value, notice: 'The exact receipt did not match the reviewed transcript action.' });
      return undefined;
    } catch (error) {
      if (generation === this.generation && this.ownerCurrent(held.owner)) this.publish({ ...this.value, notice: error instanceof Error ? error.message : 'The exact transcript command could not be checked.' });
      return undefined;
    } finally { if (generation === this.generation) { this.operationLock = false; this.publish({ ...this.value, busy: false }); } }
  }

  dispose(): void {
    this.active = false;
    this.generation += 1;
    this.operationLock = false;
    this.value = Object.freeze({ busy: false });
    this.listeners.clear();
  }
}
