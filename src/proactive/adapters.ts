import type { AppState, CalendarEventSnapshot, MailboxSnapshotMessage } from '../core';
import { proactiveSourceId, validateProactiveSource, type ProactiveCandidate, type ProactiveSource } from './index';
import type { DeviceEventSnapshot } from '../deviceCalendars';
import { isValidAccountId } from '../core/accountIds';

export interface ProactiveSourceHashMemoEntry { canonical: string; version: string }
export type ProactiveSourceHashMemo = Map<string, ProactiveSourceHashMemoEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validMailRow(value: unknown): value is MailboxSnapshotMessage {
  return isRecord(value) && isValidAccountId(value.accountId) &&
    typeof value.providerMessageId === 'string' && value.providerMessageId.length > 0 && value.providerMessageId.length <= 1024;
}

function validEventRow(value: unknown): value is CalendarEventSnapshot {
  return isRecord(value) && isValidAccountId(value.accountId) &&
    typeof value.calendarId === 'string' && value.calendarId.length > 0 && value.calendarId.length <= 256 &&
    typeof value.providerEventId === 'string' && value.providerEventId.length > 0 && value.providerEventId.length <= 1024;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function identityValue(account: AppState['accounts'][number]): string | undefined {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId) || identity.providerNamespace !== account.provider) return undefined;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? '', identity.issuer ?? '', identity.tenantId ?? ''].join(':');
}

function validObservedAt(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now && now - time < 15 * 60_000;
}

async function hashedSource(
  sourceId: string,
  canonicalValue: unknown,
  memo: ProactiveSourceHashMemo,
  digest: (value: string) => Promise<string>,
): Promise<string> {
  const canonical = stable(canonicalValue);
  const existing = memo.get(sourceId);
  if (existing?.canonical === canonical) return existing.version;
  const version = await digest(canonical);
  memo.delete(sourceId);
  memo.set(sourceId, { canonical, version });
  while (memo.size > 2000) memo.delete(memo.keys().next().value as string);
  return version;
}

function linkedIdentity(account: AppState['accounts'][number], verifiedKey: string | undefined, generation: number | undefined): boolean {
  const identity = identityValue(account);
  if (!identity || !verifiedKey) return false;
  const expected = [account.identity!.providerNamespace, account.identity!.clientId, account.identity!.subject, account.identity!.resourceUserId ?? ''].join(':');
  return verifiedKey === expected && generation === (account.connectionGeneration ?? 0);
}

async function mailSource(
  row: MailboxSnapshotMessage,
  account: AppState['accounts'][number],
  now: number,
  memo: ProactiveSourceHashMemo,
  digest: (value: string) => Promise<string>,
): Promise<ProactiveSource | undefined> {
  const namespace = account.identity?.providerNamespace;
  if (!namespace || typeof row.providerMessageId !== 'string' || !row.providerMessageId || row.providerMessageId.length > 1024) return undefined;
  const sourceId = proactiveSourceId({ namespace, accountId: account.id, providerId: row.providerMessageId });
  const identityMatches = linkedIdentity(account, row.verifiedIdentityKey, row.connectionGeneration);
  const available = !(row.providerDeletedAt && identityMatches);
  const canRead = Boolean(account.connected && account.authStatus === 'connected' && account.capabilities?.includes('mail.read') && identityMatches);
  // Freshness describes the snapshot, not whether every rule-specific field is populated.
  // The evaluator handles missing sender/read/time facts as uncertain for rules that need them.
  const freshness = canRead && validObservedAt(row.observedAt, now) ? 'fresh' : canRead ? 'stale' : identityMatches ? 'stale' : 'unknown';
  const consumed = {
    kind: 'mail', namespace, accountId: account.id, providerId: row.providerMessageId,
    verifiedIdentity: identityValue(account), senderEmail: row.senderEmail, isRead: row.isRead,
    subject: row.subject, snippet: row.snippet, receivedAt: row.receivedAt, receivedAtUtcCertified: false,
    availability: available ? 'available' : 'unavailable',
  };
  try {
    const candidate: ProactiveSource = {
      kind: 'mail', sourceId, namespace, accountId: account.id, providerId: row.providerMessageId, sourceVersion: 'pending',
      availability: available ? 'available' : 'unavailable', freshness,
      ...(row.senderEmail !== undefined ? { senderEmail: row.senderEmail } : {}),
      ...(row.isRead !== undefined ? { isRead: row.isRead } : {}),
      ...(row.subject !== undefined ? { subject: row.subject } : {}),
      ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
      ...(row.receivedAt !== undefined ? { receivedAt: row.receivedAt } : {}),
    };
    validateProactiveSource(candidate);
    const sourceVersion = await hashedSource(sourceId, consumed, memo, digest);
    return { ...candidate, sourceVersion };
  } catch { return undefined; }
}

