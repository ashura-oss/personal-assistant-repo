import { validateProactiveSource } from '../proactive';
import type { ProactiveSource } from '../proactive';
import type {
  LegacyReminderCancellation, ReminderIntent, ReminderPayload, ReminderRecord, ReminderState, ProactiveReminderOrigin,
} from './types';
export * from './types';

export const REMINDER_LIMITS = Object.freeze({ records: 500, intents: 1_000, scheduled: 50, titleChars: 200, titleBytes: 512,
  bodyBytes: 4 * 1024, originIdChars: 256, quoteBytes: 1_024, sourceVersionChars: 128 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ERRORS = new Set(['permission_denied', 'permission_unavailable', 'listing_failed', 'schedule_failed', 'cancel_failed', 'invalid_request', 'unverifiable', 'unavailable']);
const OBSERVED = new Set(['unconfirmed', 'pending', 'absent', 'blocked', 'unavailable', 'delivery_unknown', 'error']);
const encoder = new TextEncoder();

function fail(message: string): never { throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) fail(`${label} contains an unsupported field.`);
}
function text(value: unknown, label: string, options: { maxChars: number; maxBytes?: number; multiline?: boolean; empty?: boolean }): string {
  const { maxChars, maxBytes = maxChars, multiline = false, empty = true } = options;
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maxChars || encoder.encode(value).length > maxBytes ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) fail(`${label} is invalid.`);
  return value;
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID.`);
  return value.toLowerCase();
}
function boundedId(value: unknown, label: string): string {
  return text(value, label, { maxChars: REMINDER_LIMITS.originIdChars, maxBytes: REMINDER_LIMITS.originIdChars, empty: false });
}
function positiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} is invalid.`);
  return value as number;
}
function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) fail(`${label} must be a canonical whole-second UTC date.`);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) fail(`${label} must be a valid canonical UTC date.`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be a canonical ISO date.`);
  return value;
}
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 128) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}
function zone(value: unknown): string {
  if (!isValidTimeZone(value)) fail('Reminder display time zone must be a valid IANA time zone.');
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}
function optionalTimestamp(value: unknown, label: string): string | undefined { return value === undefined ? undefined : timestamp(value, label); }

export function validateReminderPayload(value: unknown): ReminderPayload {
  const row = object(value, 'Reminder payload');
  keys(row, ['title', 'body', 'dueAt', 'displayTimeZone', 'privacyMode'], 'Reminder payload');
  if (row.privacyMode !== 'private' && row.privacyMode !== 'full') fail('Reminder privacy mode is invalid.');
  return {
    title: text(row.title, 'Reminder title', { maxChars: REMINDER_LIMITS.titleChars, maxBytes: REMINDER_LIMITS.titleBytes, empty: false }),
    body: text(row.body, 'Reminder body', { maxChars: REMINDER_LIMITS.bodyBytes, maxBytes: REMINDER_LIMITS.bodyBytes, multiline: true }),
    dueAt: canonicalDate(row.dueAt, 'Reminder due time'),
    displayTimeZone: zone(row.displayTimeZone),
    privacyMode: row.privacyMode,
  };
}

function validateProactiveOrigin(value: Record<string, unknown>): ProactiveReminderOrigin {
  keys(value, ['kind', 'candidate', 'rule', 'source', 'binding', 'capturedAt', 'expiresAt'], 'Proactive reminder origin');
  const source = object(value.source, 'Proactive source');
  const sourceKeys = source.kind === 'mail'
    ? ['kind', 'sourceId', 'namespace', 'accountId', 'providerId', 'sourceVersion', 'availability', 'freshness', 'senderEmail', 'isRead', 'subject', 'snippet', 'receivedAt', 'receivedAtUtcCertified']
    : source.kind === 'meeting'
      ? ['kind', 'sourceId', 'namespace', 'accountId', 'providerId', 'sourceVersion', 'availability', 'freshness', 'subject', 'startAt', 'startAtUtcCertified']
      : ['kind', 'sourceId', 'namespace', 'accountId', 'providerId', 'sourceVersion', 'availability', 'freshness', 'title', 'status', 'dueAt', 'dueAtUtcCertified'];
  keys(source, sourceKeys, 'Proactive source');
  const validatedSource = source as unknown as ProactiveSource;
  try { validateProactiveSource(validatedSource); } catch { fail('Proactive source snapshot is invalid.'); }

  const candidate = object(value.candidate, 'Proactive candidate');
  keys(candidate, ['id', 'suppressionKey', 'ruleId', 'ruleRevision', 'sourceId', 'sourceVersion', 'sourceKind', 'namespace', 'accountId', 'providerId', 'eligibleAt', 'reasonCode', 'quote', 'quoteField'], 'Proactive candidate');
  const allowedQuotes = source.kind === 'mail' ? ['senderEmail', 'subject', 'snippet'] : source.kind === 'meeting' ? ['subject', 'startAt'] : ['dueAt', 'title'];
  if (typeof candidate.quoteField !== 'string' || !allowedQuotes.includes(candidate.quoteField)) fail('Proactive candidate quote field is invalid.');
  if ((candidate.reasonCode === 'keyword' && (source.kind !== 'mail' || !['subject', 'snippet'].includes(candidate.quoteField))) ||
      (candidate.reasonCode === 'unread_sender' && (source.kind !== 'mail' || candidate.quoteField !== 'senderEmail')) ||
      (candidate.reasonCode === 'meeting_soon' && (source.kind !== 'meeting' || !['subject', 'startAt'].includes(candidate.quoteField))) ||
      (candidate.reasonCode === 'task_due' && (source.kind !== 'task' || !['title', 'dueAt'].includes(candidate.quoteField)))) fail('Proactive candidate quote field does not match its reason.');
  const candidateQuote = text(candidate.quote, 'Proactive candidate quote', { maxChars: REMINDER_LIMITS.quoteBytes, maxBytes: REMINDER_LIMITS.quoteBytes, empty: false });
  if (candidate.sourceId !== source.sourceId || candidate.sourceVersion !== source.sourceVersion || candidate.sourceKind !== source.kind ||
      candidate.namespace !== source.namespace || candidate.accountId !== source.accountId || candidate.providerId !== source.providerId ||
      (candidate.reasonCode === 'keyword'
        ? typeof source[candidate.quoteField] !== 'string' || !(source[candidate.quoteField] as string).includes(candidateQuote)
        : candidateQuote !== source[candidate.quoteField])) fail('Proactive candidate does not match its frozen source snapshot.');
  const candidateRuleId = text(candidate.ruleId, 'Candidate rule ID', { maxChars: 160, maxBytes: 160, empty: false });
  const candidateRuleRevision = positiveInt(candidate.ruleRevision, 'Candidate rule revision');
  if (candidate.id !== JSON.stringify([candidateRuleId, candidateRuleRevision, candidate.sourceId, candidate.sourceVersion]) ||
      candidate.suppressionKey !== JSON.stringify([candidateRuleId, candidate.sourceId])) fail('Proactive candidate identity is invalid.');
  if (!['unread_sender', 'keyword', 'meeting_soon', 'task_due'].includes(String(candidate.reasonCode)) ||
      (source.kind === 'mail' && !['unread_sender', 'keyword'].includes(String(candidate.reasonCode))) ||
      (source.kind === 'meeting' && candidate.reasonCode !== 'meeting_soon') ||
      (source.kind === 'task' && candidate.reasonCode !== 'task_due')) fail('Proactive candidate reason does not match its source.');
  timestamp(candidate.eligibleAt, 'Candidate eligibility time');

  const rule = object(value.rule, 'Proactive rule snapshot');
  keys(rule, ['id', 'revision', 'version', 'name'], 'Proactive rule snapshot');
  const ruleId = text(rule.id, 'Proactive rule ID', { maxChars: 160, maxBytes: 160, empty: false });
  const ruleRevision = positiveInt(rule.revision, 'Proactive rule revision');
  const ruleVersion = positiveInt(rule.version, 'Proactive rule version');
  const ruleName = text(rule.name, 'Proactive rule name', { maxChars: 80, maxBytes: 320, empty: false });
  if (ruleVersion < ruleRevision || ruleId !== candidateRuleId || ruleRevision !== candidateRuleRevision) fail('Proactive candidate does not match its saved rule snapshot.');

  const local = validatedSource.namespace.toLowerCase() === 'local';
  let binding: ProactiveReminderOrigin['binding'];
  if (local) {
    if (value.binding !== undefined) fail('Local proactive reminders cannot contain an account binding.');
  } else {
    const raw = object(value.binding, 'Proactive account binding');
    keys(raw, ['accountId', 'namespace', 'identityKey', 'connectionGeneration'], 'Proactive account binding');
    binding = {
      accountId: boundedId(raw.accountId, 'Proactive binding account ID'),
      namespace: text(raw.namespace, 'Proactive binding namespace', { maxChars: 128, maxBytes: 128, empty: false }),
      identityKey: text(raw.identityKey, 'Proactive binding identity key', { maxChars: 512, maxBytes: 512, empty: false }),
      connectionGeneration: positiveInt(raw.connectionGeneration, 'Proactive binding generation'),
    };
    if (binding.accountId !== validatedSource.accountId || binding.namespace !== validatedSource.namespace) fail('Proactive binding does not match the frozen source identity.');
  }
  const capturedAt = timestamp(value.capturedAt, 'Proactive capture time');
  const expiresAt = timestamp(value.expiresAt, 'Proactive expiry time');
  if (Date.parse(expiresAt) <= Date.parse(capturedAt)) fail('Proactive source expiry must follow its capture time.');
  return { kind: 'proactive', candidate: candidate as unknown as ProactiveReminderOrigin['candidate'],
    rule: { id: ruleId, revision: ruleRevision, version: ruleVersion, name: ruleName }, source: source as unknown as ProactiveReminderOrigin['source'],
    ...(binding ? { binding } : {}), capturedAt, expiresAt };
}

function validateOrigin(value: unknown): ReminderRecord['origin'] {
  const row = object(value, 'Reminder origin');
  if (row.kind === 'manual') { keys(row, ['kind'], 'Manual reminder origin'); return { kind: 'manual' }; }
  if (row.kind === 'note') {
    keys(row, ['kind', 'noteId', 'proposalId', 'proposalRevision', 'sourceRevision', 'sourceVersion', 'quote'], 'Note reminder origin');
    const sourceRevision = positiveInt(row.sourceRevision, 'Note source revision');
    const sourceVersion = text(row.sourceVersion, 'Note source version', { maxChars: REMINDER_LIMITS.sourceVersionChars, maxBytes: REMINDER_LIMITS.sourceVersionChars, empty: false });
    if (!new RegExp(`^${sourceRevision}:[a-f0-9]{64}$`).test(sourceVersion)) fail('Note source version does not match its revision.');
    return { kind: 'note', noteId: boundedId(row.noteId, 'Note ID'), proposalId: boundedId(row.proposalId, 'Proposal ID'),
      proposalRevision: positiveInt(row.proposalRevision, 'Proposal revision'), sourceRevision, sourceVersion,
      quote: text(row.quote, 'Note evidence quote', { maxChars: REMINDER_LIMITS.quoteBytes, maxBytes: REMINDER_LIMITS.quoteBytes, multiline: true }) };
  }
  if (row.kind === 'proactive') return validateProactiveOrigin(row);
  return fail('Reminder origin kind is invalid.');
}

export function validateReminderRecord(value: unknown): ReminderRecord {
  const row = object(value, 'Reminder record');
  keys(row, ['id', 'revision', 'title', 'body', 'dueAt', 'displayTimeZone', 'privacyMode', 'origin', 'status', 'createdAt', 'updatedAt', 'firstSavedAt', 'approvedRevision', 'approvedPayloadDigest', 'currentIntentId'], 'Reminder record');
  if (!['draft', 'approved', 'saved', 'cancelled', 'completed'].includes(String(row.status))) fail('Reminder status is invalid.');
  const revision = positiveInt(row.revision, 'Reminder revision');
  const approvedRevision = row.approvedRevision === undefined ? undefined : positiveInt(row.approvedRevision, 'Approved reminder revision');
  const approvedPayloadDigest = row.approvedPayloadDigest === undefined ? undefined : digest(row.approvedPayloadDigest, 'Approved reminder payload digest');
  const currentIntentId = row.currentIntentId === undefined ? undefined : id(row.currentIntentId, 'Current reminder intent ID');
  if (row.status === 'draft' && (approvedRevision !== undefined || approvedPayloadDigest !== undefined || currentIntentId !== undefined)) fail('Draft reminders cannot carry approval or scheduling metadata.');
  if (row.status === 'approved' && (approvedRevision !== revision || !approvedPayloadDigest || currentIntentId !== undefined)) fail('Approved reminder metadata is inconsistent.');
  if (row.status === 'saved' && (approvedRevision !== revision || !approvedPayloadDigest || !currentIntentId)) fail('Saved reminder metadata is incomplete.');
  if ((row.status === 'cancelled' || row.status === 'completed') && ((approvedRevision === undefined) !== (approvedPayloadDigest === undefined))) fail('Reminder approval metadata is incomplete.');
  const payload = validateReminderPayload({ title: row.title, body: row.body, dueAt: row.dueAt, displayTimeZone: row.displayTimeZone, privacyMode: row.privacyMode });
  return { ...payload, id: id(row.id, 'Reminder ID'), revision, origin: validateOrigin(row.origin), status: row.status as ReminderRecord['status'],
    createdAt: timestamp(row.createdAt, 'Reminder creation time'), updatedAt: timestamp(row.updatedAt, 'Reminder update time'),
    ...(row.firstSavedAt !== undefined ? { firstSavedAt: timestamp(row.firstSavedAt, 'First saved time') } : {}),
    ...(approvedRevision !== undefined ? { approvedRevision } : {}), ...(approvedPayloadDigest ? { approvedPayloadDigest } : {}), ...(currentIntentId ? { currentIntentId } : {}) };
}

export function reminderNotificationIdentifier(installationId: string, reminderId: string, epoch: number): string {
  return `still-reminder:${id(installationId, 'Installation ID')}:${id(reminderId, 'Reminder ID')}:${positiveInt(epoch, 'Reminder intent epoch')}`;
}

export function validateReminderIntent(value: unknown, installationId?: string): ReminderIntent {
  const row = object(value, 'Reminder intent');
  keys(row, ['id', 'reminderId', 'reminderRevision', 'epoch', 'identifier', 'payloadDigest', 'payload', 'desired', 'observed', 'createdAt', 'updatedAt', 'attemptedAt', 'observedAt', 'errorCode'], 'Reminder intent');
  const intentId = id(row.id, 'Reminder intent ID');
  const reminderId = id(row.reminderId, 'Reminder ID');
  const epoch = positiveInt(row.epoch, 'Reminder intent epoch');
  const expectedIdentifier = installationId ? reminderNotificationIdentifier(installationId, reminderId, epoch) : undefined;
  if (typeof row.identifier !== 'string' || (expectedIdentifier && row.identifier !== expectedIdentifier)) fail('Reminder notification identifier is invalid.');
  if (row.desired !== 'scheduled' && row.desired !== 'cancelled') fail('Reminder intent desired state is invalid.');
  if (!OBSERVED.has(String(row.observed))) fail('Reminder intent observation is invalid.');
  const errorCode = row.errorCode === undefined ? undefined : String(row.errorCode);
  if (errorCode !== undefined && !ERRORS.has(errorCode)) fail('Reminder intent error code is invalid.');
  const observedAt = optionalTimestamp(row.observedAt, 'Reminder intent observation time');
  const scrubbedCancellation = row.desired === 'cancelled' && row.observed === 'absent' && observedAt !== undefined && row.payload === undefined;
  const payload = row.payload === undefined ? undefined : validateReminderPayload(row.payload);
  if (!payload && !scrubbedCancellation) fail('Reminder intent payload may be omitted only after an observed cancellation.');
  return { id: intentId, reminderId, reminderRevision: positiveInt(row.reminderRevision, 'Reminder intent revision'), epoch,
    identifier: expectedIdentifier ?? row.identifier as string, payloadDigest: digest(row.payloadDigest, 'Reminder payload digest'), ...(payload ? { payload } : {}),
    desired: row.desired, observed: row.observed as ReminderIntent['observed'], createdAt: timestamp(row.createdAt, 'Reminder intent creation time'),
    updatedAt: timestamp(row.updatedAt, 'Reminder intent update time'), ...(optionalTimestamp(row.attemptedAt, 'Reminder intent attempt time') ? { attemptedAt: row.attemptedAt as string } : {}),
    ...(observedAt ? { observedAt } : {}), ...(errorCode ? { errorCode: errorCode as ReminderIntent['errorCode'] } : {}) };
}

export function legacyReminderIdentifier(proposalId: string, proposalRevision: number): string {
  return `reminder-${boundedId(proposalId, 'Legacy proposal ID')}-${positiveInt(proposalRevision, 'Legacy proposal revision')}`;
}

export function validateLegacyReminderCancellation(value: unknown): LegacyReminderCancellation {
  const row = object(value, 'Legacy reminder cancellation');
  keys(row, ['id', 'proposalId', 'proposalRevision', 'identifier', 'requestedAt', 'observed', 'attemptedAt', 'observedAt', 'errorCode'], 'Legacy reminder cancellation');
  const proposalId = boundedId(row.proposalId, 'Legacy proposal ID');
  const proposalRevision = positiveInt(row.proposalRevision, 'Legacy proposal revision');
  if (row.identifier !== legacyReminderIdentifier(proposalId, proposalRevision)) fail('Legacy reminder identifier does not match its proposal.');
  if (!['unconfirmed', 'absent', 'error'].includes(String(row.observed))) fail('Legacy reminder cancellation observation is invalid.');
  const errorCode = row.errorCode === undefined ? undefined : String(row.errorCode);
  if (errorCode !== undefined && !['listing_failed', 'cancel_failed', 'unverifiable'].includes(errorCode)) fail('Legacy reminder cancellation error code is invalid.');
  return { id: id(row.id, 'Legacy reminder cancellation ID'), proposalId, proposalRevision, identifier: row.identifier, requestedAt: timestamp(row.requestedAt, 'Legacy cancellation request time'),
    observed: row.observed as LegacyReminderCancellation['observed'],
    ...(optionalTimestamp(row.attemptedAt, 'Legacy cancellation attempt time') ? { attemptedAt: row.attemptedAt as string } : {}),
    ...(optionalTimestamp(row.observedAt, 'Legacy cancellation observation time') ? { observedAt: row.observedAt as string } : {}),
    ...(errorCode ? { errorCode: errorCode as LegacyReminderCancellation['errorCode'] } : {}) };
}

export function emptyReminderState(installationId: string): ReminderState {
  return { schemaVersion: 1, installationId: id(installationId, 'Installation ID'), records: [], intents: [], legacyCancellations: [] };
}

export function validateReminderState(value: unknown): ReminderState {
  const row = object(value, 'Reminder state');
  keys(row, ['schemaVersion', 'installationId', 'records', 'intents', 'legacyCancellations'], 'Reminder state');
  if (row.schemaVersion !== 1) fail('Reminder schema version is not supported.');
  const installationId = id(row.installationId, 'Installation ID');
  if (!Array.isArray(row.records) || row.records.length > REMINDER_LIMITS.records) fail('Reminder records exceed the allowed item count.');
  if (!Array.isArray(row.intents) || row.intents.length > REMINDER_LIMITS.intents) fail('Reminder intents exceed the allowed item count.');
  const rawLegacy = row.legacyCancellations === undefined ? [] : row.legacyCancellations;
  if (!Array.isArray(rawLegacy) || rawLegacy.length > REMINDER_LIMITS.intents || row.intents.length + rawLegacy.length > REMINDER_LIMITS.intents) fail('Reminder intent history exceeds the allowed item count.');
  const records = row.records.map(validateReminderRecord);
  const intents = row.intents.map((item) => validateReminderIntent(item, installationId));
  const legacyCancellations = rawLegacy.map(validateLegacyReminderCancellation);
  const recordIds = new Set<string>();
  for (const record of records) { if (recordIds.has(record.id)) fail('Reminder records contain duplicate IDs.'); recordIds.add(record.id); }
  const intentIds = new Set<string>(), identifiers = new Set<string>(), epochs = new Set<string>();
  let scheduled = 0;
  for (const intent of intents) {
    if (intentIds.has(intent.id) || identifiers.has(intent.identifier)) fail('Reminder intents contain duplicate IDs or identifiers.');
    const epochKey = `${intent.reminderId}:${intent.epoch}`;
    if (epochs.has(epochKey)) fail('Reminder intent epochs must be unique per reminder.');
    intentIds.add(intent.id); identifiers.add(intent.identifier); epochs.add(epochKey);
    if (intent.desired === 'scheduled') scheduled += 1;
    const owner = records.find((record) => record.id === intent.reminderId);
    if (!owner) { if (intent.desired === 'scheduled') fail('Scheduled reminder intents must have an owner record.'); continue; }
    if (intent.reminderRevision > owner.revision) fail('Reminder intent revision is newer than its owner.');
    if (owner.currentIntentId === intent.id && intent.reminderRevision !== owner.revision) fail('Current reminder intent revision does not match its owner.');
    if (intent.desired === 'scheduled' && (owner.status !== 'saved' || owner.currentIntentId !== intent.id || intent.reminderRevision !== owner.revision ||
        !intent.payload || reminderPayloadForDigest(intent.payload) !== reminderPayloadForDigest({ title: owner.title, body: owner.body, dueAt: owner.dueAt, displayTimeZone: owner.displayTimeZone, privacyMode: owner.privacyMode }))) fail('Scheduled reminder intent must match its saved owner record.');
  }
  if (scheduled > REMINDER_LIMITS.scheduled) fail('Scheduled reminders exceed the allowed item count.');
  for (const record of records) {
    const current = record.currentIntentId ? intents.find((intent) => intent.id === record.currentIntentId) : undefined;
    if (record.currentIntentId && (!current || current.reminderId !== record.id)) fail('Reminder current intent does not belong to its record.');
    if (record.status === 'saved' && (!record.firstSavedAt || current?.desired !== 'scheduled')) fail('Saved reminders require a first-save time and scheduled current intent.');
    if (record.status === 'cancelled' && current && current.desired !== 'cancelled') fail('Cancelled reminders require a cancellation intent.');
    if (record.status === 'completed' && current?.desired === 'scheduled') fail('Completed reminders cannot retain a scheduled current intent.');
  }
  const legacyIds = new Set<string>(), legacyIdentifiers = new Set<string>();
  for (const item of legacyCancellations) {
    if (legacyIds.has(item.id) || legacyIdentifiers.has(item.identifier)) fail('Legacy reminder cancellations contain duplicate IDs.');
    legacyIds.add(item.id); legacyIdentifiers.add(item.identifier);
  }
  return { schemaVersion: 1, installationId, records, intents, legacyCancellations };
}

/** Canonical frozen payload bytes; observation and source-fetch metadata are intentionally absent. */
export function reminderPayloadForDigest(payload: ReminderPayload): string {
  const value = validateReminderPayload(payload);
  return JSON.stringify({ title: value.title, body: value.body, dueAt: value.dueAt, displayTimeZone: value.displayTimeZone, privacyMode: value.privacyMode });
}

export interface NotificationContentProjection {
  title: string;
  body: string;
  data: { schemaVersion: 1; installationId: string; reminderId: string; epoch: number; payloadDigest: string };
  sound: false;
  badge: undefined;
  subtitle: undefined;
  attachments: [];
}

export function notificationContentForIntent(intent: ReminderIntent, installationId: string): NotificationContentProjection {
  const valid = validateReminderIntent(intent, installationId);
  if (valid.desired !== 'scheduled' || !valid.payload) fail('Only scheduled reminders with a payload have notification content.');
  return {
    title: valid.payload.privacyMode === 'private' ? 'Still reminder' : valid.payload.title,
    body: valid.payload.privacyMode === 'private' ? 'Open Still to view' : valid.payload.body,
    data: { schemaVersion: 1, installationId: id(installationId, 'Installation ID'), reminderId: valid.reminderId, epoch: valid.epoch, payloadDigest: valid.payloadDigest },
    sound: false, badge: undefined, subtitle: undefined, attachments: [],
  };
}
