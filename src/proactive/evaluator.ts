import type {
  EvaluateProactiveInput, ProactiveCandidate, ProactiveEvaluation, ProactiveRule,
  ProactiveSource, ProactiveTrigger,
} from './types';
export type {
  EvaluateProactiveInput, ProactiveCandidate, ProactiveEvaluation, ProactiveMailSource, ProactiveMeetingSource,
  ProactiveReasonCode, ProactiveRule, ProactiveSnooze, ProactiveSource, ProactiveTaskSource,
  ProactiveTrigger, QuietHours,
} from './types';

const MAX_RULES = 64;
const MAX_SOURCES = 2000;
const MAX_PREVIOUS = 2000;
const MAX_RULE_INPUT = 1024;
const MAX_SOURCE_INPUT = 10_000;
const MAX_PREVIOUS_INPUT = 10_000;
const MAX_DISMISSALS = 5000;
const MAX_ACTIVE_PER_ACCOUNT = 5;
const MAX_ACTIVE_TOTAL = 20;
const MAX_DEFERRED = 200;
const MAX_CANDIDATE_OUTPUT = MAX_ACTIVE_TOTAL + MAX_DEFERRED;
const DAY_MS = 86_400_000;
const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const TIMESTAMP_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const TIMESTAMP_OFFSET_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-](\d{2}):(\d{2}))$/i;
const TIMESTAMP_NAIVE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/;