async function meetingSource(
  event: CalendarEventSnapshot,
  calendar: AppState['calendars'][number],
  account: AppState['accounts'][number],
  now: number,
  memo: ProactiveSourceHashMemo,
  digest: (value: string) => Promise<string>,
): Promise<ProactiveSource | undefined> {
  const namespace = account.identity?.providerNamespace;
  if (!namespace || typeof event.providerEventId !== 'string' || !event.providerEventId || event.providerEventId.length > 1024) return undefined;
  // Calendar ID is part of the provider ID tuple because event IDs may collide between calendars.
  const providerId = JSON.stringify([calendar.providerId ?? calendar.id, event.providerEventId]);
  const sourceId = proactiveSourceId({ namespace, accountId: account.id, providerId });
  const identityMatches = linkedIdentity(account, event.verifiedIdentityKey, event.connectionGeneration);
  const available = !(event.providerDeletedAt && identityMatches);
  const canRead = Boolean(account.connected && account.authStatus === 'connected' && account.capabilities?.includes('calendar.read') && calendar.connected && identityMatches);
  const freshness = canRead && validObservedAt(event.observedAt, now) ? 'fresh' : canRead ? 'stale' : identityMatches ? 'stale' : 'unknown';
  const consumed = {
    kind: 'meeting', namespace, accountId: account.id, providerId,
    verifiedIdentity: identityValue(account), calendarId: calendar.id,
    subject: event.subject, startAt: event.start, startUtcCertified: event.startUtcCertified,
    availability: available ? 'available' : 'unavailable',
  };
  try {
    const candidate: ProactiveSource = {
      kind: 'meeting', sourceId, namespace, accountId: account.id, providerId, sourceVersion: 'pending',
      availability: available ? 'available' : 'unavailable', freshness,
      ...(event.subject !== undefined ? { subject: event.subject } : {}),
      ...(event.start !== undefined ? { startAt: event.start } : {}),
      ...(event.startUtcCertified !== undefined ? { startAtUtcCertified: event.startUtcCertified } : {}),
    };
    validateProactiveSource(candidate);
    const sourceVersion = await hashedSource(sourceId, consumed, memo, digest);
    return { ...candidate, sourceVersion };
  } catch { return undefined; }
}

async function deviceMeetingSource(
  event: DeviceEventSnapshot,
  state: AppState,
  now: number,
  memo: ProactiveSourceHashMemo,
  digest: (value: string) => Promise<string>,
): Promise<ProactiveSource | undefined> {
  const device = state.deviceCalendars;
  const calendar = device.calendars.find((row) => row.localId === event.calendarId);
  const run = device.readRun;
  if (!calendar || !run || event.allDay || state.deviceCalendarAccess.status !== 'full_access' || !device.enabled ||
      run.generation !== device.generation || run.selectionRevision !== device.selectionRevision ||
      !device.selectedCalendarIds.includes(event.calendarId) || !run.selectedCalendarIds.includes(event.calendarId) ||
      event.generation !== device.generation) return undefined;
  const installationId = device.installationId;
  const binding = { installationId, generation: device.generation, calendarId: event.calendarId,
    nativeEventId: event.nativeEventId, occurrenceStart: event.occurrenceStart };
  const providerId = JSON.stringify([installationId, event.calendarId, event.nativeEventId, event.occurrenceStart]);
  const namespace = 'device_calendar';
  const sourceId = proactiveSourceId({ namespace, providerId });
  const observed = Date.parse(event.observedAt);
  const freshness = Number.isFinite(observed) && now - observed >= 0 && now - observed < 15 * 60_000 ? 'fresh' : 'stale';
  const available = !event.cancelled;
  const consumed = { kind: 'meeting', namespace, providerId, binding, calendarFingerprint: calendar.fingerprint,
    title: event.title, notes: event.notes, notesTruncated: event.notesTruncated, start: event.start, end: event.end,
    timeZone: event.timeZone ?? null, allDay: event.allDay, cancelled: event.cancelled };
  try {
    const candidate: ProactiveSource = {
      kind: 'meeting', sourceId, namespace, providerId, sourceVersion: 'pending', availability: available ? 'available' : 'unavailable', freshness,
      subject: event.title, startAt: event.start, deviceBinding: binding,
    };
    validateProactiveSource(candidate);
    const sourceVersion = await hashedSource(sourceId, consumed, memo, digest);
    return { ...candidate, sourceVersion };
  } catch { return undefined; }
}

