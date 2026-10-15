import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { AppController, ContextDocument, LocalTask, SaveKnowledgeFactInput, SaveKnowledgeContactInput, SaveKnowledgeSourceLinkInput, SaveKnowledgeMemberInput, KnowledgeItemCommand, ReviewKnowledgeSuggestionInput } from "../core";
import type { KnowledgeEntityKind, KnowledgeSuggestionReview } from "../knowledge/types";
import { BackupImportSheet } from "./BackupImportSheet";
import { ImportedBackupsSection } from "./ImportedBackupsSection";
import { KnowledgeSection } from "./KnowledgeSection";
import { KnowledgeEntitySheet } from "./KnowledgeEntitySheet";
import type { KnowledgeEntityEditCommand, KnowledgeProjectEditCommand } from "./KnowledgeEntitySheet";
import type { ImportedKnowledgePreviewDisplay, ImportedKnowledgeSelection, KnowledgeDisplay, KnowledgeSourceChoiceDisplay, KnowledgeSuggestionDisplay, KnowledgeSuggestionEditCommand } from "./knowledgeDisplayTypes";
import { KnowledgeSuggestionSheet } from "./KnowledgeSuggestionSheet";
import { ImportedKnowledgeReview } from "./ImportedKnowledgeReview";
import { ImportedKnowledgeActivationOwnership, attachImportedKnowledgePreviewForRuntime, importedKnowledgeOwnerMatchesRuntime, importedKnowledgeSelectionMatches, type ImportedKnowledgeActivationPort } from "./importedKnowledgeActivationOwnership";
import { RemindersSection } from "./RemindersSection";
import { TasksSection } from "./TasksSection";
import { IconButton, Button } from "./primitives";
import { WorkspaceNoteCard, type WorkspaceNoteCardDisplay } from "./WorkspaceContent";
import { C, s } from "./theme";
import type { PickedBackupFile } from "../backupFiles";
import { friendlyDocumentName, newDocumentPath, projectImportedKnowledgeArchives, projectKnowledgeSuggestionDisplay, projectImportedKnowledgePreview } from './libraryDisplay';
import type { ReminderAlertChannel, ReminderAlertDisplay, ReminderDisplayRecord } from './reminderDisplay';
import type { WorkspaceSnapshotDTO, DeepReadonly } from '../cloud/workspaceDto';
import type { WorkspaceActionCapability } from './workspaceCapabilities';

