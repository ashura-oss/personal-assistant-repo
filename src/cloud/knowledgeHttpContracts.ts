import { validateKnowledgeSuggestion, validateCanonicalKnowledgeReference } from '../knowledge';
import type { KnowledgeChange, KnowledgeReference, KnowledgeSuggestion } from '../knowledge/types';
import { projectKnowledgeSourceChoiceReference } from '../knowledge/sourceChoices';

export type KnowledgeSourceChoiceDTO = Readonly<{ id: string; label: string; reference: Exclude<KnowledgeReference, { kind: 'device_calendar_event' }> }>;
export type KnowledgeSourceChoicesDTO = Readonly<{
  schemaVersion: 1; workspaceId: string; privacyEpoch: number; revision: number; choices: readonly KnowledgeSourceChoiceDTO[];
}>;
export type KnowledgeSuggestionDisplayDTO = Readonly<{
  id: string; revision: number; targetRevision: number; evidence: readonly KnowledgeSuggestion['evidence'][number][]; status: KnowledgeSuggestion['status'];
  createdAt: string; updatedAt: string; change: KnowledgeChangeDisplayDTO; reviewedAt?: string; originalChange?: KnowledgeChangeDisplayDTO;
  originalEvidence?: readonly KnowledgeSuggestion['evidence'][number][]; staleReason?: string;
}>;
export type KnowledgeChangeDisplayDTO = Exclude<KnowledgeChange, { type: 'add_source_link' }> |
  (Omit<Extract<KnowledgeChange, { type: 'add_source_link' }>, 'reference'> & Readonly<{ reference: Exclude<KnowledgeReference, { kind: 'device_calendar_event' }> }>);
export type KnowledgeSuggestionReviewDTO = Readonly<{
  schemaVersion: 1; workspaceId: string; privacyEpoch: number; revision: number;
  review: Readonly<{ suggestion: KnowledgeSuggestionDisplayDTO; canEdit: boolean; canAccept: boolean; reason?: string }>;
}>;

function record(value: unknown, keys: readonly string[], required: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('knowledge_http_response_invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('knowledge_http_response_invalid');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error('knowledge_http_response_invalid');
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('knowledge_http_response_invalid');
  }
  return value as Record<string, unknown>;
}
const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeReference(value: unknown): value is Exclude<KnowledgeReference, { kind: 'device_calendar_event' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'device_calendar_event') return false;
  const keys = kind === 'note' || kind === 'task' || kind === 'document' || kind === 'person' || kind === 'project' ? ['kind', 'id']
    : kind === 'mail' ? ['kind', 'id', 'identityKey', 'connectionGeneration']
      : kind === 'calendar' ? ['kind', 'id', 'calendarId', 'identityKey', 'connectionGeneration']
        : kind === 'historical' ? ['kind', 'label', 'originalKind'] : [];
  if (!keys.length) return false;
  record(value, keys, keys);
  try { validateCanonicalKnowledgeReference(value); return true; } catch { return false; }
}

