import { describe, expect, it } from 'vitest';
import { evaluateProactive, proactiveSourceId, type ProactiveCandidate, type ProactiveSource } from '../src/proactive';
import {
  emptyReminderState, notificationContentForIntent, reminderNotificationIdentifier, reminderPayloadForDigest,
  validateReminderState, type ReminderIntent, type ReminderPayload, type ReminderRecord,
} from '../src/reminders';
import { resolveReminderLocalDateTime } from '../src/reminders/time';

const installationId = '11111111-1111-4111-8111-111111111111';
const reminderId = '22222222-2222-4222-8222-222222222222';
const intentId = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-10-12T10:00:00.000Z';
const payload: ReminderPayload = { title: 'Review the launch plan', body: 'Check the release notes.', dueAt: '2026-10-15T09:30:00.000Z', displayTimeZone: 'Asia/Singapore', privacyMode: 'full' };

function record(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return { ...payload, id: reminderId, revision: 1, origin: { kind: 'manual' }, status: 'draft', createdAt: stamp, updatedAt: stamp, ...overrides };
}
function intent(overrides: Partial<ReminderIntent> = {}): ReminderIntent {
  return { id: intentId, reminderId, reminderRevision: 1, epoch: 1, identifier: reminderNotificationIdentifier(installationId, reminderId, 1),
    payloadDigest: 'a'.repeat(64), payload, desired: 'scheduled', observed: 'unconfirmed', createdAt: stamp, updatedAt: stamp, ...overrides };
}

