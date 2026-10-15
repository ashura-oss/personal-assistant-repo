import React, { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { CloudWorkspaceSessionState, CloudWorkspaceSessionStore } from './CloudWorkspaceSession';
import { WorkspaceClientError, WorkspaceCommandNotStartedError, type WorkspaceCommandAdmission } from './workspaceClient';
import { WorkspaceScreen, type WorkspaceTab } from '../ui/WorkspaceScreen';
import { InboxWorkspaceContent } from '../ui/InboxWorkspaceContent';
import { ManualNoteComposer, RecordWorkspaceContent, workspaceNoteCardDisplay, workspaceProposalCardDisplay } from '../ui/WorkspaceContent';
import { LibraryScreen } from '../ui/LibraryScreen';
import { projectKnowledgeDisplay } from '../ui/libraryDisplay';
import { safeChatMemoryEvidenceLabels } from '../ui/chatMemoryReview';
import { WorkspaceSettingsScreen } from '../ui/WorkspaceSettingsSnapshot';
import { ChatSection } from '../ui/ChatSection';
import { AssistantBatchJobCard } from '../ui/AssistantBatchJobCard';
import { projectChatKnowledgeChoices } from '../ui/workspaceChatDisplayTypes';
import { ChatSubmissionNotStartedError, type ChatSendAttempt, type ChatSendInspectionResult } from '../ui/chatSubmission';
import { Button } from '../ui/primitives';
import { C, s } from '../ui/theme';

export type CloudWorkspaceActions = Readonly<{
  tasks: Readonly<{ complete: (taskId: string) => Promise<WorkspaceCommandResponse>; reopen: (taskId: string) => Promise<WorkspaceCommandResponse> }>;
  notes: Readonly<{ save: (transcript: string) => Promise<WorkspaceCommandResponse>; updateTranscript: (noteId: string, text: string, expectedNoteRevision: number) => Promise<WorkspaceCommandResponse>; submitAssistance: (noteId: string, question: string) => Promise<WorkspaceCommandResponse> }>;
  chat: Readonly<{ create: () => Promise<WorkspaceCommandResponse>; submit: (attempt: ChatSendAttempt) => Promise<WorkspaceCommandResponse>; refine: (conversationId: string, parentTurnId: string, effort: 'medium' | 'high' | 'max') => Promise<WorkspaceCommandResponse>; inspect: (commandId: string) => Promise<WorkspaceCommandResponse> }>;
  batch: Readonly<{ check: (jobId: string) => Promise<WorkspaceCommandResponse> }>;
}>;

function receiptFor(response: WorkspaceCommandResponse, kind: WorkspaceCommand['kind']) {
  if (response.status !== 'finished' || response.receipt?.kind !== kind || response.receipt.commandId !== response.commandId) return undefined;
  return response.receipt;
}

function errText(error: unknown) {
  return error instanceof WorkspaceClientError || error instanceof WorkspaceCommandNotStartedError ? error.message : 'The workspace action could not be confirmed.';
}

export function CloudWorkspace({ store, state, onLogout }: { store: Pick<CloudWorkspaceSessionStore, 'getSnapshot' | 'execute' | 'inspect' | 'refresh'>; state: CloudWorkspaceSessionState; onLogout: () => void }) {
  const snapshot = state.snapshot!;
  const dto = snapshot.state;
  const [tab, setTab] = useState<WorkspaceTab>('inbox');
  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [manualOpen, setManualOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inboxSection, setInboxSection] = useState<'inbox' | 'activity' | 'history'>('inbox');
  const [proposalFilter, setProposalFilter] = useState<'pending' | 'done'>('pending');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [notice, setNotice] = useState<string>();
  const originalChatAttempts = useRef(new Map<number, Readonly<{ attempt: ChatSendAttempt; envelope: WorkspaceCommandAdmission; text: string; conversationId: string; ownerGeneration: number; knowledgeSelection: ChatSendAttempt['knowledgeSelection'] }>>());
  const selectedNote = dto.notes.find((note) => note.id === selectedNoteId);
  const libraryNotes = useMemo(() => dto.notes.filter((note) => note.origin !== 'assistant_chat' &&
    `${note.title} ${note.transcript}`.toLocaleLowerCase().includes(libraryQuery.toLocaleLowerCase())), [dto.notes, libraryQuery]);
  const conversations = dto.assistantChatConversations;
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId);
  const knowledgeChoices = useMemo(() => projectChatKnowledgeChoices(dto.knowledge), [dto.knowledge]);
  const actions: CloudWorkspaceActions = {
    tasks: {
      complete: (taskId) => store.execute({ kind: 'tasks.complete', taskId }),
      reopen: (taskId) => store.execute({ kind: 'tasks.reopen', taskId }),
    },
    notes: {
      save: (transcript) => store.execute({ kind: 'notes.save', transcript }),
      updateTranscript: (noteId, text, expectedNoteRevision) => store.execute({ kind: 'notes.updateTranscript', noteId, text, expectedNoteRevision }),
      submitAssistance: (noteId, question) => store.execute({ kind: 'assistant.batch.submitNote', noteId, intent: question.trim() ? 'answer' : 'assist', ...(question.trim() ? { question: question.trim() } : {}) }),
    },
    chat: {
      create: () => store.execute({ kind: 'chat.create' }),
      submit: (attempt) => store.execute(
        { kind: 'chat.submit', conversationId: attempt.conversationId, text: attempt.text,
          ...(attempt.knowledgeSelection.length ? { knowledgeSelection: attempt.knowledgeSelection.map(({ kind, id }) => ({ kind, id })) } : {}) },
        (envelope) => { originalChatAttempts.current.set(attempt.attemptId, Object.freeze({ attempt, envelope, text: attempt.text, conversationId: attempt.conversationId, ownerGeneration: attempt.ownerGeneration,
          knowledgeSelection: Object.freeze(attempt.knowledgeSelection.map((binding) => Object.freeze({ ...binding }))) })); },
      ),
      refine: (conversationId, parentTurnId, effort) => store.execute({ kind: 'chat.refine', conversationId, parentTurnId, effort }),
      inspect: (commandId) => store.inspect(commandId),
    },
    batch: { check: (jobId) => store.execute({ kind: 'assistant.batch.check', jobId }) },
  };

  const createConversation = async () => {
    setNotice(undefined);
    try {
      const response = await actions.chat.create();
      const receipt = receiptFor(response, 'chat.create');
      const latest = response.snapshot ?? store.getSnapshot().snapshot;
      if (!receipt || !latest?.state.assistantChatConversations.some((item) => item.id === receipt.objectId)) {
        setNotice('The conversation request was accepted or is still being checked. Refresh the workspace before opening it.');
        return;
      }
      setSelectedConversationId(receipt.objectId);
      setNotice(undefined);
    } catch (error) { setNotice(errText(error)); }
  };

  const sendAttempt = async (attempt: ChatSendAttempt) => {
    const current = store.getSnapshot();
    const currentSnapshot = current.snapshot;
    if (!currentSnapshot || current.refreshRequired || current.pendingCommand || current.busy) throw new ChatSubmissionNotStartedError('Refresh the workspace and review the original message before sending.');
    const currentChoices = new Map(projectChatKnowledgeChoices(currentSnapshot.state.knowledge).filter((choice) => !choice.archivedAt).map((choice) => [`${choice.kind}:${choice.id}`, choice.revision] as const));
    if (attempt.knowledgeSelection.some((binding) => currentChoices.get(`${binding.kind}:${binding.id}`) !== binding.revision)) {
      throw new ChatSubmissionNotStartedError('A selected person or project changed. Review the current context before sending.');
    }
    try {
      const response = await actions.chat.submit(attempt);
      const receipt = receiptFor(response, 'chat.submit');
      if (!receipt || receipt.objectId !== attempt.conversationId || !('turnId' in receipt) || !('jobId' in receipt)) throw new Error('The exact chat receipt is not finished yet.');
      originalChatAttempts.current.delete(attempt.attemptId);
      return { kind: 'accepted' as const, conversationId: receipt.objectId, turnId: receipt.turnId, jobId: receipt.jobId };
    } catch (error) {
      if (error instanceof WorkspaceCommandNotStartedError) {
        throw new ChatSubmissionNotStartedError(error.message);
      }
      throw error;
    }
  };

  const inspectAttempt = async (attempt: ChatSendAttempt): Promise<ChatSendInspectionResult> => {
    const original = originalChatAttempts.current.get(attempt.attemptId);
    if (!original || original.attempt !== attempt || original.ownerGeneration !== attempt.ownerGeneration || original.text !== attempt.text || original.conversationId !== attempt.conversationId || original.envelope.command.kind !== 'chat.submit' ||
        original.knowledgeSelection.length !== attempt.knowledgeSelection.length || original.knowledgeSelection.some((binding, index) => {
          const current = attempt.knowledgeSelection[index];
          return !current || current.kind !== binding.kind || current.id !== binding.id || current.revision !== binding.revision;
        })) return { kind: 'unresolved' };
    try {
      const response = await actions.chat.inspect(original.envelope.commandId);
      const receipt = receiptFor(response, 'chat.submit');
      if (!receipt || receipt.commandId !== original.envelope.commandId || receipt.objectId !== original.conversationId || !('turnId' in receipt) || !('jobId' in receipt)) return { kind: 'unresolved' };
      originalChatAttempts.current.delete(attempt.attemptId);
      return { kind: 'accepted', submission: { kind: 'accepted', conversationId: receipt.objectId, turnId: receipt.turnId, jobId: receipt.jobId } };
    } catch { return { kind: 'unresolved' }; }
  };

  const saveManualNote = async (text: string) => {
    const transcript = text.trim();
    if (!transcript || state.busy || state.refreshRequired) return;
    setNotice(undefined);
    try {
      const response = await actions.notes.save(transcript);
      const receipt = receiptFor(response, 'notes.save');
      if (receipt) {
        setManualOpen(false);
        setSelectedNoteId(receipt.objectId);
        setNoteDraft(transcript);
        setDraft('');
        setNotice('Note saved.');
      } else setNotice('The note request is still being checked. Refresh the workspace to see its result.');
    } catch (error) { setNotice(errText(error)); }
  };

  const updateNote = async () => {
    if (!selectedNote || state.busy || noteDraft === selectedNote.transcript) return;
    try {
      const response = await actions.notes.updateTranscript(selectedNote.id, noteDraft, selectedNote.revision);
      setNotice(receiptFor(response, 'notes.updateTranscript') ? 'Note updated.' : 'The update is still being checked. Refresh the workspace to see its result.');
    } catch (error) { setNotice(errText(error)); }
  };

  const submitNoteAssistance = async () => {
    if (!selectedNote || state.busy) return;
    try {
      const response = await actions.notes.submitAssistance(selectedNote.id, draft);
      setNotice(receiptFor(response, 'assistant.batch.submitNote') ? 'Request queued. Check Batch history when you choose.' : 'The request is still being checked. Refresh the workspace to see its result.');
    } catch (error) { setNotice(errText(error)); }
  };

  const refresh = async () => { await store.refresh(); };

  const inspectPendingCommand = async () => {
    const pending = store.getSnapshot().pendingCommand;
    if (!pending || state.busy) return;
    setNotice(undefined);
    try {
      const response = await store.inspect(pending.commandId);
      const receipt = response.receipt;
      if (response.commandId !== pending.commandId || response.status !== 'finished' || !receipt ||
          receipt.commandId !== pending.commandId || receipt.kind !== pending.kind) {
        setNotice(`The exact ${pending.kind} command has no confirmed receipt yet. No request was resent.`);
        return;
      }
      setNotice(pending.kind === 'chat.submit'
        ? 'The exact chat receipt is confirmed. Open Chat to inspect the original message and context; no request was resent.'
        : `The exact ${pending.kind} receipt is confirmed. No request was resent.${response.snapshot ? '' : ' Refresh the workspace to load its current state.'}`);
    } catch (error) { setNotice(`Could not confirm the exact ${pending.kind} receipt. No request was resent. ${errText(error)}`); }
  };

  return (
    <WorkspaceScreen
      model={{ activeTab: tab, busy: state.busy, tabBarVisible: true, tabNavigationLocked: Boolean(state.pendingCommand), snapshot, notice }}
      actions={{ navigation: { selectTab: setTab }, settings: { open: () => setSettingsOpen(true) }, session: { logout: onLogout } }}
    >
      {notice || state.refreshRequired ? (
        <View style={s.notice}>
          <Text style={s.noticeText} accessibilityRole="alert">{notice ?? state.error ?? 'The latest command is recorded, but workspace data must be refreshed.'}</Text>
          {state.pendingCommand ? <Button label={`Inspect exact ${state.pendingCommand.kind} command`} tone="quiet" disabled={state.busy} onPress={() => void inspectPendingCommand()} /> : null}
          {state.refreshRequired ? <Button label="Refresh workspace" tone="quiet" disabled={state.busy} onPress={() => void refresh()} /> : null}
        </View>
      ) : null}
      {state.pendingCommand && !notice && !state.refreshRequired ? (
        <View style={s.notice}>
          <Text style={s.noticeText} accessibilityRole="alert">A {state.pendingCommand.kind} command is awaiting its exact receipt. It will not be sent again automatically.</Text>
          <Button label={`Inspect exact ${state.pendingCommand.kind} command`} tone="quiet" disabled={state.busy} onPress={() => void inspectPendingCommand()} />
        </View>
      ) : null}
      {settingsOpen ? <WorkspaceSettingsScreen
        display={dto}
        actions={{
          preferences: { available: false, reason: 'Preference edits are unavailable until the server exposes a settings command.' },
          accounts: { available: false, reason: 'Account setup and credential changes are unavailable until matching server actions are available.' },
          calendars: { available: false, reason: 'Calendar setup and device calendar actions are unavailable in this browser workspace.' },
          connections: { available: false, reason: 'Connection setup, sync, and mail actions are unavailable until matching server actions are available.' },
          recovery: { available: false, reason: 'Recovery actions must be performed by the workspace owner.' },
        }}
        busy={state.busy || state.refreshRequired} onClose={() => setSettingsOpen(false)}
      /> : tab === 'chat' ? (
        <ChatSection
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          turns={selectedConversation?.turns ?? []}
          busy={state.busy}
          enabled={!state.pendingCommand && !state.refreshRequired}
          disabledReason={state.refreshRequired ? 'Refresh the workspace before sending a message.' : 'Chat is unavailable until the workspace is ready.'}
          recoveryMessage={state.pendingCommand ? 'Check the exact pending command before sending another request.' : undefined}
          knowledgeChoices={knowledgeChoices}
          onSelectConversation={setSelectedConversationId}
          onCreateConversation={() => void createConversation()}
          onSendAttempt={sendAttempt}
          onInspectUnconfirmedSend={inspectAttempt}
          onCheckJob={async (jobId) => { await actions.batch.check(jobId); }}
          onRefineTurn={async ({ conversationId, parentTurnId, effort }) => {
            const response = await actions.chat.refine(conversationId, parentTurnId, effort);
            if (!receiptFor(response, 'chat.refine')) throw new Error('Refinement status is not confirmed.');
            return response;
          }}
        />
      ) : tab === 'record' ? (
        manualOpen ? <ManualNoteComposer storageDescription="Saved to your server workspace. Nothing is transcribed or processed until you choose." onCancel={() => setManualOpen(false)} onSave={(text) => void saveManualNote(text)} />
          : <RecordWorkspaceContent
            audio={{ status: 'idle', canResume: false, durationSeconds: 0, meter: [], hasPending: false, statusLabel: 'Browser audio capture is not connected.' }}
            recording={{ available: false, reason: 'Browser audio capture is not connected to the server workspace.' }}
            recovery={{ available: false, reason: 'Pending native recording recovery is unavailable in this browser workspace.' }}
            busy={state.busy || state.refreshRequired}
            recent={dto.notes.slice(0, 3).map((note) => workspaceNoteCardDisplay({ ...note, recordingAvailable: note.audio?.available === true }))}
            onOpenNote={(id) => { setSelectedNoteId(id); const note = dto.notes.find((item) => item.id === id); if (note) setNoteDraft(note.transcript); setTab('library'); }}
            onSeeAll={() => { setTab('library'); }}
            onWrite={() => setManualOpen(true)}
            storageHint="Your note is saved to this server workspace before any optional processing."
          />
      ) : tab === 'library' ? (
        <>
          <LibraryScreen
            notes={libraryNotes.map((note) => workspaceNoteCardDisplay({ ...note, recordingAvailable: note.audio?.available === true }))}
            query={libraryQuery} setQuery={setLibraryQuery} docs={dto.documents} tasks={dto.tasks}
            busy={state.busy || state.refreshRequired}
            archiveActions={{
              importedKnowledge: { available: false, reason: 'Imported knowledge activation is not connected to server commands yet.' },
              documents: { available: false, reason: 'Imported document activation is not connected to server commands yet.' },
              backupImport: { available: false, reason: 'Backup import is not connected to server commands yet.' },
              importedChat: { available: false, reason: 'Imported conversation deletion is not connected to server commands yet.' },
            }}
            importedBackups={dto.importedBackups} archiveActionsBlocked={state.refreshRequired}
            knowledge={projectKnowledgeDisplay(dto.knowledge)} references={[]}
            evidenceLabels={{}} chatEvidenceLabels={safeChatMemoryEvidenceLabels(dto.assistantChatConversations)}
            memoryReviewBlocked={true}
            previewMode={false} sampleBackupMode={false} knowledgeDemoMode={false}
            reminderRecords={dto.reminders.records} reminderAlerts={{}} reminderDemoMode={false}
            reminderAlertChannel="browser_unavailable"
            reminderActions={{ available: false, reason: 'Reminder creation and management are not connected to server commands yet.' }}
            onComplete={{ available: true, action: (id) => { void actions.tasks.complete(id).catch((error) => setNotice(errText(error))); } }}
            onReopen={{ available: true, action: (id) => { void actions.tasks.reopen(id).catch((error) => setNotice(errText(error))); } }}
            onOpenNote={(id, expectedRevision) => {
              const note = dto.notes.find((item) => item.id === id && item.revision === expectedRevision);
              if (!note) return;
              setSelectedNoteId(id); setNoteDraft(note.transcript); setDraft('');
            }}
            documentActions={{ available: false, reason: 'Document editing is not connected to server commands yet.' }}
            knowledgeEntityActions={{ available: false, reason: 'People and project editing are not connected to server commands yet.' }}
            knowledgeSuggestionActions={{ available: false, reason: 'Knowledge suggestion review is not connected to server commands yet.' }}
            onExport={{ available: false, reason: 'Workspace export is not connected to the browser workspace yet.' }}
          />
          {selectedNote ? <View style={styles.detail}>
            <Text style={s.sectionTitle}>Note</Text>
            <TextInput multiline value={noteDraft} onChangeText={setNoteDraft} style={styles.editor} accessibilityLabel="Edit note text" />
            <View style={styles.actions}><Button label="Save changes" disabled={state.busy || noteDraft === selectedNote.transcript || state.refreshRequired} onPress={() => void updateNote()} /><Button label="Ask about this note" tone="quiet" disabled={state.busy || state.refreshRequired} onPress={() => void submitNoteAssistance()} /></View>
            <Text style={styles.meta}>Audio playback and export are not connected in this browser workspace.</Text>
            {selectedNote.analysis ? <View style={styles.card}><Text style={styles.cardTitle}>Saved analysis</Text><Text style={styles.body}>{selectedNote.analysis.summary}</Text>{selectedNote.analysis.answer ? <Text style={styles.body}>{selectedNote.analysis.answer}</Text> : null}</View> : null}
          </View> : null}
        </>
      ) : (
        <ScrollView contentContainerStyle={s.scroll}>
          <SectionPicker values={['inbox', 'activity', 'history']} selected={inboxSection} onSelect={setInboxSection} />
          {inboxSection === 'inbox' ? <>
            <InboxWorkspaceContent proposals={dto.proposals.filter((proposal) => proposalFilter === 'pending'
              ? ['draft', 'approved', 'dispatching', 'failed'].includes(proposal.status)
              : ['accepted', 'executed', 'dismissed', 'simulated', 'unknown'].includes(proposal.status)).map(workspaceProposalCardDisplay)}
              accounts={dto.accounts} mailbox={dto.mailbox} proactive={dto.proactive} deviceCalendarAccess={dto.deviceCalendarAccess.status}
              filter={proposalFilter} setFilter={setProposalFilter} mode={dto.settings.mode} busy={state.busy || state.refreshRequired}
              onOpen={{ available: false, reason: 'Proposal review actions are not connected to the server workspace yet.' }}
              onReplyMessage={{ available: false, reason: 'Mail reply actions are not connected to the server workspace yet.' }}
              onDismissCandidate={{ available: false, reason: 'Attention item actions are not connected to the server workspace yet.' }}
              onSnoozeCandidate={{ available: false, reason: 'Attention item actions are not connected to the server workspace yet.' }}
              onRemindCandidate={{ available: false, reason: 'Reminder actions are not connected to the server workspace yet.' }}
              onGetCandidateSource={{ available: false, reason: 'Source rechecks are not connected to the server workspace yet.' }}
              onClearChatFilter={() => setNotice(undefined)} />
            <Text style={s.sectionTitle}>Batch history</Text>
            {dto.assistantBatchJobs.map((job) => <AssistantBatchJobCard key={job.id} job={job} busy={state.busy} blocked={state.refreshRequired} onCheck={(id) => actions.batch.check(id)} />)}
          </> : null}
          {inboxSection === 'activity' ? <>
            <Text style={s.sectionTitle}>Activity</Text>
            {dto.activity.map((item) => <View key={item.id} style={styles.card}><Text style={styles.cardTitle}>{item.message}</Text><Text style={styles.meta}>{item.type} · {new Date(item.createdAt).toLocaleString()}</Text></View>)}
          </> : null}
          {inboxSection === 'history' ? <>
            <Text style={s.sectionTitle}>Dispatch history</Text>
            <Text style={styles.meta}>Frozen payloads and outcomes are shown for review. Reconciliation actions are unavailable in this browser workspace.</Text>
            {dto.dispatchRecords.map((record) => <View key={record.id} style={styles.card}><Text style={styles.cardTitle}>{record.title}</Text><Text style={styles.body}>{record.body}</Text><Text style={styles.meta}>{record.operation} · {record.outcome} · {record.dispatchStartedAt}</Text><Text style={styles.meta}>Approved payload digest · {record.payloadDigest}</Text>{record.payload.kind === 'email' ? <><Text style={styles.meta}>To · {record.payload.email.to.join(', ')}</Text>{record.payload.email.cc.length ? <Text style={styles.meta}>Cc · {record.payload.email.cc.join(', ')}</Text> : null}{record.payload.email.bcc.length ? <Text style={styles.meta}>Bcc · {record.payload.email.bcc.join(', ')}</Text> : null}<Text style={styles.body}>{record.payload.email.text}</Text></> : <Text style={styles.meta}>{record.payload.event.start} – {record.payload.event.end} · {record.payload.event.timeZone}</Text>}</View>)}
          </> : null}
        </ScrollView>
      )}
    </WorkspaceScreen>
  );
}

