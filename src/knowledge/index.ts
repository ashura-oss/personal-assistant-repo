import type {
  ContactClaim, KnowledgeChange, KnowledgeEvidence, KnowledgeFact, KnowledgeImportOrigin, KnowledgeReference,
  KnowledgeSourceLink, KnowledgeState, KnowledgeSuggestion, Person, Project, ProjectMember,
} from './types';
import type { AssistantSourceInput } from '../assistant/types';
import { isCanonicalKnowledgeId } from '../../server/src/knowledgeId';

export * from './types';

export const KNOWLEDGE_LIMITS = Object.freeze({
  people: 500, projects: 500, pendingSuggestions: 200, suggestions: 2_000,
  factsPerEntity: 64, contactsPerPerson: 20, linksPerEntity: 64, membersPerProject: 64,
  globalFacts: 5_000, globalContacts: 5_000, globalLinks: 5_000, globalMembers: 5_000,
  evidencePerItem: 4, sourceIdChars: 512, sourceVersionChars: 128, quoteBytes: 1_000,
  aliasCount: 16, aliasChars: 120, nameChars: 120, narrativeBytes: 16 * 1024,
  statementBytes: 1_024, goalBytes: 4 * 1_024, labelChars: 120, addressChars: 512,
});

const CONTROL = /[\u0000-\u001f\u007f]/;
const INVALID_MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const encoder = new TextEncoder();
function fail(message: string): never { throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function bytes(value: string): number { return encoder.encode(value).length; }
function ownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains an unsupported field.`);
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(i + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return true; i += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function string(value: unknown, label: string, maxBytes: number, maxChars = maxBytes, multiline = false, unlimited = false): string {
  const invalidControl = multiline ? INVALID_MULTILINE_CONTROL : CONTROL;
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || (!unlimited && (value.length > maxChars || bytes(value) > maxBytes)) || invalidControl.test(value)) fail(`${label} is invalid.`);
  return value;
}
function id(value: unknown, label: string): string {
  if (!isCanonicalKnowledgeId(value)) fail(`${label} must be a canonical UUID.`);
  return value;
}
export { isCanonicalKnowledgeId };
function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} is invalid.`);
  return value as number;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} must be a valid date.`);
  if (new Date(value).toISOString() !== value) fail(`${label} must use canonical ISO date format.`);
  return value;
}
function dateOnly(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} is invalid.`);
  return value;
}
function timezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) fail('Project time zone is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { fail('Project time zone is invalid.'); }
  return value;
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds the allowed item count.`);
  return value;
}
function denseList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain array.`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) ||
      keys.filter((key) => key !== 'length').length !== value.length ||
      keys.some((key) => key !== 'length' && (typeof key !== 'string' || (() => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
      })()))) fail(`${label} must be a plain dense array.`);
  return value;
}
function uniqueIds<T extends { id: string }>(rows: T[], label: string): void {
  const seen = new Set<string>();
  for (const row of rows) { if (seen.has(row.id)) fail(`${label} contains duplicate IDs.`); seen.add(row.id); }
}
function normalizeEvidence(value: unknown, unlimited = false): KnowledgeEvidence[] {
  const rows = unlimited ? denseList(value, 'Evidence') : list(value, KNOWLEDGE_LIMITS.evidencePerItem, 'Evidence');
  if (rows.length < 1) fail('Evidence must contain at least one item.');
  return rows.map((row) => {
    if (!record(row)) fail('Evidence item must be an object.');
    ownKeys(row, ['sourceId', 'sourceVersion', 'revision', 'quote'], 'Evidence item');
    const sourceId = string(row.sourceId, 'Evidence source ID', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars);
    if (!sourceId) fail('Evidence source ID is invalid.');
    const sourceVersion = string(row.sourceVersion, 'Evidence source version', KNOWLEDGE_LIMITS.sourceVersionChars, KNOWLEDGE_LIMITS.sourceVersionChars);
    if (!/^\d+:[a-f0-9]{64}$/.test(sourceVersion)) fail('Evidence source version is invalid.');
    if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) fail('Evidence revision is invalid.');
    if (!sourceVersion.startsWith(`${row.revision}:`)) fail('Evidence revision does not match its source version.');
    const quote = string(row.quote, 'Evidence quote', KNOWLEDGE_LIMITS.quoteBytes, KNOWLEDGE_LIMITS.quoteBytes, true, unlimited);
    if (!quote.trim()) fail('Evidence quote cannot be blank.');
    return { sourceId, sourceVersion, revision: row.revision as number, quote };
  });
}
function normalizeReference(value: unknown): KnowledgeReference {
  if (!record(value)) fail('Knowledge reference must be an object.');
  if (value.kind === 'calendar' && value.calendarId === undefined) {
    ownKeys(value, ['kind', 'id', 'identityKey', 'connectionGeneration'], 'Legacy calendar reference');
    return { kind: 'historical', label: 'Unavailable calendar event', originalKind: 'calendar' };
  }
  if (value.kind === 'note' || value.kind === 'task' || value.kind === 'document') {
    ownKeys(value, ['kind', 'id'], 'Knowledge reference');
    const refId = string(value.id, 'Reference ID', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars);
    if (!refId) fail('Reference ID is invalid.');
    return { kind: value.kind, id: refId };
  }
  if (value.kind === 'person' || value.kind === 'project') {
    ownKeys(value, ['kind', 'id'], 'Knowledge reference');
    return { kind: value.kind, id: id(value.id, 'Knowledge entity reference ID') };
  }
  if (value.kind === 'mail' || value.kind === 'calendar') {
    ownKeys(value, value.kind === 'calendar' ? ['kind', 'id', 'calendarId', 'identityKey', 'connectionGeneration'] : ['kind', 'id', 'identityKey', 'connectionGeneration'], 'Knowledge reference');
    if (!Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 0) fail('Reference generation is invalid.');
    const refId = string(value.id, 'Reference ID', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars);
    const identityKey = string(value.identityKey, 'Reference identity key', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars);
    if (!refId || !identityKey) fail('Knowledge reference is invalid.');
    if (value.kind === 'calendar') {
      const calendarId = string(value.calendarId, 'Calendar reference ID', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars);
      if (!calendarId) fail('Calendar reference is invalid.');
      return { kind: 'calendar', id: refId, calendarId, identityKey, connectionGeneration: value.connectionGeneration as number };
    }
    return { kind: 'mail', id: refId, identityKey, connectionGeneration: value.connectionGeneration as number };
  }
  if (value.kind === 'device_calendar_event') {
    ownKeys(value, ['kind', 'installationId', 'generation', 'calendarId', 'eventId', 'occurrenceStart'], 'Device calendar reference');
    if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) fail('Device calendar reference generation is invalid.');
    const installationId = id(value.installationId, 'Device installation ID');
    const calendarId = id(value.calendarId, 'Device calendar ID');
    const eventId = string(value.eventId, 'Native event ID', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars);
    const occurrenceStart = timestamp(value.occurrenceStart, 'Event occurrence start');
    if (!eventId) fail('Native event ID is invalid.');
    return { kind: 'device_calendar_event', installationId, generation: value.generation as number, calendarId, eventId, occurrenceStart };
  }
  if (value.kind === 'historical') {
    ownKeys(value, ['kind', 'label', 'originalKind'], 'Knowledge reference');
    return { kind: 'historical', label: string(value.label, 'Historical reference label', KNOWLEDGE_LIMITS.labelChars), originalKind: string(value.originalKind, 'Historical reference kind', 64, 64) };
  }
  return fail('Knowledge reference kind is invalid.');
}
/** Validates a reference without allowing normalization to silently change its identity. */
export function validateCanonicalKnowledgeReference(value: unknown): KnowledgeReference {
  const normalized = normalizeReference(value);
  if (!record(value)) fail('Knowledge reference must be an object.');
  const originalKeys = Object.keys(value).sort();
  const normalizedKeys = Object.keys(normalized).sort();
  if (originalKeys.length !== normalizedKeys.length || originalKeys.some((key, index) => key !== normalizedKeys[index] || value[key] !== (normalized as unknown as Record<string, unknown>)[key])) {
    fail('Knowledge reference is not canonical.');
  }
  return normalized;
}
function normalizeLink(value: unknown): KnowledgeSourceLink {
  if (!record(value)) fail('Knowledge source link must be an object.');
  ownKeys(value, ['id', 'provenance', 'createdAt', 'evidence', 'suggestionId', 'outputPolicyVersion', 'reference', 'label'], 'Knowledge source link');
  const policy = outputPolicy(value, 'Knowledge source link');
  return { ...normalizeBaseItem(value, 'Knowledge source link', policy), reference: normalizeReference(value.reference), label: string(value.label, 'Source link label', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, policy === 2) };
}
function outputPolicy(value: Record<string, unknown>, label: string): 1 | 2 {
  if (value.outputPolicyVersion !== undefined && value.outputPolicyVersion !== 1 && value.outputPolicyVersion !== 2) fail(`${label} output policy version is invalid.`);
  return (value.outputPolicyVersion ?? 1) as 1 | 2;
}
function normalizeBaseItem(value: unknown, label: string, policy = 1): Pick<KnowledgeFact, 'id' | 'provenance' | 'createdAt' | 'evidence' | 'suggestionId' | 'outputPolicyVersion'> {
  if (!record(value)) fail(`${label} must be an object.`);
  const provenance = value.provenance;
  if (provenance !== 'user_authored' && provenance !== 'accepted_inference') fail(`${label} provenance is invalid.`);
  if (provenance === 'accepted_inference' && value.evidence === undefined) fail(`${label} inference requires evidence.`);
  return { id: id(value.id, `${label} ID`), provenance, createdAt: timestamp(value.createdAt, `${label} creation time`),
    ...(value.evidence !== undefined ? { evidence: normalizeEvidence(value.evidence, policy === 2) } : {}),
    ...(value.suggestionId !== undefined ? { suggestionId: id(value.suggestionId, `${label} suggestion ID`) } : {}),
    ...(value.outputPolicyVersion !== undefined ? { outputPolicyVersion: policy as 1 | 2 } : {}) };
}
function normalizeFact(value: unknown): KnowledgeFact {
  if (!record(value)) fail('Knowledge fact must be an object.');
  ownKeys(value, ['id', 'provenance', 'createdAt', 'evidence', 'suggestionId', 'outputPolicyVersion', 'statement'], 'Knowledge fact');
  const policy = outputPolicy(value, 'Knowledge fact');
  return { ...normalizeBaseItem(value, 'Knowledge fact', policy), statement: string(value.statement, 'Knowledge fact statement', KNOWLEDGE_LIMITS.statementBytes, KNOWLEDGE_LIMITS.statementBytes, true, policy === 2) };
}
function normalizeContact(value: unknown): ContactClaim {
  if (!record(value)) fail('Contact claim must be an object.');
  ownKeys(value, ['id', 'provenance', 'createdAt', 'evidence', 'suggestionId', 'outputPolicyVersion', 'address', 'label'], 'Contact claim');
  const policy = outputPolicy(value, 'Contact claim');
  const address = string(value.address, 'Contact address', KNOWLEDGE_LIMITS.addressChars, KNOWLEDGE_LIMITS.addressChars);
  if (!address.trim()) fail('Contact address is invalid.');
  return { ...normalizeBaseItem(value, 'Contact claim', policy), address, label: string(value.label, 'Contact label', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, policy === 2) };
}
function normalizeMember(value: unknown): ProjectMember {
  if (!record(value)) fail('Project member must be an object.');
  const policy = outputPolicy(value, 'Project member');
  const role = string(value.role, 'Member role', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, policy === 2);
  if (value.personId !== undefined) {
    ownKeys(value, ['id', 'provenance', 'createdAt', 'evidence', 'suggestionId', 'outputPolicyVersion', 'personId', 'role'], 'Project member');
    return { ...normalizeBaseItem(value, 'Project member', policy), personId: id(value.personId, 'Member person ID'), role };
  }
  ownKeys(value, ['id', 'provenance', 'createdAt', 'evidence', 'suggestionId', 'outputPolicyVersion', 'sourcePersonId', 'label', 'role'], 'Project member');
  return { ...normalizeBaseItem(value, 'Project member', policy), sourcePersonId: id(value.sourcePersonId, 'Source person ID'), label: string(value.label, 'Historical member label', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, policy === 2), role };
}
function normalizeChange(value: unknown, unlimited = false): KnowledgeChange {
  if (!record(value)) fail('Knowledge change must be an object.');
  const entityId = id(value.entityId, 'Knowledge change entity ID');
  if (value.type === 'add_fact') {
    ownKeys(value, ['type', 'entityKind', 'entityId', 'statement'], 'Knowledge change');
    if (value.entityKind !== 'person' && value.entityKind !== 'project') fail('Knowledge change entity kind is invalid.');
    return { type: 'add_fact', entityKind: value.entityKind, entityId, statement: string(value.statement, 'Knowledge fact statement', KNOWLEDGE_LIMITS.statementBytes, KNOWLEDGE_LIMITS.statementBytes, true, unlimited) };
  }
  if (value.type === 'add_contact') {
    ownKeys(value, ['type', 'entityKind', 'entityId', 'address', 'label'], 'Knowledge change');
    if (value.entityKind !== 'person') fail('Contact change entity kind is invalid.');
    return { type: 'add_contact', entityKind: 'person', entityId, address: string(value.address, 'Contact address', KNOWLEDGE_LIMITS.addressChars, KNOWLEDGE_LIMITS.addressChars), label: string(value.label, 'Contact label', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, unlimited) };
  }
  if (value.type === 'add_source_link') {
    ownKeys(value, ['type', 'entityKind', 'entityId', 'reference', 'referenceRevision', 'label'], 'Knowledge change');
    if (value.entityKind !== 'person' && value.entityKind !== 'project') fail('Knowledge change entity kind is invalid.');
    const reference = normalizeReference(value.reference);
    const referenceRevision = value.referenceRevision === undefined ? undefined : revision(value.referenceRevision, 'Referenced entity revision');
    if ((reference.kind === 'person' || reference.kind === 'project') !== (referenceRevision !== undefined)) fail('Entity source links require an exact referenced entity revision.');
    return { type: 'add_source_link', entityKind: value.entityKind, entityId, reference, ...(referenceRevision !== undefined ? { referenceRevision } : {}), label: string(value.label, 'Source link label', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, unlimited) };
  }
  if (value.type === 'add_member') {
    ownKeys(value, ['type', 'entityKind', 'entityId', 'personId', 'personRevision', 'role'], 'Knowledge change');
    if (value.entityKind !== 'project') fail('Member change entity kind is invalid.');
    return { type: 'add_member', entityKind: 'project', entityId, personId: id(value.personId, 'Member person ID'), personRevision: revision(value.personRevision, 'Member person revision'), role: string(value.role, 'Member role', KNOWLEDGE_LIMITS.labelChars, KNOWLEDGE_LIMITS.labelChars, false, unlimited) };
  }
  return fail('Knowledge change type is invalid.');
}
function normalizeSuggestion(value: unknown): KnowledgeSuggestion {
  if (!record(value)) fail('Knowledge suggestion must be an object.');
  ownKeys(value, ['id', 'revision', 'change', 'targetRevision', 'evidence', 'status', 'createdAt', 'updatedAt', 'reviewedAt', 'originalChange', 'originalEvidence', 'sourceNoteId', 'sourceAnalysisFingerprint', 'inputPolicyVersion', 'outputPolicyVersion', 'staleReason'], 'Knowledge suggestion');
  if (typeof value.status !== 'string' || !['pending', 'accepted', 'dismissed', 'stale'].includes(value.status)) fail('Knowledge suggestion status is invalid.');
  const hasLegacyCalendarLink = [value.change, value.originalChange].some((change) => record(change) && change.type === 'add_source_link' && record(change.reference) && change.reference.kind === 'calendar' && change.reference.calendarId === undefined);
  const status = value.status === 'pending' && hasLegacyCalendarLink ? 'stale' : value.status as KnowledgeSuggestion['status'];
  const reviewedAt = hasLegacyCalendarLink && value.status === 'pending'
    ? timestamp(value.updatedAt, 'Suggestion update time')
    : value.reviewedAt === undefined ? undefined : timestamp(value.reviewedAt, 'Suggestion review time');
  if ((status === 'pending') === (reviewedAt !== undefined)) fail('Suggestion review metadata is inconsistent with its status.');
  if (value.inputPolicyVersion !== undefined && value.inputPolicyVersion !== 1 && value.inputPolicyVersion !== 2) fail('Suggestion input policy version is invalid.');
  const policy = outputPolicy(value, 'Knowledge suggestion');
  return { id: id(value.id, 'Knowledge suggestion ID'), revision: revision(value.revision, 'Knowledge suggestion revision'), change: normalizeChange(value.change, policy === 2),
    targetRevision: revision(value.targetRevision, 'Suggestion target revision'), evidence: normalizeEvidence(value.evidence, policy === 2), status,
    createdAt: timestamp(value.createdAt, 'Suggestion creation time'), updatedAt: timestamp(value.updatedAt, 'Suggestion update time'),
    ...(reviewedAt ? { reviewedAt } : {}), ...(value.originalChange !== undefined ? { originalChange: normalizeChange(value.originalChange, policy === 2) } : {}),
    ...(value.originalEvidence !== undefined ? { originalEvidence: normalizeEvidence(value.originalEvidence, policy === 2) } : {}),
    ...(value.sourceNoteId !== undefined ? { sourceNoteId: string(value.sourceNoteId, 'Suggestion source note ID', KNOWLEDGE_LIMITS.sourceIdChars, KNOWLEDGE_LIMITS.sourceIdChars) } : {}),
    ...(value.sourceAnalysisFingerprint !== undefined ? { sourceAnalysisFingerprint: string(value.sourceAnalysisFingerprint, 'Suggestion analysis fingerprint', 256, 256) } : {}),
    ...(value.inputPolicyVersion !== undefined ? { inputPolicyVersion: value.inputPolicyVersion as 1 | 2 } : {}),
    ...(value.outputPolicyVersion !== undefined ? { outputPolicyVersion: policy } : {}),
    ...(hasLegacyCalendarLink && value.status === 'pending' ? { staleReason: 'Calendar destination could not be verified after a schema update.' }
      : value.staleReason !== undefined ? { staleReason: string(value.staleReason, 'Suggestion stale reason', KNOWLEDGE_LIMITS.statementBytes) } : {}) };
}
function normalizeEntityBase(value: Record<string, unknown>, kind: 'person' | 'project') {
  const entityId = id(value.id, `${kind} ID`);
  const narrativePath = string(value.narrativePath, `${kind} narrative path`, 80, 80);
  if (narrativePath !== `${kind === 'person' ? 'people' : 'projects'}/${entityId}.md`) fail(`${kind} narrative path must match its UUID.`);
  const aliases = list(value.aliases, KNOWLEDGE_LIMITS.aliasCount, `${kind} aliases`).map((alias) => string(alias, `${kind} alias`, KNOWLEDGE_LIMITS.aliasChars, KNOWLEDGE_LIMITS.aliasChars));
  const facts = denseList(value.facts, `${kind} facts`).map(normalizeFact);
  if (facts.filter((item) => item.outputPolicyVersion !== 2).length > KNOWLEDGE_LIMITS.factsPerEntity) fail(`${kind} legacy facts exceed the allowed item count.`);
  uniqueIds(facts, `${kind} facts`);
  const sourceLinks = denseList(value.sourceLinks, `${kind} source links`).map(normalizeLink);
  if (sourceLinks.filter((item) => item.outputPolicyVersion !== 2).length > KNOWLEDGE_LIMITS.linksPerEntity) fail(`${kind} legacy source links exceed the allowed item count.`);
  const importOrigin = value.importOrigin === undefined ? undefined : normalizeImportOrigin(value.importOrigin);
  return { id: entityId, revision: revision(value.revision, `${kind} revision`), name: string(value.name, `${kind} name`, KNOWLEDGE_LIMITS.nameChars, KNOWLEDGE_LIMITS.nameChars), aliases,
    narrativePath, createdAt: timestamp(value.createdAt, `${kind} creation time`), updatedAt: timestamp(value.updatedAt, `${kind} update time`),
    ...(value.archivedAt !== undefined ? { archivedAt: timestamp(value.archivedAt, `${kind} archive time`) } : {}),
    ...(importOrigin ? { importOrigin } : {}), facts, sourceLinks };
}

