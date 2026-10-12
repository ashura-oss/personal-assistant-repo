import { evaluateProactive, type ProactiveCandidate } from './index';
import type { ProactiveState, ProactiveCandidateEntry, SavedProactiveRule } from '../core';

export const PROACTIVE_INTEGRITY_ERROR = 'Saved proactive data failed validation. Local candidate generation is paused.';
const MAX_RULES = 64;
const MAX_CANDIDATES = 200;
const MAX_SUPPRESSIONS = 2000;
const MAX_RULE_ID = 160;
const MAX_SOURCE_ID = 2048;
const MAX_SOURCE_VERSION = 512;
const MAX_PROVIDER_ID = 1024;

export interface ProactiveQuarantine {
  reason: 'invalid_proactive_state';
  quarantinedAt: string;
  raw: unknown;
}

export function emptyProactiveState(): ProactiveState {
  return { schemaVersion: 1, rules: [], candidates: [], dismissals: [], snoozes: [] };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function canonicalTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function sourceTupleValid(sourceId: unknown): boolean {
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > MAX_SOURCE_ID) return false;
  try {
    const tuple = JSON.parse(sourceId) as unknown;
    return Array.isArray(tuple) && tuple.length === 3 && typeof tuple[0] === 'string' && tuple[0].length > 0 && tuple[0].length <= 128 &&
      (tuple[1] === null || typeof tuple[1] === 'string' && tuple[1].length > 0 && tuple[1].length <= 256) &&
      typeof tuple[2] === 'string' && tuple[2].length > 0 && tuple[2].length <= MAX_PROVIDER_ID &&
      JSON.stringify(tuple) === sourceId;
  } catch { return false; }
}

function candidateValid(value: unknown, rules: Map<string, SavedProactiveRule>): value is ProactiveCandidateEntry {
  if (!object(value) || !object(value.candidate) || !['active', 'deferred', 'uncertain'].includes(String(value.presentation))) return false;
  const candidate = value.candidate as unknown as ProactiveCandidate;
  const rule = rules.get(candidate.ruleId);
  if (!rule || !Number.isSafeInteger(candidate.ruleRevision) || candidate.ruleRevision < 1 || candidate.ruleRevision > rule.revision ||
      typeof candidate.ruleId !== 'string' || candidate.ruleId.length > MAX_RULE_ID || !sourceTupleValid(candidate.sourceId) ||
      typeof candidate.sourceVersion !== 'string' || !candidate.sourceVersion || candidate.sourceVersion.length > MAX_SOURCE_VERSION ||
      !canonicalTime(candidate.eligibleAt) || typeof candidate.id !== 'string' ||
      candidate.id.length > 4096 ||
      candidate.id !== JSON.stringify([candidate.ruleId, candidate.ruleRevision, candidate.sourceId, candidate.sourceVersion]) ||
      candidate.sourceId !== JSON.stringify([candidate.namespace, candidate.accountId ?? null, candidate.providerId]) ||
      candidate.suppressionKey !== JSON.stringify([candidate.ruleId, candidate.sourceId]) ||
      !['mail', 'meeting', 'task'].includes(candidate.sourceKind) || typeof candidate.namespace !== 'string' || !candidate.namespace || candidate.namespace.length > 128 ||
      typeof candidate.providerId !== 'string' || !candidate.providerId || candidate.providerId.length > MAX_PROVIDER_ID || typeof candidate.quote !== 'string' || candidate.quote.length > 2000 ||
      !['unread_sender', 'keyword', 'meeting_soon', 'task_due'].includes(candidate.reasonCode) ||
      !['senderEmail', 'subject', 'snippet', 'startAt', 'dueAt', 'title'].includes(candidate.quoteField)) return false;
  if (candidate.accountId !== undefined && (typeof candidate.accountId !== 'string' || !candidate.accountId || candidate.accountId.length > 256)) return false;
  if (candidate.namespace === 'local') {
    if (candidate.sourceKind !== 'task' || candidate.accountId !== undefined) return false;
  } else if (!candidate.accountId) return false;
  return true;
}

