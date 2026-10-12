import { describe, expect, it } from 'vitest';
import { computeProactiveNextCheckAt, evaluateProactive, proactiveSourceId, type ProactiveRule, type ProactiveSource } from '../src/proactive';

const rule = (trigger: ProactiveRule['trigger'], overrides: Partial<ProactiveRule> = {}): ProactiveRule => ({
  id: 'rule-1', revision: 1, enabled: true, accountIds: ['account-1'], trigger, ...overrides,
});
const meeting = (startAt: string, overrides: Partial<Extract<ProactiveSource, { kind: 'meeting' }>> = {}): ProactiveSource => {
  const base = { namespace: 'microsoft', accountId: 'account-1', providerId: 'event-1' };
  return { kind: 'meeting', ...base, sourceId: proactiveSourceId(base), sourceVersion: 'event-v1', availability: 'available', freshness: 'fresh', startAt, ...overrides };
};

describe('proactive next-check boundaries', () => {
  it('chooses the earliest future threshold, freshness expiry, or live snooze', () => {
    const nowUtc = '2026-01-01T00:00:00.000Z';
    const result = computeProactiveNextCheckAt({
      nowUtc, timeZone: 'UTC', rules: [rule({ type: 'meeting_soon', minutes: 5 })],
      sources: [meeting('2026-01-01T00:10:00Z')], freshnessExpiresAt: ['2026-01-01T00:02:00Z'],
      snoozes: [{ suppressionKey: 'rule/source', until: '2026-01-01T00:03:00Z' }],
    });
    expect(result).toBe('2026-01-01T00:02:00.000Z');
    expect(computeProactiveNextCheckAt({ nowUtc, timeZone: 'UTC', rules: [], sources: [],
      snoozes: [{ suppressionKey: 'fractional', until: '2026-01-01T00:03:00.1234567Z' }] })).toBe('2026-01-01T00:03:00.123Z');
  });

  it('schedules meeting eligibility and expiry boundaries but ignores already-past thresholds', () => {
    const nowUtc = '2026-01-01T00:00:00.000Z';
    expect(computeProactiveNextCheckAt({ nowUtc, timeZone: 'UTC', rules: [rule({ type: 'meeting_soon', minutes: 10 })], sources: [meeting('2026-01-01T00:08:00Z')] }))
      .toBe('2026-01-01T00:08:00.000Z');
    expect(computeProactiveNextCheckAt({ nowUtc, timeZone: 'UTC', rules: [rule({ type: 'task_due', minutes: 10 })], sources: [] })).toBeNull();
    const base = { namespace: 'local', providerId: 'task-1' };
    const task: ProactiveSource = { kind: 'task', ...base, sourceId: proactiveSourceId(base), sourceVersion: 'task-v1', availability: 'available', freshness: 'fresh', status: 'open', dueAt: '2026-01-01T00:20:00Z' };
    const taskRule = rule({ type: 'task_due', minutes: 5 }, { accountIds: [] });
    expect(computeProactiveNextCheckAt({ nowUtc, timeZone: 'UTC', rules: [taskRule], sources: [task] })).toBe('2026-01-01T00:15:00.000Z');
    expect(computeProactiveNextCheckAt({ nowUtc, timeZone: 'UTC', rules: [taskRule], sources: [{ ...task, status: 'completed' }] })).toBeNull();
  });

  it('detects spring-forward skipped quiet starts and fall-back repeated-hour state changes', () => {
    const spring = computeProactiveNextCheckAt({ nowUtc: '2026-03-08T06:59:00.000Z', timeZone: 'America/New_York',
      rules: [rule({ type: 'keyword', keywords: ['review'] }, { quietHours: { start: '02:30', end: '03:30' } })], sources: [] });
    expect(spring).toBe('2026-03-08T07:00:00.000Z');
    const fall = computeProactiveNextCheckAt({ nowUtc: '2026-11-01T05:59:00.000Z', timeZone: 'America/New_York',
      rules: [rule({ type: 'keyword', keywords: ['review'] }, { quietHours: { start: '01:00', end: '01:30' } })], sources: [] });
    expect(fall).toBe('2026-11-01T06:00:00.000Z');
  });

  it('handles certified Graph UTC timestamps with seven fractional digits and preserves uncertainty without certification', () => {
    const base = meeting('2026-01-01T00:10:00.0000000', { startAtUtcCertified: true });
    const r = rule({ type: 'meeting_soon', minutes: 10 });
    const known = evaluateProactive({ nowUtc: '2026-01-01T00:00:00.000Z', timeZone: 'UTC', rules: [r], sources: [base] });
    expect(known.activeCandidates).toHaveLength(1);
    const unverified = { ...base, startAtUtcCertified: undefined };
    const uncertain = evaluateProactive({ nowUtc: '2026-01-01T00:00:00.000Z', timeZone: 'UTC', rules: [r], sources: [unverified], previousCandidates: known.activeCandidates });
    expect(uncertain.activeCandidates).toEqual([]);
    expect(uncertain.unevaluatedIds).toEqual([known.activeCandidates[0].id]);
    expect(computeProactiveNextCheckAt({ nowUtc: '2026-01-01T00:00:00.000Z', timeZone: 'UTC', rules: [r], sources: [base] }))
      .toBe('2026-01-01T00:10:00.000Z');
  });

  it('keeps a proof-bounded seven-day snooze valid after clock rollback', () => {
    const nowUtc = '2026-01-08T00:00:00.000Z';
    const r = rule({ type: 'keyword', keywords: ['agenda'] });
    const base = { namespace: 'google', accountId: 'account-1', providerId: 'message-1' };
    const source: ProactiveSource = { kind: 'mail', ...base, sourceId: proactiveSourceId(base), sourceVersion: 'mail-v1', availability: 'available', freshness: 'fresh',
      isRead: false, subject: 'Agenda', receivedAt: '2026-01-07T00:00:00Z' };
    const snooze = { suppressionKey: JSON.stringify([r.id, source.sourceId]), snoozedAt: '2026-01-10T00:00:00.000Z', until: '2026-01-17T00:00:00Z' };
    const evaluation = evaluateProactive({ nowUtc, timeZone: 'UTC', rules: [r], sources: [source], snoozes: [snooze] });
    expect(evaluation.activeCandidates).toEqual([]);
    expect(evaluation.deferredCandidates).toHaveLength(1);
    expect(computeProactiveNextCheckAt({ nowUtc, timeZone: 'UTC', rules: [r], sources: [source], snoozes: [snooze] })).toBe('2026-01-17T00:00:00.000Z');
    expect(() => evaluateProactive({ nowUtc, timeZone: 'UTC', rules: [r], sources: [source], snoozes: [{ ...snooze, until: '2026-01-17T00:00:00.001Z' }] })).toThrow(/seven days/i);
  });

  it('returns null when there is no enabled future boundary and rejects invalid configuration', () => {
    expect(computeProactiveNextCheckAt({ nowUtc: '2026-01-01T00:00:00.000Z', timeZone: 'UTC', rules: [rule({ type: 'task_due', minutes: 5 }, { enabled: false })], sources: [] })).toBeNull();
    expect(() => computeProactiveNextCheckAt({ nowUtc: 'tomorrow', timeZone: 'UTC', rules: [], sources: [] })).toThrow(/canonical UTC/i);
  });
});
