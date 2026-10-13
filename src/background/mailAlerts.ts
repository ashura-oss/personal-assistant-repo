import * as Crypto from 'expo-crypto';
import type { AppState } from '../core';
import { validateProactiveMailAlertState } from '../proactiveMailAlerts/state';
import { planProactiveMailAlerts } from '../proactiveMailAlerts/planner';
import { executeRequestedMailAlertCancellations, executeReservedMailAlertAttempts } from '../proactiveMailAlerts/engine';
import type { CommittedMailAlertPage } from '../proactiveMailAlerts/types';
import type { BackgroundMailAlertWriter } from './mailRefresh.types';
import type { PrivacyService, PrivacyWorkspaceSession } from '../privacy/service';
import type { MailAlertNotificationBackend } from '../services/mailAlertNotificationBackend';
import type { StateStore } from '../storage/contracts';
import { mailAlertAccountsForWorkspace, isMailAlertAttemptCurrentForWorkspace } from '../proactiveMailAlerts/workspace';
import { validateProactiveState } from '../proactive/state';

type RecordLike = Record<string, unknown>;

export interface BackgroundMailAlertPhaseInput {
  store: StateStore;
  privacy: Pick<PrivacyService, 'getStatus' | 'assertWorkspaceEpoch'>;
  session: PrivacyWorkspaceSession;
  backend: MailAlertNotificationBackend;
  notificationWriter: BackgroundMailAlertWriter;
  pages: readonly CommittedMailAlertPage[];
  capturedBackgroundGeneration: number;
  now: () => Date;
  uuid: () => string;
  assertActive: () => void;
  withStateOwnership: <T>(work: () => Promise<T>) => Promise<T>;
  digest?: (text: string) => Promise<string>;
  isHeadlessAccountEligible: (value: unknown) => boolean;
}

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** JSON persistence equivalence with stable object-key ordering; array order is significant. */
function persistedJson(value: unknown): string {
  const jsonRoundTripped: unknown = JSON.parse(JSON.stringify(value) as string);
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((child) => child === undefined ? null : normalize(child));
    if (!isRecord(item)) return item;
    const result: RecordLike = Object.create(null) as RecordLike;
    for (const key of Object.keys(item).sort()) {
      if (item[key] !== undefined) {
        Object.defineProperty(result, key, { value: normalize(item[key]), enumerable: true, configurable: true, writable: true });
      }
    }
    return result;
  };
  return JSON.stringify(normalize(jsonRoundTripped)) ?? 'undefined';
}

function validAlertQuarantine(raw: RecordLike): boolean {
  if (raw.proactiveQuarantine !== undefined) return false;
  const mailQuarantine = raw.proactiveMailAlertQuarantine;
  return mailQuarantine === undefined || Array.isArray(mailQuarantine) && mailQuarantine.length === 0;
}

function validBackgroundGeneration(raw: RecordLike, expected: number): boolean {
  const settings = raw.settings;
  return isRecord(settings) && settings.backgroundMailRefreshEnabled === true &&
    settings.backgroundRefreshGeneration === expected && Number.isSafeInteger(expected) && expected >= 0;
}

function defaultDigest(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
}

function checkedAlertPolicy(raw: RecordLike): { alertState: ReturnType<typeof validateProactiveMailAlertState>; proactive: ReturnType<typeof validateProactiveState> } | undefined {
  if (!validAlertQuarantine(raw) || !Array.isArray(raw.accounts) || !Array.isArray(raw.mailbox) || !isRecord(raw.proactive)) return undefined;
  const alertState = validateProactiveMailAlertState(raw.proactiveMailAlerts);
  if (persistedJson(raw.proactiveMailAlerts) !== persistedJson(alertState)) return undefined;
  const proactive = validateProactiveState(raw.proactive);
  if (proactive.integrityError !== undefined) return undefined;
  return { alertState, proactive };
}

/**
 * Plans against one fresh raw state, reserves before notification IO, and executes only that
 * reservation. This intentionally does not run controller normalization or repair raw fields.
 */
