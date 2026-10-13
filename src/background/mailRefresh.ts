import type { Account, AppState, MailboxSnapshotMessage } from '../core';
import * as Crypto from 'expo-crypto';
import { ConnectorClient, describeMessageWindowQuery, type MessageSummary, type OAuthTokenStore } from '../connectors';
import { scopeGrantsCapability } from '../connectors/oauth';
import type { PrivacyWorkspaceSession } from '../privacy/service';
import type { CommittedMailAlertPage } from '../proactiveMailAlerts/types';
import { committedMailAlertPageForWorkspace } from '../proactiveMailAlerts/workspace';
import { MAIL_REFRESH_RUN_BUDGET_MS } from './backend.types';
import type { BackgroundMailConnector, BackgroundMailRefreshEngineDependencies, BackgroundMailRefreshOutcome } from './mailRefresh.types';
import { runBackgroundMailAlertPhase } from './mailAlerts';

const STATE_WRITER = { kind: 'app_state' as const, namespace: 'state_database' as const };
const PAGE_SIZE = 5 as const;
const MAX_ACCOUNTS = 2;
const MAX_RUN_MS = MAIL_REFRESH_RUN_BUDGET_MS;
const COOLDOWN_MS = 15 * 60_000;
const WINDOW_MS = 14 * 86_400_000;
const MAX_MAILBOX_PER_ACCOUNT = 200;
const MAX_TOTAL_MAILBOX = 200 * 200;

type Candidate = { account: Account; lastAttempt: number; query: ReturnType<typeof describeMessageWindowQuery> };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneState(value: AppState): AppState {
  return JSON.parse(JSON.stringify(value)) as AppState;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type AlertPageSeed = Readonly<{
  snapshot: Pick<AppState, 'accounts' | 'mailbox'>;
  account: Account;
  returnedIds: readonly string[];
  checkedAt: string;
}>;

function validMailboxSnapshot(value: unknown): value is MailboxSnapshotMessage[] {
  if (!Array.isArray(value) || value.length > MAX_TOTAL_MAILBOX) return false;
  const counts = new Map<string, number>();
  for (const item of value) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || item.id.length > 256 ||
        typeof item.accountId !== 'string' || !item.accountId || item.accountId.length > 256 ||
        typeof item.identityKey !== 'string' || !item.identityKey || item.identityKey.length > 4096 ||
        typeof item.providerMessageId !== 'string' || !item.providerMessageId || item.providerMessageId.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(item.id + item.accountId + item.identityKey + item.providerMessageId)) return false;
    const count = (counts.get(item.accountId) ?? 0) + 1;
    if (count > MAX_MAILBOX_PER_ACCOUNT) return false;
    counts.set(item.accountId, count);
  }
  return true;
}

function verifiedAccount(value: unknown): value is Account {
  if (!record(value) || (value.provider !== 'google' && value.provider !== 'microsoft') || value.connected !== true || value.authStatus !== 'connected' ||
      typeof value.id !== 'string' || !value.id || value.id.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(value.id) || /[\u0000-\u001f\u007f]/.test(value.id) || typeof value.tokenRef !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.tokenRef) ||
      !record(value.identity) || value.identity.providerNamespace !== value.provider || typeof value.identity.clientId !== 'string' || !value.identity.clientId ||
      typeof value.identity.subject !== 'string' || !value.identity.subject ||
      value.provider === 'microsoft' && (typeof value.identity.resourceUserId !== 'string' || !value.identity.resourceUserId) ||
      !Number.isSafeInteger(value.connectionGeneration ?? 0) || Number(value.connectionGeneration ?? 0) < 0 ||
      !Array.isArray(value.capabilities) || !value.capabilities.includes('mail.read') ||
      !Array.isArray(value.grantedScopes) || !value.grantedScopes.every((scope) => typeof scope === 'string') ||
      !scopeGrantsCapability(value.provider, value.grantedScopes as string[], 'mail.read')) return false;
  return true;
}

