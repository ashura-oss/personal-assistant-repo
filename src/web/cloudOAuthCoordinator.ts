import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { AuthenticatedSession } from './authClient';
import type { OAuthClient, OAuthAttemptMetadata, OAuthAvailability, OAuthCapability, OAuthProvider, OAuthStageStatus, OAuthVerifiedAccountPreview } from './cloudOAuthClient';
import { OAuthClientError, createCloudOAuthClient } from './cloudOAuthClient';

export type CloudOAuthState = Readonly<{
  availability?: OAuthAvailability;
  attempts: readonly OAuthAttemptMetadata[];
  stage?: OAuthStageStatus;
  verifiedAccount?: OAuthVerifiedAccountPreview;
  loading: boolean;
  operation?: 'starting' | 'inspecting' | 'installing';
  workspaceRefreshRequired?: boolean;
  unknownStart?: Readonly<{ provider: OAuthProvider; attemptId: string; restartOf?: string }>;
  installCommandId?: string;
  installStageId?: string;
  message?: string;
}>;
export type OAuthWorkspacePort = Readonly<{
  readSnapshot(): WorkspaceSnapshotDTO | undefined;
  readWorkspaceOperation(): Readonly<{ busy: boolean; pending: boolean; refreshRequired: boolean }>;
  execute(command: Readonly<{ kind: 'accounts.installOAuth'; stageId: string }>, onAdmitted: (commandId: string) => void): Promise<WorkspaceCommandResponse>;
  inspect(commandId: string): Promise<WorkspaceCommandResponse>;
  refresh(): Promise<WorkspaceSnapshotDTO | undefined>;
}>;
export type CloudOAuthCoordinatorOptions = Readonly<{
  workspace: OAuthWorkspacePort;
  navigate?: (url: string) => void;
  replaceCallbackHint?: (stageId: string) => void;
  client?: OAuthClient;
  makeAttemptId?: () => string;
}>;

function uuid(): string {
  const api = globalThis.crypto;
  if (typeof api?.randomUUID === 'function') return api.randomUUID();
  if (!api?.getRandomValues) throw new OAuthClientError('network', 'A secure connection request identifier is unavailable.');
  const bytes = api.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function callbackHint(): string | undefined {
  if (typeof window === 'undefined' || window.location.pathname !== '/') return undefined;
  const params = new URLSearchParams(window.location.search);
  const hints = params.getAll('oauth_stage');
  return hints.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hints[0]!) ? hints[0] : undefined;
}
function replaceValidatedCallbackHint(stageId: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.pathname !== '/' || url.searchParams.getAll('oauth_stage').length !== 1 || url.searchParams.get('oauth_stage') !== stageId) return;
  url.searchParams.delete('oauth_stage');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function safeError(error: unknown): string {
  return error instanceof OAuthClientError ? error.message : 'The connection action could not be confirmed.';
}
function exactInstallReceipt(response: WorkspaceCommandResponse, commandId: string, stageId: string) {
  const receipt = response.receipt;
  return response.status === 'finished' && response.commandId === commandId && receipt?.kind === 'accounts.installOAuth' &&
    receipt.commandId === commandId && receipt.stageId === stageId && receipt.accountGeneration >= 1 && receipt.objectId.length > 0
    ? receipt : undefined;
}

/** Keeps OAuth attempts and safe stage status alive across tabs/settings close for one authenticated owner. */
export class CloudOAuthCoordinator {
  private value: CloudOAuthState = Object.freeze({ attempts: Object.freeze([]), loading: false });
  private readonly listeners = new Set<() => void>();
  private readonly client: OAuthClient;
  private active = true;
  private generation = 1;
  private operationLock = false;
  private workspaceOperation: OAuthWorkspacePort;
  private navigate: (url: string) => void;
  private replaceHint: (stageId: string) => void;
  private readonly workspaceId: string;
  private readonly privacyEpoch: number;
  private readonly makeAttemptId: () => string;

  constructor(session: AuthenticatedSession, options: CloudOAuthCoordinatorOptions) {
    this.client = options.client ?? createCloudOAuthClient(session);
    this.workspaceOperation = options.workspace;
    this.navigate = options.navigate ?? ((url) => { if (typeof window !== 'undefined') window.location.assign(url); });
    this.replaceHint = options.replaceCallbackHint ?? replaceValidatedCallbackHint;
    this.workspaceId = session.workspaceId;
    this.privacyEpoch = session.privacyEpoch;
    this.makeAttemptId = options.makeAttemptId ?? uuid;
  }

