import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import { decodeWorkspaceSnapshotDTO } from '../cloud/workspaceSnapshotCodec';
import { WorkspaceClientError, WorkspaceCommandNotStartedError, createWebWorkspaceClient, type WorkspaceClient, type WorkspaceCommandAdmission } from './workspaceClient';
import type { AuthenticatedSession } from './authClient';
import { CloudWorkspace } from './CloudWorkspace';
import { createWebAudioUploadClient, type AudioUploadClient } from './audioClient';
import { CloudVoiceCoordinator, type CloudVoiceCapturePort, type CloudVoiceCoordinatorState } from './cloudVoiceCoordinator';
import { useCloudAudioCapture } from './useCloudAudioCapture';
import { C, s } from '../ui/theme';
import { useCloudCredentials } from './useCloudCredentials';

export type CloudWorkspaceSessionState = Readonly<{
  status: 'loading' | 'ready' | 'error';
  snapshot?: WorkspaceSnapshotDTO;
  busy: boolean;
  pendingCommand?: Readonly<{ commandId: string; kind: WorkspaceCommand['kind'] }>;
  voice?: CloudVoiceCoordinatorState;
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
    const { voice: _callerVoice, ...withoutCallerVoice } = next;
    void _callerVoice;
    const coordinator = this.active ? this.voiceCoordinator : undefined;
    const voice = coordinator?.getSnapshot();
    this.value = Object.freeze({ ...withoutCallerVoice, ...(voice ? { voice } : {}) });
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
    this.unsubscribeVoice?.();
    this.unsubscribeVoice = undefined;
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
  useEffect(() => store.start(getCapture), [store, getCapture]);

  if (!state.snapshot) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={s.safe}>
          <View style={[s.viewport, { alignItems: 'center', justifyContent: 'center', gap: 12 }]}>
            {state.status === 'loading' ? <ActivityIndicator color={C.sage} /> : null}
            <Text style={s.accountSub}>{state.error ?? 'Opening your saved workspace…'}</Text>
            {state.status === 'error' ? <Text style={s.accountSub}>Check session or reload this workspace to continue.</Text> : null}
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return <CloudWorkspace store={store} state={state} onLogout={() => { store.invalidate(); onLogout(); }} credentials={credentials} voiceCapability={state.voice ? {
    available: true,
    capture: { status: capture.status, canResume: capture.canResume, durationSeconds: capture.durationSeconds,
      meter: capture.meter, hasPending: capture.hasPending, ...(capture.statusLabel ? { statusLabel: capture.statusLabel } : {}),
      ...(capture.error ? { error: capture.error } : {}) },
    voice: state.voice,
    actions: store.voiceActions,
    cancelTranscription: (commandId) => store.cancelTranscription(commandId),
  } : { available: false, reason: 'Browser recording is not ready in this workspace session.' }} />;
}