async function taskSource(
  task: AppState['tasks'][number], memo: ProactiveSourceHashMemo, digest: (value: string) => Promise<string>,
): Promise<ProactiveSource | undefined> {
  if (typeof task.id !== 'string' || !task.id || task.id.length > 1024) return undefined;
  const namespace = 'local';
  const providerId = task.id;
  const sourceId = proactiveSourceId({ namespace, providerId });
  const consumed = { kind: 'task', namespace, providerId, title: task.title, status: task.status, dueAt: task.dueAt, dueAtUtcCertified: false };
  try {
    const candidate: ProactiveSource = {
      kind: 'task', sourceId, namespace, providerId, sourceVersion: 'pending', availability: 'available', freshness: 'fresh',
      title: task.title, status: task.status, ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    };
    validateProactiveSource(candidate);
    const sourceVersion = await hashedSource(sourceId, consumed, memo, digest);
    return { ...candidate, sourceVersion };
  } catch { return undefined; }
}

export interface ProactiveSourceBuildResult {
  sources: ProactiveSource[];
  omittedSourceCount: number;
}

/**
 * Projects only the exact mail rows supplied by a committed mailbox page (or a
 * later authoritative snapshot). This deliberately avoids constructing an
 * AppState or inspecting calendar, task, or device-calendar sources.
 */
