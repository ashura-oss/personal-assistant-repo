import { describe, expect, it } from 'vitest';
import { evaluateProactive, proactiveSourceId, type ProactiveCandidate, type ProactiveMailSource, type ProactiveRule, type ProactiveSource } from '../src/proactive';
import type { LocalTask } from '../src/core';

const nowUtc = '2026-10-13T18:00:00.000Z';
const mail = (overrides: Partial<ProactiveMailSource> = {}): ProactiveMailSource => {
  const base = { namespace: 'google', accountId: 'account-1', providerId: 'message-1' };
  return {
    kind: 'mail', ...base, sourceId: proactiveSourceId(base), sourceVersion: 'msg-v1', availability: 'available', freshness: 'fresh',
    senderEmail: 'alex@example.test', isRead: false, subject: 'Agenda for launch', receivedAt: '2026-10-13T17:55:00Z', ...overrides,
  };
};
const rule = (trigger: ProactiveRule['trigger'], overrides: Partial<ProactiveRule> = {}): ProactiveRule => ({
  id: 'rule-1', revision: 1, enabled: true, accountIds: ['account-1'], trigger, ...overrides,
});
const localTaskSource = (task: LocalTask): ProactiveSource => {
  const base = { namespace: 'local', providerId: task.id };
  return {
    kind: 'task', ...base, sourceId: proactiveSourceId(base), sourceVersion: JSON.stringify([task.status, task.dueAt ?? null, task.title]),
    availability: 'available', freshness: 'fresh', title: task.title, status: task.status, dueAt: task.dueAt,
  };
};
const run = (rules: ProactiveRule[], sources: ProactiveSource[], extra: Record<string, unknown> = {}) => evaluateProactive({
  nowUtc, timeZone: 'Asia/Singapore', rules, sources, ...extra,
} as Parameters<typeof evaluateProactive>[0]);

