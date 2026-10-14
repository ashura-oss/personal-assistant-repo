import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { ConnectionsAccountDisplay } from '../src/ui/ConnectionsSection';
import type { MailSyncControlsState } from '../src/ui/MailSyncControls';
import type { DispatchHistoryRecord } from '../src/ui/DispatchHistory';

type ExpectFalse<T extends false> = T;
type _NoAccountTokenRef = ExpectFalse<'tokenRef' extends keyof ConnectionsAccountDisplay ? true : false>;
type _NoAccountCredentialConfiguredRequirement = ExpectFalse<'credentialConfigured' extends keyof ConnectionsAccountDisplay ? true : false>;
type _NoSyncCursor = ExpectFalse<'messagesCursor' extends keyof MailSyncControlsState ? true : false>;
type _NoSyncGeneration = ExpectFalse<'connectionGeneration' extends keyof MailSyncControlsState ? true : false>;
type _NoBackfillCursor = ExpectFalse<'cursor' extends keyof NonNullable<MailSyncControlsState['mailBackfill']['activeWindow']> ? true : false>;
type _NoDispatchSourceActionKey = ExpectFalse<'sourceActionKey' extends keyof DispatchHistoryRecord ? true : false>;
type _NoDispatchDuplicateKey = ExpectFalse<'duplicateKey' extends keyof DispatchHistoryRecord ? true : false>;
type _NoProviderIdempotencyKey = ExpectFalse<'providerIdempotencyKey' extends keyof DispatchHistoryRecord ? true : false>;
type _NoMailReplyAuthorityBinding = ExpectFalse<'mailReplyBatchBinding' extends keyof DispatchHistoryRecord ? true : false>;
export const safeLeafTypeChecks = {
  noAccountTokenRef: false as _NoAccountTokenRef,
  noCredentialConfiguredRequirement: false as _NoAccountCredentialConfiguredRequirement,
  noSyncCursor: false as _NoSyncCursor,
  noSyncGeneration: false as _NoSyncGeneration,
  noBackfillCursor: false as _NoBackfillCursor,
  noDispatchSourceActionKey: false as _NoDispatchSourceActionKey,
  noDispatchDuplicateKey: false as _NoDispatchDuplicateKey,
  noProviderIdempotencyKey: false as _NoProviderIdempotencyKey,
  noMailReplyAuthorityBinding: false as _NoMailReplyAuthorityBinding,
};

export function accountDTOForConnections(snapshot: WorkspaceSnapshotDTO): readonly ConnectionsAccountDisplay[] {
  return snapshot.state.accounts;
}

export function syncDTOForMailControls(snapshot: WorkspaceSnapshotDTO): Readonly<Record<string, MailSyncControlsState>> {
  return snapshot.state.syncStates;
}

export function dispatchDTOForHistory(snapshot: WorkspaceSnapshotDTO): readonly DispatchHistoryRecord[] {
  return snapshot.state.dispatchRecords;
}