export async function buildProactiveMailSources(
  accounts: readonly AppState['accounts'][number][],
  mailboxRows: readonly MailboxSnapshotMessage[],
  now: number,
  memo: ProactiveSourceHashMemo,
  digest: (value: string) => Promise<string>,
): Promise<ProactiveSource[]> {
  const accountsById = new Map<string, AppState['accounts'][number]>();
  const ambiguousAccountIds = new Set<string>();
  for (const account of accounts) {
    if (!account || typeof account.id !== 'string' || !account.id) continue;
    if (accountsById.has(account.id)) ambiguousAccountIds.add(account.id);
    else accountsById.set(account.id, account);
  }

  const orderedRows = mailboxRows
    .filter(validMailRow)
    .slice()
    .sort((a, b) => String(b.observedAt ?? '').localeCompare(String(a.observedAt ?? '')) ||
      a.accountId.localeCompare(b.accountId) || a.providerMessageId.localeCompare(b.providerMessageId));
  const sources = new Map<string, ProactiveSource>();
  for (const row of orderedRows) {
    if (ambiguousAccountIds.has(row.accountId)) continue;
    const account = accountsById.get(row.accountId);
    if (!account || account.provider === 'local' || !account.identity?.providerNamespace) continue;
    const namespace = account.identity.providerNamespace;
    const sourceId = proactiveSourceId({ namespace, accountId: account.id, providerId: row.providerMessageId });
    if (sources.has(sourceId)) continue;
    try {
      const source = await mailSource(row, account, now, memo, digest);
      if (source) {
        validateProactiveSource(source);
        sources.set(source.sourceId, source);
      }
    } catch { /* Keep malformed or unhashable rows local to their exact source. */ }
  }
  return [...sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export async function buildProactiveSources(
  state: AppState,
  previous: ProactiveCandidate[],
  now: number,
  memo: ProactiveSourceHashMemo,
  digest: (value: string) => Promise<string>,
): Promise<ProactiveSourceBuildResult> {
  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const calendars = new Map(state.calendars.map((calendar) => [calendar.id, calendar]));
  const jobs: { sourceId: string; run: () => Promise<ProactiveSource | undefined> }[] = [];
  const mailRows = state.mailbox.filter(validMailRow).sort((a, b) => String(b.observedAt ?? '').localeCompare(String(a.observedAt ?? '')) || a.providerMessageId.localeCompare(b.providerMessageId));
  for (const row of mailRows) {
    const account = accounts.get(row.accountId);
    if (!account || account.provider === 'local') continue;
    const namespace = account.identity?.providerNamespace;
    if (!namespace || typeof row.providerMessageId !== 'string' || !row.providerMessageId) continue;
    const sourceId = proactiveSourceId({ namespace, accountId: account.id, providerId: row.providerMessageId });
    jobs.push({ sourceId, run: () => mailSource(row, account, now, memo, digest) });
  }
  const eventRows = state.calendarEvents.filter(validEventRow).sort((a, b) => String(b.observedAt ?? '').localeCompare(String(a.observedAt ?? '')) || a.providerEventId.localeCompare(b.providerEventId));
  for (const event of eventRows) {
    const calendar = calendars.get(event.calendarId);
    const account = accounts.get(event.accountId);
    if (!calendar || !account || calendar.accountId !== event.accountId) continue;
    const namespace = account.identity?.providerNamespace;
    if (!namespace || typeof event.providerEventId !== 'string' || !event.providerEventId) continue;
    const providerId = JSON.stringify([calendar.providerId ?? calendar.id, event.providerEventId]);
    const sourceId = proactiveSourceId({ namespace, accountId: account.id, providerId });
    jobs.push({ sourceId, run: () => meetingSource(event, calendar, account, now, memo, digest) });
  }
  const deviceEvents = state.deviceCalendars.events
    .filter((event): event is DeviceEventSnapshot => isRecord(event) && typeof event.calendarId === 'string' && typeof event.nativeEventId === 'string')
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.calendarId.localeCompare(b.calendarId) || a.nativeEventId.localeCompare(b.nativeEventId))
    .slice(0, 500);
  for (const event of deviceEvents) {
    const providerId = JSON.stringify([state.deviceCalendars.installationId, event.calendarId, event.nativeEventId, event.occurrenceStart]);
    const sourceId = proactiveSourceId({ namespace: 'device_calendar', providerId });
    jobs.push({ sourceId, run: () => deviceMeetingSource(event, state, now, memo, digest) });
  }
  for (const task of state.tasks) {
    if (typeof task.id !== 'string' || !task.id) continue;
    const sourceId = proactiveSourceId({ namespace: 'local', providerId: task.id });
    jobs.push({ sourceId, run: () => taskSource(task, memo, digest) });
  }
  const localTaskIds = new Set(state.tasks.map((task) => proactiveSourceId({ namespace: 'local', providerId: task.id })));
  for (const prior of previous) {
    if (prior.sourceKind !== 'task' || prior.namespace !== 'local' || localTaskIds.has(prior.sourceId)) continue;
    const sourceId = proactiveSourceId({ namespace: 'local', providerId: prior.providerId });
    if (sourceId !== prior.sourceId) continue;
    jobs.push({ sourceId, run: async () => ({
        kind: 'task', sourceId, namespace: 'local', providerId: prior.providerId, sourceVersion: prior.sourceVersion,
        availability: 'unavailable', freshness: 'fresh', status: 'completed',
      }) });
  }
  const uniqueJobs = new Map<string, typeof jobs[number]>();
  for (const job of jobs.sort((a, b) => a.sourceId.localeCompare(b.sourceId))) if (!uniqueJobs.has(job.sourceId)) uniqueJobs.set(job.sourceId, job);
  const boundedJobs = [...uniqueJobs.values()].slice(0, 2000);
  const omittedSourceCount = Math.max(0, uniqueJobs.size - boundedJobs.length);
  const unique = new Map<string, ProactiveSource>();
  // Apply the bounded input cap before canonicalization/hash work. Overflow remains unknown
  // to the evaluator rather than being interpreted as deletion.
  for (const job of boundedJobs) {
    try {
      const source = await job.run();
      if (!source) continue;
      validateProactiveSource(source);
      unique.set(source.sourceId, source);
    } catch { /* One malformed or unhashable row must not poison valid local sources. */ }
  }
  return { sources: [...unique.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)), omittedSourceCount };
}

export function proactiveStableValue(value: unknown): string { return stable(value); }
