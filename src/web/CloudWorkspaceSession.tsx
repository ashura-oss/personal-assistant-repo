import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { KnowledgeSourceChoicesDTO, KnowledgeSuggestionReviewDTO } from '../cloud/knowledgeHttpContracts';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { DispatchReviewReadDto, MailReplyBatchReviewReadDto, MailReplySourceReadDto, MailReplyTextReadDto, ProposalReviewReadDto } from './mailWorkflowDtos';
import type { ReplyBatchPlanRead } from './cloudMailClient';
import { decodeWorkspaceSnapshotDTO } from '../cloud/workspaceSnapshotCodec';
import { WorkspaceClientError, WorkspaceCommandNotStartedError, createWebWorkspaceClient, type WorkspaceClient, type WorkspaceCommandAdmission } from './workspaceClient';
import type { AuthenticatedSession } from './authClient';
import { CloudWorkspace } from './CloudWorkspace';
import { createWebAudioUploadClient, type AudioUploadClient } from './audioClient';
import { CloudVoiceCoordinator, type CloudVoiceCapturePort, type CloudVoiceCoordinatorState } from './cloudVoiceCoordinator';
import { useCloudAudioCapture } from './useCloudAudioCapture';
import { C, s } from '../ui/theme';
import { useCloudCredentials } from './useCloudCredentials';
import { CloudOAuthCoordinator, type CloudOAuthState } from './cloudOAuthCoordinator';
import { CloudMailCoordinator, type CloudMailCoordinatorState } from './cloudMailCoordinator';

export type CloudWorkspaceSessionState = Readonly<{
  status: 'loading' | 'ready' | 'error';
  snapshot?: WorkspaceSnapshotDTO;
  busy: boolean;
  pendingCommand?: Readonly<{ commandId: string; kind: WorkspaceCommand['kind'] }>;
  voice?: CloudVoiceCoordinatorState;
  oauth?: CloudOAuthState;
  mail?: CloudMailCoordinatorState;
  refreshRequired: boolean;
  error?: string;
}>;

const INITIAL_STATE: CloudWorkspaceSessionState = Object.freeze({ status: 'loading', busy: false, refreshRequired: false });

/** One authenticated workspace/epoch owns one disposable, receipt-aware browser client. */
export class CloudWorkspaceSessionStore {
  private value: CloudWorkspaceSessionState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private client?: WorkspaceClient;
  private audioClient?: AudioUploadClient;
  private voiceCoordinator?: CloudVoiceCoordinator;
  private unsubscribeVoice?: () => void;
  private oauthCoordinator?: CloudOAuthCoordinator;
  private unsubscribeOAuth?: () => void;
  private mailCoordinator?: CloudMailCoordinator;
  private unsubscribeMail?: () => void;
  private ownerGeneration = 0;
  private active = false;
  private operationInFlight = false;
  private operationTicket = 0;

  readonly voiceActions: CloudWorkspaceVoiceActions;

  constructor(private readonly session: AuthenticatedSession) {
    this.voiceActions = Object.freeze({
      start: () => this.currentVoiceCoordinator().start(),
      pause: () => this.currentVoiceCoordinator().pause(),
      resume: () => this.currentVoiceCoordinator().resume(),
      stopAndSave: () => this.currentVoiceCoordinator().stopAndSave(),
      uploadStoppedClip: () => this.currentVoiceCoordinator().uploadStoppedClip(),
      saveReady: () => this.currentVoiceCoordinator().saveReady(),
      inspectUpload: (uploadId: string) => this.currentVoiceCoordinator().inspectUpload(uploadId),
      listHistory: (cursor?: string) => this.currentVoiceCoordinator().listHistory(cursor),
      inspectAdoption: (commandId?: string) => this.currentVoiceCoordinator().inspectAdoption(commandId),
      discardLocalClip: () => this.currentVoiceCoordinator().discardLocalClip(),
      cancelCurrentRecording: () => this.currentVoiceCoordinator().cancelCurrentRecording(),
      resetAfterSave: () => this.currentVoiceCoordinator().resetAfterSave(),
    });
  }

