/** Persisted, user-reviewable knowledge claims. This module contains data only. */

export interface KnowledgeEvidence {
  sourceId: string;
  sourceVersion: string;
  revision: number;
  quote: string;
}

export type KnowledgeReference =
  | { kind: 'note' | 'task' | 'document'; id: string }
  | { kind: 'person' | 'project'; id: string }
  | { kind: 'mail'; id: string; identityKey: string; connectionGeneration: number }
  | { kind: 'calendar'; id: string; calendarId: string; identityKey: string; connectionGeneration: number }
  | { kind: 'device_calendar_event'; installationId: string; generation: number; calendarId: string; eventId: string; occurrenceStart: string }
  | { kind: 'historical'; label: string; originalKind: string };

export interface KnowledgeSourceLink {
  id: string;
  provenance: 'user_authored' | 'accepted_inference';
  createdAt: string;
  evidence?: KnowledgeEvidence[];
  suggestionId?: string;
  reference: KnowledgeReference;
  label: string;
}

export interface KnowledgeFact {
  id: string;
  provenance: 'user_authored' | 'accepted_inference';
  createdAt: string;
  evidence?: KnowledgeEvidence[];
  suggestionId?: string;
  statement: string;
}

export interface ContactClaim {
  id: string;
  provenance: 'user_authored' | 'accepted_inference';
  createdAt: string;
  evidence?: KnowledgeEvidence[];
  suggestionId?: string;
  address: string;
  label: string;
}

interface ProjectMemberBase {
  id: string;
  provenance: 'user_authored' | 'accepted_inference';
  createdAt: string;
  evidence?: KnowledgeEvidence[];
  suggestionId?: string;
  role: string;
}

export type ProjectMember = ProjectMemberBase & (
  | { personId: string; sourcePersonId?: never; label?: never }
  | { sourcePersonId: string; label: string; personId?: never }
);

interface EntityBase {
  id: string;
  revision: number;
  name: string;
  aliases: string[];
  narrativePath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  importOrigin?: KnowledgeImportOrigin;
  facts: KnowledgeFact[];
  sourceLinks: KnowledgeSourceLink[];
}

export interface Person extends EntityBase {
  contacts: ContactClaim[];
}

export interface Project extends EntityBase {
  status: 'planned' | 'active' | 'paused' | 'completed';
  goal: string;
  startsOn?: string;
  targetOn?: string;
  dateTimeZone?: string;
  members: ProjectMember[];
}

export type KnowledgeEntityKind = 'person' | 'project';

export type KnowledgeChange =
  | { type: 'add_fact'; entityKind: KnowledgeEntityKind; entityId: string; statement: string }
  | { type: 'add_contact'; entityKind: 'person'; entityId: string; address: string; label: string }
  | { type: 'add_source_link'; entityKind: KnowledgeEntityKind; entityId: string; reference: KnowledgeReference; referenceRevision?: number; label: string }
  | { type: 'add_member'; entityKind: 'project'; entityId: string; personId: string; personRevision: number; role: string };

export interface KnowledgeSuggestion {
  id: string;
  revision: number;
  change: KnowledgeChange;
  targetRevision: number;
  evidence: KnowledgeEvidence[];
  status: 'pending' | 'accepted' | 'dismissed' | 'stale';
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  originalChange?: KnowledgeChange;
  originalEvidence?: KnowledgeEvidence[];
  sourceNoteId?: string;
  sourceAnalysisFingerprint?: string;
  staleReason?: string;
}

export interface KnowledgeSuggestionReview {
  readonly suggestion: KnowledgeSuggestion;
  readonly canEdit: boolean;
  readonly canAccept: boolean;
  readonly reason?: string;
}

export interface KnowledgeState {
  schemaVersion: 1;
  people: Person[];
  projects: Project[];
  suggestions: KnowledgeSuggestion[];
}

export interface KnowledgeImportOrigin {
  kind: 'backup_knowledge';
  archiveId: string;
  cohortId: string;
  sourceEntityId: string;
  sourceDigest: string;
}