function fail(message: string): never { throw new Error(message); }
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function assertTimeZone(value: string): void {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { fail('Proactive evaluation time zone is invalid.'); }
}
function isCalendarDateValid(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1];
}
function parseTimestamp(value: string | undefined, certifiedUtcNaive: boolean | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (TIMESTAMP_OFFSET.test(value)) {
    const parts = TIMESTAMP_OFFSET_PARTS.exec(value)!;
    const [, y, m, d, h, min, sec = '0', fraction = '0', zone, zoneHour = '0', zoneMinute = '0'] = parts;
    if (!isCalendarDateValid(Number(y), Number(m), Number(d), Number(h), Number(min), Number(sec)) || Number(zoneHour) > 23 || Number(zoneMinute) > 59) fail(`${label} is invalid.`);
    const normalized = fraction === '0' ? value : value.replace(`.${fraction}`, `.${fraction.slice(0, 3).padEnd(3, '0')}`);
    const date = Date.parse(normalized);
    if (!Number.isFinite(date)) fail(`${label} is invalid.`);
    return date;
  }
  const match = TIMESTAMP_NAIVE.exec(value);
  if (match && certifiedUtcNaive === true) {
    const [, y, m, d, h, min, sec = '0', fraction = '0'] = match;
    const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(min), second = Number(sec);
    if (!isCalendarDateValid(year, month, day, hour, minute, second)) fail(`${label} is invalid.`);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, '0')));
    return date.getTime();
  }
  fail(`${label} must include an offset, or be explicitly certified as UTC.`);
}
function canonicalNow(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail('nowUtc must be a canonical UTC timestamp.');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('nowUtc is invalid.');
  return parsed;
}
function validMinutes(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_080) fail(`${label} must be an integer from 1 to 10080.`);
  return Number(value);
}
function validateRule(rule: ProactiveRule): void {
  string(rule.id, 'Rule ID', 160);
  if (!Number.isSafeInteger(rule.revision) || rule.revision < 1) fail('Rule revision is invalid.');
  if (typeof rule.enabled !== 'boolean') fail('Rule enabled flag is invalid.');
  if (!Array.isArray(rule.accountIds) || rule.accountIds.length > 64) fail('Rule account filter must contain at most 64 account IDs.');
  const accounts = rule.accountIds.map((id) => string(id, 'Rule account ID', 256));
  if (new Set(accounts).size !== accounts.length) fail('Rule account IDs must be unique.');
  if (!rule.trigger || !['unread_from', 'keyword', 'meeting_soon', 'task_due'].includes(rule.trigger.type)) fail('Rule trigger is invalid.');
  if (rule.trigger.type === 'unread_from') {
    if (!Array.isArray(rule.trigger.addresses) || !rule.trigger.addresses.length || rule.trigger.addresses.length > 20 ||
        rule.trigger.addresses.some((address) => typeof address !== 'string' || address.length > 320 || !EMAIL.test(address))) fail('Sender rule requires 1 to 20 valid email addresses.');
  } else if (rule.trigger.type === 'keyword') {
    if (!Array.isArray(rule.trigger.keywords) || !rule.trigger.keywords.length || rule.trigger.keywords.length > 10 ||
        rule.trigger.keywords.some((word) => typeof word !== 'string' || !word.trim() || word.length > 128 || /[\u0000-\u001f\u007f]/.test(word))) fail('Keyword rule requires 1 to 10 bounded literal keywords.');
    if (rule.trigger.unreadOnly !== undefined && typeof rule.trigger.unreadOnly !== 'boolean') fail('Keyword unreadOnly must be boolean.');
  } else validMinutes(rule.trigger.minutes, 'Rule threshold');
  if (rule.quietHours) {
    if (!/^\d{2}:\d{2}$/.test(rule.quietHours.start) || !/^\d{2}:\d{2}$/.test(rule.quietHours.end) ||
        Number(rule.quietHours.start.slice(0, 2)) > 23 || Number(rule.quietHours.start.slice(3)) > 59 ||
        Number(rule.quietHours.end.slice(0, 2)) > 23 || Number(rule.quietHours.end.slice(3)) > 59) fail('Quiet hours must use valid HH:mm values.');
  }
}
function sourceId(source: Pick<ProactiveSource, 'namespace' | 'accountId' | 'providerId'>): string {
  return JSON.stringify([source.namespace, source.accountId ?? null, source.providerId]);
}
function validateSource(source: ProactiveSource): void {
  string(source.namespace, 'Source namespace', 128);
  if (source.accountId !== undefined) string(source.accountId, 'Source account ID', 256);
  string(source.providerId, 'Provider source ID', 1024);
  if (source.namespace === 'local') {
    if (source.kind !== 'task' || source.accountId !== undefined) fail('Only accountless local tasks are supported as local sources.');
  } else if (source.namespace === 'device_calendar') {
    if (source.kind !== 'meeting' || source.accountId !== undefined || !source.deviceBinding) fail('Device calendar sources must be accountless, typed meetings with a binding.');
    const binding = source.deviceBinding;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.installationId) ||
        !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.calendarId) ||
        !binding.nativeEventId || binding.nativeEventId.length > 1024 || /[\u0000-\u001f\u007f]/.test(binding.nativeEventId) ||
        !Number.isFinite(Date.parse(binding.occurrenceStart)) || new Date(binding.occurrenceStart).toISOString() !== binding.occurrenceStart) fail('Device calendar source binding is invalid.');
    const expectedProviderId = JSON.stringify([binding.installationId, binding.calendarId, binding.nativeEventId, binding.occurrenceStart]);
    if (source.providerId !== expectedProviderId) fail('Device calendar provider ID does not match its frozen tuple.');
  } else if (!source.accountId) fail('Remote mail, meeting, and task sources must identify their account.');
  if (source.sourceId !== sourceId(source)) fail('Source ID does not match its immutable namespace/account/provider identity.');
  string(source.sourceVersion, 'Source version', 512);
  if (source.availability !== 'available' && source.availability !== 'unavailable') fail('Source availability is invalid.');
  if (!['fresh', 'stale', 'unknown'].includes(source.freshness)) fail('Source freshness is invalid.');
  if (source.kind === 'mail') {
    if (source.isRead !== undefined && typeof source.isRead !== 'boolean') fail('Mail read state is invalid.');
    optionalText(source.senderEmail, 'Mail sender', 320);
    optionalText(source.subject, 'Mail subject', 2000);
    optionalText(source.snippet, 'Mail snippet', 2000);
  } else if (source.kind === 'meeting') {
    optionalText(source.subject, 'Meeting subject', 2000);
    if (source.namespace !== 'device_calendar' && source.deviceBinding !== undefined) fail('Only native meetings may carry a device binding.');
  }
  else if (source.kind === 'task') {
    optionalText(source.title, 'Task title', 2000);
    if (source.status !== undefined && source.status !== 'open' && source.status !== 'completed') fail('Task status is invalid.');
  } else fail('Proactive source kind is invalid.');
}

