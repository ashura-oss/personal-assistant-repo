import type { PrivacyPublicStatus, PrivacyWriterScope } from '../privacy/types';
import {
  validateProactiveMailAlertState,
} from './state';
import type { ProactiveMailAlertReceipt, ProactiveMailAlertState } from './types';
import type {
  MailAlertNotificationBackend,
  MailAlertPresentationResult,
  MailAlertCancellationResult,
} from '../services/mailAlertNotificationBackend';

/** Minimal fresh-state shape used by the scoped postflight writer. */
export interface MailAlertWorkspaceState {
  proactiveMailAlerts: ProactiveMailAlertState;
}

export interface MailAlertScopedStore<State extends MailAlertWorkspaceState = MailAlertWorkspaceState> {
  load(): Promise<State | undefined>;
  save(state: State): Promise<void>;
  assertCurrent(): Promise<void>;
}

/**
 * A controller gives this capability only while it already owns its transactionQueue slot.
 * It acquires the notification writer after entering the slot; this engine never re-enters the
 * controller queue or uses its normal bound store from inside the child scope.
 */
export interface MailAlertNotificationWriter<State extends MailAlertWorkspaceState = MailAlertWorkspaceState> {
  withNotificationWriter<T>(
    work: (scope: PrivacyWriterScope, store: MailAlertScopedStore<State>) => Promise<T>,
  ): Promise<T>;
}

export interface ProactiveMailAlertEngineDependencies<State extends MailAlertWorkspaceState = MailAlertWorkspaceState> {
  backend: MailAlertNotificationBackend;
  notificationWriter: MailAlertNotificationWriter<State>;
  sessionEpoch: string;
  getPrivacyStatus(): Promise<PrivacyPublicStatus>;
  /** Rebuilds admission from the exact committed-page proof and current controller policy. */
  isAttemptCurrent(state: State, receipt: ProactiveMailAlertReceipt): boolean | Promise<boolean>;
  /** Synchronous final gate for quarantine/disposal/refresh-required state after all async checks. */
  isDispatchGateOpen(): boolean;
  now?: () => Date;
}

export interface MailAlertQueueSlot<State extends MailAlertWorkspaceState = MailAlertWorkspaceState> {
  /** Adopt a child-store save that already succeeded under the same queue slot. No I/O. */
  publishScoped(state: State): void;
}

export interface MailAlertEngineResult {
  submitted: number;
  deliveryUnknown: number;
  notAdmitted: number;
  cancelled: number;
  cancellationUnknown: number;
  cancellationPending: number;
  cleanupPending: number;
}

const MAX_ACTIONS_PER_CALL = 16;

function receiptIdentityMatch(a: ProactiveMailAlertReceipt, b: ProactiveMailAlertReceipt): boolean {
  return a.id === b.id && a.installationId === b.installationId && a.consentId === b.consentId &&
    a.ruleId === b.ruleId && a.ruleVersion === b.ruleVersion && a.ruleRevision === b.ruleRevision &&
    a.timeZone === b.timeZone && a.consentActivatedAt === b.consentActivatedAt && a.accountId === b.accountId &&
    a.identityKey === b.identityKey && a.connectionGeneration === b.connectionGeneration &&
    a.providerMessageId === b.providerMessageId && a.sourceVersion === b.sourceVersion &&
    a.receivedAt === b.receivedAt && a.attemptedAt === b.attemptedAt;
}

function canonicalReceiptMatch(a: ProactiveMailAlertReceipt, b: ProactiveMailAlertReceipt): boolean {
  return receiptIdentityMatch(a, b) && a.cancellation?.requestedAt === b.cancellation?.requestedAt;
}

function cancellationObservation(
  current: ProactiveMailAlertReceipt,
  outcome: MailAlertCancellationResult,
  at: string,
): ProactiveMailAlertReceipt {
  const verifiedAbsent = outcome === 'cancelled' || outcome === 'absent';
  const cancellation = {
    requestedAt: current.cancellation?.requestedAt ?? at,
    attemptedAt: at,
    observedAt: at,
    result: verifiedAbsent ? 'absent' as const : 'unknown' as const,
  };
  return { ...current, observed: verifiedAbsent ? 'cancelled' : 'cancellation_unknown', cancellation, updatedAt: at };
}

function fixedNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Mail alert clock is invalid.');
  return value.toISOString();
}

function findReceipt(state: ProactiveMailAlertState, id: string): ProactiveMailAlertReceipt | undefined {
  return state.receipts.find((receipt) => receipt.id === id);
}

async function readFresh<State extends MailAlertWorkspaceState>(store: MailAlertScopedStore<State>): Promise<State | undefined> {
  await store.assertCurrent();
  const value = await store.load();
  if (!value) return undefined;
  const normalized = validateProactiveMailAlertState(value.proactiveMailAlerts);
  return { ...value, proactiveMailAlerts: normalized };
}

async function patchFreshReceipt<State extends MailAlertWorkspaceState>(
  store: MailAlertScopedStore<State>,
  id: string,
  update: (receipt: ProactiveMailAlertReceipt) => ProactiveMailAlertReceipt | undefined,
): Promise<State | undefined> {
  const fresh = await readFresh(store);
  if (!fresh) return undefined;
  const current = findReceipt(fresh.proactiveMailAlerts, id);
  if (!current) return undefined;
  const replacement = update(current);
  if (!replacement) return undefined;
  const receipts = fresh.proactiveMailAlerts.receipts.map((item) => item.id === id ? replacement : item);
  const alerts = validateProactiveMailAlertState({
    ...fresh.proactiveMailAlerts,
    revision: fresh.proactiveMailAlerts.revision + 1,
    receipts,
  });
  const next = { ...fresh, proactiveMailAlerts: alerts } as State;
  await store.save(next);
  return next;
}

function ownedPrivacyWriter(status: PrivacyPublicStatus, sessionEpoch: string): boolean {
  return status.epoch === sessionEpoch && status.phase === 'writer_active' && status.activeWriterCount >= 1 &&
    status.pendingCleanupCount === 0 && status.failedCleanupCount === 0;
}

function solePrivacyWriter(status: PrivacyPublicStatus, sessionEpoch: string): boolean {
  return ownedPrivacyWriter(status, sessionEpoch) && status.activeWriterCount === 1;
}

/**
 * Executes only the newly reserved `attempting` receipts from the just-committed plan. This
 * method must be called inside the controller's already-held transactionQueue slot.
 */