  readonly getSnapshot = (): CloudOAuthState => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private ownsWorkspace(): boolean {
    const snapshot = this.workspaceOperation.readSnapshot();
    return Boolean(snapshot && snapshot.workspaceId === this.workspaceId && snapshot.privacyEpoch === this.privacyEpoch);
  }
  private publish(patch: Partial<CloudOAuthState>): void {
    if (!this.active || !this.ownsWorkspace()) return;
    this.value = Object.freeze({ ...this.value, ...patch });
    for (const listener of this.listeners) listener();
  }
  private current(generation: number): boolean { return this.active && this.generation === generation && this.ownsWorkspace(); }
  private begin(): number | undefined {
    if (!this.current(this.generation) || this.operationLock) return undefined;
    this.operationLock = true;
    return this.generation;
  }
  private finish(generation: number): void { if (this.current(generation)) this.operationLock = false; }
  private workspaceReady(): WorkspaceSnapshotDTO {
    if (this.value.workspaceRefreshRequired) throw new OAuthClientError('stale', 'Refresh the workspace before starting or installing a connection.');
    const workspace = this.workspaceOperation.readWorkspaceOperation();
    const snapshot = this.workspaceOperation.readSnapshot();
    if (!snapshot || snapshot.workspaceId !== this.workspaceId || snapshot.privacyEpoch !== this.privacyEpoch || workspace.busy || workspace.pending || workspace.refreshRequired) {
      throw new OAuthClientError('stale', 'Resolve the current workspace operation before starting or installing a connection.');
    }
    return snapshot;
  }

  async open(): Promise<void> {
    const generation = this.begin();
    if (generation === undefined) return;
    this.publish({ loading: true, message: undefined });
    try {
      const [availability, attempts] = await Promise.all([this.client.availability(), this.client.listStarts()]);
      if (!this.current(generation)) return;
      this.publish({ availability, attempts, loading: false });
      const hint = callbackHint();
      if (hint) {
        const inspection = await this.client.inspectStage(hint);
        if (!this.current(generation)) return;
        const stage = inspection.stage;
        this.publish({ stage, ...(inspection.verifiedAccount ? { verifiedAccount: inspection.verifiedAccount } : { verifiedAccount: undefined }),
          message: stage.status === 'verified' ? 'A connection is verified. Review the account and access below; choose Add account only when ready.' : `Connection status · ${stage.status.replaceAll('_', ' ')}. Returning to Still did not add an account.` });
        this.replaceHint(hint);
      }
    } catch (error) {
      if (this.current(generation)) this.publish({ loading: false, message: safeError(error) });
    } finally { this.finish(generation); }
  }

  async refreshAttempts(): Promise<void> {
    const generation = this.begin();
    if (generation === undefined) return;
    this.publish({ loading: true, message: undefined });
    try {
      const attempts = await this.client.listStarts();
      if (this.current(generation)) this.publish({ attempts, loading: false });
    } catch (error) { if (this.current(generation)) this.publish({ loading: false, message: safeError(error) }); }
    finally { this.finish(generation); }
  }

  async refreshWorkspace(): Promise<void> {
    if (!this.value.workspaceRefreshRequired) return;
    const generation = this.begin();
    if (generation === undefined) return;
    this.publish({ operation: 'inspecting', message: undefined });
    try {
      const snapshot = await this.workspaceOperation.refresh();
      if (!this.current(generation)) return;
      if (!snapshot || snapshot.workspaceId !== this.workspaceId || snapshot.privacyEpoch !== this.privacyEpoch) {
        this.publish({ operation: undefined, message: 'The workspace could not be refreshed. Retry before starting another connection.' });
        return;
      }
      this.publish({ workspaceRefreshRequired: false, operation: undefined, message: 'Workspace refreshed. Review the current saved details before starting another connection.' });
    } catch {
      if (this.current(generation)) this.publish({ operation: undefined, message: 'The workspace could not be refreshed. Retry before starting another connection.' });
    } finally { this.finish(generation); }
  }

