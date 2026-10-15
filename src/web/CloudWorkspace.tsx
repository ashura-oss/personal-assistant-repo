import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { WorkspaceCommand, WorkspaceCommandResponse, WorkspaceSettingsPatch } from '../cloud/workspaceCommands';
import type { WorkspaceSettingsDTO } from '../cloud/workspaceDto';
import type { CloudWorkspaceSessionState, CloudWorkspaceSessionStore, CloudWorkspaceVoiceActions } from './CloudWorkspaceSession';
import { WorkspaceClientError, WorkspaceCommandNotStartedError, type WorkspaceCommandAdmission } from './workspaceClient';
import { WorkspaceScreen, type WorkspaceTab } from '../ui/WorkspaceScreen';
import { InboxWorkspaceContent } from '../ui/InboxWorkspaceContent';
import { ManualNoteComposer, RecordWorkspaceContent, workspaceNoteCardDisplay, workspaceProposalCardDisplay } from '../ui/WorkspaceContent';
import { LibraryScreen } from '../ui/LibraryScreen';
import { projectKnowledgeDisplay } from '../ui/libraryDisplay';
import { safeChatMemoryEvidenceLabels } from '../ui/chatMemoryReview';
import { WorkspaceSettingsScreen } from '../ui/WorkspaceSettingsSnapshot';
import type { WorkspaceSettingsCredentialCapability } from '../ui/WorkspaceSettingsSnapshot';
import { noteDetailDisplayNote } from '../ui/NoteDetail';
import { WorkspaceModals } from '../ui/WorkspaceModals';
import type { ServerRecordingPresentation } from '../ui/ServerRecordingPanel';
import type { WorkspaceRecordDisplay } from '../ui/WorkspaceContent';
import type { WorkspaceSettingsDraft } from '../ui/WorkspaceSettingsPreferences';
import { ChatSection } from '../ui/ChatSection';
import { AssistantBatchJobCard } from '../ui/AssistantBatchJobCard';
import { projectChatKnowledgeChoices } from '../ui/workspaceChatDisplayTypes';
import { ChatSubmissionNotStartedError, type ChatSendAttempt, type ChatSendInspectionResult } from '../ui/chatSubmission';
import { Button } from '../ui/primitives';
import { C, s } from '../ui/theme';
import { useCloudAudioPlayback } from './useCloudAudioPlayback';
import type { CloudVoiceCoordinatorState } from './cloudVoiceCoordinator';
import type { CloudCredentialController } from './useCloudCredentials';

export type CloudWorkspaceActions = Readonly<{
  tasks: Readonly<{ complete: (taskId: string) => Promise<WorkspaceCommandResponse>; reopen: (taskId: string) => Promise<WorkspaceCommandResponse> }>;
  notes: Readonly<{ save: (transcript: string) => Promise<WorkspaceCommandResponse>; updateTranscript: (noteId: string, text: string, expectedNoteRevision: number) => Promise<WorkspaceCommandResponse>; submitAssistance: (noteId: string, options: { intent: 'assist' | 'summarize' | 'answer' | 'extract'; question?: string; knowledgeSelection?: readonly { kind: 'person' | 'project'; id: string }[] }) => Promise<WorkspaceCommandResponse>; transcribe: (noteId: string, expectedNoteRevision: number, onAdmitted: (envelope: WorkspaceCommandAdmission) => void) => Promise<WorkspaceCommandResponse> }>;
  chat: Readonly<{ create: () => Promise<WorkspaceCommandResponse>; submit: (attempt: ChatSendAttempt) => Promise<WorkspaceCommandResponse>; refine: (conversationId: string, parentTurnId: string, effort: 'medium' | 'high' | 'max') => Promise<WorkspaceCommandResponse>; inspect: (commandId: string) => Promise<WorkspaceCommandResponse> }>;
  batch: Readonly<{ check: (jobId: string) => Promise<WorkspaceCommandResponse> }>;
}>;

export type CloudWorkspaceVoiceCapability = Readonly<{
  available: true;
  capture: WorkspaceRecordDisplay & Readonly<{ error?: string }>;
  voice: CloudVoiceCoordinatorState;
  actions: CloudWorkspaceVoiceActions;
  cancelTranscription: (commandId: string) => Promise<'cancellation_requested' | 'not_running'>;
}> | Readonly<{ available: false; reason: string }>;

function validatedAudioMediaId(value: string | undefined) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