export async function executeReservedMailAlertAttempts<State extends MailAlertWorkspaceState>(
  dependencies: ProactiveMailAlertEngineDependencies<State>,
  queueSlot: MailAlertQueueSlot<State>,
  reserved: readonly ProactiveMailAlertReceipt[],
): Promise<MailAlertEngineResult> {
  if (!Array.isArray(reserved) || reserved.length > 2) throw new Error('Mail alert attempt batch is invalid.');
  const result: MailAlertEngineResult = { submitted: 0, deliveryUnknown: 0, notAdmitted: 0, cancelled: 0,
    cancellationUnknown: 0, cancellationPending: 0, cleanupPending: 0 };
  for (const planned of reserved) {
    if (planned.desired !== 'notify' || planned.observed !== 'attempting' || !planned.attemptedAt) {
      throw new Error('Mail alert attempt must have a durable reservation.');
    }
    let outcome: MailAlertPresentationResult = 'not_admitted';
    let compensatedCancellation: MailAlertCancellationResult | undefined;
    let compensatedReceipt: ProactiveMailAlertReceipt | undefined;
    let postflightSaved = false;
    try {
      outcome = await dependencies.notificationWriter.withNotificationWriter(async (_scope, store): Promise<MailAlertPresentationResult> => {
        const admitted = async (): Promise<boolean> => {
          try {
            const status = await dependencies.getPrivacyStatus();
            if (!ownedPrivacyWriter(status, dependencies.sessionEpoch)) return false;
            const fresh = await readFresh(store);
            const current = fresh && findReceipt(fresh.proactiveMailAlerts, planned.id);
            if (!fresh || !current || current.desired !== 'notify' || current.observed !== 'attempting' ||
                !canonicalReceiptMatch(current, planned)) return false;
            if (!(await dependencies.isAttemptCurrent(fresh as State, current))) return false;
            await store.assertCurrent();
            return dependencies.isDispatchGateOpen();
          } catch { return false; }
        };
        const current = await readFresh(store);
        const row = current && findReceipt(current.proactiveMailAlerts, planned.id);
        if (!current || !row || row.desired !== 'notify' || row.observed !== 'attempting' ||
            !canonicalReceiptMatch(row, planned) || !(await dependencies.isAttemptCurrent(current as State, row))) {
          const terminal = await patchFreshReceipt(store, planned.id, (latest) => {
            if (latest.desired !== 'notify' || latest.observed !== 'attempting' || !canonicalReceiptMatch(latest, planned)) return undefined;
            const at = fixedNow(dependencies.now ?? (() => new Date()));
            return { ...latest, observed: 'delivery_unknown', updatedAt: at };
          });
          if (terminal) queueSlot.publishScoped(terminal);
          return 'not_admitted';
        }
        const dispatchOutcome = await dependencies.backend.present({ installationId: planned.installationId, receiptId: planned.id }, admitted);
        if (dispatchOutcome !== 'not_admitted') {
          // A cross-workspace revocation may commit after admission but before native scheduling
          // settles. Re-read that one receipt and compensate once under this still-held writer.
          const afterDispatch = await readFresh(store);
          const latest = afterDispatch && findReceipt(afterDispatch.proactiveMailAlerts, planned.id);
          if (latest?.desired === 'cancel' && receiptIdentityMatch(latest, planned)) {
            compensatedReceipt = latest;
            try { compensatedCancellation = await dependencies.backend.cancel(
              { installationId: planned.installationId, receiptId: planned.id },
              async () => {
                try {
                  if (!solePrivacyWriter(await dependencies.getPrivacyStatus(), dependencies.sessionEpoch)) return false;
                  const cancellationState = await readFresh(store);
                  const currentReceipt = cancellationState && findReceipt(cancellationState.proactiveMailAlerts, planned.id);
                  return Boolean(currentReceipt?.desired === 'cancel' && currentReceipt.cancellation?.requestedAt === latest.cancellation?.requestedAt &&
                    receiptIdentityMatch(currentReceipt, latest));
                } catch { return false; }
              },
            ); } catch { compensatedCancellation = 'cancellation_unknown'; }
          }
        }
        if (dispatchOutcome === 'not_admitted') {
          const terminal = await patchFreshReceipt(store, planned.id, (latest) => {
            if (latest.desired !== 'notify' || latest.observed !== 'attempting' || !canonicalReceiptMatch(latest, planned)) return undefined;
            const at = fixedNow(dependencies.now ?? (() => new Date()));
            return { ...latest, observed: 'delivery_unknown', updatedAt: at };
          });
          if (terminal) queueSlot.publishScoped(terminal);
          return 'not_admitted';
        }
        const next = await patchFreshReceipt(store, planned.id, (latest) => {
          if (!receiptIdentityMatch(latest, planned)) return undefined;
          const at = fixedNow(dependencies.now ?? (() => new Date()));
          if (latest.desired === 'cancel') {
            if (!compensatedReceipt || !receiptIdentityMatch(latest, compensatedReceipt) ||
                latest.cancellation?.requestedAt !== compensatedReceipt.cancellation?.requestedAt ||
                !compensatedCancellation || compensatedCancellation === 'not_admitted') return undefined;
            return cancellationObservation(latest, compensatedCancellation, at);
          }
          if (latest.desired !== 'notify' || latest.observed !== 'attempting') return undefined;
          return { ...latest, observed: dispatchOutcome === 'submitted' ? 'submitted' : 'delivery_unknown', updatedAt: at };
        });
        if (next) { queueSlot.publishScoped(next); postflightSaved = true; }
        return dispatchOutcome;
      });
    } catch {
      outcome = 'delivery_unknown';
    }

    if (outcome === 'not_admitted') { result.notAdmitted++; continue; }
    // The notification writer remains held through the exact-receipt postflight save. If that
    // save fails, the durable `attempting` reservation is deliberately retained and never retried.
    if (outcome === 'submitted') result.submitted++;
    else if (outcome === 'delivery_unknown') result.deliveryUnknown++;
    else result.notAdmitted++;
    if (compensatedReceipt) {
      if (!postflightSaved || !compensatedCancellation || compensatedCancellation === 'not_admitted') result.cleanupPending++;
      else if (compensatedCancellation === 'cancelled' || compensatedCancellation === 'absent') result.cancelled++;
      else result.cancellationUnknown++;
    }
  }
  return result;
}