describe('local proactive rule evaluation', () => {
  it('requires known fresh unread metadata and preserves prior candidates when facts are unknown', () => {
    const r = rule({ type: 'unread_from', addresses: ['alex@example.test'] });
    const previous = run([r], [mail()]).activeCandidates;
    expect(previous).toHaveLength(1);
    const result = run([r], [mail({ isRead: undefined, senderEmail: undefined })], { previousCandidates: previous });
    expect(result.activeCandidates).toEqual([]);
    expect(result.invalidatedIds).toEqual([]);
    expect(result.unevaluatedIds).toEqual([previous[0].id]);
  });

  it('quotes exact Unicode keyword substrings and defaults keyword alerts to unread messages', () => {
    const source = mail({ subject: 'Quarterly REVIEW with Zoë', receivedAt: '2026-10-13T17:55:00Z' });
    const result = run([rule({ type: 'keyword', keywords: ['zoë'] })], [source]);
    expect(result.activeCandidates[0]).toMatchObject({ quote: 'Zoë', quoteField: 'subject', reasonCode: 'keyword' });
    expect(run([rule({ type: 'keyword', keywords: ['review'] })], [mail({ isRead: true })]).activeCandidates).toEqual([]);
    expect(run([rule({ type: 'keyword', keywords: ['review'], unreadOnly: false })], [mail({ isRead: true, subject: 'Quarterly REVIEW' })]).activeCandidates).toHaveLength(1);
  });

  it('applies exact meeting threshold and excludes meetings at their start time while including overdue tasks', () => {
    const meetingBase = { namespace: 'microsoft', accountId: 'account-1', providerId: 'event-1' };
    const meeting: ProactiveSource = { kind: 'meeting', ...meetingBase, sourceId: proactiveSourceId(meetingBase), sourceVersion: 'event-v1', availability: 'available', freshness: 'fresh', subject: 'Standup', startAt: nowUtc };
    const task: LocalTask = { id: 'task-1', title: 'Submit report', body: 'Submit the report today.', status: 'open', createdAt: '2026-10-12T00:00:00.000Z', dueAt: '2026-10-13T17:00:00Z', sourceNoteId: 'note-1', sourceRevision: 1, proposalId: 'proposal-1' };
    const taskSource = localTaskSource(task);
    const result = run([rule({ type: 'meeting_soon', minutes: 10 }), rule({ type: 'task_due', minutes: 1 }, { id: 'task-rule', accountIds: [] })], [meeting, taskSource]);
    expect(result.activeCandidates.map((item) => item.reasonCode)).toEqual(['task_due']);
    expect(run([rule({ type: 'task_due', minutes: 1 })], [taskSource]).activeCandidates).toEqual([]);
    const thresholdMeeting = { ...meeting, startAt: '2026-10-13T18:10:00Z', sourceVersion: 'event-boundary' };
    expect(run([rule({ type: 'meeting_soon', minutes: 10 })], [thresholdMeeting]).activeCandidates).toHaveLength(1);
    const futureMeeting = { ...meeting, startAt: '2026-10-13T18:10:00.001Z', sourceVersion: 'event-v2' };
    expect(run([rule({ type: 'meeting_soon', minutes: 10 })], [futureMeeting]).activeCandidates).toHaveLength(0);
    expect(run([rule({ type: 'meeting_soon', minutes: 11 })], [futureMeeting]).activeCandidates).toHaveLength(1);
  });

  it('keeps candidate identity and eligibleAt stable across reevaluation and does not hide a changed source version', () => {
    const r = rule({ type: 'keyword', keywords: ['agenda'] });
    const original = run([r], [mail()]).activeCandidates[0];
    const later = evaluateProactive({ nowUtc: '2026-10-13T18:30:00.000Z', timeZone: 'Asia/Singapore', rules: [r], sources: [mail()] }).activeCandidates[0];
    expect(later.id).toBe(original.id);
    expect(later.eligibleAt).toBe(original.eligibleAt);
    const changed = run([r], [mail({ sourceVersion: 'msg-v2' })], { previousCandidates: [original] });
    expect(changed.activeCandidates).toHaveLength(1);
    expect(changed.activeCandidates[0].id).not.toBe(original.id);
  });

  it('defers overnight and DST quiet hours, while equal endpoints disable quiet hours', () => {
    const source = mail();
    const overnight = rule({ type: 'keyword', keywords: ['agenda'] }, { quietHours: { start: '22:00', end: '07:00' } });
    expect(run([overnight], [source]).deferredCandidates).toHaveLength(1);
    const disabled = rule({ type: 'keyword', keywords: ['agenda'] }, { quietHours: { start: '08:00', end: '08:00' } });
    expect(run([disabled], [source]).activeCandidates).toHaveLength(1);
    const dstRule = rule({ type: 'keyword', keywords: ['agenda'] }, { quietHours: { start: '01:00', end: '02:00' } });
    const dst = evaluateProactive({ nowUtc: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', rules: [dstRule], sources: [source] });
    expect(dst.deferredCandidates).toHaveLength(1);
  });

  it('uses exact-version dismissals and suppression-key snoozes across source revisions', () => {
    const r = rule({ type: 'keyword', keywords: ['agenda'] });
    const first = run([r], [mail()]).activeCandidates[0];
    const secondSource = mail({ sourceVersion: 'msg-v2' });
    const secondId = JSON.stringify([r.id, r.revision, secondSource.sourceId, secondSource.sourceVersion]);
    expect(run([r], [mail()], { dismissedCandidateIds: [first.id] }).activeCandidates).toEqual([]);
    const dismissed = run([r], [secondSource], { dismissedCandidateIds: [first.id] });
    expect(dismissed.activeCandidates[0].id).toBe(secondId);
    const snoozed = run([r], [secondSource], { snoozes: [{ suppressionKey: first.suppressionKey, until: '2026-10-13T19:00:00Z' }] });
    expect(snoozed.activeCandidates).toEqual([]);
    expect(snoozed.deferredCandidates[0].id).toBe(secondId);
  });

  it('invalidates known read, completed, unavailable, removed, and expired facts', () => {
    const mailRule = rule({ type: 'unread_from', addresses: ['alex@example.test'] });
    const mailCandidate = run([mailRule], [mail()]).activeCandidates[0];
    const read = run([mailRule], [mail({ isRead: true })], { previousCandidates: [mailCandidate] });
    expect(read.invalidatedIds).toContain(mailCandidate.id);
    expect(run([mailRule], [mail({ isRead: true, senderEmail: undefined })], { previousCandidates: [mailCandidate] }).invalidatedIds).toContain(mailCandidate.id);

    const taskRule = rule({ type: 'task_due', minutes: 30 }, { id: 'task-rule' });
    const task: LocalTask = { id: 'task-1', title: 'Finish report', body: '', status: 'open', createdAt: '2026-10-12T00:00:00.000Z', dueAt: '2026-10-13T17:59:00Z', sourceNoteId: 'note-1', sourceRevision: 1, proposalId: 'proposal-1' };
    const taskSource = localTaskSource(task);
    const localTaskRule = { ...taskRule, accountIds: [] };
    const taskCandidate = run([localTaskRule], [taskSource]).activeCandidates[0];
    const completedTask = { ...task, status: 'completed' as const };
    expect(run([localTaskRule], [localTaskSource(completedTask)], { previousCandidates: [taskCandidate] }).invalidatedIds).toContain(taskCandidate.id);
    expect(run([localTaskRule], [localTaskSource({ ...completedTask, dueAt: undefined })], { previousCandidates: [taskCandidate] }).invalidatedIds).toContain(taskCandidate.id);
    expect(run([mailRule], [mail({ availability: 'unavailable' })], { previousCandidates: [mailCandidate] }).invalidatedIds).toContain(mailCandidate.id);
    expect(run([], [mail()], { previousCandidates: [mailCandidate] }).invalidatedIds).toContain(mailCandidate.id);

    const meetingBase = { namespace: 'microsoft', accountId: 'account-1', providerId: 'event' };
    const meeting: ProactiveSource = { kind: 'meeting', ...meetingBase, sourceId: proactiveSourceId(meetingBase), sourceVersion: 'event-v1', availability: 'available', freshness: 'fresh', startAt: '2026-10-13T18:05:00Z', subject: 'Briefing' };
    const meetingRule = rule({ type: 'meeting_soon', minutes: 10 }, { id: 'meeting-rule' });
    const meetingCandidate = run([meetingRule], [meeting]).activeCandidates[0];
    const expired = evaluateProactive({ nowUtc: '2026-10-13T18:06:00.000Z', timeZone: 'Asia/Singapore', rules: [meetingRule], sources: [meeting], previousCandidates: [meetingCandidate] });
    expect(expired.invalidatedIds).toContain(meetingCandidate.id);
  });

  it('preserves candidates during partial snapshots and invalidates absent sources only when completeness is proven', () => {
    const r = rule({ type: 'keyword', keywords: ['agenda'] });
    const prior = run([r], [mail()]).activeCandidates[0];
    const incomplete = run([r], [], { previousCandidates: [prior], sourceSnapshotComplete: false });
    expect(incomplete.invalidatedIds).toEqual([]);
    expect(incomplete.unevaluatedIds).toContain(prior.id);
    const complete = run([r], [], { previousCandidates: [prior], sourceSnapshotComplete: true });
    expect(complete.invalidatedIds).toContain(prior.id);
  });

  it('isolates malformed source timestamps and marks only affected previous candidates unevaluated', () => {
    const r = rule({ type: 'keyword', keywords: ['agenda'] });
    const invalid = mail({ providerId: 'bad-date', sourceId: proactiveSourceId({ namespace: 'google', accountId: 'account-1', providerId: 'bad-date' }), receivedAt: '2026-02-31T12:00:00Z' });
    const previous = run([r], [mail({ ...invalid, receivedAt: '2026-10-13T17:55:00Z' })]).activeCandidates[0];
    const result = run([r], [invalid, mail({ providerId: 'good-date', sourceId: proactiveSourceId({ namespace: 'google', accountId: 'account-1', providerId: 'good-date' }) })], { previousCandidates: [previous] });
    expect(result.activeCandidates.map((candidate) => candidate.providerId)).toEqual(['good-date']);
    expect(result.unevaluatedIds).toContain(previous.id);
    expect(result.invalidatedIds).not.toContain(previous.id);
  });

  it('caps rules, sources, and active output without falsely invalidating candidates outside the caps', () => {
    const r = rule({ type: 'keyword', keywords: ['agenda'] });
    const sixSources = Array.from({ length: 6 }, (_, index) => mail({ providerId: `m-${index}`, sourceId: proactiveSourceId({ namespace: 'google', accountId: 'account-1', providerId: `m-${index}` }), receivedAt: `2026-10-13T17:5${index}:00Z` }));
    const previous = run([r], [sixSources[5]]).activeCandidates;
    const capped = run([r], sixSources, { previousCandidates: previous });
    expect(capped.activeCandidates).toHaveLength(5);
    expect(capped.unevaluatedIds).toContain(previous[0].id);
    const reordered = run([r], [...sixSources].reverse(), { previousCandidates: previous });
    expect(reordered.activeCandidates.map((candidate) => candidate.id)).toEqual(capped.activeCandidates.map((candidate) => candidate.id));
    const oversizedSources = Array.from({ length: 2001 }, (_, index) => mail({ providerId: `bulk-${index}`, sourceId: proactiveSourceId({ namespace: 'google', accountId: 'account-1', providerId: `bulk-${index}` }) }));
    const outside = run([r], [oversizedSources[2000]]).activeCandidates;
    const bounded = run([r], oversizedSources, { previousCandidates: outside, sourceSnapshotComplete: true });
    expect(bounded.truncation.sources).toBe(1);
    expect(bounded.invalidatedIds).toEqual([]);
    expect(bounded.unevaluatedIds).toContain(outside[0].id);
    expect(run([r], [...oversizedSources].reverse()).activeCandidates.map((candidate) => candidate.id))
      .toEqual(run([r], oversizedSources).activeCandidates.map((candidate) => candidate.id));

    const lateRule = rule({ type: 'keyword', keywords: ['agenda'] }, { id: 'zz-rule' });
    const lateCandidate = run([lateRule], [mail()]).activeCandidates[0];
    const earlierRules = Array.from({ length: 64 }, (_, index) => rule({ type: 'keyword', keywords: ['agenda'] }, { id: `rule-${String(index).padStart(2, '0')}` }));
    const cappedRules = [...earlierRules, lateRule];
    const ruleCapResult = run(cappedRules, [mail()], { previousCandidates: [lateCandidate] });
    expect(ruleCapResult.truncation.rules).toBe(1);
    expect(ruleCapResult.unevaluatedIds).toContain(lateCandidate.id);
    expect(run([...cappedRules].reverse(), [mail()], { previousCandidates: [lateCandidate] }).activeCandidates.map((candidate) => candidate.id))
      .toEqual(ruleCapResult.activeCandidates.map((candidate) => candidate.id));

    const previousMany: ProactiveCandidate[] = Array.from({ length: 2001 }, (_, index) => ({
      ...lateCandidate, id: `prior-${String(index).padStart(4, '0')}`, eligibleAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString(),
    }));
    const previousCap = run([lateRule], [], { previousCandidates: previousMany, sourceSnapshotComplete: true });
    const previousCapReordered = run([lateRule], [], { previousCandidates: [...previousMany].reverse(), sourceSnapshotComplete: true });
    expect(previousCap.truncation.candidates).toBe(1);
    expect(previousCap.unevaluatedIds).toEqual(['prior-2000']);
    expect(previousCap.invalidatedIds).toEqual(previousCapReordered.invalidatedIds);
    expect(previousCap.unevaluatedIds).toEqual(previousCapReordered.unevaluatedIds);
    expect(() => run(Array.from({ length: 1025 }, (_, index) => rule({ type: 'keyword', keywords: ['agenda'] }, { id: `r-${index}` })), [])).toThrow(/exceeds 1024/i);
    const tooManySources = Array.from({ length: 10_001 }, (_, index) => {
      const providerId = `too-many-${index}`;
      return mail({ providerId, sourceId: proactiveSourceId({ namespace: 'google', accountId: 'account-1', providerId }) });
    });
    expect(() => run([r], tooManySources)).toThrow(/exceeds 10000/i);
  });

  it('rejects invalid rule bounds, malformed timestamps, uncertified naive timestamps, and overlong snoozes', () => {
    expect(() => run([rule({ type: 'keyword', keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) })], [mail()])).toThrow(/1 to 10/i);
    expect(() => run([rule({ type: 'meeting_soon', minutes: 0 })], [])).toThrow(/1 to 10080/i);
    expect(run([rule({ type: 'keyword', keywords: ['agenda'] })], [mail({ receivedAt: '2026-10-13T17:55:00' })]).activeCandidates).toEqual([]);
    expect(run([rule({ type: 'keyword', keywords: ['agenda'] })], [mail({ receivedAt: '2026-10-13T17:55:00', receivedAtUtcCertified: true })]).activeCandidates).toHaveLength(1);
    expect(() => run([rule({ type: 'keyword', keywords: ['agenda'] })], [mail()], { snoozes: [{ suppressionKey: 'key', until: '2026-10-21T18:00:01Z' }] })).toThrow(/seven days/i);
  });
});