  async start(provider: OAuthProvider, capabilities: readonly OAuthCapability[], reconnectAccountId?: string, restartOfStartAttemptId?: string): Promise<void> {
    const generation = this.begin();
    if (generation === undefined) return;
    if (this.value.unknownStart) {
      this.publish({ message: `Inspect the original connection request ${this.value.unknownStart.attemptId} before starting or restarting another request.` });
      this.finish(generation);
      return;
    }
    if (this.value.workspaceRefreshRequired) {
      this.publish({ message: 'Refresh the workspace before starting another connection.' });
      this.finish(generation);
      return;
    }
    let attemptId: string;
    try { attemptId = this.makeAttemptId(); } catch (error) { this.publish({ message: safeError(error) }); this.finish(generation); return; }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) {
      this.publish({ message: 'A secure connection request identifier is unavailable.' }); this.finish(generation); return;
    }
    let snapshot: WorkspaceSnapshotDTO;
    try {
      snapshot = this.workspaceReady();
      if (reconnectAccountId) {
        const account = snapshot.state.accounts.find((item) => item.id === reconnectAccountId);
        if (!account || account.provider !== provider) throw new OAuthClientError('stale', 'Choose a saved account for this provider before reconnecting.');
      }
    } catch (error) { if (this.current(generation)) this.publish({ message: safeError(error) }); this.finish(generation); return; }
    this.publish({ operation: 'starting', unknownStart: undefined, message: undefined });
    try {
      const result = await this.client.start(provider, { startAttemptId: attemptId, requestedCapabilities: Object.freeze([...capabilities]),
        expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch,
        ...(reconnectAccountId ? { reconnectAccountId } : {}), ...(restartOfStartAttemptId ? { restartOfStartAttemptId } : {}) });
      if (!this.current(generation)) return;
      const metadata: OAuthAttemptMetadata = Object.freeze({ startAttemptId: attemptId, provider, stageId: result.status.attemptId,
        status: result.status.status, createdAt: result.status.createdAt, expiresAt: result.status.expiresAt,
        ...(result.status.consumption ? { consumption: result.status.consumption } : {}) });
      this.publish({ attempts: [metadata, ...this.value.attempts.filter((item) => item.startAttemptId !== attemptId)], stage: result.status,
        verifiedAccount: undefined, unknownStart: undefined, operation: undefined, message: result.kind === 'existing' ? 'This request already exists. Inspect its status; choose Restart only if it is safe to start a new request.' : 'Connection request started. Still will not add the account until you review the verified result.' });
      if (result.kind === 'started' && result.authorizationUrl && this.current(generation)) this.navigate(result.authorizationUrl);
    } catch (error) {
      if (!this.current(generation)) return;
      if (error instanceof OAuthClientError && error.kind === 'not_started') {
        this.publish({ operation: undefined, unknownStart: undefined, message: safeError(error) });
        return;
      }
      if (error instanceof OAuthClientError && error.kind === 'not_admitted') {
        this.publish({ operation: undefined, unknownStart: undefined, workspaceRefreshRequired: true,
          message: 'The workspace changed before the request started. Refresh saved workspace details before trying again.' });
        return;
      }
      this.publish({ operation: undefined, unknownStart: Object.freeze({ provider, attemptId, ...(restartOfStartAttemptId ? { restartOf: restartOfStartAttemptId } : {}) }),
        message: `The start result is uncertain. Inspect request ${attemptId} before choosing any next action. ${safeError(error)}` });
    } finally { this.finish(generation); }
  }

  async inspectStart(provider: OAuthProvider, attemptId: string): Promise<void> {
    const generation = this.begin(); if (generation === undefined) return;
    this.publish({ operation: 'inspecting', message: undefined });
    try {
      const metadata = await this.client.inspectStart(provider, attemptId);
      if (!this.current(generation)) return;
      this.publish({ attempts: [metadata, ...this.value.attempts.filter((item) => item.startAttemptId !== attemptId)], operation: undefined,
        unknownStart: this.value.unknownStart?.attemptId === attemptId ? undefined : this.value.unknownStart,
        message: `Connection request status · ${metadata.status.replaceAll('_', ' ')}. Inspection never restarts authorization.` });
    } catch (error) { if (this.current(generation)) this.publish({ operation: undefined, message: safeError(error) }); }
    finally { this.finish(generation); }
  }

  async inspectStage(stageId: string): Promise<void> {
    const generation = this.begin(); if (generation === undefined) return;
    this.publish({ operation: 'inspecting', stage: undefined, verifiedAccount: undefined, message: undefined });
    try {
      const inspection = await this.client.inspectStage(stageId);
      if (this.current(generation)) this.publish({ stage: inspection.stage, ...(inspection.verifiedAccount ? { verifiedAccount: inspection.verifiedAccount } : { verifiedAccount: undefined }),
        operation: undefined, message: inspection.stage.status === 'verified' ? 'Connection verified. Review the account and access before choosing Add account.' : `Connection status · ${inspection.stage.status.replaceAll('_', ' ')}. This status check does not add an account.` });
    } catch (error) { if (this.current(generation)) this.publish({ operation: undefined, message: safeError(error) }); }
    finally { this.finish(generation); }
  }

  async installStage(stageId: string): Promise<void> {
    const generation = this.begin(); if (generation === undefined) return;
    try { this.workspaceReady(); }
    catch (error) { if (this.current(generation)) this.publish({ message: safeError(error) }); this.finish(generation); return; }
    const preview = this.value.verifiedAccount;
    if (this.value.stage?.attemptId !== stageId || this.value.stage.status !== 'verified' || !preview) {
      this.publish({ message: 'Inspect the verified connection stage again before adding an account.' }); this.finish(generation); return;
    }
    if (preview.reconnectAccountId) {
      const account = this.workspaceOperation.readSnapshot()?.state.accounts.find((item) => item.id === preview.reconnectAccountId);
      if (!account || account.provider !== this.value.stage.provider) {
        this.publish({ message: 'The verified reconnect target is not present in the current saved accounts. Refresh workspace details before adding it.' }); this.finish(generation); return;
      }
    }
    this.publish({ operation: 'installing', installCommandId: undefined, installStageId: stageId, message: undefined });
    let commandId: string | undefined;
    let receiptConfirmed = false;
    try {
      const response = await this.workspaceOperation.execute({ kind: 'accounts.installOAuth', stageId }, (admissionId) => {
        commandId = admissionId;
        if (this.current(generation)) this.publish({ installCommandId: admissionId });
      });
      if (!this.current(generation)) return;
      if (!commandId) throw new Error('The install command was not admitted.');
      const receipt = exactInstallReceipt(response, commandId, stageId);
      if (!receipt) {
        this.publish({ operation: undefined, installCommandId: commandId, message: 'The exact account-install receipt is not confirmed. Inspect this command before continuing.' }); return;
      }
      receiptConfirmed = true;
      this.publish({ stage: undefined, verifiedAccount: undefined, installCommandId: undefined, message: 'The account-install receipt is confirmed. Checking the saved account details.' });
      const account = response.snapshot?.state.accounts.find((item) => item.id === receipt.objectId);
      if (response.snapshot && (!account || account.connectionGeneration !== receipt.accountGeneration)) {
        this.publish({ operation: undefined, installCommandId: commandId, message: 'The install receipt does not match the refreshed account generation. Inspect the account status before continuing.' }); return;
      }
      const currentSnapshot = response.snapshot ?? await this.workspaceOperation.refresh();
      if (!this.current(generation)) return;
      const confirmedAccount = currentSnapshot?.state.accounts.find((item) => item.id === receipt.objectId);
      if (!confirmedAccount || confirmedAccount.connectionGeneration !== receipt.accountGeneration) {
        this.publish({ operation: undefined, installCommandId: commandId, message: 'The exact install receipt is confirmed. Refresh account details before relying on the new connection.' }); return;
      }
      this.publish({ operation: undefined, installCommandId: undefined, message: 'Account added. Its saved connection details are available in Settings.' });
      await this.client.inspectStage(stageId).then((inspection) => { if (this.current(generation)) this.publish({ stage: inspection.stage, verifiedAccount: undefined }); }).catch(() => undefined);
    } catch (error) {
      if (this.current(generation)) this.publish({ operation: undefined, ...(!receiptConfirmed && commandId ? { installCommandId: commandId } : {}),
        message: receiptConfirmed ? 'The install receipt is confirmed. Refresh account details before relying on the new connection.' : commandId ? 'The install result is uncertain. Inspect the exact workspace command before continuing.' : safeError(error) });
    } finally { this.finish(generation); }
  }

  async inspectInstall(): Promise<void> {
    const commandId = this.value.installCommandId;
    const stageId = this.value.installStageId;
    if (!commandId || !stageId) return;
    const generation = this.begin(); if (generation === undefined) return;
    this.publish({ operation: 'inspecting', message: undefined });
    let receiptConfirmed = false;
    try {
      const response = await this.workspaceOperation.inspect(commandId);
      if (!this.current(generation)) return;
      const receipt = exactInstallReceipt(response, commandId, stageId);
      if (!receipt) { this.publish({ operation: undefined, message: `The exact install command ${commandId} has no confirmed receipt yet. It was not resent.` }); return; }
      receiptConfirmed = true;
      this.publish({ stage: undefined, verifiedAccount: undefined, installCommandId: undefined, message: 'The exact install receipt is confirmed. Checking the saved account details.' });
      const snapshot = response.snapshot ?? await this.workspaceOperation.refresh();
      if (!this.current(generation)) return;
      const account = snapshot?.state.accounts.find((item) => item.id === receipt.objectId);
      if (!account || account.connectionGeneration !== receipt.accountGeneration) {
        this.publish({ operation: undefined, message: 'The exact install receipt is confirmed. Refresh account details before relying on the new connection.' }); return;
      }
      this.publish({ operation: undefined, installCommandId: undefined, message: 'The exact install receipt is confirmed. Account details are refreshed; no install was resent.' });
    } catch (error) { if (this.current(generation)) this.publish({ operation: undefined, message: receiptConfirmed ? 'The exact install receipt is confirmed. Refresh account details before relying on the new connection.' : safeError(error) }); }
    finally { this.finish(generation); }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false; this.generation += 1; this.operationLock = false; this.client.dispose(); this.listeners.clear();
  }
}