function identityKey(account: Account): string {
  const identity = account.identity!;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function fixedOutcome(status: BackgroundMailRefreshOutcome['status'], attempted: number, completed: number, failed: number, skipped: number, reason?: BackgroundMailRefreshOutcome['reason']): BackgroundMailRefreshOutcome {
  return Object.freeze({ status, attempted, completed, failed, skipped, ...(reason ? { reason } : {}) });
}

export function createBackgroundMailRefreshEngine(dependencies: BackgroundMailRefreshEngineDependencies) {
  const session: PrivacyWorkspaceSession = Object.freeze({ epoch: dependencies.session.epoch, runtimeId: dependencies.session.runtimeId });
  const now = dependencies.now ?? (() => new Date());
  const createConnector = dependencies.connectorFactory ?? ((tokenStore: OAuthTokenStore, withProviderOwnership) =>
    new ConnectorClient({ tokenStore, withProviderOwnership }));

  return Object.freeze({
    async run(parentSignal?: AbortSignal): Promise<BackgroundMailRefreshOutcome> {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(parentSignal?.reason);
      const deadlineMs = Math.max(1_000, Math.min(MAX_RUN_MS, dependencies.deadlineMs ?? MAX_RUN_MS));
      const started = Date.now();
      let requestCount = 0;
      let attempted = 0; let completed = 0; let failed = 0; let skipped = 0;
      let deadlineReached = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const assertActive = () => {
        if (controller.signal.aborted || Date.now() - started >= deadlineMs) {
          if (Date.now() - started >= deadlineMs) deadlineReached = true;
          throw new Error('Background mail refresh deadline.');
        }
      };
      const withStateOwnership = <T>(work: () => Promise<T>) => dependencies.privacy.withWriter(session.epoch, STATE_WRITER, async () => {
        assertActive();
        await dependencies.privacy.assertWorkspaceEpoch(session.epoch);
        assertActive();
        return work();
      });
      parentSignal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        if (parentSignal?.aborted) return fixedOutcome('skipped', 0, 0, 0, 0, 'privacy_not_ready');
        timer = setTimeout(() => { deadlineReached = true; controller.abort(new Error('Background mail refresh deadline.')); }, deadlineMs);
        const privacyStatus = await dependencies.privacy.getStatus();
        if (privacyStatus.epoch !== session.epoch || privacyStatus.phase !== 'ready' || privacyStatus.activeWriterCount !== 0 ||
            privacyStatus.pendingCleanupCount !== 0 || privacyStatus.failedCleanupCount !== 0) {
          return fixedOutcome('skipped', 0, 0, 0, 0, 'privacy_not_ready');
        }
        await dependencies.privacy.assertWorkspaceEpoch(session.epoch);
        assertActive();
        const store = dependencies.createStateStore();
        if (typeof store.assertCurrent !== 'function') return fixedOutcome('skipped', 0, 0, 0, 0, 'state_unavailable');
        const raw = await withStateOwnership(() => store.load());
        if (!raw || !record(raw) || !Array.isArray(raw.accounts) || !Array.isArray(raw.mailbox) || !record(raw.syncStates) ||
            raw.mailboxSchemaVersion !== 2 || !record(raw.settings)) return fixedOutcome('skipped', 0, 0, 0, 0, 'state_unavailable');
        if (raw.accounts.some((item) => record(item) && typeof item.id === 'string' &&
            (['__proto__', 'prototype', 'constructor'].includes(item.id) || /[\u0000-\u001f\u007f]/.test(item.id)))) {
          return fixedOutcome('skipped', 0, 0, 0, 0, 'state_unavailable');
        }
        const settings = raw.settings;
        const enabled = settings.backgroundMailRefreshEnabled === true;
        const generation = settings.backgroundRefreshGeneration === undefined ? 0 : settings.backgroundRefreshGeneration;
        if (!Number.isSafeInteger(generation) || Number(generation) < 0 || (settings.backgroundMailRefreshEnabled !== undefined && typeof settings.backgroundMailRefreshEnabled !== 'boolean')) {
          return fixedOutcome('skipped', 0, 0, 0, 0, 'disabled');
        }
        if (enabled && settings.backgroundRefreshGeneration === undefined) return fixedOutcome('skipped', 0, 0, 0, 0, 'disabled');
        if (!enabled) return fixedOutcome('skipped', 0, 0, 0, 0, 'disabled');
        if (raw.accounts.length > 200) return fixedOutcome('skipped', 0, 0, 0, 0, 'state_unavailable');
        if (!validMailboxSnapshot(raw.mailbox)) return fixedOutcome('skipped', 0, 0, 0, 0, 'state_unavailable');
        const capturedBackgroundGeneration = Number(generation);
        const committedAlertPages: CommittedMailAlertPage[] = [];
        const alertPageSeeds: AlertPageSeed[] = [];
        const runMailAlerts = async () => {
          if (!dependencies.mailAlerts) return;
          await runBackgroundMailAlertPhase({
            store, privacy: dependencies.privacy, session, backend: dependencies.mailAlerts.backend,
            notificationWriter: dependencies.mailAlerts.notificationWriter, pages: committedAlertPages,
            capturedBackgroundGeneration, now, uuid: dependencies.uuid ?? defaultUuid, assertActive,
            withStateOwnership, digest: dependencies.mailAlerts.digest, isHeadlessAccountEligible: verifiedAccount,
          });
        };
        const currentDate = now(); const currentMs = currentDate.getTime();
        if (!Number.isFinite(currentMs)) return fixedOutcome('skipped', 0, 0, 0, 0, 'state_unavailable');
        const timeMax = currentDate.toISOString(); const timeMin = new Date(currentMs - WINDOW_MS).toISOString();
        const candidates: Candidate[] = [];
        let connectedReadAccounts = 0;
        let cooldownSkipped = 0;
        const eligibleAccountIds = new Set<string>();
        for (const account of raw.accounts) {
          if (!verifiedAccount(account)) { skipped++; continue; }
          if (eligibleAccountIds.has(account.id)) return fixedOutcome('skipped', 0, 0, 0, skipped, 'state_unavailable');
          eligibleAccountIds.add(account.id);
          connectedReadAccounts++;
          const syncState: unknown = raw.syncStates[account.id];
          const head: Record<string, unknown> = record(syncState) && record(syncState.mailHead) ? syncState.mailHead : {};
          let lastAttempt = 0;
          if (head.lastAttemptAt !== undefined) {
            if (typeof head.lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(head.lastAttemptAt))) { skipped++; continue; }
            lastAttempt = Date.parse(head.lastAttemptAt);
            if (currentMs - lastAttempt < COOLDOWN_MS) { skipped++; cooldownSkipped++; continue; }
          }
          try {
            candidates.push({ account, lastAttempt, query: describeMessageWindowQuery(account, { timeMin, timeMax, pageSize: PAGE_SIZE }) });
          } catch { skipped++; }
        }
        candidates.sort((left, right) => left.lastAttempt - right.lastAttempt || left.account.id.localeCompare(right.account.id));
        if (!candidates.length) {
          const outcome = fixedOutcome('skipped', 0, 0, 0, skipped,
            connectedReadAccounts > 0 && cooldownSkipped > 0 ? 'cooldown' : 'no_eligible_accounts');
          await runMailAlerts();
          return outcome;
        }
        const selected = candidates.slice(0, MAX_ACCOUNTS);
        skipped += candidates.length - selected.length;
        const reservation = cloneState(raw as AppState);
        const attemptedAt = timeMax;
        for (const candidate of selected) {
          const prior: unknown = reservation.syncStates[candidate.account.id];
          const existing: Record<string, unknown> = record(prior) ? prior : { accountId: candidate.account.id };
          const head: Record<string, unknown> = record(existing.mailHead) ? existing.mailHead : { status: 'idle' };
          reservation.syncStates[candidate.account.id] = {
            ...existing,
            mailHead: { ...head, lastAttemptAt: attemptedAt },
          } as AppState['syncStates'][string];
        }
        await withStateOwnership(async () => {
          assertActive();
          await store.save(reservation);
        });
        const connector = createConnector(dependencies.tokenStore, dependencies.withProviderOwnership);
        for (const candidate of selected) {
          if (controller.signal.aborted) { skipped += selected.length - completed - failed; break; }
          const guard = () => {
            assertActive();
            if (++requestCount > 20) throw new Error('Background mail request limit.');
          };
          try {
            assertActive();
            await withStateOwnership(() => store.assertCurrent!());
            assertActive();
            attempted++;
            const page = await connector.syncMessageWindow(candidate.account, {
              timeMin: candidate.query.window.from, timeMax: candidate.query.window.to, pageSize: PAGE_SIZE,
              signal: controller.signal, guard, allowTokenRefresh: false,
            });
            assertActive();
            if (!record(page) || !record(page.window) || !Array.isArray(page.items) || !Array.isArray(page.unavailableIds) ||
                page.window.from !== candidate.query.window.from || page.window.to !== candidate.query.window.to ||
                page.queryFingerprint !== candidate.query.queryFingerprint || page.items.length > PAGE_SIZE || page.unavailableIds.length > PAGE_SIZE ||
                typeof page.partial !== 'boolean' || page.nextCursor !== undefined &&
                  (typeof page.nextCursor !== 'string' || page.nextCursor.length > 8192 || /[\u0000-\u001f\u007f]/.test(page.nextCursor))) {
              throw new Error('Provider page did not match the captured mailbox query.');
            }
            const returnedIds = new Set<string>();
            for (const item of page.items) {
              if (!record(item) || typeof item.id !== 'string' || !item.id || item.id.length > 2048 || /[\u0000-\u001f\u007f]/.test(item.id) || returnedIds.has(item.id)) {
                throw new Error('Provider page did not match the captured mailbox query.');
              }
              returnedIds.add(item.id);
            }
            for (const id of page.unavailableIds) {
              if (typeof id !== 'string' || !id || id.length > 2048 || /[\u0000-\u001f\u007f]/.test(id) || returnedIds.has(id)) {
                throw new Error('Provider page did not match the captured mailbox query.');
              }
              returnedIds.add(id);
            }
            // Freeze provider output before any further await. Neither a later SDK mutation nor
            // a shared test adapter can widen the committed-page proof after validation.
            const capturedItems = cloneJson(page.items);
            const capturedReturnedIds = Object.freeze(capturedItems.map((item) => item.id));
            const capturedUnavailableIds = cloneJson(page.unavailableIds);
            const capturedPage = { ...page, items: capturedItems, unavailableIds: capturedUnavailableIds,
              window: cloneJson(page.window) };
            await withStateOwnership(() => store.assertCurrent!());
            assertActive();
            const next = cloneState(reservation);
            const checkedAt = now().toISOString();
            applyPage(next, candidate.account, capturedItems, capturedUnavailableIds, capturedPage, checkedAt, dependencies.uuid ?? defaultUuid);
            try {
              await withStateOwnership(async () => {
                assertActive();
                await store.save(next);
              });
            } catch {
              return fixedOutcome('failed', attempted, completed, failed + 1, skipped + selected.length - completed - 1, 'stale_state');
            }
            Object.assign(reservation, next);
            completed++;
            if (dependencies.mailAlerts && capturedReturnedIds.length > 0) {
              try {
                // Capture only the exact rows acknowledged by this page save. Hashing and policy
                // evaluation are deferred until after the provider loop and mail outcome freeze.
                const ids = new Set(capturedReturnedIds);
                const accountKey = identityKey(candidate.account);
                const exactRows = next.mailbox.filter((row) => row.accountId === candidate.account.id &&
                  ids.has(row.providerMessageId) && row.connectionGeneration === (candidate.account.connectionGeneration ?? 0) &&
                  row.verifiedIdentityKey === accountKey && !row.providerDeletedAt);
                const proofAccounts = cloneJson(next.accounts);
                const proofAccount = proofAccounts.find((row) => row.id === candidate.account.id);
                if (proofAccount && exactRows.length > 0) {
                  alertPageSeeds.push(Object.freeze({
                    snapshot: Object.freeze({ accounts: proofAccounts, mailbox: cloneJson(exactRows) }),
                    account: proofAccount,
                    returnedIds: Object.freeze([...capturedReturnedIds]),
                    checkedAt,
                  }));
                }
              } catch { /* Optional proof capture cannot downgrade an acknowledged mail save. */ }
            }
          } catch (error) {
            if (controller.signal.aborted || deadlineReached) {
              failed += 1;
              skipped += selected.length - completed - failed;
              break;
            }
            if (error instanceof Error && /Saved data changed|workspace changed|stale_epoch|cleanup_in_progress/i.test(error.message)) {
              return fixedOutcome('failed', attempted, completed, failed, skipped + selected.length - completed - failed, 'stale_state');
            }
            failed++;
          }
        }
        let mailOutcome: BackgroundMailRefreshOutcome;
        if (deadlineReached) mailOutcome = fixedOutcome('failed', attempted, completed, failed, skipped, 'deadline');
        else if (completed === selected.length) {
          const partial = selected.some((candidate) => {
            const head = reservation.syncStates[candidate.account.id]?.mailHead;
            return head?.status === 'partial';
          });
          mailOutcome = fixedOutcome(partial ? 'partial' : 'refreshed', attempted, completed, failed, skipped);
        } else if (completed > 0) mailOutcome = fixedOutcome('partial', attempted, completed, failed, skipped);
        else mailOutcome = fixedOutcome('failed', attempted, completed, failed || attempted, skipped, 'provider_unavailable');
        if (dependencies.mailAlerts) {
          for (const seed of alertPageSeeds) {
            try {
              assertActive();
              const proof = await committedMailAlertPageForWorkspace(seed.snapshot, seed.account,
                seed.returnedIds, seed.checkedAt, { now, digest: dependencies.mailAlerts.digest ?? ((text) => Crypto.digestStringAsync(
                  Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX })) });
              assertActive();
              if (proof) committedAlertPages.push(Object.freeze({ ...proof,
                sources: Object.freeze(proof.sources.map((source) => Object.freeze({ ...source }))) }));
            } catch {
              if (controller.signal.aborted || deadlineReached) break;
              // A page remains a successful mail refresh if optional alert proof fails.
            }
          }
        }
        // Optional alert drainage does not alter the independently committed mail result.
        await runMailAlerts();
        return mailOutcome;
      } catch {
        if (deadlineReached || controller.signal.aborted) return fixedOutcome('failed', attempted, completed, failed, skipped, 'deadline');
        return fixedOutcome('failed', attempted, completed, failed, skipped, 'state_unavailable');
      } finally {
        if (timer) clearTimeout(timer);
        parentSignal?.removeEventListener('abort', forwardAbort);
      }
    },
  });
}

