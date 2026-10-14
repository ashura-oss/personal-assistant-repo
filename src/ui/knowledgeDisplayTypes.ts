import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';

type WorkspaceKnowledge = WorkspaceSnapshotDTO['state']['knowledge'];
type WorkspacePerson = WorkspaceKnowledge['people'][number];
type WorkspaceProject = WorkspaceKnowledge['projects'][number];
type KnowledgeImportOriginDisplay = Readonly<{ kind: 'backup_knowledge' }>;
export type KnowledgeReferenceDisplay = Exclude<WorkspacePerson['sourceLinks'][number]['reference'], { readonly kind: 'device_calendar_event' }>;
export type KnowledgeFactDisplay = Pick<WorkspacePerson['facts'][number], 'id' | 'provenance' | 'statement'>;
export type KnowledgeContactDisplay = Pick<WorkspacePerson['contacts'][number], 'id' | 'provenance' | 'address' | 'label'>;
export type KnowledgeSourceLinkDisplay = Pick<WorkspacePerson['sourceLinks'][number], 'id' | 'provenance' | 'label'> & Readonly<{ reference: KnowledgeReferenceDisplay }>;
type KnowledgeEntityCommonDisplay = Pick<WorkspacePerson, 'id' | 'revision' | 'name' | 'aliases' | 'narrativePath' | 'createdAt' | 'updatedAt' | 'archivedAt'> & Readonly<{
  importOrigin?: KnowledgeImportOriginDisplay;
  facts: readonly KnowledgeFactDisplay[];
  sourceLinks: readonly KnowledgeSourceLinkDisplay[];
}>;
export type KnowledgePersonDisplay = KnowledgeEntityCommonDisplay & Readonly<{ contacts: readonly KnowledgeContactDisplay[] }>;
export type KnowledgeProjectDisplay = Omit<KnowledgeEntityCommonDisplay, 'id' | 'revision' | 'name' | 'aliases' | 'narrativePath' | 'createdAt' | 'updatedAt' | 'archivedAt'> &
  Pick<WorkspaceProject, 'id' | 'revision' | 'name' | 'aliases' | 'narrativePath' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'status' | 'goal' | 'startsOn' | 'targetOn' | 'dateTimeZone' | 'members'>;
export type KnowledgeEntityDisplay = KnowledgePersonDisplay | KnowledgeProjectDisplay;
type WorkspaceKnowledgeChange = WorkspaceKnowledge['suggestions'][number]['change'];
export type KnowledgeChangeDisplay =
  | Extract<WorkspaceKnowledgeChange, { type: 'add_fact' }>
  | Extract<WorkspaceKnowledgeChange, { type: 'add_contact' }>
  | Extract<WorkspaceKnowledgeChange, { type: 'add_member' }>
  | (Omit<Extract<WorkspaceKnowledgeChange, { type: 'add_source_link' }>, 'reference'> & Readonly<{ reference: KnowledgeReferenceDisplay }>);
type WorkspaceKnowledgeSuggestion = WorkspaceKnowledge['suggestions'][number];
export type KnowledgeSuggestionDisplay = Pick<WorkspaceKnowledgeSuggestion, 'id' | 'revision' | 'targetRevision' | 'evidence' | 'status' | 'createdAt' | 'updatedAt' | 'originalEvidence' | 'staleReason'> & Readonly<{
  change: KnowledgeChangeDisplay;
  originalChange?: KnowledgeChangeDisplay;
}>;
export type KnowledgeSuggestionReviewDisplay = Readonly<{ suggestion: KnowledgeSuggestionDisplay; canEdit: boolean; canAccept: boolean; reason?: string }>;
export type KnowledgeSuggestionReviewCommand = Readonly<{ expectedRevision: number; decision: 'accept' | 'dismiss'; targetRevision?: number; memberPersonRevision?: number }>;
export type KnowledgeSuggestionEditCommand = Readonly<{ expectedRevision: number; change: KnowledgeChangeDisplay; evidence: readonly WorkspaceKnowledgeSuggestion['evidence'][number][] }>;
export type KnowledgeDisplay = Readonly<{
  people: readonly KnowledgePersonDisplay[];
  projects: readonly KnowledgeProjectDisplay[];
  suggestions: readonly KnowledgeSuggestionDisplay[];
}>;
export type KnowledgeSourceChoiceDisplay = Readonly<{ id: string; reference: KnowledgeReferenceDisplay; label: string }>;
type ImportedArchive = WorkspaceSnapshotDTO['state']['importedBackups'][number];
type ImportedCohort = NonNullable<ImportedArchive['archivedKnowledge']>[number];
export type ImportedKnowledgeCohortDisplay = Pick<ImportedCohort, 'id' | 'sourceId'> & Readonly<{
  knowledge: Pick<ImportedCohort['knowledge'], 'narratives'> & Readonly<{ state: KnowledgeDisplay }>;
  activatedEntities: readonly Readonly<{ entityKind: 'person' | 'project'; sourceEntityId: string }>[];
}>;
export type ImportedArchiveDisplay = Pick<ImportedArchive, 'id' | 'sourceFormat' | 'importedAt' | 'noteLinks' | 'taskLinks' | 'documents'> & Readonly<{
  archivedKnowledge?: readonly ImportedKnowledgeCohortDisplay[];
}>;
export type ImportedKnowledgeSelection = Readonly<{ archiveId: string; cohortId: string; kind: 'person' | 'project'; entityId: string }>;
export type ImportedKnowledgePreviewDisplay = Readonly<{
  archiveId: string;
  cohortId: string;
  kind: 'person' | 'project';
  sourceEntityId: string;
  sourceName: string;
  sourceEntity: KnowledgeEntityDisplay;
  alreadyActivated: boolean;
  narrativeContent: string;
  factCount: number;
  contactCount: number;
  sourceLinkCount: number;
  memberCount: number;
  unavailableProviderReferenceCount: number;
  unresolvedMemberCount: number;
}>;