export async function runBackgroundMailAlertPhase(input: BackgroundMailAlertPhaseInput): Promise<void> {
  const { store, privacy, session, backend, notificationWriter, pages } = input;
  const readFreshRaw = async (): Promise<RecordLike | undefined> => {
    input.assertActive();
    const value: unknown = await input.withStateOwnership(async () => {
      input.assertActive();
      if (!store.assertCurrent) throw new Error('Workspace storage ownership cannot be checked.');
      await store.assertCurrent();
      input.assertActive();
      await privacy.assertWorkspaceEpoch(session.epoch);
      input.assertActive();
      return store.load();
    });
    input.assertActive();
    return isRecord(value) ? value : undefined;
  };

  let initial: RecordLike | undefined;
  try {
    initial = await readFreshRaw();
    if (!initial || !validBackgroundGeneration(initial, input.capturedBackgroundGeneration)) return;
    const checkedPolicy = checkedAlertPolicy(initial);
    if (!checkedPolicy) return;
    const { alertState, proactive } = checkedPolicy;
    // The validator is a checker here, not a migration. Unknown or noncanonical persisted
    // ledger data is preserved and causes this optional feature to fail closed.
    if (!isRecord(initial.settings) || typeof initial.settings.timezone !== 'string') return;

    const rawAccountRows = initial.accounts as unknown[];
    const accountCounts = new Map<string, number>();
    for (const row of rawAccountRows) {
      if (isRecord(row) && typeof row.id === 'string') accountCounts.set(row.id, (accountCounts.get(row.id) ?? 0) + 1);
    }
    const eligibleAccountIds = new Set(rawAccountRows.flatMap((row) =>
      isRecord(row) && typeof row.id === 'string' && accountCounts.get(row.id) === 1 && input.isHeadlessAccountEligible(row)
        ? [row.id] : []));
    const accounts = mailAlertAccountsForWorkspace(initial as unknown as AppState)
      .filter((account) => eligibleAccountIds.has(account.accountId));
    const currentDate = input.now();
    if (!(currentDate instanceof Date) || !Number.isFinite(currentDate.getTime())) return;
    const plan = planProactiveMailAlerts({
      state: alertState,
      rules: proactive.rules,
      accounts,
      pages,
      previousCandidates: proactive.candidates.map((entry) => entry.candidate),
      dismissedCandidateIds: proactive.dismissals.map((item) => item.candidateId),
      snoozes: proactive.snoozes,
      now: currentDate.toISOString(),
      currentTimeZone: initial.settings.timezone,
      uuid: input.uuid,
    });

    const reservedRaw = cloneJson(initial);
    reservedRaw.proactiveMailAlerts = plan.nextState;
    if (persistedJson(alertState) !== persistedJson(plan.nextState)) {
      input.assertActive();
      await input.withStateOwnership(async () => {
        input.assertActive();
        if (!store.assertCurrent) throw new Error('Workspace storage ownership cannot be checked.');
        await store.assertCurrent();
        input.assertActive();
        await privacy.assertWorkspaceEpoch(session.epoch);
        input.assertActive();
        await store.save(reservedRaw as unknown as AppState);
      });
      input.assertActive();
    }

    if (!plan.cancellationReceipts.length && !plan.newAttempts.length) return;
    const engine = {
      backend,
      sessionEpoch: session.epoch,
      getPrivacyStatus: () => privacy.getStatus(),
      isDispatchGateOpen: () => {
        try { input.assertActive(); } catch { return false; }
        return true;
      },
      isCancellationGateOpen: () => {
        try { input.assertActive(); } catch { return false; }
        return true;
      },
      isAttemptCurrent: async (latest: AppState, receipt: Parameters<typeof isMailAlertAttemptCurrentForWorkspace>[2]) => {
        try {
          input.assertActive();
          const latestRaw = latest as unknown as RecordLike;
          if (!validBackgroundGeneration(latestRaw, input.capturedBackgroundGeneration) || !checkedAlertPolicy(latestRaw)) return false;
          if (!Array.isArray(latestRaw.accounts)) return false;
          const matchingAccounts = latestRaw.accounts.filter((row) => isRecord(row) && row.id === receipt.accountId);
          if (matchingAccounts.length !== 1 || !input.isHeadlessAccountEligible(matchingAccounts[0])) return false;
          const current = await isMailAlertAttemptCurrentForWorkspace(latest, pages, receipt, { now: input.now, digest: input.digest ?? defaultDigest });
          input.assertActive();
          return current && validBackgroundGeneration(latestRaw, input.capturedBackgroundGeneration) && Boolean(checkedAlertPolicy(latestRaw));
        } catch { return false; }
      },
      notificationWriter: {
        withNotificationWriter: <T>(work: (scope: import('../privacy/types').PrivacyWriterScope,
          scopedStore: import('../proactiveMailAlerts/engine').MailAlertScopedStore<AppState>) => Promise<T>) => {
          input.assertActive();
          return notificationWriter.withNotificationWriter(store, (scope, scopedStore) => {
            input.assertActive();
            const checkedStore: import('../proactiveMailAlerts/engine').MailAlertScopedStore<AppState> = {
              async load() {
                const fresh = await scopedStore.load();
                if (!fresh || !checkedAlertPolicy(fresh as unknown as RecordLike)) throw new Error('Mail alert state is unavailable.');
                return fresh;
              },
              async save(state) {
                if (!checkedAlertPolicy(state as unknown as RecordLike)) throw new Error('Mail alert state is unavailable.');
                await scopedStore.save(state);
              },
              assertCurrent: () => scopedStore.assertCurrent(),
            };
            return work(scope, checkedStore);
          });
        },
      },
    };
    const queueSlot = { publishScoped: (_saved: AppState) => undefined };
    if (plan.cancellationReceipts.length) {
      await executeRequestedMailAlertCancellations(engine, queueSlot, plan.cancellationReceipts);
    }
    if (plan.newAttempts.length) {
      await executeReservedMailAlertAttempts(engine, queueSlot, plan.newAttempts);
    }
  } catch {
    // Mail refresh is independently useful. Any malformed/stale alert state, CAS conflict,
    // lost reservation acknowledgement, or notification ambiguity simply stops alert work.
  }
}