function normalizeImportOrigin(value: unknown): KnowledgeImportOrigin {
  if (!record(value)) fail('Knowledge import origin must be an object.');
  ownKeys(value, ['kind', 'archiveId', 'cohortId', 'sourceEntityId', 'sourceDigest'], 'Knowledge import origin');
  if (value.kind !== 'backup_knowledge' || typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDigest)) fail('Knowledge import origin is invalid.');
  return { kind: 'backup_knowledge', archiveId: id(value.archiveId, 'Import archive ID'), cohortId: id(value.cohortId, 'Import cohort ID'), sourceEntityId: id(value.sourceEntityId, 'Import source entity ID'), sourceDigest: value.sourceDigest };
}

export function emptyKnowledgeState(): KnowledgeState { return { schemaVersion: 1, people: [], projects: [], suggestions: [] }; }
export const createEmptyKnowledgeState = emptyKnowledgeState;

/** Strictly validates one assistant-proposed knowledge DTO. */
export function validateKnowledgeSuggestion(value: unknown): KnowledgeSuggestion { return normalizeSuggestion(value); }

/** Strictly validates persisted knowledge and returns a fresh, normalized allowlisted value. */
export function validateKnowledgeState(value: unknown): KnowledgeState {
  if (!record(value)) fail('Knowledge state must be an object.');
  ownKeys(value, ['schemaVersion', 'people', 'projects', 'suggestions'], 'Knowledge state');
  if (value.schemaVersion !== 1) fail('Knowledge schema version is not supported.');
  const people = list(value.people, KNOWLEDGE_LIMITS.people, 'People').map((row) => {
    if (!record(row)) fail('Person must be an object.');
    ownKeys(row, ['id', 'revision', 'name', 'aliases', 'narrativePath', 'createdAt', 'updatedAt', 'archivedAt', 'importOrigin', 'facts', 'sourceLinks', 'contacts'], 'Person');
    const contacts = denseList(row.contacts, 'Person contacts').map(normalizeContact);
    if (contacts.filter((item) => item.outputPolicyVersion !== 2).length > KNOWLEDGE_LIMITS.contactsPerPerson) fail('Legacy person contacts exceed the allowed item count.');
    uniqueIds(contacts, 'Person contacts');
    return { ...normalizeEntityBase(row, 'person'), contacts } as Person;
  });
  const projects = list(value.projects, KNOWLEDGE_LIMITS.projects, 'Projects').map((row) => {
    if (!record(row)) fail('Project must be an object.');
    ownKeys(row, ['id', 'revision', 'name', 'aliases', 'narrativePath', 'createdAt', 'updatedAt', 'archivedAt', 'importOrigin', 'facts', 'sourceLinks', 'status', 'goal', 'startsOn', 'targetOn', 'dateTimeZone', 'members'], 'Project');
    if (typeof row.status !== 'string' || !['planned', 'active', 'paused', 'completed'].includes(row.status)) fail('Project status is invalid.');
    const members = denseList(row.members, 'Project members').map(normalizeMember);
    if (members.filter((item) => item.outputPolicyVersion !== 2).length > KNOWLEDGE_LIMITS.membersPerProject) fail('Legacy project members exceed the allowed item count.');
    uniqueIds(members, 'Project members');
    return { ...normalizeEntityBase(row, 'project'), status: row.status as Project['status'], goal: string(row.goal, 'Project goal', KNOWLEDGE_LIMITS.goalBytes),
      ...(row.startsOn !== undefined ? { startsOn: dateOnly(row.startsOn, 'Project start date') } : {}),
      ...(row.targetOn !== undefined ? { targetOn: dateOnly(row.targetOn, 'Project target date') } : {}),
      ...(row.dateTimeZone !== undefined ? { dateTimeZone: timezone(row.dateTimeZone) } : {}), members } as Project;
  });
  uniqueIds(people, 'People'); uniqueIds(projects, 'Projects');
  const suggestions = denseList(value.suggestions, 'Knowledge suggestions').map(normalizeSuggestion);
  if (suggestions.filter((item) => item.outputPolicyVersion !== 2).length > KNOWLEDGE_LIMITS.suggestions) fail('Legacy knowledge suggestions exceed the allowed item count.');
  uniqueIds(suggestions, 'Knowledge suggestions');
  if (suggestions.filter((suggestion) => suggestion.status === 'pending' && suggestion.outputPolicyVersion !== 2).length > KNOWLEDGE_LIMITS.pendingSuggestions) fail('Legacy pending suggestions exceed the allowed item count.');
  let facts = 0; let contacts = 0; let links = 0; let members = 0;
  for (const person of people) { facts += person.facts.length; contacts += person.contacts.length; links += person.sourceLinks.length; }
  for (const project of projects) { facts += project.facts.length; links += project.sourceLinks.length; members += project.members.length; }
  const legacyFacts = [...people, ...projects].flatMap((entity) => entity.facts).filter((item) => item.outputPolicyVersion !== 2).length;
  const legacyContacts = people.flatMap((entity) => entity.contacts).filter((item) => item.outputPolicyVersion !== 2).length;
  const legacyLinks = [...people, ...projects].flatMap((entity) => entity.sourceLinks).filter((item) => item.outputPolicyVersion !== 2).length;
  const legacyMembers = projects.flatMap((entity) => entity.members).filter((item) => item.outputPolicyVersion !== 2).length;
  if (legacyFacts > KNOWLEDGE_LIMITS.globalFacts) fail('Legacy knowledge facts exceed the allowed item count.');
  if (legacyContacts > KNOWLEDGE_LIMITS.globalContacts) fail('Legacy knowledge contacts exceed the allowed item count.');
  if (legacyLinks > KNOWLEDGE_LIMITS.globalLinks) fail('Legacy knowledge source links exceed the allowed item count.');
  if (legacyMembers > KNOWLEDGE_LIMITS.globalMembers) fail('Legacy knowledge project members exceed the allowed item count.');
  const allIds = new Set([...people.map(({ id: entityId }) => entityId), ...projects.map(({ id: entityId }) => entityId)]);
  const itemIds = [...people, ...projects].flatMap((entity) => [entity.id, ...entity.facts.map(({ id: itemId }) => itemId), ...entity.sourceLinks.map(({ id: itemId }) => itemId),
    ...('contacts' in entity ? entity.contacts.map(({ id: itemId }) => itemId) : []), ...('members' in entity ? entity.members.map(({ id: itemId }) => itemId) : [])]);
  itemIds.push(...suggestions.map(({ id: itemId }) => itemId));
  if (new Set(itemIds).size !== itemIds.length) fail('Knowledge state contains duplicate item IDs.');
  for (const entity of [...people, ...projects]) for (const link of entity.sourceLinks) {
    const reference = link.reference;
    if (reference.kind === 'person' && !people.some((person) => person.id === reference.id)) fail('Knowledge source link refers to a missing person.');
    if (reference.kind === 'project' && !projects.some((project) => project.id === reference.id)) fail('Knowledge source link refers to a missing project.');
  }
  for (const project of projects) for (const member of project.members) if ('personId' in member && !people.some((person) => person.id === member.personId)) fail('Project member refers to a missing person.');
  const validateSuggestionTarget = (change: KnowledgeChange) => {
    const entityExists = change.entityKind === 'person' ? people.some((person) => person.id === change.entityId) : projects.some((project) => project.id === change.entityId);
    if (!entityExists) fail('Knowledge suggestion target does not match its entity kind.');
    if (change.type === 'add_member' && !people.some((person) => person.id === change.personId)) fail('Member suggestion refers to a missing person.');
  };
  for (const suggestion of suggestions) {
    if (!allIds.has(suggestion.change.entityId)) fail('Knowledge suggestion refers to a missing entity.');
    validateSuggestionTarget(suggestion.change);
    if (suggestion.originalChange) validateSuggestionTarget(suggestion.originalChange);
    for (const change of [suggestion.change, suggestion.originalChange]) {
      if (change?.type !== 'add_source_link') continue;
      const reference = change.reference;
      if (reference.kind !== 'person' && reference.kind !== 'project') continue;
      const related = reference.kind === 'person' ? people.find((person) => person.id === reference.id) : projects.find((project) => project.id === reference.id);
      if (!related) fail('Knowledge suggestion refers to a missing related entity.');
    }
  }
  return { schemaVersion: 1, people, projects, suggestions };
}
export const normalizeKnowledgeState = validateKnowledgeState;