/**
 * Processes persisted cancellation intents, including receipts whose consent was later removed.
 * It never schedules or retries notifications and keeps every uncertain cancellation durable.
 */
export async function executeRequestedMailAlertCancellations<State extends MailAlertWorkspaceState>(
  dependencies: ProactiveMailAlertEngineDependencies<State>,
  queueSlot: MailAlertQueueSlot<State>,
  requested: readonly ProactiveMailAlertReceipt[],
): Promise<MailAlertEngineResult> {
  if (!Array.isArray(requested) || requested.length > 2000) throw new Error('Mail alert cancellation batch is invalid.');
  const result: MailAlertEngineResult = { submitted: 0, deliveryUnknown: 0, notAdmitted: 0, cancelled: 0,
    cancellationUnknown: 0, cancellationPending: 0, cleanupPending: 0 };
  result.cancellationPending = Math.max(0, requested.length - MAX_ACTIONS_PER_CALL);
  for (const planned of requested.slice(0, MAX_ACTIONS_PER_CALL)) {
    if (planned.desired !== 'cancel' || !planned.cancellation) throw new Error('Mail alert cancellation intent is invalid.');
    let outcome: MailAlertCancellationResult = 'not_admitted';
    let postflightSaved = false;
    try {
      outcome = await dependencies.notificationWriter.withNotificationWriter(async (_scope, store): Promise<MailAlertCancellationResult> => {
        const beforeCancel = async (): Promise<boolean> => {
          try {
            // This privacy-count proof is deliberately before the backend's first list/read.
            if (!solePrivacyWriter(await dependencies.getPrivacyStatus(), dependencies.sessionEpoch)) return false;
            const fresh = await readFresh(store);
            const current = fresh && findReceipt(fresh.proactiveMailAlerts, planned.id);
            return Boolean(current && current.desired === 'cancel' && canonicalReceiptMatch(current, planned));
          } catch { return false; }
        };
        const cancellationOutcome = await dependencies.backend.cancel({ installationId: planned.installationId, receiptId: planned.id }, beforeCancel);
        if (cancellationOutcome === 'not_admitted') return 'not_admitted';
        const next = await patchFreshReceipt(store, planned.id, (current) => {
          if (current.desired !== 'cancel' || !canonicalReceiptMatch(current, planned)) return undefined;
          return cancellationObservation(current, cancellationOutcome, fixedNow(dependencies.now ?? (() => new Date())));
        });
        if (next) { queueSlot.publishScoped(next); postflightSaved = true; }
        return cancellationOutcome;
      });
    } catch { outcome = 'cancellation_unknown'; }
    if (outcome === 'not_admitted') { result.cancellationPending++; continue; }
    if (!postflightSaved) { result.cancellationPending++; continue; }
    // Keep this writer through postflight; the sole-writer count is the explicit race proof.
    if (outcome === 'cancelled' || outcome === 'absent') result.cancelled++;
    else if (outcome === 'cancellation_unknown') result.cancellationUnknown++;
    else result.cancellationPending++;
  }
  return result;
}