const styles = {
  editor: { minHeight: 132, borderWidth: 1, borderColor: C.border, borderRadius: 14, backgroundColor: C.card, color: C.text, padding: 14, textAlignVertical: 'top' as const },
  card: { gap: 7, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '600' as const },
  body: { color: C.text, fontSize: 14, lineHeight: 21 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 16 },
  detail: { gap: 10, marginTop: 18, padding: 14, borderWidth: 1, borderColor: C.border, borderRadius: 18, backgroundColor: '#101113' },
  actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8 },
  sectionPicker: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 7, marginBottom: 12 },
  sectionChip: { borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 11 },
  sectionChipSelected: { borderColor: C.sage, backgroundColor: C.card },
  sectionChipText: { color: C.muted, fontSize: 12 },
  sectionChipTextSelected: { color: C.text },
};

function SectionPicker<T extends string>({ values, selected, onSelect }: { values: readonly T[]; selected: T; onSelect: (value: T) => void }) {
  return <View style={styles.sectionPicker} accessibilityRole="tablist">{values.map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: value === selected }} onPress={() => onSelect(value)} style={[styles.sectionChip, value === selected && styles.sectionChipSelected]}><Text style={[styles.sectionChipText, value === selected && styles.sectionChipTextSelected]}>{value[0]!.toUpperCase()}{value.slice(1)}</Text></Pressable>)}</View>;
}