export function getKnowledgeEntity(state: KnowledgeState, kind: 'person' | 'project', entityId: string): Person | Project | undefined {
  return kind === 'person' ? state.people.find((person) => person.id === entityId) : state.projects.find((project) => project.id === entityId);
}

function utf8Prefix(value: string, limit: number): { text: string; truncated: boolean } {
  let used = 0; let end = 0;
  for (const character of value) {
    const width = bytes(character);
    if (used + width > limit) return { text: value.slice(0, end), truncated: true };
    used += width; end += character.length;
  }
  return { text: value, truncated: false };
}
const provenanceText = (provenance: 'user_authored' | 'accepted_inference') => provenance === 'user_authored'
  ? 'Entered by user; not independently verified' : 'User-retained inference; unverified';

/** Derived summary with explicit provenance and honest omission markers. Policy 2 output uses only the enclosing physical-state budget. */
export function renderKnowledgeMarkdown(state: KnowledgeState, kind: 'person' | 'project', entityId: string): string {
  const entity = getKnowledgeEntity(state, kind, entityId);
  if (!entity) return '';
  const lines = [`# ${entity.name}`, '', `Revision: ${entity.revision}`];
  if (entity.importOrigin) lines.push('Import origin: imported from a backup; unverified.');
  const claimRows: { category: string; text: string }[] = [];
  if (kind === 'person') {
    const person = entity as Person;
    if (person.aliases.length) claimRows.push({ category: 'aliases', text: `Aliases: ${person.aliases.join(', ')}` });
    for (const claim of person.contacts) claimRows.push({ category: 'contacts', text: `Contact claim: ${claim.label}: ${claim.address} — ${provenanceText(claim.provenance)}` });
  } else {
    const project = entity as Project;
    if (project.aliases.length) claimRows.push({ category: 'aliases', text: `Aliases: ${project.aliases.join(', ')}` });
    claimRows.push({ category: 'project', text: `Status: ${project.status}` });
    if (project.goal) claimRows.push({ category: 'goal', text: `Goal: ${project.goal}` });
    if (project.startsOn) claimRows.push({ category: 'dates', text: `Starts: ${project.startsOn}${project.dateTimeZone ? ` (${project.dateTimeZone})` : ''}` });
    if (project.targetOn) claimRows.push({ category: 'dates', text: `Target: ${project.targetOn}${project.dateTimeZone ? ` (${project.dateTimeZone})` : ''}` });
    for (const member of project.members) {
      if (!('personId' in member)) {
        claimRows.push({ category: 'members', text: `Historical member (unavailable): ${member.role}: ${member.label} — ${provenanceText(member.provenance)}` });
        continue;
      }
      const person = state.people.find((candidate) => candidate.id === member.personId);
      if (person && !person.archivedAt) claimRows.push({ category: 'members', text: `Member: ${member.role}: ${person.name} — ${provenanceText(member.provenance)}` });
    }
  }
  for (const fact of entity.facts) claimRows.push({ category: 'facts', text: `Fact: ${fact.statement} — ${provenanceText(fact.provenance)}` });
  for (const link of entity.sourceLinks) {
    let refLabel = link.reference.kind === 'historical' ? `historical ${link.reference.originalKind}; unavailable` : `${link.reference.kind} reference`;
    if (link.reference.kind === 'person' || link.reference.kind === 'project') {
      const related = getKnowledgeEntity(state, link.reference.kind, link.reference.id);
      refLabel = related ? `${related.archivedAt ? 'archived ' : ''}${link.reference.kind} ${related.name}${related.archivedAt ? '; unavailable' : ''}` : `historical ${link.reference.kind}; unavailable`;
    }
    claimRows.push({ category: 'sources', text: `Source: ${link.label} (${refLabel}) — ${provenanceText(link.provenance)}` });
  }
  const policy2 = [...entity.facts, ...entity.sourceLinks, ...(kind === 'person' ? (entity as Person).contacts : (entity as Project).members)]
    .some((item) => item.outputPolicyVersion === 2);
  const budget = policy2 ? Number.MAX_SAFE_INTEGER : KNOWLEDGE_LIMITS.narrativeBytes;
  let rendered = lines.join('\n');
  let omitted = 0;
  for (const row of claimRows) {
    const candidate = `${rendered}\n\n${row.text}`;
    const omission = `\n\n[Omitted ${String(omitted + 1)} structured claim${omitted === 0 ? '' : 's'} from this summary; full records remain available.]`;
    if (bytes(candidate) + bytes(omission) <= budget) rendered = candidate;
    else omitted += 1;
  }
  if (omitted) {
    const marker = `\n\n[Omitted ${omitted} structured claim${omitted === 1 ? '' : 's'} from this summary; full records remain available.]`;
    rendered += marker;
  }
  if (bytes(rendered) > budget) rendered = utf8Prefix(rendered, budget).text;
  return rendered;
}