describe('reminder ledger validation and projections', () => {
  it('creates an empty versioned ledger and rejects malformed or forged opaque ownership', () => {
    expect(emptyReminderState(installationId)).toEqual({ schemaVersion: 1, installationId, records: [], intents: [], legacyCancellations: [] });
    const validRecord = record();
    const validIntent = intent();
    const scheduled = { ...validRecord, status: 'saved' as const, firstSavedAt: stamp, approvedRevision: 1, approvedPayloadDigest: 'b'.repeat(64), currentIntentId: intentId };
    expect(validateReminderState({ schemaVersion: 1, installationId, records: [scheduled], intents: [validIntent] }).records).toHaveLength(1);

    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [validRecord], intents: [], arbitrary: 'foreign state' })).toThrow(/unsupported field/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [], intents: [intent({ identifier: 'still-reminder:somebody-elses-id' })] })).toThrow(/identifier/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [], intents: [validIntent] })).toThrow(/owner record/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ title: 'Bad\u0000title' })], intents: [] })).toThrow(/invalid/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ dueAt: '2026-10-15T09:30:00Z' })], intents: [] })).toThrow(/whole-second UTC/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ displayTimeZone: 'Mars/Olympus' })], intents: [] })).toThrow(/IANA/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ body: 'x'.repeat(4 * 1024 + 1) })], intents: [] })).toThrow(/invalid/i);
  });

  it('accepts a canonical first-save timestamp on later user-owned revisions and rejects malformed timestamps', () => {
    const savedHistory = record({ revision: 2, firstSavedAt: stamp });
    expect(validateReminderState({ schemaVersion: 1, installationId, records: [savedHistory], intents: [] }).records[0]?.firstSavedAt).toBe(stamp);
    expect(() => validateReminderState({ schemaVersion: 1, installationId,
      records: [record({ firstSavedAt: '2026-10-12T10:00:00Z' })], intents: [] })).toThrow(/first saved time/i);
  });

  it('keeps cancellation tombstones valid after their reminder record is deleted and enforces the scheduled cap', () => {
    const tombstone = intent({ desired: 'cancelled', observed: 'absent' });
    expect(validateReminderState({ schemaVersion: 1, installationId, records: [], intents: [tombstone] }).intents[0]?.desired).toBe('cancelled');
    const scheduled = Array.from({ length: 51 }, (_, index) => intent({
      id: `${(index + 4).toString(16).padStart(8, '0')}-3333-4333-8333-333333333333`, reminderId: `${(index + 20).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`,
      epoch: 1, identifier: reminderNotificationIdentifier(installationId, `${(index + 20).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`, 1),
    }));
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [], intents: scheduled })).toThrow(/owner record/i);
    const withOwners = scheduled.map((item) => record({ id: item.reminderId, status: 'saved', firstSavedAt: stamp, approvedRevision: 1, approvedPayloadDigest: 'b'.repeat(64), currentIntentId: item.id }));
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: withOwners, intents: scheduled })).toThrow(/scheduled reminders exceed/i);
  });

  it('redacts only payloads from confirmed absent cancellation intents without changing their identity', () => {
    const redacted = intent({ desired: 'cancelled', observed: 'absent', observedAt: stamp, payload: undefined });
    const validated = validateReminderState({ schemaVersion: 1, installationId, records: [], intents: [redacted] }).intents[0]!;
    expect(validated).toMatchObject({ id: intentId, identifier: redacted.identifier, payloadDigest: redacted.payloadDigest, desired: 'cancelled', observed: 'absent' });
    expect(validated).not.toHaveProperty('payload');
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [], intents: [intent({ desired: 'cancelled', observed: 'absent', payload: undefined })] })).toThrow(/only after an observed cancellation/i);
    expect(() => notificationContentForIntent(validated, installationId)).toThrow(/only scheduled reminders/i);
  });

  it('validates and freezes proactive evidence against its captured source and rule', () => {
    const source: ProactiveSource = { kind: 'task', sourceId: proactiveSourceId({ namespace: 'local', providerId: 'task-7' }), namespace: 'local', providerId: 'task-7',
      sourceVersion: `1:${'c'.repeat(64)}`, availability: 'available', freshness: 'fresh', title: 'Send the proposal', status: 'open', dueAt: stamp, dueAtUtcCertified: true };
    const rule = { id: 'rule-local-1', revision: 2, version: 3, name: 'Local task reminder' };
    const candidate: ProactiveCandidate = { id: JSON.stringify([rule.id, rule.revision, source.sourceId, source.sourceVersion]), suppressionKey: JSON.stringify([rule.id, source.sourceId]),
      ruleId: rule.id, ruleRevision: rule.revision, sourceId: source.sourceId, sourceVersion: source.sourceVersion, sourceKind: source.kind,
      namespace: source.namespace, providerId: source.providerId, eligibleAt: stamp, reasonCode: 'task_due', quote: source.dueAt!, quoteField: 'dueAt' };
    const proactive = record({ origin: { kind: 'proactive', candidate, rule, source, capturedAt: stamp, expiresAt: '2026-10-12T10:05:00.000Z' } });
    expect(validateReminderState({ schemaVersion: 1, installationId, records: [proactive], intents: [] }).records[0]?.origin.kind).toBe('proactive');
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ origin: { kind: 'proactive', candidate: { ...candidate, quote: 'forged' }, rule, source, capturedAt: stamp, expiresAt: '2026-10-12T10:05:00.000Z' } })], intents: [] })).toThrow(/frozen source/i);
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ origin: { kind: 'proactive', candidate, rule, source, capturedAt: stamp, expiresAt: '2026-10-12T10:05:00.000Z', binding: { accountId: 'account-1', namespace: 'google', identityKey: 'google:user', connectionGeneration: 1 } } })], intents: [] })).toThrow(/local proactive/i);
  });

  it('accepts evaluator-produced Unicode keyword excerpts from a bound mail source but rejects forged excerpts', () => {
    const base = { namespace: 'google', accountId: 'account-1', providerId: 'message-42' };
    const source: ProactiveSource = { kind: 'mail', ...base, sourceId: proactiveSourceId(base), sourceVersion: 'mail-v1', availability: 'available', freshness: 'fresh',
      subject: 'Quarterly REVIEW with Zoë', senderEmail: 'zoe@example.test', isRead: false, receivedAt: '2026-10-12T09:59:00Z' };
    const rule = { id: 'keyword-rule', revision: 1, enabled: true, accountIds: ['account-1'], trigger: { type: 'keyword' as const, keywords: ['zoë'] } };
    const evaluated = evaluateProactive({ nowUtc: stamp, timeZone: 'UTC', rules: [rule], sources: [source] }).activeCandidates[0]!;
    expect(evaluated).toMatchObject({ reasonCode: 'keyword', quote: 'Zoë', quoteField: 'subject' });
    const origin = { kind: 'proactive' as const, candidate: evaluated, rule: { id: rule.id, revision: rule.revision, version: 1, name: 'Keyword rule' }, source,
      binding: { accountId: 'account-1', namespace: 'google', identityKey: 'google:user', connectionGeneration: 1 },
      capturedAt: stamp, expiresAt: '2026-10-12T10:05:00.000Z' };
    expect(validateReminderState({ schemaVersion: 1, installationId, records: [record({ origin })], intents: [] }).records[0]?.origin.kind).toBe('proactive');
    expect(() => validateReminderState({ schemaVersion: 1, installationId, records: [record({ origin: { ...origin, candidate: { ...evaluated, quote: 'forged' } } })], intents: [] })).toThrow(/frozen source/i);
  });

  it('uses privacy-specific native text and canonical frozen payload bytes', () => {
    const privateIntent = intent({ payload: { ...payload, privacyMode: 'private' } });
    const privateContent = notificationContentForIntent(privateIntent, installationId);
    expect(privateContent).toMatchObject({ title: 'Still reminder', body: 'Open Still to view', sound: false, data: { schemaVersion: 1, installationId, reminderId, epoch: 1, payloadDigest: 'a'.repeat(64) } });
    expect(JSON.stringify(privateContent)).not.toContain(payload.title);
    const fullContent = notificationContentForIntent(intent(), installationId);
    expect(fullContent).toMatchObject({ title: payload.title, body: payload.body, sound: false });
    expect(reminderPayloadForDigest(payload)).toBe(reminderPayloadForDigest({ ...payload }));
    expect(reminderPayloadForDigest(payload)).not.toBe(reminderPayloadForDigest({ ...payload, displayTimeZone: 'UTC' }));
  });
});

describe('wall clock reminder time resolution', () => {
  it('returns no instant for DST gaps, two sorted instants for folds, and one instant in quarter-hour zones', () => {
    expect(resolveReminderLocalDateTime('2025-03-09T02:30', 'America/New_York')).toEqual([]);
    const fold = resolveReminderLocalDateTime('2025-11-02T01:30', 'America/New_York');
    expect(fold).toHaveLength(2);
    expect(fold).toEqual([...fold].sort());
    expect(Date.parse(fold[1]!) - Date.parse(fold[0]!)).toBe(60 * 60_000);
    expect(resolveReminderLocalDateTime('2025-01-15T09:00', 'Asia/Kathmandu')).toEqual(['2025-01-15T03:15:00.000Z']);
  });

  it('rejects invalid local dates, unsupported formats, and invalid time zones with no guessed instant', () => {
    expect(resolveReminderLocalDateTime('2025-02-29T09:00', 'UTC')).toEqual([]);
    expect(resolveReminderLocalDateTime('2025-10-12T9:00', 'UTC')).toEqual([]);
    expect(resolveReminderLocalDateTime('2025-10-12T09:00', 'Invalid/Zone')).toEqual([]);
  });
});
