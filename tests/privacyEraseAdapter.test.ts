import { describe, expect, it } from 'vitest';
// This test intentionally imports both platform-specific eraser implementations.
/* eslint-disable import/no-duplicates */
import { createPrivacyEraseAdapter, type NativePrivacyEraseIO } from '../src/privacy/eraseAdapter';
import { createWebPrivacyEraseAdapter, type WebPrivacyEraseIO } from '../src/privacy/eraseAdapter.web';
/* eslint-enable import/no-duplicates */
import { createWebSpeechAudioService, speechStagingMemoryCount } from '../src/audio/speechUpload.web';
import type { Note } from '../src/core';
import { MAIL_REFRESH_TASK_NAME } from '../src/background/backend.types';
import { PrivacyEraseAdapterError, safeRelativeMarkdownPath } from '../src/privacy/eraseAdapter.shared';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from '../src/privacy/schema';
import { PRIVACY_NAMESPACES, type PrivacyCleanupTarget, type PrivacyControlState, type PrivacyControlStore, type PrivacyOwner } from '../src/privacy/types';

const epoch = '30000000-0000-4000-8000-000000000001';
const tokenRef = '30000000-0000-4000-8000-000000000002';

describe('shared erase target path validation', () => {
  it('rejects unpaired surrogate code units while accepting a valid bounded Unicode path', () => {
    expect(safeRelativeMarkdownPath(`notes/\uD800.md`)).toBe(false);
    expect(safeRelativeMarkdownPath(`notes/\uDC00.md`)).toBe(false);
    expect(safeRelativeMarkdownPath(`notes/${'😀'.repeat(250)}.md`)).toBe(true);
  });
});

function stateFor(target: PrivacyCleanupTarget, currentEpoch = epoch): PrivacyControlState {
  const targets: PrivacyCleanupTarget[] = PRIVACY_NAMESPACES.map((namespace) => ({ kind: 'namespace', namespace }));
  if (!targets.some((entry) => JSON.stringify(entry) === JSON.stringify(target))) targets.push(target);
  return validatePrivacyControlState({
    ...createEmptyPrivacyControlState(currentEpoch),
    ownedNamespaces: [...PRIVACY_NAMESPACES],
    oauthTokenRefs: target.kind === 'oauth_token' ? [target.tokenRef] : [],
    legacyMarkdownPaths: target.kind === 'legacy_markdown' ? [target.path] : [],
    cleanup: {
      id: '30000000-0000-4000-8000-000000000003', epoch: currentEpoch,
      startedAt: '2026-10-13T00:00:00.000Z', status: 'erasing', coverage: 'tracked_with_legacy_limits',
      steps: targets.map((item) => ({ target: item, status: 'pending' })),
    },
  });
}

function storeReturning(readState: () => PrivacyControlState): PrivacyControlStore {
  return { async read() { return readState(); }, async compareAndSwap() { throw new Error('unused'); } };
}

const iosOwner: PrivacyOwner = {
  platform: 'ios', runtimeId: '30000000-0000-4000-8000-000000000004',
  processLaunchId: '30000000-0000-4000-8000-000000000005', bundleIdentifier: 'com.still.voiceassistant',
};
const webOwner: PrivacyOwner = { platform: 'web', runtimeId: '30000000-0000-4000-8000-000000000006' };

function nativeIO(): NativePrivacyEraseIO & { removed: string[] } {
  const dirs = new Set(['file:///docs/ExpoAudio/', 'file:///docs/recording-recovery/', 'file:///cache/speech-upload/', 'file:///cache/DocumentPicker/', 'file:///docs/StillDocuments-v1/', 'file:///docs/memory/', 'file:///docs/logs/', 'file:///docs/notes/', 'file:///docs/people/', 'file:///docs/projects/']);
  const files = new Set(['file:///docs/still-export.json', 'file:///docs/memory/PROFILE.md']);
  const secrets = new Set(['speech', 'openai', tokenRef]);
  const removed: string[] = [];
  let backgroundRegistered = true;
  return {
    removed,
    documentDirectory: 'file:///docs/', cacheDirectory: 'file:///cache/',
    async exists(uri) { return { exists: dirs.has(uri) || files.has(uri), isDirectory: dirs.has(uri) }; },
    async deleteFile(uri) { files.delete(uri); removed.push(uri); },
    async deleteDirectory(uri) { dirs.delete(uri); removed.push(uri); },
    async deleteStateDatabase() { removed.push('state-db'); }, async verifyStateDatabaseGone() { return true; },
    async deleteProviderCredential(kind, check) { await check(); secrets.delete(kind); removed.push(`credential:${kind}`); },
    async providerCredentialExists(kind) { return secrets.has(kind); },
    async deleteOAuthToken(ref, check) { await check(); secrets.delete(ref); removed.push(`oauth:${ref}`); },
    async oauthTokenExists(ref) { return secrets.has(ref); },
    async cancelAndDismissNotifications(check) { await check(); removed.push('notifications'); },
    async notificationsRemain() { return false; },
    async unregisterBackgroundTask(name, check) { await check(); expect(name).toBe(MAIL_REFRESH_TASK_NAME); backgroundRegistered = false; removed.push(`background:${name}`); },
    async backgroundTaskRegistered(name) { expect(name).toBe(MAIL_REFRESH_TASK_NAME); return backgroundRegistered; },
  };
}