/** Active knowledge only, exposed as bounded local context inputs with stable IDs. */
export function knowledgeContextSources(
  state: KnowledgeState,
  narratives: readonly { path: string; content: string }[] = [],
  includeArchived: readonly { kind: 'person' | 'project'; id: string }[] = [],
): AssistantSourceInput[] {
  const normalized = validateKnowledgeState(state);
  const byCanonicalPath = new Map<string, string>();
  const allowedPaths = new Set([...normalized.people, ...normalized.projects].map((entity) => entity.narrativePath));
  for (const document of narratives) if (allowedPaths.has(document.path)) byCanonicalPath.set(document.path, document.content);
  const textFor = (kind: 'person' | 'project', entityId: string, path: string) => {
    const entity = getKnowledgeEntity(normalized, kind, entityId)!;
    const structured = `${entity.archivedAt ? 'Status: archived\n\n' : ''}${renderKnowledgeMarkdown(normalized, kind, entityId)}`;
    const narrative = byCanonicalPath.get(path);
    const narrativeLimit = KNOWLEDGE_LIMITS.narrativeBytes - 64;
    const boundedNarrative = narrative === undefined ? undefined : utf8Prefix(narrative, narrativeLimit);
    const narrativeText = boundedNarrative?.truncated ? `${boundedNarrative.text}\n[Narrative excerpt; full narrative remains available.]` : boundedNarrative?.text;
    return narrativeText ? `${narrativeText}\n\n---\n\n${structured}` : structured;
  };
  const sources: AssistantSourceInput[] = [];
  const archivedKeys = new Set(includeArchived.map(({ kind, id: entityId }) => `${kind}:${entityId}`));
  for (const person of normalized.people) if (!person.archivedAt || archivedKeys.has(`person:${person.id}`)) {
    const text = textFor('person', person.id, person.narrativePath);
    const links = person.sourceLinks.map((link) => link.reference.kind === 'historical' ? { kind: 'historical', label: link.label, originalKind: link.reference.originalKind } : link.reference);
    const related = person.sourceLinks.flatMap((link) => {
      if (link.reference.kind !== 'person' && link.reference.kind !== 'project') return [];
      const target = getKnowledgeEntity(normalized, link.reference.kind, link.reference.id);
      return target ? [{ kind: link.reference.kind, id: target.id, revision: target.revision, name: target.name, archivedAt: target.archivedAt ?? null }] : [];
    });
    const versionMaterial = JSON.stringify({ narrative: byCanonicalPath.get(person.narrativePath) ?? '', entity: person, links, related });
    sources.push({ id: `knowledge:person:${person.id}`, revision: person.revision, title: person.name, kind: 'knowledge', required: false, text, updatedAt: person.updatedAt, versionMaterial });
  }
  for (const project of normalized.projects) if (!project.archivedAt || archivedKeys.has(`project:${project.id}`)) {
    const text = textFor('project', project.id, project.narrativePath);
    const relationships = project.members.map((member) => 'personId' in member
      ? (() => { const person = normalized.people.find((candidate) => candidate.id === member.personId); return { role: member.role, personId: member.personId, person: person ? { id: person.id, revision: person.revision, name: person.name, archivedAt: person.archivedAt ?? null } : null }; })()
      : { role: member.role, historicalPersonId: member.sourcePersonId, label: member.label });
    const links = project.sourceLinks.map((link) => link.reference.kind === 'historical' ? { kind: 'historical', label: link.label, originalKind: link.reference.originalKind } : link.reference);
    const related = project.sourceLinks.flatMap((link) => {
      if (link.reference.kind !== 'person' && link.reference.kind !== 'project') return [];
      const target = getKnowledgeEntity(normalized, link.reference.kind, link.reference.id);
      return target ? [{ kind: link.reference.kind, id: target.id, revision: target.revision, name: target.name, archivedAt: target.archivedAt ?? null }] : [];
    });
    const versionMaterial = JSON.stringify({ narrative: byCanonicalPath.get(project.narrativePath) ?? '', entity: project, relationships, links, related });
    sources.push({ id: `knowledge:project:${project.id}`, revision: project.revision, title: project.name, kind: 'knowledge', required: false, text, updatedAt: project.updatedAt, versionMaterial });
  }
  return sources;
}
