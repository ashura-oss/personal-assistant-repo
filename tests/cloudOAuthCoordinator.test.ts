import { describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { Account } from '../src/core';
import type { AuthenticatedSession } from '../src/web/authClient';
import { OAuthClientError, type OAuthAttemptMetadata, type OAuthCapability, type OAuthClient, type OAuthStageInspection, type OAuthStartInput, type OAuthStartResponse } from '../src/web/cloudOAuthClient';
import { CloudOAuthCoordinator, type OAuthWorkspacePort } from '../src/web/cloudOAuthCoordinator';
import type { WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const replacementWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const session: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 4, csrfToken: 'c'.repeat(43) });
const startId = '11111111-1111-4111-8111-111111111111';
const stageId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
function snapshot(workspaceId = session.workspaceId, privacyEpoch = session.privacyEpoch) {
  const state = createInitialWorkspaceState(() => '44444444-4444-4444-8444-444444444444');
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch, revision: 7 });
}
const installedAccountId = '66666666-6666-4666-8666-666666666666';
function snapshotWithInstalledAccount() {
  const state = createInitialWorkspaceState(() => '44444444-4444-4444-8444-444444444444');
  state.accounts.push({ id: installedAccountId, provider: 'google', displayName: 'Verified account', email: 'safe@example.test', connected: true,
    authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'private-subject' }, capabilities: ['mail.read'], connectionGeneration: 1,
    lastSyncedAt: '2026-10-15T00:00:00.000Z' } satisfies Account);
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: session.workspaceId, privacyEpoch: session.privacyEpoch, revision: 8 });
}
function stage(status: OAuthStageInspection['stage']['status'] = 'authorization_pending') {
  return Object.freeze({ attemptId: stageId, registrationId: 'google-web', provider: 'google' as const, status,
    payloadGeneration: 1, createdAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000 });
}
function metadata(status: OAuthAttemptMetadata['status'] = 'authorization_pending', id = startId): OAuthAttemptMetadata {
  return Object.freeze({ startAttemptId: id, provider: 'google', status, stageId, createdAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000 });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeClient(overrides: Partial<OAuthClient> = {}): OAuthClient {
  return Object.freeze({ availability: vi.fn(async () => ({ google: true, microsoft: false })), listStarts: vi.fn(async () => []),
    inspectStart: vi.fn(async () => metadata()), inspectStage: vi.fn(async () => ({ stage: stage() })),
    start: vi.fn(async (_provider: 'google' | 'microsoft', _input: OAuthStartInput): Promise<OAuthStartResponse> => ({ kind: 'started', status: stage(), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=hidden' })),
    dispose: vi.fn(), ...overrides });
}
function workspace(snapshotReader: () => ReturnType<typeof snapshot>, overrides: Partial<OAuthWorkspacePort> = {}): OAuthWorkspacePort {
  return Object.freeze({ readSnapshot: snapshotReader, readWorkspaceOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
    execute: vi.fn(async (_command, onAdmitted) => { onAdmitted(commandId); return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1,
      commandId, kind: 'accounts.installOAuth', stageId, objectId: 'account-opaque', accountGeneration: 1 } } as WorkspaceCommandResponse; }),
    inspect: vi.fn(async () => { throw new Error('not used'); }), refresh: vi.fn(async () => snapshotReader()), ...overrides });
}

describe('session-owned OAuth coordination', () => {
  it('preserves an unknown start CID, blocks another POST, and allows only explicit restart after exact inspection', async () => {
    const nextId = '55555555-5555-4555-8555-555555555555';
    const start = vi.fn(async (_provider: 'google' | 'microsoft', input: OAuthStartInput) => {
      if (input.startAttemptId === startId) throw new Error('lost acknowledgement');
      return { kind: 'started' as const, status: stage(), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=private' };
    });
    const inspectStart = vi.fn(async () => metadata('inspect_required'));
    const client = fakeClient({ start, inspectStart });
    const coordinator = new CloudOAuthCoordinator(session, { workspace: workspace(() => snapshot()), client, makeAttemptId: () => start.mock.calls.length === 0 ? startId : nextId, navigate: vi.fn() });
    await coordinator.start('google', ['mail.read', 'calendar.read']);
    const held = coordinator.getSnapshot().unknownStart;
    expect(held?.attemptId).toBe(startId);
    await coordinator.start('google', ['mail.read', 'calendar.read']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().unknownStart?.attemptId).toBe(startId);
    await coordinator.inspectStart('google', startId);
    expect(coordinator.getSnapshot().attempts[0]?.status).toBe('inspect_required');
    expect(coordinator.getSnapshot().unknownStart).toBeUndefined();
    await coordinator.start('google', ['mail.read', 'calendar.read'], undefined, startId);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]?.[1]).toMatchObject({ startAttemptId: nextId, restartOfStartAttemptId: startId });
    coordinator.dispose();
  });

  it('requires an explicit workspace refresh after proven pre-admission rejection before a fresh start', async () => {
    const nextId = '55555555-5555-4555-8555-555555555555';
    const start = vi.fn(async (_provider: 'google' | 'microsoft', input: OAuthStartInput) => {
      if (input.startAttemptId === startId) throw new OAuthClientError('not_admitted', 'stale workspace');
      return { kind: 'started' as const, status: stage(), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fresh' };
    });
    const port = workspace(() => snapshot());
    const coordinator = new CloudOAuthCoordinator(session, { workspace: port, client: fakeClient({ start }),
      makeAttemptId: () => start.mock.calls.length === 0 ? startId : nextId, navigate: vi.fn() });
    await coordinator.start('google', ['mail.read']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot()).toMatchObject({ workspaceRefreshRequired: true });
    expect(coordinator.getSnapshot().unknownStart).toBeUndefined();
    await coordinator.start('google', ['mail.read']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(port.refresh).not.toHaveBeenCalled();
    await coordinator.refreshWorkspace();
    expect(port.refresh).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().workspaceRefreshRequired).toBe(false);
    await coordinator.start('google', ['mail.read']);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]?.[1]).toMatchObject({ startAttemptId: nextId });
    coordinator.dispose();
  });

  it('treats locally invalid start identifiers as not started without creating an uncertain attempt', async () => {
    const start = vi.fn();
    const coordinator = new CloudOAuthCoordinator(session, { workspace: workspace(() => snapshot()), client: fakeClient({ start }), makeAttemptId: () => 'invalid' });
    await coordinator.start('google', ['mail.read']);
    expect(start).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().unknownStart).toBeUndefined();
    expect(coordinator.getSnapshot().workspaceRefreshRequired).toBeUndefined();
    expect(coordinator.getSnapshot().message).toContain('identifier is unavailable');
    coordinator.dispose();
  });

  it('does not navigate or publish a late start after the live workspace owner changes', async () => {
    const started = deferred<OAuthStartResponse>();
    let currentSnapshot = snapshot();
    const navigate = vi.fn();
    const client = fakeClient({ start: vi.fn(async () => started.promise) });
    const coordinator = new CloudOAuthCoordinator(session, { workspace: workspace(() => currentSnapshot), client, makeAttemptId: () => startId, navigate });
    const request = coordinator.start('google', ['mail.read']);
    expect(coordinator.getSnapshot().operation).toBe('starting');
    currentSnapshot = snapshot(replacementWorkspaceId, 5);
    started.resolve({ kind: 'started', status: stage(), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=secret' });
    await request;
    expect(navigate).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().attempts).toEqual([]);
    expect(coordinator.getSnapshot().message).toBeUndefined();
    coordinator.dispose();
  });

  it('does not admit installation when a verified stage belongs to a replaced live owner', async () => {
    let currentSnapshot = snapshot();
    const client = fakeClient({ inspectStage: vi.fn(async () => ({ stage: stage('verified'), verifiedAccount: {
      displayName: 'Verified account', email: 'safe@example.test', requestedCapabilities: ['mail.read'] satisfies OAuthCapability[], capabilities: ['mail.read'] satisfies OAuthCapability[],
    } })) });
    const port = workspace(() => currentSnapshot);
    const coordinator = new CloudOAuthCoordinator(session, { workspace: port, client });
    await coordinator.inspectStage(stageId);
    expect(coordinator.getSnapshot().verifiedAccount?.displayName).toBe('Verified account');
    const verifiedMessage = coordinator.getSnapshot().message;
    currentSnapshot = snapshot(replacementWorkspaceId, 5);
    await coordinator.installStage(stageId);
    expect(port.execute).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().message).toBe(verifiedMessage);
    coordinator.dispose();
  });

  it('drops a stage-inspection response when the live workspace owner changes while it is pending', async () => {
    const inspection = deferred<OAuthStageInspection>();
    let currentSnapshot = snapshot();
    const coordinator = new CloudOAuthCoordinator(session, { workspace: workspace(() => currentSnapshot),
      client: fakeClient({ inspectStage: vi.fn(() => inspection.promise) }) });
    const request = coordinator.inspectStage(stageId);
    currentSnapshot = snapshot(replacementWorkspaceId, 5);
    inspection.resolve({ stage: stage('verified'), verifiedAccount: {
      displayName: 'Should not publish', requestedCapabilities: ['mail.read'] satisfies OAuthCapability[],
      capabilities: ['mail.read'] satisfies OAuthCapability[],
    } });
    await request;
    expect(coordinator.getSnapshot().stage).toBeUndefined();
    expect(coordinator.getSnapshot().verifiedAccount).toBeUndefined();
    expect(coordinator.getSnapshot().message).toBeUndefined();
    coordinator.dispose();
  });

  it('does not publish a delayed install result after the live workspace owner changes', async () => {
    let currentSnapshot = snapshot();
    const install = deferred<WorkspaceCommandResponse>();
    const port = workspace(() => currentSnapshot, { execute: vi.fn(async (_command, onAdmitted) => {
      onAdmitted(commandId);
      return install.promise;
    }) });
    const coordinator = new CloudOAuthCoordinator(session, { workspace: port,
      client: fakeClient({ inspectStage: vi.fn(async () => ({ stage: stage('verified'), verifiedAccount: {
        displayName: 'Verified account', requestedCapabilities: ['mail.read'] satisfies OAuthCapability[],
        capabilities: ['mail.read'] satisfies OAuthCapability[],
      } })) }) });
    await coordinator.inspectStage(stageId);
    const request = coordinator.installStage(stageId);
    expect(port.execute).toHaveBeenCalledTimes(1);
    currentSnapshot = snapshot(replacementWorkspaceId, 5);
    install.resolve({ schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1,
      commandId, kind: 'accounts.installOAuth', stageId, objectId: 'account-opaque', accountGeneration: 1 } } as WorkspaceCommandResponse);
    await request;
    expect(coordinator.getSnapshot().installCommandId).toBe(commandId);
    expect(coordinator.getSnapshot().message).toBeUndefined();
    coordinator.dispose();
  });

  it('retires a verified preview after direct install even when the optional stage refresh fails', async () => {
    const accountSnapshot = snapshotWithInstalledAccount();
    const inspectStage = vi.fn()
      .mockResolvedValueOnce({ stage: stage('verified'), verifiedAccount: { displayName: 'Verified account', requestedCapabilities: ['mail.read'] satisfies OAuthCapability[], capabilities: ['mail.read'] satisfies OAuthCapability[] } })
      .mockRejectedValueOnce(new Error('stage status unavailable'));
    const port = workspace(() => accountSnapshot, { execute: vi.fn(async (_command, onAdmitted) => {
      onAdmitted(commandId);
      return { schemaVersion: 1, commandId, status: 'finished', snapshot: accountSnapshot, receipt: { schemaVersion: 1,
        commandId, kind: 'accounts.installOAuth', stageId, objectId: installedAccountId, accountGeneration: 1 } } as WorkspaceCommandResponse;
    }) });
    const coordinator = new CloudOAuthCoordinator(session, { workspace: port, client: fakeClient({ inspectStage }) });
    await coordinator.inspectStage(stageId);
    await coordinator.installStage(stageId);
    expect(coordinator.getSnapshot().verifiedAccount).toBeUndefined();
    expect(coordinator.getSnapshot().stage).toBeUndefined();
    await coordinator.installStage(stageId);
    expect(port.execute).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('retires the verified preview after exact recovery inspection without replaying installation', async () => {
    const accountSnapshot = snapshotWithInstalledAccount();
    const port = workspace(() => accountSnapshot, {
      execute: vi.fn(async (_command, onAdmitted) => { onAdmitted(commandId); throw new Error('lost acknowledgement'); }),
      inspect: vi.fn(async () => ({ schemaVersion: 1, commandId, status: 'finished', snapshot: accountSnapshot, receipt: { schemaVersion: 1,
        commandId, kind: 'accounts.installOAuth', stageId, objectId: installedAccountId, accountGeneration: 1 } } as WorkspaceCommandResponse)),
    });
    const coordinator = new CloudOAuthCoordinator(session, { workspace: port, client: fakeClient({ inspectStage: vi.fn(async () => ({ stage: stage('verified'),
      verifiedAccount: { displayName: 'Verified account', requestedCapabilities: ['mail.read'] satisfies OAuthCapability[], capabilities: ['mail.read'] satisfies OAuthCapability[] } })) }) });
    await coordinator.inspectStage(stageId);
    await coordinator.installStage(stageId);
    expect(coordinator.getSnapshot().installCommandId).toBe(commandId);
    await coordinator.inspectInstall();
    expect(coordinator.getSnapshot().verifiedAccount).toBeUndefined();
    expect(coordinator.getSnapshot().stage).toBeUndefined();
    await coordinator.installStage(stageId);
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(port.inspect).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });
});
