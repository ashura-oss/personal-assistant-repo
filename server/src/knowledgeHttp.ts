import type { WorkspaceHttpAdmission } from './workspaceHttp.js';

// Keep server transport self-contained; parity is covered against the domain codec.
const CANONICAL_KNOWLEDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const KNOWLEDGE_SOURCE_CHOICES_PATH = '/api/workspace/knowledge/source-choices';
export const KNOWLEDGE_SUGGESTION_REVIEW_PATH = '/api/workspace/knowledge/suggestion-review';

export interface KnowledgeHttpApi {
  readKnowledgeSourceChoices(admission: WorkspaceHttpAdmission, input: Readonly<{ expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<unknown>;
  readKnowledgeSuggestionReview(admission: WorkspaceHttpAdmission, input: Readonly<{ suggestionId: string; expectedSuggestionRevision: number; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<unknown>;
}

export type KnowledgeHttpRead =
  | Readonly<{ kind: 'source_choices'; expectedRevision: number; expectedPrivacyEpoch: number }>
  | Readonly<{ kind: 'suggestion_review'; suggestionId: string; expectedSuggestionRevision: number; expectedRevision: number; expectedPrivacyEpoch: number }>;

function decimal(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Strict query codec. Repeated keys, extras, encoding aliases, and malformed values are rejected. */
export function parseKnowledgeHttpRead(pathname: string, rawQuery: string): KnowledgeHttpRead {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  const pairs = query ? query.split('&') : [];
  if (pairs.some((item) => !item || item.includes('%') || item.includes('+') || item.includes(';'))) throw new Error('knowledge_http_query_invalid');
  const fields = new Map<string, string>();
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0 || equals === pair.length - 1) throw new Error('knowledge_http_query_invalid');
    const key = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (fields.has(key)) throw new Error('knowledge_http_query_invalid');
    fields.set(key, value);
  }
  const expectedRevisionText = fields.get('expectedRevision');
  const expectedPrivacyEpochText = fields.get('expectedPrivacyEpoch');
  if (expectedRevisionText === undefined || expectedPrivacyEpochText === undefined) throw new Error('knowledge_http_query_invalid');
  const expectedRevision = decimal(expectedRevisionText), expectedPrivacyEpoch = decimal(expectedPrivacyEpochText);
  if (expectedRevision === undefined || expectedPrivacyEpoch === undefined) throw new Error('knowledge_http_query_invalid');
  if (pathname === KNOWLEDGE_SOURCE_CHOICES_PATH) {
    if (fields.size !== 2) throw new Error('knowledge_http_query_invalid');
    return Object.freeze({ kind: 'source_choices', expectedRevision, expectedPrivacyEpoch });
  }
  if (pathname === KNOWLEDGE_SUGGESTION_REVIEW_PATH) {
    const suggestionId = fields.get('suggestionId'), suggestionRevisionText = fields.get('expectedSuggestionRevision');
    if (fields.size !== 4 || typeof suggestionId !== 'string' || !CANONICAL_KNOWLEDGE_ID.test(suggestionId) || suggestionRevisionText === undefined) throw new Error('knowledge_http_query_invalid');
    const expectedSuggestionRevision = decimal(suggestionRevisionText);
    if (expectedSuggestionRevision === undefined || expectedSuggestionRevision < 1) throw new Error('knowledge_http_query_invalid');
    return Object.freeze({ kind: 'suggestion_review', suggestionId, expectedSuggestionRevision, expectedRevision, expectedPrivacyEpoch });
  }
  throw new Error('knowledge_http_route_not_found');
}