function defaultUuid(): string {
  return Crypto.randomUUID();
}

function applyPage(
  state: AppState,
  account: Account,
  items: MessageSummary[],
  unavailableIds: string[],
  page: Awaited<ReturnType<BackgroundMailConnector['syncMessageWindow']>>,
  checkedAt: string,
  uuid: () => string,
): void {
  const key = identityKey(account);
  const timestamp = checkedAt;
  for (const item of items) {
    if (!item.id || item.id.length > 2048 || /[\u0000-\u001f\u007f]/.test(item.id)) throw new Error('Provider returned invalid message metadata.');
    const providerKey = `${key}:${item.id}`;
    const prior = state.mailbox.find((entry) => entry.accountId === account.id && entry.identityKey === providerKey);
    const value: MailboxSnapshotMessage = {
      id: prior?.id ?? uuid(), accountId: account.id, providerMessageId: item.id, identityKey: providerKey,
      verifiedIdentityKey: key, connectionGeneration: account.connectionGeneration ?? 0, idFormat: item.idFormat,
      threadId: item.threadId, subject: item.subject, from: item.from, senderEmail: item.senderEmail,
      receivedAt: item.receivedAt, snippet: item.snippet, isRead: item.isRead,
      replyMetadataComplete: item.replyMetadataComplete, internetMessageId: item.internetMessageId, providerVersion: item.providerVersion,
      sizeEstimate: item.sizeEstimate, sizeCheckedAt: item.sizeCheckedAt, replyTo: item.replyTo, to: item.to, cc: item.cc,
      references: item.references, inReplyTo: item.inReplyTo, headers: item.headers, observedAt: timestamp,
    };
    if (prior) {
      Object.assign(prior, value);
      delete prior.providerDeletedAt;
    } else {
      state.mailbox.push(value);
    }
  }
  let unavailableCount = 0;
  for (const id of unavailableIds) {
    if (!id || id.length > 2048 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Provider returned invalid message metadata.');
    const providerKey = `${key}:${id}`;
    const prior = state.mailbox.find((entry) => entry.accountId === account.id && entry.identityKey === providerKey);
    const deletedAt = prior?.providerDeletedAt ?? timestamp;
    const tombstone: MailboxSnapshotMessage = {
      id: prior?.id ?? uuid(), accountId: account.id, providerMessageId: id, identityKey: providerKey,
      verifiedIdentityKey: key, connectionGeneration: account.connectionGeneration ?? 0,
      idFormat: account.provider === 'microsoft' ? 'graph-immutable' : 'gmail', providerDeletedAt: deletedAt, observedAt: timestamp,
    };
    if (prior) Object.assign(prior, tombstone); else state.mailbox.push(tombstone);
    unavailableCount++;
  }
  const accountMessages = state.mailbox.filter((entry) => entry.accountId === account.id)
    .sort((left, right) => (right.receivedAt ?? right.observedAt ?? '').localeCompare(left.receivedAt ?? left.observedAt ?? '')).slice(0, MAX_MAILBOX_PER_ACCOUNT);
  state.mailbox = [...state.mailbox.filter((entry) => entry.accountId !== account.id), ...accountMessages];
  const sync = state.syncStates[account.id];
  if (!sync) throw new Error('Mailbox sync state is unavailable.');
  sync.mailHead = {
    ...sync.mailHead,
    status: page.partial ? 'partial' : 'idle',
    window: { from: page.window.from, through: page.window.to, pageSize: PAGE_SIZE, queryFingerprint: page.queryFingerprint, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) },
    lastPageCheckedAt: checkedAt, lastPageSucceededAt: checkedAt, unavailableCount: (sync.mailHead.unavailableCount ?? 0) + unavailableCount,
    lastError: undefined,
    ...(!page.partial ? { completeWindow: { from: page.window.from, through: page.window.to } } : {}),
  };
}