  readonly getSnapshot = (): CloudWorkspaceSessionState => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: CloudWorkspaceSessionState): void {
    const { voice: _callerVoice, oauth: _callerOAuth, mail: _callerMail, ...withoutCallerOwnedState } = next;
    void _callerVoice;
    void _callerOAuth;
    void _callerMail;
    const coordinator = this.active ? this.voiceCoordinator : undefined;
    const voice = coordinator?.getSnapshot();
    const oauth = this.active ? this.oauthCoordinator?.getSnapshot() : undefined;
    const mail = this.active ? this.mailCoordinator?.getSnapshot() : undefined;
    this.value = Object.freeze({ ...withoutCallerOwnedState, ...(voice ? { voice } : {}), ...(oauth ? { oauth } : {}), ...(mail ? { mail } : {}) });
    for (const listener of this.listeners) listener();
  }

  private isCurrent(owner: number): boolean { return this.active && this.ownerGeneration === owner; }

  private beginOperation(): number {
    if (this.operationInFlight) throw new WorkspaceClientError('busy', 'A workspace request is already in progress.');
    this.operationInFlight = true;
    return ++this.operationTicket;
  }

  private finishOperation(ticket: number, owner: number): void {
    if (this.operationTicket !== ticket) return;
    this.operationInFlight = false;
    if (this.isCurrent(owner)) this.publish({ ...this.value, busy: false });
  }

  start(getCapture?: () => CloudVoiceCapturePort): () => void {
    this.invalidateGeneration();
    this.disposeResources();
    this.operationInFlight = false;
    this.operationTicket += 1;
    this.active = true;
    const owner = ++this.ownerGeneration;
    const operation = this.beginOperation();
    this.client = createWebWorkspaceClient(this.session, {
      decodeSnapshot: decodeWorkspaceSnapshotDTO,
      assertCurrent: () => { if (!this.isCurrent(owner)) throw new Error('Cloud workspace owner changed.'); },
    });
    const oauthCoordinator = new CloudOAuthCoordinator(this.session, { workspace: {
      readSnapshot: () => this.isCurrent(owner) ? this.value.snapshot : undefined,
      readWorkspaceOperation: () => ({ busy: this.value.busy, pending: Boolean(this.value.pendingCommand), refreshRequired: this.value.refreshRequired }),
      execute: (command, onAdmitted) => this.execute(command, (envelope) => onAdmitted(envelope.commandId)),
      inspect: (commandId) => this.inspect(commandId),
      refresh: () => this.refresh(),
    } });
    this.oauthCoordinator = oauthCoordinator;
    this.unsubscribeOAuth = oauthCoordinator.subscribe(() => {
      if (this.isCurrent(owner) && this.oauthCoordinator === oauthCoordinator) this.publish({ ...this.value, oauth: oauthCoordinator.getSnapshot() });
    });
    const mailCoordinator = new CloudMailCoordinator({
      readSnapshot: () => this.isCurrent(owner) ? this.value.snapshot : undefined,
      readOperation: () => ({ busy: this.value.busy, pending: Boolean(this.value.pendingCommand), refreshRequired: this.value.refreshRequired,
        ...(this.value.pendingCommand ? { pendingCommandId: this.value.pendingCommand.commandId } : {}) }),
      readMailReplySource: (messageId, expectedRevision) => this.readMailReplySource(messageId, expectedRevision),
      readMailReplyText: (messageId, expectedRevision, source) => this.readMailReplyText(messageId, expectedRevision, source),
      readProposalReview: (proposalId, expectedRevision) => this.readProposalReview(proposalId, expectedRevision),
      readDispatchReview: (recordId, expectedRevision) => this.readDispatchReview(recordId, expectedRevision),
      readReplyBatchReview: (plan, expectedRevision) => this.readReplyBatchReview(plan, expectedRevision),
      execute: (command, onAdmitted) => this.execute(command, onAdmitted),
      inspect: (commandId) => this.inspect(commandId),
      refresh: () => this.refresh(),
    });
    this.mailCoordinator = mailCoordinator;
    this.unsubscribeMail = mailCoordinator.subscribe(() => {
      if (this.isCurrent(owner) && this.mailCoordinator === mailCoordinator) this.publish({ ...this.value, mail: mailCoordinator.getSnapshot() });
    });
    if (getCapture) {
      this.audioClient = createWebAudioUploadClient(this.session, {
        assertCurrent: () => { if (!this.isCurrent(owner)) throw new Error('Cloud workspace owner changed.'); },
      });
      const coordinator = new CloudVoiceCoordinator({
        audio: this.audioClient,
        workspace: {
          execute: (command, onAdmitted) => this.execute(command, onAdmitted),
          inspect: (commandId) => this.inspect(commandId),
          refresh: () => this.refresh(),
          readSnapshot: () => this.isCurrent(owner) ? this.value.snapshot : undefined,
        },
        getCapture,
        disposeAudioOnDispose: false,
      });
      this.voiceCoordinator = coordinator;
      this.unsubscribeVoice = coordinator.subscribe(() => {
        if (this.isCurrent(owner) && this.voiceCoordinator === coordinator) {
          this.publish({ ...this.value, voice: coordinator.getSnapshot() });
        }
      });
    }
    this.publish({ status: 'loading', busy: false, refreshRequired: false });
    void this.loadInitial(owner, operation);
    return () => {
      if (!this.isCurrent(owner)) return;
      this.invalidateGeneration();
      this.disposeResources();
    };
  }

  private invalidateGeneration(): void {
    this.active = false;
    this.ownerGeneration += 1;
    this.operationInFlight = false;
    this.operationTicket += 1;
  }

  private disposeResources(): void {
    this.unsubscribeMail?.();
    this.unsubscribeMail = undefined;
    this.mailCoordinator?.dispose();
    this.mailCoordinator = undefined;
    this.unsubscribeVoice?.();
    this.unsubscribeVoice = undefined;
    this.unsubscribeOAuth?.();
    this.unsubscribeOAuth = undefined;
    this.oauthCoordinator?.dispose();
    this.oauthCoordinator = undefined;
    this.voiceCoordinator?.dispose();
    this.voiceCoordinator = undefined;
    this.audioClient?.dispose();
    this.audioClient = undefined;
    this.client?.dispose();
    this.client = undefined;
  }

  private currentClient(): WorkspaceClient {
    if (!this.active || !this.client) throw new WorkspaceClientError('disposed', 'This workspace session is no longer active.');
    return this.client;
  }

  private currentVoiceCoordinator(): CloudVoiceCoordinator {
    if (!this.active || !this.voiceCoordinator) {
      throw new WorkspaceClientError('disposed', 'This workspace voice session is no longer active.');
    }
    return this.voiceCoordinator;
  }

  getOAuthCoordinator(): CloudOAuthCoordinator | undefined {
    if (!this.active) return undefined;
    return this.oauthCoordinator;
  }

  getMailCoordinator(): CloudMailCoordinator | undefined {
    if (!this.active) return undefined;
    return this.mailCoordinator;
  }

  async cancelTranscription(commandId: string): Promise<'cancellation_requested' | 'not_running'> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    const result = await client.cancelTranscription(commandId);
    if (!this.isCurrent(owner)) throw new WorkspaceClientError('stale', 'The workspace session changed.');
    return result;
  }

  private async loadInitial(owner: number, operation: number): Promise<void> {
    try {
      const snapshot = await this.currentClient().getSnapshot();
      if (!this.isCurrent(owner)) return;
      this.publish({ status: 'ready', snapshot, busy: false, refreshRequired: false });
    } catch (error) {
      if (!this.isCurrent(owner)) return;
      this.publish({ status: 'error', busy: false, refreshRequired: true, error: this.message(error) });
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  private message(error: unknown): string {
    return error instanceof WorkspaceClientError
      ? error.message
      : 'The workspace response could not be confirmed.';
  }

  async readKnowledgeSourceChoices(expectedRevision: number): Promise<KnowledgeSourceChoicesDTO> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    const current = this.value.snapshot;
    if (!current || current.workspaceId !== this.session.workspaceId || current.privacyEpoch !== this.session.privacyEpoch || current.revision !== expectedRevision) {
      throw new WorkspaceClientError('stale', 'The workspace changed. Reload it before loading source choices.');
    }
    const operation = this.beginOperation();
    this.publish({ ...this.value, busy: true, error: undefined });
    try {
      const result = await client.readKnowledgeSourceChoices(expectedRevision);
      const latest = this.value.snapshot;
      if (!this.isCurrent(owner) || !latest || latest.workspaceId !== current.workspaceId || latest.privacyEpoch !== current.privacyEpoch || latest.revision !== expectedRevision) {
        throw new WorkspaceClientError('stale', 'The workspace changed while source choices were loading. Reload before continuing.');
      }
      return result;
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  async readKnowledgeSuggestionReview(input: Readonly<{ suggestionId: string; expectedSuggestionRevision: number; expectedRevision: number }>): Promise<KnowledgeSuggestionReviewDTO> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    const current = this.value.snapshot;
    if (!current || current.workspaceId !== this.session.workspaceId || current.privacyEpoch !== this.session.privacyEpoch || current.revision !== input.expectedRevision) {
      throw new WorkspaceClientError('stale', 'The workspace changed. Reload it before preparing this suggestion.');
    }
    const operation = this.beginOperation();
    this.publish({ ...this.value, busy: true, error: undefined });
    try {
      const result = await client.readKnowledgeSuggestionReview(input);
      const latest = this.value.snapshot;
      if (!this.isCurrent(owner) || !latest || latest.workspaceId !== current.workspaceId || latest.privacyEpoch !== current.privacyEpoch || latest.revision !== input.expectedRevision) {
        throw new WorkspaceClientError('stale', 'The workspace changed while the suggestion was loading. Reload before continuing.');
      }
      return result;
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  private async readSavedMail<T>(expectedRevision: number, read: (client: WorkspaceClient) => Promise<T>): Promise<T> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    const current = this.value.snapshot;
    if (!current || current.workspaceId !== this.session.workspaceId || current.privacyEpoch !== this.session.privacyEpoch || current.revision !== expectedRevision) {
      throw new WorkspaceClientError('stale', 'The workspace changed. Refresh it before opening saved mail or proposal details.');
    }
    const operation = this.beginOperation();
    this.publish({ ...this.value, busy: true, error: undefined });
    try {
      const result = await read(client);
      const latest = this.value.snapshot;
      if (!this.isCurrent(owner) || !latest || latest.workspaceId !== current.workspaceId || latest.privacyEpoch !== current.privacyEpoch || latest.revision !== expectedRevision) {
        throw new WorkspaceClientError('stale', 'The workspace changed while saved details were loading. Refresh before continuing.');
      }
      return result;
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  readMailReplySource(messageId: string, expectedRevision: number): Promise<MailReplySourceReadDto> {
    return this.readSavedMail(expectedRevision, (client) => client.readMailReplySource(messageId, expectedRevision));
  }

  readMailReplyText(messageId: string, expectedRevision: number, source: NonNullable<MailReplySourceReadDto['source']>): Promise<MailReplyTextReadDto> {
    return this.readSavedMail(expectedRevision, (client) => client.readMailReplyText(messageId, expectedRevision, source));
  }

  readProposalReview(proposalId: string, expectedRevision: number): Promise<ProposalReviewReadDto> {
    return this.readSavedMail(expectedRevision, (client) => client.readProposalReview(proposalId, expectedRevision));
  }

  readDispatchReview(recordId: string, expectedRevision: number): Promise<DispatchReviewReadDto> {
    return this.readSavedMail(expectedRevision, (client) => client.readDispatchReview(recordId, expectedRevision));
  }

  readReplyBatchReview(plan: ReplyBatchPlanRead, expectedRevision: number): Promise<MailReplyBatchReviewReadDto> {
    return this.readSavedMail(expectedRevision, (client) => client.readReplyBatchReview(plan, expectedRevision));
  }

  async refresh(): Promise<WorkspaceSnapshotDTO | undefined> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    const operation = this.beginOperation();
    this.publish({ ...this.value, busy: true, error: undefined });
    try {
      const snapshot = await client.refresh();
      if (!this.isCurrent(owner)) return undefined;
      const pending = client.getPendingCommand();
      this.publish({ status: 'ready', snapshot, busy: false, refreshRequired: false,
        ...(pending ? { pendingCommand: { commandId: pending.commandId, kind: pending.command.kind }, error: 'A refreshed snapshot does not resolve the pending command. Inspect its exact receipt before continuing.' } : {}) });
      return snapshot;
    } catch (error) {
      if (this.isCurrent(owner)) this.publish({ ...this.value, status: this.value.snapshot ? 'ready' : 'error', busy: false, refreshRequired: true, error: this.message(error) });
      return undefined;
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  async execute(command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    let operation: number;
    try { operation = this.beginOperation(); }
    catch (error) {
      if (error instanceof WorkspaceClientError && error.kind === 'busy') throw new WorkspaceCommandNotStartedError(error.message);
      throw error;
    }
    this.publish({ ...this.value, busy: true, error: undefined });
    let publishedCommandId: string | undefined;
    try {
      const response = await client.execute(command, (envelope) => {
        if (!this.isCurrent(owner)) throw new WorkspaceClientError('stale', 'The workspace session changed.');
        publishedCommandId = envelope.commandId;
        this.publish({ ...this.value, pendingCommand: { commandId: envelope.commandId, kind: envelope.command.kind } });
        onAdmitted?.(envelope);
      });
      if (!this.isCurrent(owner)) throw new WorkspaceClientError('stale', 'The workspace session changed.');
      const snapshot = response.snapshot ?? this.value.snapshot;
      const refreshRequired = !response.snapshot;
      const pending = response.status === 'finished' ? undefined : client.getPendingCommand();
      this.publish({ status: snapshot ? 'ready' : 'error', ...(snapshot ? { snapshot } : {}), busy: false,
        ...(pending ? { pendingCommand: { commandId: pending.commandId, kind: pending.command.kind } } : {}),
        refreshRequired, ...(refreshRequired ? { error: 'The command receipt was recorded. Refresh the workspace to load its current state.' } : {}) });
      return response;
    } catch (error) {
      if (this.isCurrent(owner)) {
        const pending = client.getPendingCommand();
        const currentPending = this.value.pendingCommand;
        let base = this.value;
        if (!pending && publishedCommandId && currentPending?.commandId === publishedCommandId) {
          const { pendingCommand: _discarded, ...withoutPending } = this.value;
          void _discarded;
          base = withoutPending;
        }
        this.publish({ ...base, busy: false, ...(pending ? { pendingCommand: { commandId: pending.commandId, kind: pending.command.kind } } : {}),
          ...(error instanceof WorkspaceCommandNotStartedError ? { error: this.message(error) } : { refreshRequired: true, error: this.message(error) }) });
      }
      throw error;
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  async inspect(commandId: string): Promise<WorkspaceCommandResponse> {
    const owner = this.ownerGeneration;
    const client = this.currentClient();
    const operation = this.beginOperation();
    this.publish({ ...this.value, busy: true, error: undefined });
    try {
      const response = await client.inspectCommand(commandId);
      if (!this.isCurrent(owner)) throw new WorkspaceClientError('stale', 'The workspace session changed.');
      const snapshot = response.snapshot ?? this.value.snapshot;
      const refreshRequired = !response.snapshot;
      const pending = client.getPendingCommand();
      this.publish({ status: snapshot ? 'ready' : 'error', ...(snapshot ? { snapshot } : {}), busy: false,
        ...(pending ? { pendingCommand: { commandId: pending.commandId, kind: pending.command.kind } } : {}),
        refreshRequired, ...(refreshRequired ? { error: 'The receipt was read, but the current workspace state still needs a refresh.' } : {}) });
      return response;
    } catch (error) {
      if (this.isCurrent(owner)) this.publish({ ...this.value, busy: false, refreshRequired: true, error: this.message(error) });
      throw error;
    } finally {
      this.finishOperation(operation, owner);
    }
  }

  /** Invalidates every in-flight read and write before clearing the session-owned client. */
  invalidate(): void {
    this.invalidateGeneration();
    this.disposeResources();
    this.publish({ status: 'loading', busy: false, refreshRequired: true });
  }
}

export type CloudWorkspaceVoiceActions = Readonly<{
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stopAndSave(): Promise<void>;
  uploadStoppedClip(): Promise<void>;
  saveReady(): Promise<void>;
  inspectUpload(uploadId: string): ReturnType<CloudVoiceCoordinator['inspectUpload']>;
  listHistory(cursor?: string): ReturnType<CloudVoiceCoordinator['listHistory']>;
  inspectAdoption(commandId?: string): Promise<void>;
  discardLocalClip(): Promise<void>;
  cancelCurrentRecording(): Promise<void>;
  resetAfterSave(): void;
}>;

export function CloudWorkspaceSession({ session, onLogout }: { session: AuthenticatedSession; onLogout: () => void }) {
  const credentials = useCloudCredentials(session);
  const capture = useCloudAudioCapture();
  const captureRef = useRef(capture);
  useLayoutEffect(() => { captureRef.current = capture; }, [capture]);
  const getCapture = useCallback(() => captureRef.current, []);
  const [store] = useState(() => new CloudWorkspaceSessionStore(session));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const initialRetryLock = useRef(false);
  useEffect(() => store.start(getCapture), [store, getCapture]);

  const retryWorkspace = async () => {
    if (initialRetryLock.current || state.busy) return;
    initialRetryLock.current = true;
    try { await store.refresh(); }
    catch { /* refresh publishes its safe error; this also catches synchronous disposed/busy failures. */ }
    finally { initialRetryLock.current = false; }
  };

  if (!state.snapshot) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={s.safe}>
          <View style={[s.viewport, { alignItems: 'center', justifyContent: 'center', gap: 12 }]}>
            {state.status === 'loading' ? <ActivityIndicator color={C.sage} /> : null}
            <Text style={s.accountSub}>{state.error ?? 'Opening your saved workspace…'}</Text>
            {state.status === 'error' ? <>
              <Text style={s.accountSub}>Your workspace could not be loaded. Retry this session or sign out to check your session again.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Retry workspace" disabled={state.busy} onPress={() => { void retryWorkspace(); }} style={recoveryStyles.primary}>
                <Text style={recoveryStyles.primaryText}>{state.busy ? 'Retrying…' : 'Retry workspace'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Sign out" disabled={state.busy} onPress={() => { store.invalidate(); onLogout(); }} style={recoveryStyles.secondary}>
                <Text style={recoveryStyles.secondaryText}>Sign out</Text>
              </Pressable>
            </> : null}
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return <CloudWorkspace store={store} state={state} onLogout={() => { store.invalidate(); onLogout(); }} credentials={credentials} oauthCoordinator={store.getOAuthCoordinator()} mailCoordinator={store.getMailCoordinator()} voiceCapability={state.voice ? {
    available: true,
    capture: { status: capture.status, canResume: capture.canResume, durationSeconds: capture.durationSeconds,
      meter: capture.meter, hasPending: capture.hasPending, ...(capture.statusLabel ? { statusLabel: capture.statusLabel } : {}),
      ...(capture.error ? { error: capture.error } : {}) },
    voice: state.voice,
    actions: store.voiceActions,
    cancelTranscription: (commandId) => store.cancelTranscription(commandId),
  } : { available: false, reason: 'Browser recording is not ready in this workspace session.' }} />;
}

const recoveryStyles = {
  primary: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: C.sage, alignItems: 'center' as const, justifyContent: 'center' as const },
  primaryText: { color: C.bg, fontSize: 15, fontWeight: '700' as const },
  secondary: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: C.border, alignItems: 'center' as const, justifyContent: 'center' as const },
  secondaryText: { color: C.text, fontSize: 15, fontWeight: '600' as const },
};