function receiptFor(response: WorkspaceCommandResponse, kind: WorkspaceCommand['kind']) {
  if (response.status !== 'finished' || response.receipt?.kind !== kind || response.receipt.commandId !== response.commandId) return undefined;
  return response.receipt;
}

function errText(error: unknown) {
  return error instanceof WorkspaceClientError || error instanceof WorkspaceCommandNotStartedError ? error.message : 'The workspace action could not be confirmed.';
}

type WorkspaceSettingsBaseline = Readonly<{
  mode: WorkspaceSettingsDTO['mode'];
  llmProvider: WorkspaceSettingsDTO['llmProvider'];
  speechEnabled: boolean;
  speechProvider: NonNullable<WorkspaceSettingsDTO['speechProvider']>;
  speechEndpoint: string;
  effort: NonNullable<WorkspaceSettingsDTO['openRouterReasoningEffort']>;
  maxAudioSeconds: number;
  retention: WorkspaceSettingsDTO['audioRetention'];
}>;

function projectSettingsBaseline(settings: WorkspaceSettingsDTO): WorkspaceSettingsBaseline {
  return {
    mode: settings.mode,
    llmProvider: settings.llmProvider,
    speechEnabled: settings.speechEnabled === true,
    speechProvider: settings.speechProvider ?? 'azure',
    speechEndpoint: settings.speechEndpoint ?? '',
    effort: settings.openRouterReasoningEffort ?? 'low',
    maxAudioSeconds: settings.maxAudioSeconds,
    retention: settings.audioRetention,
  };
}

function settingsDraftFrom(settings: WorkspaceSettingsDTO): WorkspaceSettingsDraft {
  const baseline = projectSettingsBaseline(settings);
  return {
    providerEnabled: baseline.mode === 'provider',
    speechEnabled: baseline.speechEnabled,
    speechProvider: baseline.speechProvider,
    speechEndpoint: baseline.speechEndpoint,
    effort: baseline.effort,
    maxAudioSeconds: String(baseline.maxAudioSeconds),
    retention: baseline.retention,
  };
}

function equalSettingsBaseline(left: WorkspaceSettingsBaseline, right: WorkspaceSettingsBaseline) {
  return left.mode === right.mode && left.llmProvider === right.llmProvider && left.speechEnabled === right.speechEnabled &&
    left.speechProvider === right.speechProvider && left.speechEndpoint === right.speechEndpoint && left.effort === right.effort &&
    left.maxAudioSeconds === right.maxAudioSeconds && left.retention === right.retention;
}