function parseEnvelope(value: unknown, allowedKeys: readonly string[]) {
  const row = record(value, allowedKeys, ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision']);
  if (row.schemaVersion !== 1 || typeof row.workspaceId !== 'string' || !UUID_V4.test(row.workspaceId) || !nonNegative(row.privacyEpoch) || !nonNegative(row.revision)) {
    throw new Error('knowledge_http_response_invalid');
  }
  return row;
}

export function parseKnowledgeSourceChoicesDTO(value: unknown, expected: Readonly<{ workspaceId: string; privacyEpoch: number; revision: number }>): KnowledgeSourceChoicesDTO {
  const row = parseEnvelope(value, ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', 'choices']);
  if (row.workspaceId !== expected.workspaceId || row.privacyEpoch !== expected.privacyEpoch || row.revision !== expected.revision) throw new Error('knowledge_http_response_stale');
  if (!Array.isArray(row.choices)) throw new Error('knowledge_http_response_invalid');
  const seen = new Set<string>();
  const choices = row.choices.map((item) => {
    const choice = record(item, ['id', 'label', 'reference'], ['id', 'label', 'reference']);
    if (typeof choice.id !== 'string' || !/^knowledge-choice-[a-f0-9]{64}$/.test(choice.id) || seen.has(choice.id) ||
        typeof choice.label !== 'string' || choice.label.length > 4096 || !safeReference(choice.reference)) throw new Error('knowledge_http_response_invalid');
    seen.add(choice.id);
    return Object.freeze({ id: choice.id, label: choice.label, reference: Object.freeze(structuredClone(choice.reference)) });
  });
  return Object.freeze({ schemaVersion: 1, workspaceId: row.workspaceId as string, privacyEpoch: row.privacyEpoch as number, revision: row.revision as number, choices: Object.freeze(choices) });
}

function projectChange(change: KnowledgeSuggestion['change']): KnowledgeChangeDisplayDTO {
  return change.type === 'add_source_link' ? Object.freeze({ ...change, reference: projectKnowledgeSourceChoiceReference(change.reference) }) : Object.freeze(structuredClone(change));
}
function projectSuggestion(item: KnowledgeSuggestion): KnowledgeSuggestionDisplayDTO {
  return Object.freeze({ id: item.id, revision: item.revision, targetRevision: item.targetRevision, evidence: Object.freeze(item.evidence.map((entry) => Object.freeze({ ...entry }))),
    status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, change: projectChange(item.change),
    ...(item.reviewedAt ? { reviewedAt: item.reviewedAt } : {}),
    ...(item.originalChange ? { originalChange: projectChange(item.originalChange) } : {}),
    ...(item.originalEvidence ? { originalEvidence: Object.freeze(item.originalEvidence.map((entry) => Object.freeze({ ...entry }))) } : {}),
    ...(item.staleReason ? { staleReason: item.staleReason } : {}) });
}

const SUGGESTION_DISPLAY_KEYS = ['id', 'revision', 'targetRevision', 'evidence', 'status', 'createdAt', 'updatedAt', 'reviewedAt',
  'change', 'originalChange', 'originalEvidence', 'staleReason'] as const;

function assertSafeDisplayChange(value: unknown): void {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!row) throw new Error('knowledge_http_response_invalid');
  if (row.type === 'add_source_link') {
    const keys = ['type', 'entityKind', 'entityId', 'reference', 'referenceRevision', 'label'];
    record(row, keys, ['type', 'entityKind', 'entityId', 'reference', 'label']);
    if (!safeReference(row.reference)) throw new Error('knowledge_http_response_invalid');
  }
}

function assertSafeSuggestionDisplay(value: unknown): void {
  const row = record(value, SUGGESTION_DISPLAY_KEYS, ['id', 'revision', 'targetRevision', 'evidence', 'status', 'createdAt', 'updatedAt', 'change']);
  assertSafeDisplayChange(row.change);
  if (Object.hasOwn(row, 'originalChange')) assertSafeDisplayChange(row.originalChange);
}

export function parseKnowledgeSuggestionReviewDTO(value: unknown, expected: Readonly<{ workspaceId: string; privacyEpoch: number; revision: number; suggestionId: string; suggestionRevision: number }>): KnowledgeSuggestionReviewDTO {
  const row = parseEnvelope(value, ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', 'review']);
  if (row.workspaceId !== expected.workspaceId || row.privacyEpoch !== expected.privacyEpoch || row.revision !== expected.revision) throw new Error('knowledge_http_response_stale');
  const reviewRow = record(row.review, ['suggestion', 'canEdit', 'canAccept', 'reason'], ['suggestion', 'canEdit', 'canAccept']);
  if (typeof reviewRow.canEdit !== 'boolean' || typeof reviewRow.canAccept !== 'boolean' || (Object.hasOwn(reviewRow, 'reason') && typeof reviewRow.reason !== 'string')) throw new Error('knowledge_http_response_invalid');
  let parsed: KnowledgeSuggestion;
  assertSafeSuggestionDisplay(reviewRow.suggestion);
  try { parsed = validateKnowledgeSuggestion(reviewRow.suggestion); } catch { throw new Error('knowledge_http_response_invalid'); }
  if (parsed.id !== expected.suggestionId || parsed.revision !== expected.suggestionRevision) throw new Error('knowledge_http_response_stale');
  const suggestion = projectSuggestion(parsed);
  return Object.freeze({ schemaVersion: 1, workspaceId: row.workspaceId as string, privacyEpoch: row.privacyEpoch as number, revision: row.revision as number,
    review: Object.freeze({ suggestion, canEdit: reviewRow.canEdit, canAccept: reviewRow.canAccept, ...(Object.hasOwn(reviewRow, 'reason') ? { reason: reviewRow.reason as string } : {}) }) });
}

export function projectKnowledgeSuggestionForHttp(item: KnowledgeSuggestion): KnowledgeSuggestionDisplayDTO { return projectSuggestion(item); }