/** Validate one persisted/source-adapter row without evaluating rules or creating time-bound work. */
export function validateProactiveSource(source: ProactiveSource): void {
  validateSource(source);
}
function sourceTimestamp(source: ProactiveSource): { date?: number; raw?: string; field: 'receivedAt' | 'startAt' | 'dueAt' } {
  if (source.kind === 'mail') return { date: parseTimestamp(source.receivedAt, source.receivedAtUtcCertified, 'Mail received time'), raw: source.receivedAt, field: 'receivedAt' };
  if (source.kind === 'meeting') return { date: parseTimestamp(source.startAt, source.startAtUtcCertified, 'Meeting start'), raw: source.startAt, field: 'startAt' };
  return { date: parseTimestamp(source.dueAt, source.dueAtUtcCertified, 'Task due time'), raw: source.dueAt, field: 'dueAt' };
}
function safeSourceTimestamp(source: ProactiveSource): { date?: number; raw?: string; field: 'receivedAt' | 'startAt' | 'dueAt'; invalid: boolean } {
  try { return { ...sourceTimestamp(source), invalid: false }; }
  catch { return { field: source.kind === 'mail' ? 'receivedAt' : source.kind === 'meeting' ? 'startAt' : 'dueAt', invalid: true }; }
}
function localMinutes(epoch: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(epoch);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}
function isQuiet(now: number, timeZone: string, quiet: { start: string; end: string } | undefined): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  const minute = localMinutes(now, timeZone);
  const start = Number(quiet.start.slice(0, 2)) * 60 + Number(quiet.start.slice(3));
  const end = Number(quiet.end.slice(0, 2)) * 60 + Number(quiet.end.slice(3));
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
function exactSubstring(text: string, needle: string): string | undefined {
  const offsets: Array<{ start: number; end: number }> = [];
  let folded = '';
  let position = 0;
  for (const character of text) {
    const start = position;
    position += character.length;
    const lower = character.toLowerCase();
    folded += lower;
    for (let i = 0; i < lower.length; i++) offsets.push({ start, end: position });
  }
  const loweredNeedle = needle.toLowerCase();
  const index = folded.indexOf(loweredNeedle);
  if (index < 0) return undefined;
  const first = offsets[index];
  const last = offsets[index + loweredNeedle.length - 1];
  return first && last ? text.slice(first.start, last.end) : undefined;
}
function candidateFor(rule: ProactiveRule, source: ProactiveSource, trigger: ProactiveTrigger, now: number, previous?: ProactiveCandidate): { candidate?: ProactiveCandidate; uncertain: boolean } {
  if (source.kind !== 'mail' && trigger.type !== (source.kind === 'meeting' ? 'meeting_soon' : 'task_due')) return { uncertain: false };
  if (source.kind === 'mail' && trigger.type !== 'unread_from' && trigger.type !== 'keyword') return { uncertain: false };
  if (source.kind === 'mail') {
    if (trigger.type === 'unread_from') {
      if (source.isRead === true) return { uncertain: false };
      if (source.isRead === undefined || !source.senderEmail || !EMAIL.test(source.senderEmail)) return { uncertain: true };
      if (!trigger.addresses.some((address) => address.toLowerCase() === source.senderEmail!.toLowerCase())) return { uncertain: false };
      return buildCandidate(rule, source, previous, 'unread_sender', 'senderEmail', source.senderEmail);
    }
    if (trigger.type !== 'keyword') return { uncertain: false };
    const unreadOnly = trigger.unreadOnly !== false;
    if (unreadOnly && source.isRead === true) return { uncertain: false };
    if (unreadOnly && source.isRead === undefined) return { uncertain: true };
    const fields: Array<['subject' | 'snippet', string | undefined]> = [['subject', source.subject], ['snippet', source.snippet]];
    for (const [field, text] of fields) {
      if (!text) continue;
      for (const keyword of trigger.keywords) {
        const quote = exactSubstring(text, keyword);
        if (quote !== undefined) return buildCandidate(rule, source, previous, 'keyword', field, quote);
      }
    }
    return { uncertain: !source.subject && !source.snippet };
  }
  const stamp = safeSourceTimestamp(source);
  if (source.kind === 'meeting') {
    if (trigger.type !== 'meeting_soon') return { uncertain: false };
    if (stamp.invalid || stamp.date === undefined) return { uncertain: true };
    const max = now + trigger.minutes * 60_000;
    if (stamp.date <= now || stamp.date > max) return { uncertain: false };
    return buildCandidate(rule, source, previous, 'meeting_soon', source.subject ? 'subject' : 'startAt', source.subject ?? stamp.raw! , new Date(stamp.date).toISOString());
  }
  if (trigger.type !== 'task_due') return { uncertain: false };
  if (source.status === 'completed') return { uncertain: false };
  if (source.status === undefined) return { uncertain: true };
  if (stamp.invalid || stamp.date === undefined) return { uncertain: true };
  if (stamp.date > now + trigger.minutes * 60_000) return { uncertain: false };
  return buildCandidate(rule, source, previous, 'task_due', source.title ? 'title' : 'dueAt', source.title ?? stamp.raw!, new Date(stamp.date).toISOString());
}
function buildCandidate(rule: ProactiveRule, source: ProactiveSource, previous: ProactiveCandidate | undefined,
  reasonCode: ProactiveCandidate['reasonCode'], quoteField: ProactiveCandidate['quoteField'], quote: string, eligibleAt?: string): { candidate?: ProactiveCandidate; uncertain: boolean } {
  const id = JSON.stringify([rule.id, rule.revision, source.sourceId, source.sourceVersion]);
  const suppressionKey = JSON.stringify([rule.id, source.sourceId]);
  if (!eligibleAt) {
    const stamp = safeSourceTimestamp(source);
    if (stamp.invalid) return { uncertain: true };
    eligibleAt = previous?.id === id ? previous.eligibleAt : stamp.date === undefined ? undefined : new Date(stamp.date).toISOString();
  }
  if (!eligibleAt) return { uncertain: true };
  return { candidate: { id, suppressionKey, ruleId: rule.id, ruleRevision: rule.revision, sourceId: source.sourceId,
    sourceVersion: source.sourceVersion, sourceKind: source.kind, namespace: source.namespace, ...(source.accountId ? { accountId: source.accountId } : {}),
    providerId: source.providerId, eligibleAt, reasonCode, quote, quoteField }, uncertain: false };
}
function candidateSort(a: ProactiveCandidate, b: ProactiveCandidate): number { return a.eligibleAt.localeCompare(b.eligibleAt) || a.id.localeCompare(b.id); }
function sourceSort(a: ProactiveSource, b: ProactiveSource): number {
  const aTime = safeSourceTimestamp(a), bTime = safeSourceTimestamp(b);
  const aKnown = !aTime.invalid && aTime.date !== undefined, bKnown = !bTime.invalid && bTime.date !== undefined;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown && aTime.date !== bTime.date) return aTime.date! - bTime.date!;
  return a.sourceId.localeCompare(b.sourceId);
}
function priorSort(a: ProactiveCandidate, b: ProactiveCandidate): number {
  const aTime = Date.parse(a.eligibleAt), bTime = Date.parse(b.eligibleAt);
  const aKnown = Number.isFinite(aTime), bKnown = Number.isFinite(bTime);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown && aTime !== bTime) return aTime - bTime;
  return a.id.localeCompare(b.id);
}
function appliesToRule(rule: ProactiveRule, source: ProactiveSource): boolean {
  if (source.namespace === 'device_calendar') return rule.accountIds.length === 0;
  return rule.accountIds.length === 0 || (source.accountId !== undefined && rule.accountIds.includes(source.accountId));
}