function validateProactive(value: unknown): ProactiveState {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.rules) || value.rules.length > MAX_RULES ||
      !Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES ||
      !Array.isArray(value.dismissals) || value.dismissals.length > MAX_SUPPRESSIONS ||
      !Array.isArray(value.snoozes) || value.snoozes.length > MAX_SUPPRESSIONS) throw new Error('invalid');
  const rules = value.rules as SavedProactiveRule[];
  const byId = new Map<string, SavedProactiveRule>();
  for (const rule of rules) {
    if (!object(rule) || typeof rule.id !== 'string' || !rule.id || rule.id.length > 160 || byId.has(rule.id) ||
        typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 80 || /[\u0000-\u001f\u007f]/.test(rule.name) ||
        !Number.isSafeInteger(rule.revision) || rule.revision < 1 || !Number.isSafeInteger(rule.version) || rule.version < rule.revision ||
        !canonicalTime(rule.createdAt) || !canonicalTime(rule.updatedAt) ||
        !Array.isArray(rule.accountIds) || rule.accountIds.length > 64 ||
        rule.accountIds.some((id) => typeof id !== 'string' || !id || id.length > 256) || new Set(rule.accountIds).size !== rule.accountIds.length ||
        (rule.trigger?.type === 'task_due' && rule.accountIds.length !== 0)) throw new Error('invalid');
    byId.set(rule.id, rule);
  }
  // Delegate the full trigger and quiet-hours schema to the same pure rule validator used at evaluation time.
  evaluateProactive({ nowUtc: new Date().toISOString(), timeZone: 'UTC', rules, sources: [] });
  const candidates = value.candidates as ProactiveCandidateEntry[];
  const candidateIds = new Set<string>();
  for (const entry of candidates) {
    if (!candidateValid(entry, byId) || candidateIds.has(entry.candidate.id)) throw new Error('invalid');
    candidateIds.add(entry.candidate.id);
  }
  const dismissals = value.dismissals as ProactiveState['dismissals'];
  const dismissalIds = new Set<string>();
  for (const dismissal of dismissals) {
    const rule = byId.get(dismissal.ruleId);
    if (!object(dismissal) || !rule || !Number.isSafeInteger(dismissal.ruleRevision) || dismissal.ruleRevision < 1 || dismissal.ruleRevision > rule.revision ||
        typeof dismissal.ruleId !== 'string' || dismissal.ruleId.length > MAX_RULE_ID || !sourceTupleValid(dismissal.sourceId) ||
        typeof dismissal.sourceVersion !== 'string' || !dismissal.sourceVersion || dismissal.sourceVersion.length > MAX_SOURCE_VERSION ||
        typeof dismissal.candidateId !== 'string' || dismissal.candidateId.length > 4096 ||
        dismissal.candidateId !== JSON.stringify([dismissal.ruleId, dismissal.ruleRevision, dismissal.sourceId, dismissal.sourceVersion]) ||
        !canonicalTime(dismissal.dismissedAt) || dismissalIds.has(dismissal.candidateId)) throw new Error('invalid');
    dismissalIds.add(dismissal.candidateId);
  }
  const snoozeIds = new Set<string>();
  for (const snooze of value.snoozes as ProactiveState['snoozes']) {
    if (!object(snooze)) throw new Error('invalid');
    const rule = byId.get(snooze.ruleId);
    const expectedKey = JSON.stringify([snooze.ruleId, snooze.sourceId]);
    const until = typeof snooze.until === 'string' ? Date.parse(snooze.until) : NaN;
    const snoozedAt = typeof snooze.snoozedAt === 'string' ? Date.parse(snooze.snoozedAt) : NaN;
    if (!rule || typeof snooze.ruleId !== 'string' || snooze.ruleId.length > MAX_RULE_ID || !sourceTupleValid(snooze.sourceId) ||
        typeof snooze.suppressionKey !== 'string' || snooze.suppressionKey.length > 4096 || snooze.suppressionKey !== expectedKey ||
        !canonicalTime(snooze.until) || !canonicalTime(snooze.snoozedAt) || until <= snoozedAt || until - snoozedAt > 7 * 86_400_000 ||
        snoozeIds.has(snooze.suppressionKey)) throw new Error('invalid');
    snoozeIds.add(snooze.suppressionKey);
  }
  let lastEvaluation: ProactiveState['lastEvaluation'];
  if (value.lastEvaluation !== undefined) {
    const rawLast = value.lastEvaluation;
    const truncation = object(rawLast) ? rawLast.truncation : undefined;
    if (!object(rawLast) || typeof rawLast.inputFingerprint !== 'string' || !rawLast.inputFingerprint ||
        !canonicalTime(rawLast.asOf) || !object(truncation) ||
        !['rules', 'sources', 'candidates'].every((key) => Number.isSafeInteger(truncation[key]) && Number(truncation[key]) >= 0) ||
        (rawLast.nextCheckAt !== undefined && !canonicalTime(rawLast.nextCheckAt))) throw new Error('invalid');
    lastEvaluation = rawLast as unknown as NonNullable<ProactiveState['lastEvaluation']>;
  }
  if (value.integrityError !== undefined && value.integrityError !== PROACTIVE_INTEGRITY_ERROR) throw new Error('invalid');
  return {
    schemaVersion: 1, rules: structuredClone(rules), candidates: structuredClone(candidates),
    dismissals: structuredClone(dismissals), snoozes: structuredClone(value.snoozes as ProactiveState['snoozes']),
    ...(lastEvaluation ? { lastEvaluation: structuredClone(lastEvaluation) } : {}),
    ...(value.integrityError === PROACTIVE_INTEGRITY_ERROR ? { integrityError: PROACTIVE_INTEGRITY_ERROR } : {}),
  };
}

export function normalizeProactiveData(
  raw: unknown,
  priorQuarantine: unknown,
): { state: ProactiveState; quarantine?: ProactiveQuarantine } {
  if (priorQuarantine !== undefined) {
    const quarantine: ProactiveQuarantine = object(priorQuarantine) && priorQuarantine.reason === 'invalid_proactive_state' &&
      canonicalTime(priorQuarantine.quarantinedAt) && 'raw' in priorQuarantine
      ? priorQuarantine as unknown as ProactiveQuarantine
      : { reason: 'invalid_proactive_state', quarantinedAt: new Date().toISOString(), raw: priorQuarantine };
    return { state: { ...emptyProactiveState(), integrityError: PROACTIVE_INTEGRITY_ERROR }, quarantine };
  }
  if (raw === undefined) return { state: emptyProactiveState() };
  try { return { state: validateProactive(raw) }; }
  catch {
    return {
      state: { ...emptyProactiveState(), integrityError: PROACTIVE_INTEGRITY_ERROR },
      quarantine: { reason: 'invalid_proactive_state', quarantinedAt: new Date().toISOString(), raw: structuredClone(raw) },
    };
  }
}

export function uncertainOnLoad(state: ProactiveState): ProactiveState {
  return { ...state, candidates: state.candidates.map((entry) => ({ ...entry, presentation: 'uncertain' })) };
}