function webIO(): WebPrivacyEraseIO & { removed: string[] } {
  const removed: string[] = [];
  const credentials = new Set(['speech', 'openai', tokenRef]);
  const dbs = new Set<string>();
  return {
    removed,
    supported: () => true,
    async deleteStateDatabase(check) { await check(); dbs.delete('voice-assistant'); removed.push('state-db'); },
    async stateDatabaseGone() { return removed.includes('state-db'); },
    async deleteDatabase(name, check) { await check(); dbs.delete(name); removed.push(`db:${name}`); },
    databaseDeletionConfirmed(name) { return removed.includes(`db:${name}`); },
    async deleteProviderCredential(kind, check) { await check(); credentials.delete(kind); removed.push(`credential:${kind}`); },
    async providerCredentialExists(kind) { return credentials.has(kind); },
    async deleteOAuthToken(ref, check) { await check(); credentials.delete(ref); removed.push(`oauth:${ref}`); },
    async oauthTokenExists(ref) { return credentials.has(ref); },
  };
}

describe('privacy erase adapter', () => {
  it('deletes only exact native-owned folders/files and verifies them absent', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'markdown_mirrors' };
    const io = nativeIO();
    const adapter = createPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => iosOwner, io });
    await adapter.erase(target, epoch);
    expect(await adapter.verifyGone(target, epoch)).toBe(true);
    expect(io.removed).toEqual([
      'file:///docs/StillDocuments-v1/', 'file:///docs/memory/', 'file:///docs/logs/',
      'file:///docs/notes/', 'file:///docs/people/', 'file:///docs/projects/',
    ]);
  });

  it('rechecks the durable journal before each credential deletion', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'provider_credentials' };
    let reads = 0;
    const io = nativeIO();
    const adapter = createPrivacyEraseAdapter({
      controlStore: storeReturning(() => { reads += 1; if (reads >= 3) throw new Error('journal read failed'); return stateFor(target); }),
      getOwner: async () => iosOwner, io,
    });
    await expect(adapter.erase(target, epoch)).rejects.toBeInstanceOf(PrivacyEraseAdapterError);
    expect(io.removed).toEqual(['credential:speech']);
  });

  it('erases only the fixed background task and verifies its registration is gone', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'notifications' };
    const io = nativeIO();
    const adapter = createPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => iosOwner, io });
    await adapter.erase(target, epoch);
    expect(io.removed).toContain('notifications');
    expect(io.removed).toContain(`background:${MAIL_REFRESH_TASK_NAME}`);
    expect(await adapter.verifyGone(target, epoch)).toBe(true);
  });

  it('fails closed for an unimplemented privileged state-database deletion seam', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'state_database' };
    const io = nativeIO();
    const { deleteStateDatabase: _delete, ...withoutStateDatabase } = io;
    const adapter = createPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => iosOwner, io: withoutStateDatabase });
    await expect(adapter.erase(target, epoch)).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(io.removed).toEqual([]);
  });

  it('never runs native cleanup in an unsupported runtime or for a stale journal epoch', async () => {
    const target: PrivacyCleanupTarget = { kind: 'oauth_token', tokenRef };
    const io = nativeIO();
    const unsupported = createPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => ({ platform: 'unsupported', runtimeId: iosOwner.runtimeId }), io });
    await expect(unsupported.erase(target, epoch)).rejects.toMatchObject({ code: 'unsupported_target' });
    const stale = createPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target, '30000000-0000-4000-8000-000000000007')), getOwner: async () => iosOwner, io });
    await expect(stale.erase(target, epoch)).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(io.removed).toEqual([]);
  });

  it('requires browser deletion confirmation and exact current cleanup membership', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'state_database' };
    const io = webIO();
    const adapter = createWebPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => webOwner, io });
    await adapter.erase(target, epoch);
    expect(await adapter.verifyGone(target, epoch)).toBe(true);
    expect(io.removed).toEqual(['state-db']);
    const changed = createWebPrivacyEraseAdapter({ controlStore: storeReturning(() => { throw new Error('journal unavailable'); }), getOwner: async () => webOwner, io });
    await expect(changed.erase(target, epoch)).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('clears and verifies all instance-local web speech staging maps', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'speech_staging' };
    const webNote = {
      id: '30000000-0000-4000-8000-000000000010', title: 'Voice', transcript: '', audioUri: 'indexeddb-audio:source',
      durationSeconds: 7, createdAt: '2026-10-13T00:00:00.000Z', status: 'recorded', revision: 1,
    } as Note;
    const first = createWebSpeechAudioService({ get: async () => new Blob([new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 1])], { type: 'audio/mp4' }), crypto: { sha256: async () => 'a'.repeat(64) } });
    const second = createWebSpeechAudioService({ get: async () => new Blob([new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 1])], { type: 'audio/mp4' }), crypto: { sha256: async () => 'b'.repeat(64) } });
    await first.prepare(webNote, { leaseId: '30000000-0000-4000-8000-000000000011', maxDurationSeconds: 30 });
    await second.prepare(webNote, { leaseId: '30000000-0000-4000-8000-000000000012', maxDurationSeconds: 30 });
    expect(speechStagingMemoryCount()).toBeGreaterThanOrEqual(2);
    const adapter = createWebPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => webOwner, io: webIO() });
    await adapter.erase(target, epoch);
    expect(speechStagingMemoryCount()).toBe(0);
    expect(await adapter.verifyGone(target, epoch)).toBe(true);
  });

  it('does not treat blocked web database deletion as success', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'browser_audio' };
    const io = webIO();
    io.deleteDatabase = async () => { throw new PrivacyEraseAdapterError('target_unavailable'); };
    const adapter = createWebPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => webOwner, io });
    await expect(adapter.erase(target, epoch)).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(await adapter.verifyGone(target, epoch)).toBe(false);
  });

  it('keeps the web cleanup operation pending until the original blocked-delete request settles', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'browser_audio' };
    const io = webIO();
    let finishDelete!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let confirmed = false;
    io.deleteDatabase = async (_name, check) => {
      await check();
      await new Promise<void>((resolve) => { finishDelete = resolve; notifyStarted(); });
      confirmed = true;
    };
    io.databaseDeletionConfirmed = () => confirmed;
    const adapter = createWebPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => webOwner, io });
    let settled = false;
    const erase = adapter.erase(target, epoch).then(() => { settled = true; });
    await started;
    expect(settled).toBe(false);
    finishDelete();
    await erase;
    expect(settled).toBe(true);
    expect(await adapter.verifyGone(target, epoch)).toBe(true);
  });

  it('does not acknowledge native state deletion before the privileged database callback resolves', async () => {
    const target: PrivacyCleanupTarget = { kind: 'namespace', namespace: 'state_database' };
    const io = nativeIO();
    let finishDelete!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let settled = false;
    io.deleteStateDatabase = async (check) => {
      await check();
      await new Promise<void>((resolve) => { finishDelete = resolve; notifyStarted(); });
      io.removed.push('state-db');
    };
    const adapter = createPrivacyEraseAdapter({ controlStore: storeReturning(() => stateFor(target)), getOwner: async () => iosOwner, io });
    const erase = adapter.erase(target, epoch).then(() => { settled = true; });
    await started;
    expect(settled).toBe(false);
    finishDelete();
    await erase;
    expect(settled).toBe(true);
    expect(await adapter.verifyGone(target, epoch)).toBe(true);
    io.deleteStateDatabase = async () => { throw new PrivacyEraseAdapterError('target_unavailable'); };
    await expect(adapter.erase(target, epoch)).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(await adapter.verifyGone(target, epoch)).toBe(false);
  });
});