/** Pure local rule evaluator. It performs no network access, model calls, or external actions. */
export function evaluateProactive(input: EvaluateProactiveInput): ProactiveEvaluation {
  const now = canonicalNow(input.nowUtc);
  const timeZone = string(input.timeZone, 'Evaluation time zone', 128);
  assertTimeZone(timeZone);
  if (!Array.isArray(input.rules) || !Array.isArray(input.sources)) fail('Proactive rules and sources must be arrays.');
  if (input.sourceSnapshotComplete !== undefined && typeof input.sourceSnapshotComplete !== 'boolean') fail('Source snapshot completeness flag must be boolean.');
  if (input.rules.length > MAX_RULE_INPUT) fail(`Proactive rule input exceeds ${MAX_RULE_INPUT} entries.`);
  if (input.sources.length > MAX_SOURCE_INPUT) fail(`Proactive source input exceeds ${MAX_SOURCE_INPUT} entries.`);
  for (const rule of input.rules) validateRule(rule);
  const ruleIds = new Set<string>();
  for (const rule of input.rules) { if (ruleIds.has(rule.id)) fail('Proactive rule IDs must be unique.'); ruleIds.add(rule.id); }
  const orderedRules = [...input.rules].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
  const rulesTruncated = Math.max(0, orderedRules.length - MAX_RULES);
  const rules = orderedRules.slice(0, MAX_RULES);
  const fullSourceIds = new Set<string>();
  for (const source of input.sources) { validateSource(source); if (fullSourceIds.has(source.sourceId)) fail('Proactive source IDs must be unique.'); fullSourceIds.add(source.sourceId); }
  const orderedSources = [...input.sources].sort(sourceSort);
  const sourcesTruncated = Math.max(0, orderedSources.length - MAX_SOURCES);
  const sources = orderedSources.slice(0, MAX_SOURCES);
  const sourceById = new Map<string, ProactiveSource>(sources.map((source) => [source.sourceId, source]));
  const previousInput = input.previousCandidates ?? [];
  if (!Array.isArray(previousInput)) fail('Previous proactive candidates must be an array.');
  if (previousInput.length > MAX_PREVIOUS_INPUT) fail(`Previous proactive candidates exceed ${MAX_PREVIOUS_INPUT} entries.`);
  for (const item of previousInput) {
    string(item.id, 'Previous candidate ID', 4096);
    string(item.ruleId, 'Previous candidate rule ID', 160);
    string(item.sourceId, 'Previous candidate source ID', 2048);
    string(item.sourceVersion, 'Previous candidate source version', 512);
  }
  const orderedPrevious = [...previousInput].sort(priorSort);
  const previousTruncated = Math.max(0, orderedPrevious.length - MAX_PREVIOUS);
  const previous = orderedPrevious.slice(0, MAX_PREVIOUS);
  const priorByRuleSource = new Map<string, ProactiveCandidate[]>();
  for (const item of previous) {
    const key = JSON.stringify([item.ruleId, item.sourceId]);
    const list = priorByRuleSource.get(key) ?? [];
    list.push(item);
    priorByRuleSource.set(key, list);
  }
  const dismissedInput = input.dismissedCandidateIds ?? [];
  if (!Array.isArray(dismissedInput) || dismissedInput.length > MAX_DISMISSALS) fail(`Dismissals must be an array of at most ${MAX_DISMISSALS} IDs.`);
  const dismissed = new Set(dismissedInput.map((id) => string(id, 'Dismissed candidate ID', 4096)));
  const snoozes = new Map<string, number>();
  const snoozeInput = input.snoozes ?? [];
  if (!Array.isArray(snoozeInput) || snoozeInput.length > MAX_SOURCES) fail('Snooze list is invalid or exceeds the bounded limit.');
  for (const snooze of snoozeInput) {
    const key = string(snooze.suppressionKey, 'Snooze key', 2048);
    const until = parseTimestamp(snooze.until, false, 'Snooze expiry');
    if (until === undefined) fail('Snooze expiry is invalid.');
    if (snooze.snoozedAt !== undefined) {
      if (typeof snooze.snoozedAt !== 'string') fail('Snooze creation time is invalid.');
      const createdAt = canonicalNow(snooze.snoozedAt);
      if (until <= createdAt || until - createdAt > 7 * DAY_MS) fail('Snoozes may last no more than seven days from creation.');
    } else if (until > now + 7 * DAY_MS) fail('Snoozes may last no more than seven days.');
    if (until > now) snoozes.set(key, Math.max(until, snoozes.get(key) ?? 0));
  }
  const potential: ProactiveCandidate[] = [];
  const uncertainIds = new Set<string>();
  for (const source of sources) {
    if (source.availability !== 'available' || source.freshness !== 'fresh') continue;
    for (const rule of rules) {
      if (!rule.enabled || !appliesToRule(rule, source) || dismissed.has(JSON.stringify([rule.id, rule.revision, source.sourceId, source.sourceVersion]))) continue;
      const priorForPair = priorByRuleSource.get(JSON.stringify([rule.id, source.sourceId])) ?? [];
      const result = candidateFor(rule, source, rule.trigger, now, priorForPair.find((candidate) => candidate.sourceVersion === source.sourceVersion));
      if (result.uncertain) {
        for (const candidate of priorForPair) uncertainIds.add(candidate.id);
      }
      if (!result.candidate) continue;
      const candidate = result.candidate;
      if (dismissed.has(candidate.id)) continue;
      potential.push(candidate);
    }
  }
  potential.sort(candidateSort);
  const potentialIds = new Set(potential.map((candidate) => candidate.id));
  const activeCandidates: ProactiveCandidate[] = [];
  const deferredCandidates: ProactiveCandidate[] = [];
  const accountCounts = new Map<string, number>();
  const retainedIds = new Set<string>();
  let candidateTruncated = previousTruncated;
  for (const candidate of potential) {
    const rule = rules.find((item) => item.id === candidate.ruleId)!;
    const snoozed = (snoozes.get(candidate.suppressionKey) ?? 0) > now;
    const quiet = isQuiet(now, timeZone, rule.quietHours);
    if (snoozed || quiet) {
      if (deferredCandidates.length < MAX_DEFERRED) { deferredCandidates.push(candidate); retainedIds.add(candidate.id); }
      else { candidateTruncated++; }
      continue;
    }
    const capKey = candidate.accountId ?? 'local';
    const count = accountCounts.get(capKey) ?? 0;
    if (count >= MAX_ACTIVE_PER_ACCOUNT || activeCandidates.length >= MAX_ACTIVE_TOTAL) { candidateTruncated++; continue; }
    activeCandidates.push(candidate);
    accountCounts.set(capKey, count + 1);
    retainedIds.add(candidate.id);
  }
  const invalidated = new Set<string>();
  const deferredIds = new Set<string>(deferredCandidates.map((candidate) => candidate.id));
  const unevaluatedIds = new Set<string>();
  for (const old of orderedPrevious.slice(MAX_PREVIOUS)) unevaluatedIds.add(string(old.id, 'Previous candidate ID', 4096));
  const effectiveComplete = input.sourceSnapshotComplete === true;
  for (const old of previous) {
    if (retainedIds.has(old.id) || dismissed.has(old.id)) continue;
    if (potentialIds.has(old.id)) { unevaluatedIds.add(old.id); continue; }
    const rule = rules.find((item) => item.id === old.ruleId);
    if (!rule) {
      if (ruleIds.has(old.ruleId)) unevaluatedIds.add(old.id); else invalidated.add(old.id);
      continue;
    }
    if (!rule.enabled) { invalidated.add(old.id); continue; }
    const source = sourceById.get(old.sourceId);
    if (!source) {
      if (fullSourceIds.has(old.sourceId) || !effectiveComplete) unevaluatedIds.add(old.id); else invalidated.add(old.id);
      continue;
    }
    if (source.availability === 'unavailable') { invalidated.add(old.id); continue; }
    if (source.freshness !== 'fresh' || uncertainIds.has(old.id)) { unevaluatedIds.add(old.id); continue; }
    // Inputs outside the current account filter, or known completed/read/expired facts, are definitive.
    if (!appliesToRule(rule, source) || !retainedIds.has(old.id)) invalidated.add(old.id);
  }
  for (const candidate of potential) {
    if (!retainedIds.has(candidate.id) && !invalidated.has(candidate.id)) unevaluatedIds.add(candidate.id);
  }
  return {
    activeCandidates, deferredCandidates,
    invalidatedIds: [...invalidated].sort(), deferredIds: [...deferredIds].sort(), unevaluatedIds: [...unevaluatedIds].sort(),
    truncation: { rules: rulesTruncated, sources: sourcesTruncated, candidates: candidateTruncated },
  };
}

export { sourceId as proactiveSourceId };
