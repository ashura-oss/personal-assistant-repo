import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import { decodeWorkspaceSnapshotDTO } from '../cloud/workspaceSnapshotCodec';
import { WorkspaceClientError, WorkspaceCommandNotStartedError, createWebWorkspaceClient, type WorkspaceClient, type WorkspaceCommandAdmission } from './workspaceClient';
import type { AuthenticatedSession } from './authClient';
import { CloudWorkspace } from './CloudWorkspace';
import { C, s } from '../ui/theme';

export type CloudWorkspaceSessionState = Readonly<{
  status: 'loading' | 'ready' | 'error';
  snapshot?: WorkspaceSnapshotDTO;
  busy: boolean;
  pendingCommand?: Readonly<{ commandId: string; kind: WorkspaceCommand['kind'] }>;
  refreshRequired: boolean;
  error?: string;
}>;

const INITIAL_STATE: CloudWorkspaceSessionState = Object.freeze({ status: 'loading', busy: false, refreshRequired: false });

/** One authenticated workspace/epoch owns one disposable, receipt-aware browser client. */
export class CloudWorkspaceSessionStore {
  private value: CloudWorkspaceSessionState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private client?: WorkspaceClient;
  private ownerGeneration = 0;
  private active = false;
  private operationInFlight = false;
  private operationTicket = 0;

  constructor(private readonly session: AuthenticatedSession) {}

  readonly getSnapshot = (): CloudWorkspaceSessionState => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: CloudWorkspaceSessionState): void {
    this.value = Object.freeze(next);
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

  start(): () => void {
    this.disposeClient();
    this.operationInFlight = false;
    this.operationTicket += 1;
    this.active = true;
    const owner = ++this.ownerGeneration;
    const operation = this.beginOperation();
    this.client = createWebWorkspaceClient(this.session, {
      decodeSnapshot: decodeWorkspaceSnapshotDTO,
      assertCurrent: () => { if (!this.isCurrent(owner)) throw new Error('Cloud workspace owner changed.'); },
    });
    this.publish({ status: 'loading', busy: false, refreshRequired: false });
    void this.loadInitial(owner, operation);
    return () => {
      if (!this.isCurrent(owner)) return;
      this.active = false;
      this.ownerGeneration += 1;
      this.operationInFlight = false;
      this.operationTicket += 1;
      this.disposeClient();
    };
  }

  private disposeClient(): void {
    this.client?.dispose();
    this.client = undefined;
  }

  private currentClient(): WorkspaceClient {
    if (!this.active || !this.client) throw new WorkspaceClientError('disposed', 'This workspace session is no longer active.');
    return this.client;
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
    try {
      const response = await client.execute(command, onAdmitted);
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
        this.publish({ ...this.value, busy: false, ...(pending ? { pendingCommand: { commandId: pending.commandId, kind: pending.command.kind } } : {}),
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
    this.active = false;
    this.ownerGeneration += 1;
    this.operationInFlight = false;
    this.operationTicket += 1;
    this.disposeClient();
    this.publish({ status: 'loading', busy: false, refreshRequired: true });
  }
}

export function CloudWorkspaceSession({ session, onLogout }: { session: AuthenticatedSession; onLogout: () => void }) {
  const [store] = useState(() => new CloudWorkspaceSessionStore(session));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.start(), [store]);

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

  return <CloudWorkspace store={store} state={state} onLogout={() => { store.invalidate(); onLogout(); }} />;
}