export type LibraryArchiveActionPorts = Readonly<{
  importedKnowledge: WorkspaceActionCapability<ImportedKnowledgeActivationPort>;
  documents: WorkspaceActionCapability<Pick<AppController, 'activateImportedDocument'>>;
  backupImport: WorkspaceActionCapability<Readonly<{ controller: Pick<AppController, 'prepareBackupImport' | 'applyBackupImport'>; chooseBackup: () => Promise<PickedBackupFile | null> }>>;
  importedChat: WorkspaceActionCapability<Pick<AppController, 'deleteImportedChatConversation'>>;
}>;
type LibraryReminderActions = Readonly<{
  create: () => void; open: (id: string, expectedRevision: number) => void;
  retry: (id: string, expectedRevision: number) => Promise<unknown>;
  done: (id: string, expectedRevision: number) => Promise<unknown>;
  cancel: (id: string, expectedRevision: number) => Promise<unknown>;
  delete: (id: string, expectedRevision: number) => Promise<unknown>;
}>;
type LibraryKnowledgeEntityActions = Readonly<{
  archive: (kind: KnowledgeEntityKind, id: string, revision: number, archived: boolean) => void;
  savePerson: (input: KnowledgeEntityEditCommand) => Promise<unknown>;
  saveProject: (input: KnowledgeProjectEditCommand) => Promise<unknown>;
  saveFact: (input: SaveKnowledgeFactInput) => Promise<unknown>;
  removeFact: (input: KnowledgeItemCommand) => Promise<unknown>;
  saveContact: (input: SaveKnowledgeContactInput) => Promise<unknown>;
  removeContact: (input: KnowledgeItemCommand & { entityKind: 'person' }) => Promise<unknown>;
  saveSourceLink: (input: Omit<SaveKnowledgeSourceLinkInput, 'reference'> & { referenceChoiceId?: string }) => Promise<unknown>;
  removeSourceLink: (input: KnowledgeItemCommand) => Promise<unknown>;
  saveMember: (input: SaveKnowledgeMemberInput) => Promise<unknown>;
  removeMember: (input: KnowledgeItemCommand & { entityKind: 'project' }) => Promise<unknown>;
}>;
type LibraryKnowledgeSuggestionActions = Readonly<{
  review: (id: string, input: ReviewKnowledgeSuggestionInput) => Promise<unknown>;
  edit: (id: string, input: KnowledgeSuggestionEditCommand) => Promise<KnowledgeSuggestionDisplay | undefined>;
  prepare: (id: string, input: { expectedRevision: number }) => Promise<KnowledgeSuggestionReview>;
}>;
export function LibraryScreen({
  notes,
  query,
  setQuery,
  docs,
  tasks,
  busy,
  archiveActions,
  importedBackups,
  archiveActionsBlocked,
  knowledge,
  knowledgeRecoveryStatus,
  references,
  evidenceLabels,
  chatEvidenceLabels,
  memoryReviewBlocked,
  memoryReviewRequest,
  onMemoryReviewRequestHandled,
  previewMode,
  sampleBackupMode,
  knowledgeDemoMode,
  reminderRecords,
  reminderAlerts,
  reminderRecoveryStatus,
  reminderDemoMode,
  reminderAlertChannel,
  reminderActions,
  onComplete,
  onReopen,
  onOpenNote,
  documentActions,
  knowledgeEntityActions,
  knowledgeSuggestionActions,
  onExport,
  onRun,
}: {
  notes: readonly WorkspaceNoteCardDisplay[];
  query: string;
  setQuery: (v: string) => void;
  docs: readonly DeepReadonly<ContextDocument>[];
  tasks: readonly DeepReadonly<LocalTask>[];
  busy: boolean;
  archiveActions: LibraryArchiveActionPorts;
  importedBackups: WorkspaceSnapshotDTO['state']['importedBackups'];
  archiveActionsBlocked: boolean;
  knowledge: KnowledgeDisplay;
  knowledgeRecoveryStatus?: Readonly<{ message: string }>;
  references: readonly KnowledgeSourceChoiceDisplay[];
  evidenceLabels: Record<string, string>;
  chatEvidenceLabels: Record<string, string>;
  memoryReviewBlocked: boolean;
  memoryReviewRequest?: { suggestionId: string; requestId: number };
  onMemoryReviewRequestHandled?: (requestId: number) => void;
  previewMode: boolean;
  sampleBackupMode: boolean;
  knowledgeDemoMode: boolean;
  reminderRecords: readonly ReminderDisplayRecord[];
  reminderAlerts: Readonly<Record<string, ReminderAlertDisplay>>;
  reminderRecoveryStatus?: Readonly<{ message: string }>;
  reminderDemoMode: boolean;
  reminderAlertChannel: ReminderAlertChannel;
  reminderActions: WorkspaceActionCapability<LibraryReminderActions>;
  onComplete: WorkspaceActionCapability<(id: string) => void>;
  onReopen: WorkspaceActionCapability<(id: string) => void>;
  onOpenNote: (id: string, expectedRevision: number) => void;
  documentActions: WorkspaceActionCapability<(d: { path: string; content: string }) => void>;
  knowledgeEntityActions: WorkspaceActionCapability<LibraryKnowledgeEntityActions>;
  knowledgeSuggestionActions: WorkspaceActionCapability<LibraryKnowledgeSuggestionActions>;
  onExport: WorkspaceActionCapability<() => void>;
  onRun?: <T>(action: () => Promise<T>) => Promise<T | undefined>;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const importedOwnershipRef = useRef(new ImportedKnowledgeActivationOwnership());
  const importedSelectionRef = useRef<ImportedKnowledgeSelection | null>(null);
  const importedKnowledgePort = archiveActions.importedKnowledge.available ? archiveActions.importedKnowledge.action : undefined;
  const backupImportPort = archiveActions.backupImport.available ? archiveActions.backupImport.action : undefined;
  const importedChatPort = archiveActions.importedChat.available ? archiveActions.importedChat.action : undefined;
  const importedRuntimeRef = useRef({ controller: importedKnowledgePort, blocked: memoryReviewBlocked || archiveActionsBlocked, importedBackups });
  importedRuntimeRef.current = { controller: importedKnowledgePort, blocked: memoryReviewBlocked || archiveActionsBlocked, importedBackups };
  const [importedReviewState, setImportedReviewState] = useState<{ selection: ImportedKnowledgeSelection | null; preview: ImportedKnowledgePreviewDisplay | null; preparing: boolean; applying: boolean; message: string }>({
    selection: null, preview: null, preparing: false, applying: false, message: '',
  });
  const invalidateImportedReview = useCallback((clearSelection = true) => {
    importedOwnershipRef.current.invalidate();
    if (clearSelection) importedSelectionRef.current = null;
    setImportedReviewState({ selection: clearSelection ? null : importedSelectionRef.current, preview: null, preparing: false, applying: false, message: '' });
  }, []);
  const cancelImportedReview = useCallback(() => invalidateImportedReview(), [invalidateImportedReview]);
  const onImportedSelectionChange = useCallback((selection: ImportedKnowledgeSelection | null) => {
    importedSelectionRef.current = selection;
    invalidateImportedReview(false);
    setImportedReviewState({ selection, preview: null, preparing: false, applying: false, message: '' });
  }, [invalidateImportedReview]);
  const prepareImportedKnowledge = useCallback(async (selection: ImportedKnowledgeSelection) => {
    const runtime = importedRuntimeRef.current;
    if (busy || runtime.blocked || !runtime.controller || runtime.controller !== importedKnowledgePort || !importedKnowledgeSelectionMatches(importedSelectionRef.current, selection)) return;
    const archive = runtime.importedBackups.find((item) => item.id === selection.archiveId);
    const cohort = archive?.archivedKnowledge?.find((item) => item.id === selection.cohortId);
    const source = selection.kind === 'person'
      ? cohort?.knowledge.state.people.find((item) => item.id === selection.entityId)
      : cohort?.knowledge.state.projects.find((item) => item.id === selection.entityId);
    if (!source) return;
    const claim = importedOwnershipRef.current.claimPrepare(selection, runtime.controller);
    if (!claim) return;
    const { owner } = claim;
    setImportedReviewState({ selection, preview: null, preparing: true, applying: false, message: '' });
    try {
      if (!onRun) return;
      const prepared = await onRun(() => owner.controller.prepareImportedKnowledgeActivation({ archiveId: selection.archiveId, cohortId: selection.cohortId, kind: selection.kind, entityId: selection.entityId }));
      if (!prepared) return;
      const currentRuntime = importedRuntimeRef.current;
      if (!attachImportedKnowledgePreviewForRuntime(importedOwnershipRef.current, owner, selection, prepared, currentRuntime, importedSelectionRef.current)) return;
      setImportedReviewState({ selection, preview: projectImportedKnowledgePreview(prepared), preparing: false, applying: false, message: '' });
    } catch (error) {
      const currentRuntime = importedRuntimeRef.current;
      if (importedKnowledgeOwnerMatchesRuntime(importedOwnershipRef.current, owner, selection, currentRuntime) && importedKnowledgeSelectionMatches(importedSelectionRef.current, selection)) {
        setImportedReviewState({ selection, preview: null, preparing: false, applying: false, message: error instanceof Error ? error.message : 'Could not prepare this imported copy. Try again.' });
      }
    } finally {
      importedOwnershipRef.current.release(claim);
      if (importedOwnershipRef.current.current() === owner) setImportedReviewState((current) => current.selection && importedKnowledgeSelectionMatches(current.selection, selection)
        ? { ...current, preparing: false } : current);
    }
  }, [busy, importedKnowledgePort, onRun]);
  const activateImportedKnowledge = useCallback(async (selection: ImportedKnowledgeSelection, confirmed: true) => {
    const runtime = importedRuntimeRef.current;
    if (!confirmed || busy || runtime.blocked || !runtime.controller || runtime.controller !== importedKnowledgePort || !importedKnowledgeSelectionMatches(importedSelectionRef.current, selection)) return;
    const claim = importedOwnershipRef.current.claimActivation(selection, runtime.controller);
    if (!claim) return;
    const { owner, credentials } = claim;
    setImportedReviewState((current) => ({ ...current, applying: true, message: '' }));
    try {
      if (!onRun) return;
      const result = await onRun(() => owner.controller.activateImportedKnowledgeEntity(credentials));
      const currentRuntime = importedRuntimeRef.current;
      if (!importedKnowledgeOwnerMatchesRuntime(importedOwnershipRef.current, owner, selection, currentRuntime) || !importedKnowledgeSelectionMatches(importedSelectionRef.current, selection)) return;
      if (result) {
        owner.sessionId = undefined;
        setImportedReviewState((current) => current.preview ? { ...current, preview: { ...current.preview, alreadyActivated: true }, applying: false,
          message: `Added ${result.entity.name} as a separate ${selection.kind}.` } : { ...current, applying: false });
      } else setImportedReviewState((current) => ({ ...current, applying: false }));
    } catch (error) {
      const currentRuntime = importedRuntimeRef.current;
      if (importedKnowledgeOwnerMatchesRuntime(importedOwnershipRef.current, owner, selection, currentRuntime) && importedKnowledgeSelectionMatches(importedSelectionRef.current, selection)) {
        setImportedReviewState((current) => ({ ...current, applying: false, message: error instanceof Error ? error.message : 'Could not activate this imported copy.' }));
      }
    } finally {
      importedOwnershipRef.current.release(claim);
      const currentRuntime = importedRuntimeRef.current;
      if (importedKnowledgeOwnerMatchesRuntime(importedOwnershipRef.current, owner, selection, currentRuntime) && importedKnowledgeSelectionMatches(importedSelectionRef.current, selection)) {
        setImportedReviewState((current) => ({ ...current, applying: false }));
      }
    }
  }, [busy, importedKnowledgePort, onRun]);
  useEffect(() => {
    if (memoryReviewBlocked || archiveActionsBlocked) invalidateImportedReview();
  }, [archiveActionsBlocked, memoryReviewBlocked, invalidateImportedReview]);
  useEffect(() => {
    invalidateImportedReview();
  }, [importedKnowledgePort, importedBackups, invalidateImportedReview]);
  useEffect(() => () => {
    importedOwnershipRef.current.invalidate();
  }, []);
  const [section, setSection] = useState<'notes' | 'people' | 'projects' | 'memory' | 'reminders'>(() =>
    memoryReviewRequest ? 'memory' : reminderDemoMode ? 'reminders' : knowledgeDemoMode ? 'memory' : 'notes');
  const [entityKind, setEntityKind] = useState<'person' | 'project'>('person');
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const [editorInstance, setEditorInstance] = useState(0);
  const [entitySheetOpen, setEntitySheetOpen] = useState(false);
  const structuredNarrativePaths = new Set([
    ...knowledge.people.map((entity) => entity.narrativePath),
    ...knowledge.projects.map((entity) => entity.narrativePath),
  ]);
  const libraryDocuments = docs.filter((document) => !structuredNarrativePaths.has(document.path));
  const editingEntity = entityKind === 'person'
    ? knowledge.people.find((entity) => entity.id === editingEntityId)
    : knowledge.projects.find((entity) => entity.id === editingEntityId);
  return (
    <ScrollView
      contentContainerStyle={s.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.kicker}>LIBRARY</Text>
      <Text style={s.h1}>Your own archive.</Text>
      <Text style={s.intro}>
        Voice notes, transcripts, and documents saved in this workspace.
      </Text>
      <View style={s.search}>
        <Ionicons
          accessible={false}
          name="search-outline"
          size={18}
          color={C.muted}
        />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search your library"
          placeholderTextColor={C.muted}
          style={s.searchInput}
          accessibilityLabel="Search library"
        />
      </View>
      <View style={s.librarySegments} accessibilityRole="tablist">
        {([['notes', 'Notes'], ['people', 'People'], ['projects', 'Projects'], ['memory', 'Memory'], ['reminders', 'Reminders']] as const).map(([key, label]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityLabel={`${label} library section`} accessibilityState={{ selected: section === key }} onPress={() => setSection(key)} style={[s.librarySegment, section === key && s.librarySegmentActive]}>
            <Text style={[s.librarySegmentText, section === key && s.librarySegmentTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {reminderRecoveryStatus ? <View style={s.analysisStale}><Text style={s.analysisText}>{reminderRecoveryStatus.message}</Text></View> : null}
      {section === 'reminders' ? <RemindersSection
        records={reminderRecords}
        alertDisplays={reminderAlerts}
        query={query}
        busy={busy}
        alertChannel={reminderAlertChannel}
        demoMode={reminderDemoMode}
        actions={reminderActions}
      /> : null}
      {section === 'notes' ? <>
      <TasksSection
        tasks={tasks}
        busy={busy}
        onComplete={onComplete}
        onReopen={onReopen}
      />
      <Text style={s.sectionTitle}>Notes</Text>
      {notes.length ? (
        notes.map((n) => (
          <WorkspaceNoteCard key={n.id} note={n} onPress={() => onOpenNote(n.id, n.revision)} />
        ))
      ) : (
        <Text style={s.emptyText}>No matching notes.</Text>
      )}
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Documents</Text>
        <IconButton
          name="add"
          label="Create personal document"
            onPress={() => {
              if (documentActions.available) documentActions.action({ path: newDocumentPath(docs), content: "" });
            }}
            disabled={!documentActions.available}
        />
      </View>
      {libraryDocuments.length ? (
        libraryDocuments.map((d) => {
          const title = friendlyDocumentName(d.path);
          return (
            <Pressable
              key={d.path}
              accessibilityRole="button"
              accessibilityLabel={`Open document ${title}`}
              onPress={() => { if (documentActions.available) documentActions.action(d); }}
              disabled={!documentActions.available}
              style={s.documentRow}
            >
              <Ionicons
                accessible={false}
                importantForAccessibility="no"
                name="document-text-outline"
                size={18}
                color={C.muted}
              />
              <Text style={s.documentTitle}>{title}</Text>
              <Ionicons
                accessible={false}
                importantForAccessibility="no"
                name="chevron-forward"
                size={16}
                color={C.muted}
              />
            </Pressable>
          );
        })
      ) : (
          <Text style={s.emptyText}>
          No personal documents yet. Add notes or rules here.
        </Text>
      )}
      {!documentActions.available ? <Text style={s.noteSub}>{documentActions.reason}</Text> : null}
      <View style={{ height: 10 }} />
      <Button
        label="Import a backup"
        tone="quiet"
        icon="cloud-download-outline"
        disabled={busy || (previewMode && !sampleBackupMode) || !archiveActions.backupImport.available}
        onPress={() => {
          if (previewMode && !sampleBackupMode || !archiveActions.backupImport.available) return;
          setImportOpen(true);
        }}
      />
      {!archiveActions.backupImport.available ? <Text style={s.noteSub}>{archiveActions.backupImport.reason}</Text> : null}
      <ImportedBackupsSection
        archives={importedBackups}
        currentDocuments={docs}
        onActivateDocument={archiveActions.documents}
        busy={busy}
        archiveActionsBlocked={archiveActionsBlocked}
        query={query}
        onDeleteImportedChatConversation={importedChatPort && onRun ? async (archiveId, conversationId) => {
          const runAction = onRun;
          const removed = await runAction(async () => {
            await importedChatPort.deleteImportedChatConversation({ archiveId, conversationId });
            return true;
          });
          return removed === true;
        } : undefined}
      />
      <View style={{ height: 10 }} />
      <Button
        label={sampleBackupMode ? "Export sample backup" : previewMode ? "Export unavailable in sample mode" : "Export local data"}
        tone="quiet"
        icon="download-outline"
        disabled={previewMode && !sampleBackupMode || busy || !onExport.available}
        onPress={() => { if (onExport.available) onExport.action(); }}
      />
      {!onExport.available ? <Text style={s.noteSub}>{onExport.reason}</Text> : null}
      <Text style={s.disclaimer}>
        JSON exports include notes, tasks, Markdown documents, People and
        Projects, imported knowledge archives, and read-only action history.
        Accounts, credentials, active approvals, and recordings are not included.
        Imported knowledge stays archived until you activate a separate copy.
        Protect exported files as private data.
      </Text>
      {sampleBackupMode ? (
        <Text style={s.disclaimer}>
          Sample preview uses in-memory data. OAuth, provider keys, microphone capture, and external requests are disabled.
        </Text>
      ) : null}
      </> : section === 'people' || section === 'projects' ? (
        <KnowledgeSection
          kind={section === 'people' ? 'person' : 'project'}
          people={knowledge.people}
          projects={knowledge.projects}
          query={query}
          busy={busy}
          actions={knowledgeEntityActions.available ? { available: true, action: {
            create: (kind) => { setEntityKind(kind); setEditingEntityId(null); setEditorInstance((value) => value + 1); setEntitySheetOpen(true); },
            open: (entity) => { setEntityKind(section === 'people' ? 'person' : 'project'); setEditingEntityId(entity.id); setEditorInstance((value) => value + 1); setEntitySheetOpen(true); },
            archive: knowledgeEntityActions.action.archive,
          } } : knowledgeEntityActions}
        />
      ) : section === 'memory' ? (
        <>
          {knowledgeRecoveryStatus ? <View style={s.analysisStale}><Text style={s.analysisText}>{knowledgeRecoveryStatus.message}</Text></View> : null}
          {knowledgeSuggestionActions.available ? <KnowledgeSuggestionSheet
            suggestions={knowledge.suggestions}
            people={knowledge.people}
            projects={knowledge.projects}
            sourceLabels={{ ...evidenceLabels, ...chatEvidenceLabels }}
            busy={busy}
            blocked={memoryReviewBlocked}
            openRequest={memoryReviewRequest}
            onRequestHandled={onMemoryReviewRequestHandled}
            onPrepareReview={async (id, input) => {
              const review = await knowledgeSuggestionActions.action.prepare(id, input);
              return { suggestion: projectKnowledgeSuggestionDisplay(review.suggestion), canEdit: review.canEdit, canAccept: review.canAccept, ...(review.reason ? { reason: review.reason } : {}) };
            }}
            onReview={knowledgeSuggestionActions.action.review}
            onEdit={knowledgeSuggestionActions.action.edit}
          /> : <View style={{ gap: 9 }}>
            <Text style={s.sectionTitle}>Suggestions</Text>
            <Text style={s.noteSub}>{knowledgeSuggestionActions.reason}</Text>
            {knowledge.suggestions.map((item) => <Text key={item.id} style={s.accountSub}>{item.status} · {item.change.type.replaceAll('_', ' ')}</Text>)}
          </View>}
          <ImportedKnowledgeReview
            archives={projectImportedKnowledgeArchives(importedBackups)}
            busy={busy}
            blocked={archiveActionsBlocked || memoryReviewBlocked}
            preparing={importedReviewState.preparing}
            applying={importedReviewState.applying}
            preview={importedReviewState.preview}
            message={importedReviewState.message}
            canActivate={Boolean(importedReviewState.selection && importedOwnershipRef.current.current()?.preview && importedOwnershipRef.current.current()?.sessionId && importedOwnershipRef.current.current()?.planHash &&
              importedKnowledgeSelectionMatches(importedReviewState.selection, importedOwnershipRef.current.current()?.selection) && importedKnowledgeSelectionMatches(importedSelectionRef.current, importedOwnershipRef.current.current()?.selection) &&
              importedOwnershipRef.current.current()?.controller === importedKnowledgePort && !importedOwnershipRef.current.current()?.preview?.alreadyActivated && !busy && !memoryReviewBlocked && !archiveActionsBlocked && Boolean(importedKnowledgePort))}
            onSelectionChange={onImportedSelectionChange}
            onPrepare={(selection) => { void prepareImportedKnowledge(selection); }}
            onActivate={(selection, confirmed) => { void activateImportedKnowledge(selection, confirmed); }}
            onCancel={cancelImportedReview}
          />
        </>
      ) : null}
      {backupImportPort ? <BackupImportSheet
        visible={importOpen}
        controller={backupImportPort.controller}
        busy={busy}
        sampleMode={sampleBackupMode}
        chooseBackup={backupImportPort.chooseBackup}
        onClose={() => setImportOpen(false)}
      /> : null}
      {knowledgeEntityActions.available ? <KnowledgeEntitySheet
        key={editorInstance}
        visible={entitySheetOpen}
        kind={entityKind}
        entity={editingEntity}
        people={knowledge.people}
        documents={docs}
        references={references}
        busy={busy}
        onClose={() => { setEntitySheetOpen(false); setEditingEntityId(null); }}
        onSavePerson={knowledgeEntityActions.action.savePerson}
        onSaveProject={knowledgeEntityActions.action.saveProject}
        onSaveFact={knowledgeEntityActions.action.saveFact}
        onRemoveFact={knowledgeEntityActions.action.removeFact}
        onSaveContact={knowledgeEntityActions.action.saveContact}
        onRemoveContact={knowledgeEntityActions.action.removeContact}
        onSaveSourceLink={knowledgeEntityActions.action.saveSourceLink}
        onRemoveSourceLink={knowledgeEntityActions.action.removeSourceLink}
        onSaveMember={knowledgeEntityActions.action.saveMember}
        onRemoveMember={knowledgeEntityActions.action.removeMember}
      /> : null}
    </ScrollView>
  );
}