export function CloudWorkspace({ store, state, onLogout, voiceCapability, credentials }: { store: Pick<CloudWorkspaceSessionStore, 'getSnapshot' | 'execute' | 'inspect' | 'refresh'>; state: CloudWorkspaceSessionState; onLogout: () => void; voiceCapability?: CloudWorkspaceVoiceCapability; credentials?: CloudCredentialController }) {
  const snapshot = state.snapshot!;
  const dto = snapshot.state;
  const [tab, setTab] = useState<WorkspaceTab>('inbox');
  const [, setDraft] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [manualOpen, setManualOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<WorkspaceSettingsDraft>();
  const [settingsBaseline, setSettingsBaseline] = useState<WorkspaceSettingsBaseline>();
  const [settingsDraftOwner, setSettingsDraftOwner] = useState<string>();
  const [settingsFormMessage, setSettingsFormMessage] = useState<string>();
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNeedsReload, setSettingsNeedsReload] = useState(false);
  const settingsFormGeneration = useRef(0);
  const settingsOperationLock = useRef<object | undefined>(undefined);
  const [inboxSection, setInboxSection] = useState<'inbox' | 'activity' | 'history'>('inbox');
  const [proposalFilter, setProposalFilter] = useState<'pending' | 'done'>('pending');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [notice, setNotice] = useState<string>();
  const [voiceActionBusy, setVoiceActionBusy] = useState(false);
  const voiceActionLock = useRef<object | undefined>(undefined);
  const [cancelingTranscriptionCommandId, setCancelingTranscriptionCommandId] = useState<string>();
  const transcriptionCancelLock = useRef<object | undefined>(undefined);
  const [admittedTranscription, setAdmittedTranscription] = useState<Readonly<{ commandId: string; owner: string }>>();
  const originalChatAttempts = useRef(new Map<number, Readonly<{ attempt: ChatSendAttempt; envelope: WorkspaceCommandAdmission; text: string; conversationId: string; ownerGeneration: number; knowledgeSelection: ChatSendAttempt['knowledgeSelection'] }>>());
  const selectedNote = dto.notes.find((note) => note.id === selectedNoteId);
  const selectedNoteOwner = useRef<string | undefined>(undefined);
  const selectedNoteOwnerKey = selectedNote ? `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${selectedNote.id}:${selectedNote.revision}` : undefined;
  useLayoutEffect(() => { selectedNoteOwner.current = selectedNoteOwnerKey; }, [selectedNoteOwnerKey]);
  const selectedMediaId = selectedNote ? validatedAudioMediaId(selectedNote.audio?.mediaId) : undefined;
  const playbackVisible = tab === 'library' && !settingsOpen && Boolean(selectedNote);
  const audioPlayback = useCloudAudioPlayback({
    ownerKey: `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${selectedNote?.id ?? 'hidden'}:${selectedNote?.revision ?? 0}`,
    mediaId: playbackVisible ? selectedMediaId : undefined,
  });
  const voiceOwner = `${snapshot.workspaceId}:${snapshot.privacyEpoch}`;
  const voiceError = (error: unknown) => {
    const latest = store.getSnapshot().snapshot;
    if (latest && `${latest.workspaceId}:${latest.privacyEpoch}` === voiceOwner) setNotice(errText(error));
  };
  const runVoiceAction = (operation: () => unknown) => {
    if (voiceActionLock.current) return;
    const latest = store.getSnapshot().snapshot;
    if (!latest || `${latest.workspaceId}:${latest.privacyEpoch}` !== voiceOwner) return;
    const token = {};
    voiceActionLock.current = token;
    setVoiceActionBusy(true);
    try {
      void Promise.resolve().then(operation).catch(voiceError).finally(() => {
        if (voiceActionLock.current === token) {
          voiceActionLock.current = undefined;
          setVoiceActionBusy(false);
        }
      });
    } catch (error) {
      if (voiceActionLock.current === token) {
        voiceActionLock.current = undefined;
        setVoiceActionBusy(false);
      }
      voiceError(error);
    }
  };
  const runTranscriptionCancellation = (commandId: string) => {
    const binding = admittedTranscription;
    const current = store.getSnapshot();
    const currentSnapshot = current.snapshot;
    const exactPending = current.pendingCommand?.commandId === commandId && current.pendingCommand.kind === 'notes.transcribe';
    const noteOwner = selectedNote ? `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${selectedNote.id}:${selectedNote.revision}` : undefined;
    if (!voiceCapability?.available || !binding || binding.commandId !== commandId || binding.owner !== noteOwner ||
        !currentSnapshot || `${currentSnapshot.workspaceId}:${currentSnapshot.privacyEpoch}` !== voiceOwner || !exactPending || transcriptionCancelLock.current) return;
    const token = {};
    transcriptionCancelLock.current = token;
    setCancelingTranscriptionCommandId(commandId);
    void voiceCapability.cancelTranscription(commandId).then((result) => {
      const latest = store.getSnapshot();
      if (selectedNoteOwner.current !== binding.owner || latest.pendingCommand?.commandId !== commandId) return;
      setNotice(result === 'cancellation_requested'
        ? 'Cancellation was requested for this transcription. The final command receipt is still pending.'
        : 'The transcription service reports that this command is not running. Its final command receipt is still being checked.');
    }).catch((error) => {
      const latest = store.getSnapshot();
      if (selectedNoteOwner.current === binding.owner && latest.pendingCommand?.commandId === commandId) voiceError(error);
    }).finally(() => {
      if (transcriptionCancelLock.current === token) {
        transcriptionCancelLock.current = undefined;
        setCancelingTranscriptionCommandId(undefined);
      }
    });
  };
  const pendingTranscriptionCancellation = selectedNote && state.pendingCommand?.kind === 'notes.transcribe' &&
    admittedTranscription?.commandId === state.pendingCommand.commandId &&
    admittedTranscription.owner === (selectedNote ? `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${selectedNote.id}:${selectedNote.revision}` : undefined)
      ? { commandId: state.pendingCommand.commandId, busy: cancelingTranscriptionCommandId === state.pendingCommand.commandId, onCancel: runTranscriptionCancellation }
      : undefined;
  const serverRecording: ServerRecordingPresentation | undefined = voiceCapability?.available ? {
    voice: voiceCapability.voice,
    actions: voiceCapability.actions,
    busy: voiceActionBusy,
    ...(voiceCapability.capture.error ? { captureError: voiceCapability.capture.error } : {}),
    openNoteAvailable: Boolean(voiceCapability.voice.noteId && dto.notes.some((note) => note.id === voiceCapability.voice.noteId)),
    onOpenNote: (noteId) => {
      const current = store.getSnapshot();
      const note = current.snapshot?.state.notes.find((item) => item.id === noteId);
      if (!note || !current.snapshot || current.snapshot.workspaceId !== snapshot.workspaceId || current.snapshot.privacyEpoch !== snapshot.privacyEpoch) return;
      setSelectedNoteId(note.id);
      setTab('library');
    },
    onError: voiceError,
  } : undefined;
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
      submitAssistance: (noteId, options) => store.execute({ kind: 'assistant.batch.submitNote', noteId, intent: options.intent, ...(options.question?.trim() ? { question: options.question.trim() } : {}), ...(options.knowledgeSelection?.length ? { knowledgeSelection: options.knowledgeSelection } : {}) }),
      transcribe: (noteId, expectedNoteRevision, onAdmitted) => store.execute({ kind: 'notes.transcribe', noteId, expectedNoteRevision }, onAdmitted),
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

  const settingsOwnerKey = (workspaceSnapshot: NonNullable<CloudWorkspaceSessionState['snapshot']>) => `${workspaceSnapshot.workspaceId}:${workspaceSnapshot.privacyEpoch}`;
  const openSettings = () => {
    const current = store.getSnapshot().snapshot ?? snapshot;
    settingsFormGeneration.current += 1;
    setSettingsDraft(settingsDraftFrom(current.state.settings));
    setSettingsBaseline(projectSettingsBaseline(current.state.settings));
    setSettingsDraftOwner(settingsOwnerKey(current));
    setSettingsFormMessage(undefined);
    setSettingsSaving(Boolean(settingsOperationLock.current));
    setSettingsNeedsReload(false);
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    settingsFormGeneration.current += 1;
    setSettingsOpen(false);
  };
  const reloadSettings = async () => {
    if (settingsOperationLock.current) {
      setSettingsFormMessage('Wait for the current settings operation to finish.');
      return;
    }
    const token = {};
    settingsOperationLock.current = token;
    const generation = ++settingsFormGeneration.current;
    const ownerAtStart = settingsOwnerKey(store.getSnapshot().snapshot ?? snapshot);
    setSettingsSaving(true);
    setSettingsFormMessage(undefined);
    try {
      const refreshed = await store.refresh();
      if (generation !== settingsFormGeneration.current) return;
      if (!refreshed) {
        setSettingsFormMessage('Saved settings could not be loaded. Your current draft is still here.');
        return;
      }
      const latest = store.getSnapshot().snapshot;
      if (!ownerAtStart || !latest || settingsOwnerKey(refreshed) !== ownerAtStart || settingsOwnerKey(latest) !== ownerAtStart) {
        setSettingsFormMessage('The workspace changed while settings were reloading. Reload again from the current workspace.');
        return;
      }
      setSettingsDraft(settingsDraftFrom(refreshed.state.settings));
      setSettingsBaseline(projectSettingsBaseline(refreshed.state.settings));
      setSettingsDraftOwner(settingsOwnerKey(refreshed));
      setSettingsNeedsReload(false);
      setSettingsFormMessage('Loaded the saved workspace settings.');
    } catch (error) {
      const latestOwner = store.getSnapshot().snapshot;
      if (generation === settingsFormGeneration.current && latestOwner && settingsOwnerKey(latestOwner) === ownerAtStart) {
        setSettingsFormMessage(errText(error));
      }
    } finally {
      if (settingsOperationLock.current === token) {
        settingsOperationLock.current = undefined;
        setSettingsSaving(false);
      }
    }
  };
  const latestSettingsState = store.getSnapshot();
  const latestSettingsSnapshot = latestSettingsState.snapshot ?? snapshot;
  const latestSettingsOwner = settingsOwnerKey(latestSettingsSnapshot);
  const currentSettingsBaseline = projectSettingsBaseline(latestSettingsSnapshot.state.settings);
  const settingsConflict = Boolean(settingsOpen && settingsDraft && settingsBaseline &&
    (settingsDraftOwner !== latestSettingsOwner || !equalSettingsBaseline(settingsBaseline, currentSettingsBaseline)));
  const settingsUnavailableReason = settingsConflict
    ? 'Saved settings changed after this form opened. Reload them before making another change.'
    : settingsNeedsReload
      ? 'Reload saved settings before making another change.'
    : !settingsDraft || !settingsBaseline || !settingsDraftOwner
      ? 'Open Settings again to load the current saved preferences.'
      : latestSettingsOwner !== settingsDraftOwner
        ? 'This workspace changed. Reload its saved settings before continuing.'
        : latestSettingsState.busy || latestSettingsState.refreshRequired || latestSettingsState.pendingCommand || settingsSaving
          ? 'Resolve the current workspace operation before saving settings.'
          : undefined;
  const saveSettings = async () => {
    const draft = settingsDraft;
    const baseline = settingsBaseline;
    const owner = settingsDraftOwner;
    const generation = settingsFormGeneration.current;
    if (settingsOperationLock.current) {
      setSettingsFormMessage('Wait for the current settings operation to finish.');
      return;
    }
    if (!draft || !baseline || !owner) {
      setSettingsFormMessage('Open Settings again to load the current saved preferences.');
      return;
    }
    if (!/^\d+$/.test(draft.maxAudioSeconds.trim())) {
      setSettingsFormMessage('Maximum recording length must be a whole number from 10 to 600 seconds.');
      return;
    }
    const maxAudioSeconds = Number(draft.maxAudioSeconds);
    if (!Number.isSafeInteger(maxAudioSeconds) || maxAudioSeconds < 10 || maxAudioSeconds > 600) {
      setSettingsFormMessage('Maximum recording length must be a whole number from 10 to 600 seconds.');
      return;
    }
    const current = store.getSnapshot();
    const currentSnapshot = current.snapshot;
    if (!currentSnapshot || settingsOwnerKey(currentSnapshot) !== owner || current.busy || current.pendingCommand || current.refreshRequired) {
      setSettingsFormMessage('Resolve the current workspace operation or reload saved settings before saving.');
      return;
    }
    if (!equalSettingsBaseline(baseline, projectSettingsBaseline(currentSnapshot.state.settings))) {
      setSettingsFormMessage('Saved settings changed after this form opened. Reload them before making another change.');
      return;
    }
    const patch: WorkspaceSettingsPatch = {
      mode: draft.providerEnabled ? 'provider' : 'preview',
      speechEnabled: draft.speechEnabled,
      speechProvider: draft.speechProvider,
      speechEndpoint: draft.speechEndpoint.trim(),
      openRouterReasoningEffort: draft.effort,
      maxAudioSeconds,
      audioRetention: draft.retention,
    };
    const token = {};
    settingsOperationLock.current = token;
    setSettingsSaving(true);
    setSettingsFormMessage(undefined);
    try {
      const response = await store.execute({ kind: 'settings.update', patch });
      const latestSnapshot = store.getSnapshot().snapshot;
      if (generation !== settingsFormGeneration.current || settingsDraftOwner !== owner) return;
      if (!latestSnapshot || settingsOwnerKey(latestSnapshot) !== owner) {
        setSettingsFormMessage('The workspace changed while the settings command was in progress. Reload the current workspace settings.');
        return;
      }
      const receipt = receiptFor(response, 'settings.update');
      if (!receipt || receipt.kind !== 'settings.update' || receipt.objectId !== 'workspace-settings') {
        setSettingsFormMessage('The settings command has no confirmed receipt. Inspect it before trying again.');
        return;
      }
      if (!response.snapshot) {
        setSettingsNeedsReload(true);
        setSettingsFormMessage('Settings were saved. Reload the saved settings to load the confirmed values.');
        return;
      }
      if (settingsOwnerKey(response.snapshot) !== owner) {
        setSettingsFormMessage('The workspace changed while the settings command was in progress. Reload the current workspace settings.');
        return;
      }
      setSettingsDraft(settingsDraftFrom(response.snapshot.state.settings));
      setSettingsBaseline(projectSettingsBaseline(response.snapshot.state.settings));
      setSettingsDraftOwner(settingsOwnerKey(response.snapshot));
      setSettingsNeedsReload(false);
      setSettingsFormMessage('Settings saved.');
    } catch (error) {
      const latestSnapshot = store.getSnapshot().snapshot;
      if (generation === settingsFormGeneration.current && latestSnapshot && settingsOwnerKey(latestSnapshot) === owner) {
        setSettingsFormMessage(errText(error));
      }
    } finally {
      if (settingsOperationLock.current === token) {
        settingsOperationLock.current = undefined;
        setSettingsSaving(false);
      }
    }
  };
  const updateSettingsDraft = (patch: Partial<WorkspaceSettingsDraft>) => {
    const current = store.getSnapshot();
    const currentSnapshot = current.snapshot;
    if (!settingsDraftOwner || !settingsBaseline || !currentSnapshot || settingsOwnerKey(currentSnapshot) !== settingsDraftOwner ||
        current.busy || current.pendingCommand || current.refreshRequired || settingsNeedsReload ||
        !equalSettingsBaseline(settingsBaseline, projectSettingsBaseline(currentSnapshot.state.settings))) {
      setSettingsFormMessage('Saved settings changed or a workspace operation is active. Reload saved settings before editing.');
      return;
    }
    setSettingsDraft((draft) => draft ? { ...draft, ...patch } : draft);
    setSettingsFormMessage(undefined);
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
        setDraft('');
        setNotice('Note saved.');
      } else setNotice('The note request is still being checked. Refresh the workspace to see its result.');
    } catch (error) { setNotice(errText(error)); }
  };

  const updateNote = async (note: NonNullable<typeof selectedNote>, text: string) => {
    if (state.busy || state.refreshRequired || text === note.transcript) return;
    const owner = `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${note.id}:${note.revision}`;
    try {
      const response = await actions.notes.updateTranscript(note.id, text, note.revision);
      if (selectedNoteOwner.current !== owner) return;
      const receipt = receiptFor(response, 'notes.updateTranscript');
      setNotice(receipt?.objectId === note.id ? 'Note updated.' : 'The update is still being checked. Refresh the workspace to see its result.');
    } catch (error) { if (selectedNoteOwner.current === owner) setNotice(errText(error)); }
  };

  const transcribeNote = async (note: NonNullable<typeof selectedNote>, expectedRevision: number) => {
    if (state.busy || state.refreshRequired || expectedRevision !== note.revision || note.audio?.available !== true) return;
    const owner = `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${note.id}:${note.revision}`;
    let admitted: WorkspaceCommandAdmission | undefined;
    setNotice(undefined);
    try {
      const response = await actions.notes.transcribe(note.id, expectedRevision, (envelope) => {
        admitted = envelope;
        if (envelope.command.kind === 'notes.transcribe') setAdmittedTranscription({ commandId: envelope.commandId, owner });
      });
      if (selectedNoteOwner.current !== owner) return;
      const receipt = receiptFor(response, 'notes.transcribe');
      if (!admitted || admitted.command.kind !== 'notes.transcribe' || !receipt || receipt.kind !== 'notes.transcribe' || receipt.commandId !== admitted.commandId ||
          receipt.objectId !== note.id || receipt.sourceRevision !== expectedRevision) {
        setNotice('The exact transcription result is not confirmed. Refresh the workspace before editing this note.');
        return;
      }
      switch (receipt.outcome) {
        case 'completed':
          setNotice(response.snapshot?.state.notes.some((item) => item.id === note.id && item.revision > expectedRevision)
            ? 'Transcription completed. The updated note is available in the refreshed workspace.'
            : 'Transcription completed. Refresh the workspace to load the saved transcript.');
          break;
        case 'no_speech': setNotice('No speech was detected. The transcript was left unchanged.'); break;
        case 'cancelled': setNotice('Transcription was cancelled. The transcript was left unchanged.'); break;
        case 'failed': setNotice('Transcription did not complete. The transcript was left unchanged.'); break;
        case 'unknown': setNotice('The transcription result is uncertain. Check its status before trying again.'); break;
        case 'discarded': setNotice('The note changed before transcription finished. The result was not applied. Refresh the workspace.'); break;
      }
    } catch (error) { if (selectedNoteOwner.current === owner) setNotice(errText(error)); }
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
      actions={{ navigation: { selectTab: setTab }, settings: { open: openSettings }, session: { logout: onLogout } }}
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
        display={latestSettingsSnapshot.state}
        actions={{
          preferences: {
            update: settingsUnavailableReason
              ? { available: false, reason: settingsUnavailableReason }
              : { available: true, action: updateSettingsDraft },
            save: settingsUnavailableReason
              ? { available: false, reason: settingsUnavailableReason }
              : { available: true, action: saveSettings },
          },
          accounts: { available: false, reason: 'Connected account management is unavailable in this browser workspace.' },
          calendars: { available: false, reason: 'Calendar setup and device calendar actions are unavailable in this browser workspace.' },
          connections: { available: false, reason: 'Connection setup, sync, and mail actions are unavailable until matching server actions are available.' },
          recovery: { available: false, reason: 'Recovery actions must be performed by the workspace owner.' },
        }}
        preferencesDraft={settingsDraft ?? settingsDraftFrom(latestSettingsSnapshot.state.settings)}
        preferencesMessage={settingsFormMessage ?? (settingsConflict ? settingsUnavailableReason : settingsSaving ? 'Saving settings…' : undefined)}
        credentials={credentials
          ? { available: true, controller: credentials }
          : { available: false, reason: 'Provider credentials are unavailable in this workspace view.' } satisfies WorkspaceSettingsCredentialCapability}
        onReloadPreferences={settingsConflict || settingsNeedsReload || state.refreshRequired ? reloadSettings : undefined}
        busy={state.busy || state.refreshRequired || Boolean(state.pendingCommand) || settingsSaving} onClose={closeSettings}
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
            audio={voiceCapability?.available ? voiceCapability.capture : { status: 'idle', canResume: false, durationSeconds: 0, meter: [], hasPending: false, statusLabel: 'Browser audio capture is not connected.' }}
            recording={voiceCapability?.available ? { available: true, action: {
              start: () => { const current = store.getSnapshot(); if (current.busy || current.pendingCommand || current.refreshRequired) { setNotice('Resolve the current workspace operation before starting a recording.'); return; } runVoiceAction(voiceCapability.actions.start); },
              pause: () => runVoiceAction(voiceCapability.actions.pause),
              resume: () => runVoiceAction(voiceCapability.actions.resume),
              stop: () => runVoiceAction(voiceCapability.actions.stopAndSave),
              cancel: () => runVoiceAction(voiceCapability.actions.cancelCurrentRecording),
              startDisabled: state.busy || state.refreshRequired || Boolean(state.pendingCommand) || voiceActionBusy,
            } } : { available: false, reason: 'Browser audio capture is not connected to the server workspace.' }}
            recovery={{ available: false, reason: 'Pending native recording recovery is unavailable in this browser workspace.' }}
            busy={state.busy || state.refreshRequired}
            serverRecording={serverRecording}
            recent={dto.notes.slice(0, 3).map((note) => workspaceNoteCardDisplay({ ...note, recordingAvailable: note.audio?.available === true }))}
            onOpenNote={(id, revision) => { const note = store.getSnapshot().snapshot?.state.notes.find((item) => item.id === id && item.revision === revision); if (!note) return; setSelectedNoteId(id); setTab('library'); }}
            onSeeAll={() => { setTab('library'); }}
            onWrite={() => setManualOpen(true)}
            storageHint="Audio stays in temporary browser memory until you explicitly save it to this workspace."
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
              setSelectedNoteId(id); setDraft('');
            }}
            documentActions={{ available: false, reason: 'Document editing is not connected to server commands yet.' }}
            knowledgeEntityActions={{ available: false, reason: 'People and project editing are not connected to server commands yet.' }}
            knowledgeSuggestionActions={{ available: false, reason: 'Knowledge suggestion review is not connected to server commands yet.' }}
            onExport={{ available: false, reason: 'Workspace export is not connected to the browser workspace yet.' }}
          />
          {selectedNote ? <WorkspaceModals
            key={`${selectedNote.id}:${selectedNote.revision}`}
            note={noteDetailDisplayNote(selectedNote)}
            recordingAvailable={selectedNote.audio?.available === true}
            importedAudioMissing={selectedNote.importOrigin?.audioMissing === true}
            analysis={selectedNote.analysis}
            proposals={dto.proposals.filter((proposal) => proposal.noteId === selectedNote.id).map((proposal) => ({ status: proposal.status }))}
            busy={state.busy || state.refreshRequired}
            preview={dto.settings.mode === 'preview'} demoMode={false}
            providerReady={credentials?.presence ? (dto.settings.speechProvider === 'openrouter' ? credentials.presence.openrouter : credentials.presence.speech) : false} speechEnabled={dto.settings.speechEnabled === true} speechProvider={dto.settings.speechProvider}
            serverManagedTranscription
            transcriptionAttempts={dto.transcription.attempts.filter((attempt) => attempt.noteId === selectedNote.id)}
            assistantBatchJobs={dto.assistantBatchJobs} assistantBatchActionsBlocked={state.refreshRequired || Boolean(dto.assistantBatchRecoveryStatus)}
            people={dto.knowledge.people.map((person) => ({ id: person.id, name: person.name, revision: person.revision, archivedAt: person.archivedAt, importOrigin: person.importOrigin }))}
            projects={dto.knowledge.projects.map((project) => ({ id: project.id, name: project.name, revision: project.revision, archivedAt: project.archivedAt, importOrigin: project.importOrigin }))}
            actionCapabilities={{
              delete: { available: false, reason: 'Note deletion is not connected to a server command.' },
              confirmImportedTimeZone: { available: false, reason: 'Imported time zone confirmation is not connected to a server command.' },
              attachRecording: { available: false, reason: 'Attaching a replacement recording is not connected to the server workspace.' },
              playback: selectedMediaId ? { available: true } : { available: false, reason: 'This saved recording has no validated server media reference for playback.' },
              exportAudio: { available: false, reason: 'Recording export is not available in this browser workspace yet.' },
              cancelTranscription: { available: false, reason: 'Transcription cancellation is not connected to the browser workspace yet.' },
              retryTranscriptionCleanup: { available: false, reason: 'Transcription cleanup is managed by the workspace service.' },
              transcribe: { available: true },
              speechSettings: { available: true },
              assistance: dto.settings.mode === 'provider' && dto.settings.llmProvider === 'openrouter'
                ? { available: true }
                : { available: false, reason: 'Enable OpenRouter provider analysis in Settings to queue this note.' },
              memorySuggestion: { available: false, reason: 'Saving a memory suggestion is not connected to a server command.' },
              chatTransfer: { available: false, reason: 'Transcript transfer review is not connected to the browser workspace yet.' },
              sourceCheck: { available: false, reason: 'Source rechecks are not connected to the browser workspace yet.' },
              openProposals: { available: true },
            }}
            serverManagedAssistance
            onRetryStatus={() => setNotice('Source rechecks are not connected to this browser workspace yet.')}
            onClose={() => setSelectedNoteId(undefined)}
            onUpdate={(text) => void updateNote(selectedNote, text)}
            onConfirmImportedTimeZone={() => setNotice('Imported time zone confirmation is not connected to a server command.')}
            onAssist={(options) => {
              const owner = `${snapshot.workspaceId}:${snapshot.privacyEpoch}:${selectedNote.id}:${selectedNote.revision}`;
              const current = store.getSnapshot();
              const currentSnapshot = current.snapshot;
              if (!currentSnapshot || currentSnapshot.workspaceId !== snapshot.workspaceId || currentSnapshot.privacyEpoch !== snapshot.privacyEpoch ||
                  current.busy || current.refreshRequired || current.pendingCommand) {
                if (selectedNoteOwner.current === owner) setNotice('Refresh the workspace and resolve any pending command before requesting note assistance.');
                return;
              }
              const currentNote = currentSnapshot.state.notes.find((item) => item.id === selectedNote.id);
              if (!currentNote || currentNote.revision !== selectedNote.revision) {
                if (selectedNoteOwner.current === owner) setNotice('This note changed. Refresh it before requesting assistance.');
                return;
              }
              if (currentSnapshot.state.settings.mode !== 'provider' || currentSnapshot.state.settings.llmProvider !== 'openrouter') {
                if (selectedNoteOwner.current === owner) setNotice('Enable OpenRouter provider analysis in Settings to queue this note.');
                return;
              }
              void actions.notes.submitAssistance(selectedNote.id, options).then((response) => {
                if (selectedNoteOwner.current !== owner) return;
                const receipt = receiptFor(response, 'assistant.batch.submitNote');
                setNotice(receipt?.objectId === selectedNote.id ? 'Request queued. Check Batch history when you choose.' : 'The request is still being checked. Refresh the workspace to see its result.');
              }).catch((error) => { if (selectedNoteOwner.current === owner) setNotice(errText(error)); });
            }}
            onCreateMemorySuggestion={async () => { throw new Error('Saving a memory suggestion is not connected to a server command.'); }}
            onOpenProposals={() => { setSelectedNoteId(undefined); setTab('inbox'); setInboxSection('inbox'); setProposalFilter('pending'); }}
            onTranscribe={(expectedRevision) => void transcribeNote(selectedNote, expectedRevision)}
            onCancelTranscription={() => setNotice('Native transcription attempt cancellation is unavailable without its native attempt mapping.')}
            transcriptionCommandCancellation={pendingTranscriptionCancellation}
            onCheckAssistantBatch={(jobId) => actions.batch.check(jobId)}
            onOpenSpeechSettings={openSettings}
            onAttachRecording={() => setNotice('Attaching a replacement recording is not connected to the server workspace.')}
            onPlay={() => { void audioPlayback.play(); }}
            playbackState={selectedMediaId ? audioPlayback.state : undefined}
            onPausePlayback={() => audioPlayback.pause()}
            onExportAudio={() => setNotice('Recording export is not available in this browser workspace yet.')}
            onDelete={() => setNotice('Note deletion is not connected to a server command.')}
          /> : null}
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
