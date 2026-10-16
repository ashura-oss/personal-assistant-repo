import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { WorkspaceCommand, WorkspaceCommandReceipt, WorkspaceCommandResponse, WorkspaceSettingsPatch } from '../cloud/workspaceCommands';
import type { WorkspaceSettingsDTO } from '../cloud/workspaceDto';
import type { AppController, ContextDocument, BackupImportPreview, PeriodSummaryApplicationPlan, PeriodSummaryApplicationPreview,
  PeriodSummaryApplicationReceipt, PeriodSummaryMoreComputePlan, PeriodSummaryResultReview } from '../core';
import type { ImportedBackupArchive } from '../backup';
import type { CloudWorkspaceSessionState, CloudWorkspaceSessionStore, CloudWorkspaceVoiceActions } from './CloudWorkspaceSession';
import { WorkspaceClientError, WorkspaceCommandNotStartedError, type WorkspaceCommandAdmission } from './workspaceClient';
import { WorkspaceScreen, type WorkspaceTab } from '../ui/WorkspaceScreen';
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
import { projectChatKnowledgeChoices } from '../ui/workspaceChatDisplayTypes';
import { ChatSubmissionNotStartedError, type ChatSendAttempt, type ChatSendInspectionResult } from '../ui/chatSubmission';
import { Button } from '../ui/primitives';
import { C, s } from '../ui/theme';
import { useCloudAudioPlayback } from './useCloudAudioPlayback';
import { createCloudKnowledgeActions } from './cloudKnowledgeActions';
import type { CloudVoiceCoordinatorState } from './cloudVoiceCoordinator';
import type { CloudCredentialController } from './useCloudCredentials';
import { useCloudOAuth } from './useCloudOAuth';
import type { CloudOAuthCoordinator } from './cloudOAuthCoordinator';
import type { CloudMailCoordinator } from './cloudMailCoordinator';
import type { CloudTranscriptTransferCoordinator, CloudTranscriptTransferState } from './cloudTranscriptTransferCoordinator';
import type { CloudBackgroundPolicyCoordinator } from './cloudBackgroundPolicyCoordinator';
import { CloudMailWorkspace } from './CloudMailWorkspace';
import { InboxWorkspaceContent, inboxAccountDisplay } from '../ui/InboxWorkspaceContent';
import { AssistantBatchJobCard } from '../ui/AssistantBatchJobCard';
import type { WorkspaceEraseActions } from './WorkspaceErasePanel';
import { CloudReminderPanel } from './CloudReminderPanel';
import { pickPortableBackup } from './portableBackupPicker';

export type CloudWorkspaceActions = Readonly<{
  tasks: Readonly<{ complete: (taskId: string) => Promise<WorkspaceCommandResponse>; reopen: (taskId: string) => Promise<WorkspaceCommandResponse> }>;
  notes: Readonly<{ save: (transcript: string) => Promise<WorkspaceCommandResponse>; updateTranscript: (noteId: string, text: string, expectedNoteRevision: number) => Promise<WorkspaceCommandResponse>; submitAssistance: (noteId: string, options: { intent: 'assist' | 'summarize' | 'answer' | 'extract'; question?: string; knowledgeSelection?: readonly { kind: 'person' | 'project'; id: string }[] }) => Promise<WorkspaceCommandResponse>; transcribe: (noteId: string, expectedNoteRevision: number, onAdmitted: (envelope: WorkspaceCommandAdmission) => void) => Promise<WorkspaceCommandResponse> }>;
  chat: Readonly<{ create: () => Promise<WorkspaceCommandResponse>; submit: (attempt: ChatSendAttempt) => Promise<WorkspaceCommandResponse>; refine: (conversationId: string, parentTurnId: string, effort: 'medium' | 'high' | 'max') => Promise<WorkspaceCommandResponse>; inspect: (commandId: string) => Promise<WorkspaceCommandResponse> }>;
  batch: Readonly<{
    check: (jobId: string) => Promise<WorkspaceCommandResponse>;
    prepareSummaryMoreCompute: (jobId: string, effort: 'low' | 'medium' | 'high' | 'max') => Promise<PeriodSummaryMoreComputePlan>;
    submitSummaryMoreCompute: (planId: string, jobId: string) => Promise<Readonly<{ jobStatus: import('../services/openRouterBatchJobs').AssistantBatchJobDTO['status'] }>>;
    cancelSummaryMoreCompute: (planId: string) => void;
    readSummary: (jobId: string) => Promise<PeriodSummaryResultReview>;
    prepareSummaryApplication: (jobId: string) => Promise<PeriodSummaryApplicationPlan | PeriodSummaryApplicationReceipt>;
    cancelSummaryApplication: (planId: string) => void;
    applySummaryApplication: (planId: string, jobId: string) => Promise<PeriodSummaryApplicationReceipt>;
    readSummaryApplicationPreview: (planId: string, jobId: string) => Promise<PeriodSummaryApplicationPreview>;
  }>;
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

function receiptFor<K extends WorkspaceCommand['kind']>(response: WorkspaceCommandResponse, kind: K): Extract<WorkspaceCommandReceipt, { kind: K }> | undefined {
  if (response.status !== 'finished' || response.receipt?.kind !== kind || response.receipt.commandId !== response.commandId) return undefined;
  return response.receipt as Extract<WorkspaceCommandReceipt, { kind: K }>;
}

function errText(error: unknown) {
  return error instanceof WorkspaceClientError || error instanceof WorkspaceCommandNotStartedError ? error.message : 'The workspace action could not be confirmed.';
}

const EMPTY_TRANSCRIPT_TRANSFER: CloudTranscriptTransferState = Object.freeze({ busy: false });
const EMPTY_TRANSCRIPT_SUBSCRIBE = (_listener: () => void) => () => undefined;

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

type CloudWorkspaceEraseStoreMethods = 'discoverWorkspaceErase' | 'prepareWorkspaceErase' | 'confirmWorkspaceErase' | 'executeWorkspaceErase' |
  'cancelWorkspaceErase' | 'retryWorkspaceEraseReview' | 'retryWorkspaceEraseCleanup';
type CloudWorkspaceStorePort = Pick<CloudWorkspaceSessionStore, 'getSnapshot' | 'execute' | 'inspect' | 'refresh'> &
  Partial<Pick<CloudWorkspaceSessionStore, 'readKnowledgeSourceChoices' | 'readKnowledgeSuggestionReview' | 'readPeriodSummaryResult' | 'readPeriodSummaryApplicationPreview' |
    'exportPortableBackup' | 'preparePortableBackupImport' | 'prepareImportedKnowledgeActivation' | 'cancelImportedKnowledgeActivation' | 'downloadAudio'>> &
  Partial<Pick<CloudWorkspaceSessionStore, 'getWebPushCoordinator' | 'getReminderCoordinator'>> &
  Partial<Pick<CloudWorkspaceSessionStore, CloudWorkspaceEraseStoreMethods>>;

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

export function CloudWorkspace({ store, state, onLogout, voiceCapability, credentials, oauthCoordinator, mailCoordinator, transcriptTransferCoordinator, backgroundPolicyCoordinator }: { store: CloudWorkspaceStorePort; state: CloudWorkspaceSessionState; onLogout: () => void; voiceCapability?: CloudWorkspaceVoiceCapability; credentials?: CloudCredentialController; oauthCoordinator?: CloudOAuthCoordinator; mailCoordinator?: CloudMailCoordinator; transcriptTransferCoordinator?: CloudTranscriptTransferCoordinator; backgroundPolicyCoordinator?: CloudBackgroundPolicyCoordinator }) {
  const oauthState = useCloudOAuth(oauthCoordinator);
  const transcriptTransferState = useSyncExternalStore(transcriptTransferCoordinator?.subscribe ?? EMPTY_TRANSCRIPT_SUBSCRIBE,
    transcriptTransferCoordinator?.getSnapshot ?? (() => EMPTY_TRANSCRIPT_TRANSFER),
    transcriptTransferCoordinator?.getSnapshot ?? (() => EMPTY_TRANSCRIPT_TRANSFER));
  const snapshot = state.snapshot!;
  const dto = snapshot.state;
  const libraryMutationActions = useMemo(() => createCloudKnowledgeActions(store, { workspaceId: snapshot.workspaceId, privacyEpoch: snapshot.privacyEpoch }),
    [snapshot.privacyEpoch, snapshot.workspaceId, store]);
  const cloudKnowledgeEntityActions = libraryMutationActions.entities.available ? libraryMutationActions.entities.action : undefined;
  const [tab, setTab] = useState<WorkspaceTab>('inbox');
  const [inboxFilter, setInboxFilter] = useState<'pending' | 'done'>('pending');
  const [inboxSection, setInboxSection] = useState<'inbox' | 'activity' | 'history' | 'mail'>('inbox');
  const [, setDraft] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const transcriptTransferPlan = transcriptTransferState.plan;
  const transcriptTransferCommand = transcriptTransferState.held;
  const deleteReviewOwner = useRef<Readonly<{ workspaceId: string; privacyEpoch: number; revision: number; conversationId: string }> | undefined>(undefined);
  const deleteCommandOwner = useRef<Readonly<{ commandId: string; workspaceId: string; privacyEpoch: number; revision: number; conversationId: string }> | undefined>(undefined);
  const timeZoneCommandOwner = useRef<Readonly<{ commandId: string; workspaceId: string; privacyEpoch: number; noteId: string; noteRevision: number; timeZone: string }> | undefined>(undefined);
  const backupPickerController = useRef<AbortController | undefined>(undefined);
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
  const [libraryQuery, setLibraryQuery] = useState('');
  const [notice, setNotice] = useState<string>();
  const displayedNotice = notice ?? transcriptTransferState.notice;
  const unavailableEraseAction = () => Promise.reject(new WorkspaceClientError('disposed', 'Workspace erasure is unavailable in this view.'));
  const eraseActions: WorkspaceEraseActions = {
    refresh: () => store.discoverWorkspaceErase?.() ?? unavailableEraseAction(),
    prepare: () => store.prepareWorkspaceErase?.() ?? unavailableEraseAction(),
    confirm: () => store.confirmWorkspaceErase?.() ?? unavailableEraseAction(),
    execute: () => store.executeWorkspaceErase?.() ?? unavailableEraseAction(),
    cancel: () => store.cancelWorkspaceErase?.() ?? unavailableEraseAction(),
    retryReview: () => store.retryWorkspaceEraseReview?.() ?? unavailableEraseAction(),
    retryCleanup: () => store.retryWorkspaceEraseCleanup?.() ?? unavailableEraseAction(),
  };
  const [voiceActionBusy, setVoiceActionBusy] = useState(false);
  const voiceActionLock = useRef<object | undefined>(undefined);
  const [cancelingTranscriptionCommandId, setCancelingTranscriptionCommandId] = useState<string>();
  const transcriptionCancelLock = useRef<object | undefined>(undefined);
  const [admittedTranscription, setAdmittedTranscription] = useState<Readonly<{ commandId: string; owner: string }>>();
  const originalChatAttempts = useRef(new Map<number, Readonly<{ attempt: ChatSendAttempt; envelope: WorkspaceCommandAdmission; text: string; conversationId: string; ownerGeneration: number; knowledgeSelection: ChatSendAttempt['knowledgeSelection'] }>>());
  const selectedNote = dto.notes.find((note) => note.id === selectedNoteId);
  useEffect(() => () => backupPickerController.current?.abort(), [snapshot.workspaceId, snapshot.privacyEpoch]);
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
    batch: {
      check: (jobId) => store.execute({ kind: 'assistant.batch.check', jobId }),
      prepareSummaryMoreCompute: async (jobId: string, effort: 'low' | 'medium' | 'high' | 'max') => {
        const response = await store.execute({ kind: 'assistant.periodSummary.moreCompute.prepare', jobId, effort });
        if (response.status !== 'finished' || !response.receipt || response.receipt.kind !== 'assistant.periodSummary.moreCompute.prepare') throw new Error('summary_plan_unavailable');
        return response.receipt.plan;
      },
      submitSummaryMoreCompute: async (planId: string, jobId: string) => {
        const response = await store.execute({ kind: 'assistant.periodSummary.moreCompute.submit', planId, jobId });
        if (response.status !== 'finished' || !response.receipt || response.receipt.kind !== 'assistant.periodSummary.moreCompute.submit') throw new Error('summary_submit_unknown');
        return response.receipt;
      },
      cancelSummaryMoreCompute: (planId: string) => {
        void store.execute({ kind: 'assistant.periodSummary.moreCompute.cancel', planId }).catch(() => undefined);
      },
      readSummary: (jobId: string) => {
        const current = store.getSnapshot().snapshot;
        if (!current || !store.readPeriodSummaryResult) throw new Error('summary_workspace_unavailable');
        return store.readPeriodSummaryResult(jobId, current.revision);
      },
      prepareSummaryApplication: async (jobId: string) => {
        const response = await store.execute({ kind: 'assistant.periodSummary.application.prepare', jobId });
        const receipt = receiptFor(response, 'assistant.periodSummary.application.prepare');
        if (!receipt || (receipt.applicationPlan && receipt.application) || (!receipt.applicationPlan && !receipt.application)) throw new Error('summary_application_plan_unavailable');
        return receipt.applicationPlan ?? receipt.application!;
      },
      cancelSummaryApplication: (planId: string) => {
        void store.execute({ kind: 'assistant.periodSummary.application.cancel', planId }).catch(() => undefined);
      },
      applySummaryApplication: async (planId: string, jobId: string) => {
        const response = await store.execute({ kind: 'assistant.periodSummary.application.apply', planId, jobId });
        const receipt = receiptFor(response, 'assistant.periodSummary.application.apply');
        if (!receipt) throw new Error('summary_application_outcome_unknown');
        return Object.freeze({ kind: 'applied', jobId: receipt.jobId, path: receipt.path, documentRevision: receipt.documentRevision, appliedAt: receipt.appliedAt });
      },
      readSummaryApplicationPreview: (planId: string, jobId: string) => {
        const current = store.getSnapshot().snapshot;
        if (!current || !store.readPeriodSummaryApplicationPreview) throw new Error('summary_workspace_unavailable');
        return store.readPeriodSummaryApplicationPreview(planId, jobId, current.revision);
      },
    },
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
  const connectionCapability = oauthCoordinator ? {
    available: true as const,
    state: oauthState,
    accounts: dto.accounts.filter((account) => account.provider === 'google' || account.provider === 'microsoft').map((account) => ({
      id: account.id, provider: account.provider as 'google' | 'microsoft', displayName: account.displayName, email: account.email,
      connected: account.connected, authStatus: account.authStatus, capabilities: account.capabilities, connectionGeneration: account.connectionGeneration,
    })),
    blockedReason: state.busy || state.pendingCommand || state.refreshRequired
      ? 'Resolve the current workspace operation before starting or installing a connection.'
      : oauthState.workspaceRefreshRequired ? 'Refresh the workspace before starting or installing a connection.' : undefined,
    actions: {
      open: () => oauthCoordinator.open(),
      reload: () => oauthCoordinator.open(),
      refreshWorkspace: () => oauthCoordinator.refreshWorkspace(),
      start: (provider: 'google' | 'microsoft', capabilities: readonly import('./cloudOAuthClient').OAuthCapability[], reconnectAccountId?: string) => oauthCoordinator.start(provider, capabilities, reconnectAccountId),
      restart: (provider: 'google' | 'microsoft', capabilities: readonly import('./cloudOAuthClient').OAuthCapability[], attemptId: string, reconnectAccountId?: string) => oauthCoordinator.start(provider, capabilities, reconnectAccountId, attemptId),
      inspectStart: (provider: 'google' | 'microsoft', attemptId: string) => oauthCoordinator.inspectStart(provider, attemptId),
      inspectStage: (stageId: string) => oauthCoordinator.inspectStage(stageId),
      installStage: (stageId: string) => oauthCoordinator.installStage(stageId),
      inspectInstall: () => oauthCoordinator.inspectInstall(),
    },
  } : undefined;
  const settingsMailCapability = mailCoordinator ? {
    available: true as const,
    accounts: dto.accounts.map((account) => ({ id: account.id, provider: account.provider, displayName: account.displayName, email: account.email,
      connected: account.connected, authStatus: account.authStatus, connectionGeneration: account.connectionGeneration })),
    syncStates: dto.syncStates,
    busy: state.busy || state.refreshRequired,
    onAction: (accountId: string, action: 'accounts.refreshMail' | 'accounts.continueMailBackfill' | 'accounts.syncCalendars' | 'accounts.disconnect') => { void mailCoordinator.runAccountAction(accountId, action); },
  } : { available: false as const, reason: 'Mail and calendar actions are not available in this workspace session.' };
  const settingsBackgroundPolicyCapability = backgroundPolicyCoordinator ? {
    available: true as const, coordinator: backgroundPolicyCoordinator, state: state.backgroundPolicies ?? backgroundPolicyCoordinator.getSnapshot(),
    accounts: dto.accounts, busy: state.busy, blocked: Boolean(state.pendingCommand || state.refreshRequired),
  } : { available: false as const, reason: 'Background policy controls are unavailable in this workspace session.' };
  const webPushCoordinator = store.getWebPushCoordinator?.();
  const reminderCoordinator = store.getReminderCoordinator?.();
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

  const workspaceOwner = `${snapshot.workspaceId}:${snapshot.privacyEpoch}`;
  const prepareTranscriptTransfer = (note: NonNullable<typeof selectedNote>) => { void transcriptTransferCoordinator?.prepare(note.id, note.revision); };
  const cancelTranscriptTransfer = (planId: string) => { void transcriptTransferCoordinator?.cancel(planId); };
  const submitTranscriptTransfer = (planId: string, conversationId: string) => transcriptTransferCoordinator
    ? transcriptTransferCoordinator.submit(planId, conversationId) : Promise.resolve(undefined);

  const confirmImportedTimeZone = async (note: NonNullable<typeof selectedNote>, timeZone: string, expectedRevision: number) => {
    const current = store.getSnapshot();
    const currentSnapshot = current.snapshot;
    const latestNote = currentSnapshot?.state.notes.find((item) => item.id === note.id);
    if (!currentSnapshot || `${currentSnapshot.workspaceId}:${currentSnapshot.privacyEpoch}` !== workspaceOwner || current.busy ||
        current.pendingCommand || current.refreshRequired || expectedRevision !== note.revision || latestNote?.revision !== expectedRevision ||
        note.importOrigin?.originalTimeZoneUnknown !== true || timeZone.trim() !== timeZone) {
      setNotice('The imported note changed. Refresh it before confirming its capture time zone.');
      return;
    }
    try {
      const response = await store.execute({ kind: 'notes.confirmImportedTimeZone', noteId: note.id, expectedNoteRevision: expectedRevision, timeZone }, (envelope) => {
        if (envelope.command.kind === 'notes.confirmImportedTimeZone') timeZoneCommandOwner.current = Object.freeze({ commandId: envelope.commandId,
          workspaceId: snapshot.workspaceId, privacyEpoch: snapshot.privacyEpoch, noteId: note.id, noteRevision: expectedRevision, timeZone });
      });
      const receipt = receiptFor(response, 'notes.confirmImportedTimeZone');
      if (receipt?.kind === 'notes.confirmImportedTimeZone' && receipt.noteId === note.id && receipt.noteRevision > expectedRevision && receipt.timeZone === timeZone) {
        timeZoneCommandOwner.current = undefined;
        setNotice('Capture time zone confirmed. Date-sensitive assistance can now use this imported note.');
        if (!response.snapshot) void store.refresh().catch((error) => setNotice(errText(error)));
      } else setNotice('The exact time zone confirmation is still being checked. No other note was changed.');
    } catch (error) { setNotice(errText(error)); }
  };

  const deleteChatConversation = async (conversationId: string) => {
    const review = deleteReviewOwner.current;
    const current = store.getSnapshot();
    const currentSnapshot = current.snapshot;
    if (!review || review.conversationId !== conversationId || !currentSnapshot || currentSnapshot.workspaceId !== review.workspaceId ||
        currentSnapshot.privacyEpoch !== review.privacyEpoch || currentSnapshot.revision !== review.revision || current.busy ||
        current.pendingCommand || current.refreshRequired || !currentSnapshot.state.assistantChatConversations.some((item) => item.id === conversationId)) {
      const message = 'The workspace or conversation changed while deletion was under review. Reopen the confirmation before trying again.';
      if (review && currentSnapshot && currentSnapshot.workspaceId === review.workspaceId && currentSnapshot.privacyEpoch === review.privacyEpoch) setNotice(message);
      throw new Error(message);
    }
    const response = await store.execute({ kind: 'chat.conversation.delete', conversationId }, (envelope) => {
      if (envelope.command.kind === 'chat.conversation.delete') deleteCommandOwner.current = Object.freeze({ commandId: envelope.commandId,
        workspaceId: review.workspaceId, privacyEpoch: review.privacyEpoch, revision: review.revision, conversationId });
    });
    const receipt = receiptFor(response, 'chat.conversation.delete');
    if (!receipt || receipt.kind !== 'chat.conversation.delete' || receipt.conversationId !== conversationId || receipt.objectId !== conversationId) {
      setNotice('Conversation deletion has no confirmed receipt yet. Inspect the exact command before continuing.');
      throw new Error('The exact conversation deletion is still being checked.');
    }
    const latest = store.getSnapshot().snapshot;
    if (!latest || latest.workspaceId !== review.workspaceId || latest.privacyEpoch !== review.privacyEpoch) return;
    deleteCommandOwner.current = undefined;
    setSelectedConversationId(undefined);
    setNotice('Conversation removed from this workspace. No provider account or external data was changed.');
    if (!response.snapshot) void store.refresh().catch((error) => setNotice(errText(error)));
  };

  const inspectPendingCommand = async () => {
    const pending = store.getSnapshot().pendingCommand;
    if (!pending || state.busy) return;
    if (transcriptTransferCommand?.commandId === pending.commandId && transcriptTransferCommand.kind === pending.kind) {
      setNotice(undefined);
      const result = await transcriptTransferCoordinator?.inspect(pending.commandId);
      if (result?.kind === 'accepted') { setSelectedConversationId(result.conversationId); setTab('chat'); }
      return;
    }
    setNotice(undefined);
    try {
      const response = await store.inspect(pending.commandId);
      const receipt = response.receipt;
      if (response.commandId !== pending.commandId || response.status !== 'finished' || !receipt ||
          receipt.commandId !== pending.commandId || receipt.kind !== pending.kind) {
        setNotice(`The exact ${pending.kind} command has no confirmed receipt yet. No request was resent.`);
        return;
      }
      const deletion = deleteCommandOwner.current;
      if (pending.kind === 'chat.conversation.delete' && deletion?.commandId === pending.commandId && receipt.kind === 'chat.conversation.delete' &&
          receipt.conversationId === deletion.conversationId && receipt.objectId === deletion.conversationId) {
        const current = store.getSnapshot().snapshot;
        if (!current || current.workspaceId !== deletion.workspaceId || current.privacyEpoch !== deletion.privacyEpoch) return;
        await store.refresh();
        const latest = store.getSnapshot().snapshot;
        if (latest?.workspaceId === deletion.workspaceId && latest.privacyEpoch === deletion.privacyEpoch) {
          deleteCommandOwner.current = undefined;
          setNotice('Conversation removal is confirmed. No provider account or external data was changed.');
        }
        return;
      }
      const zone = timeZoneCommandOwner.current;
      if (pending.kind === 'notes.confirmImportedTimeZone' && zone?.commandId === pending.commandId && receipt.kind === 'notes.confirmImportedTimeZone' &&
          receipt.noteId === zone.noteId && receipt.noteRevision > zone.noteRevision && receipt.timeZone === zone.timeZone) {
        const current = store.getSnapshot().snapshot;
        if (!current || current.workspaceId !== zone.workspaceId || current.privacyEpoch !== zone.privacyEpoch) return;
        await store.refresh();
        const latest = store.getSnapshot().snapshot;
        if (latest?.workspaceId === zone.workspaceId && latest.privacyEpoch === zone.privacyEpoch) {
          timeZoneCommandOwner.current = undefined;
          setNotice('Capture time zone confirmation is saved. No request was resent.');
        }
        return;
      }
      setNotice(pending.kind === 'chat.submit'
        ? 'The exact chat receipt is confirmed. Open Chat to inspect the original message and context; no request was resent.'
        : `The exact ${pending.kind} receipt is confirmed. No request was resent.${response.snapshot ? '' : ' Refresh the workspace to load its current state.'}`);
    } catch (error) { setNotice(`Could not confirm the exact ${pending.kind} receipt. No request was resent. ${errText(error)}`); }
  };

  const downloadUrls = useRef(new Set<string>());
  useEffect(() => () => {
    for (const url of downloadUrls.current) URL.revokeObjectURL(url);
    downloadUrls.current.clear();
  }, []);
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    downloadUrls.current.add(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
    window.setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 0);
  };

  const currentOwnedSnapshot = useCallback(() => {
    const current = store.getSnapshot();
    const latest = current.snapshot;
    if (!latest || `${latest.workspaceId}:${latest.privacyEpoch}` !== workspaceOwner || current.refreshRequired) {
      throw new Error('Refresh the current workspace before continuing this archive action.');
    }
    return latest;
  }, [store, workspaceOwner]);
  const archiveCommand = useCallback(async <K extends WorkspaceCommand['kind'],>(command: WorkspaceCommand, kind: K) => {
    const before = currentOwnedSnapshot();
    const current = store.getSnapshot();
    if (current.busy || current.pendingCommand) throw new Error('Resolve the current workspace command before continuing.');
    const response = await store.execute(command);
    const receipt = receiptFor(response, kind);
    const latest = response.snapshot ?? store.getSnapshot().snapshot;
    if (!receipt || !latest || `${latest.workspaceId}:${latest.privacyEpoch}` !== workspaceOwner ||
        latest.revision < before.revision) {
      throw new Error(`The exact ${kind} command has not been confirmed. Inspect its receipt before continuing.`);
    }
    return { receipt, latest };
  }, [store, currentOwnedSnapshot, workspaceOwner]);

  const backupImportCapability = useMemo(() => {
    if (!store.preparePortableBackupImport) return { available: false as const, reason: 'Backup import is unavailable in this workspace session.' };
    return { available: true as const, action: {
      controller: {
        prepareBackupImport: async (bytes: string | Uint8Array): Promise<BackupImportPreview> => {
          if (typeof bytes === 'string') throw new Error('Choose a local JSON backup file.');
          const latest = currentOwnedSnapshot();
          if (!(bytes instanceof Uint8Array)) throw new Error('The selected backup could not be read. Choose it again.');
          const prepare = store.preparePortableBackupImport;
          if (!prepare) throw new Error('Backup import is unavailable in this workspace session.');
          return prepare.call(store, new Uint8Array(bytes), latest.revision);
        },
        applyBackupImport: async (input: { sessionId: string; planHash: string }): Promise<ImportedBackupArchive> => {
          const { receipt, latest } = await archiveCommand({ kind: 'backup.import.apply', ...input }, 'backup.import.apply');
          if (receipt.kind !== 'backup.import.apply') throw new Error('The import receipt did not match this command.');
          const archive = latest.state.importedBackups.find((item) => item.id === receipt.archiveId);
          if (!archive) throw new Error('The import is confirmed, but its archive is not in the current snapshot. Refresh before continuing.');
          return archive as unknown as ImportedBackupArchive;
        },
      } satisfies Pick<AppController, 'prepareBackupImport' | 'applyBackupImport'>,
      chooseBackup: async () => {
        backupPickerController.current?.abort();
        const controller = new AbortController();
        backupPickerController.current = controller;
        try { return await pickPortableBackup(controller.signal); }
        finally { if (backupPickerController.current === controller) backupPickerController.current = undefined; }
      },
    } };
  }, [store, currentOwnedSnapshot, archiveCommand]);

  const archiveDocumentActions = useMemo(() => ({ available: true as const, action: {
    activateImportedDocument: async (input: Parameters<AppController['activateImportedDocument']>[0]) => {
      const { receipt, latest } = await archiveCommand({ kind: 'backup.document.activate', ...input }, 'backup.document.activate');
      if (receipt.kind !== 'backup.document.activate' || receipt.archiveId !== input.archiveId || receipt.documentId !== input.documentId) {
        throw new Error('The document activation receipt did not match this selection.');
      }
      const document = latest.state.documents.find((item) => item.path === input.destinationPath);
      if (!document || document.revision !== receipt.documentRevision) throw new Error('The activated document is not present in the current snapshot. Refresh the library.');
      return { status: receipt.status, document: document as unknown as ContextDocument, mirrorPending: receipt.mirrorPending };
    },
  } }), [archiveCommand]);

  const importedKnowledgeActions = useMemo(() => {
    const kinds = new Map<string, 'person' | 'project'>();
    const available = store.prepareImportedKnowledgeActivation && store.cancelImportedKnowledgeActivation;
    if (!available) return { available: false as const, reason: 'Imported knowledge activation is unavailable in this workspace session.' };
    return { available: true as const, action: {
      prepareImportedKnowledgeActivation: async (input: Parameters<AppController['prepareImportedKnowledgeActivation']>[0]) => {
        const latest = currentOwnedSnapshot();
        const prepare = store.prepareImportedKnowledgeActivation;
        if (!prepare) throw new Error('Imported knowledge activation is unavailable in this workspace session.');
        const preview = await prepare.call(store, { ...input, expectedRevision: latest.revision });
        kinds.set(preview.sessionId, preview.kind);
        return preview;
      },
      cancelImportedKnowledgeActivation: async (sessionId: string) => {
        await store.cancelImportedKnowledgeActivation!(sessionId);
        kinds.delete(sessionId);
      },
      activateImportedKnowledgeEntity: async (input: Parameters<AppController['activateImportedKnowledgeEntity']>[0]) => {
        const kind = kinds.get(input.sessionId);
        if (!kind) throw new Error('The exact imported knowledge preview is no longer available. Prepare it again.');
        const { receipt, latest } = await archiveCommand({ kind: 'backup.knowledge.activate', ...input }, 'backup.knowledge.activate');
        if (receipt.kind !== 'backup.knowledge.activate') throw new Error('The knowledge activation receipt did not match this command.');
        const entity = kind === 'person'
          ? latest.state.knowledge.people.find((item) => item.id === receipt.objectId)
          : latest.state.knowledge.projects.find((item) => item.id === receipt.objectId);
        const document = latest.state.documents.find((item) => item.path === receipt.documentPath);
        if (!entity || !document || document.revision !== receipt.documentRevision) throw new Error('The activated knowledge is not present in the current snapshot. Refresh the library.');
        kinds.delete(input.sessionId);
        return { entity, document } as Awaited<ReturnType<AppController['activateImportedKnowledgeEntity']>>;
      },
    } };
  }, [store, currentOwnedSnapshot, archiveCommand]);

  const importedChatActions = useMemo(() => ({ available: true as const, action: {
    deleteImportedChatConversation: async (input: Parameters<AppController['deleteImportedChatConversation']>[0]) => {
      const { receipt } = await archiveCommand({ kind: 'backup.chat.delete', ...input }, 'backup.chat.delete');
      if (receipt.kind !== 'backup.chat.delete' || !receipt.deleted || receipt.archiveId !== input.archiveId || receipt.conversationId !== input.conversationId) {
        throw new Error('The archived conversation deletion receipt did not match this selection.');
      }
    },
  } }), [archiveCommand]);

  const exportWorkspace = async () => {
    try {
      const current = currentOwnedSnapshot();
      if (!store.exportPortableBackup) throw new Error('Workspace export is unavailable in this session.');
      const bytes = await store.exportPortableBackup(current.revision);
      currentOwnedSnapshot();
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      downloadBlob(new Blob([copy.buffer], { type: 'application/json' }), 'still-backup.json');
    } catch (error) { setNotice(errText(error)); }
  };

  const exportSelectedAudio = async () => {
    if (!selectedMediaId || !store.downloadAudio) return;
    const owner = selectedNoteOwnerKey;
    try {
      const downloaded = await store.downloadAudio(selectedMediaId);
      if (selectedNoteOwner.current !== owner) return;
      downloadBlob(downloaded.blob, downloaded.filename);
    } catch (error) { if (selectedNoteOwner.current === owner) setNotice(errText(error)); }
  };

  return (
    <WorkspaceScreen
      model={{ activeTab: tab, busy: state.busy, tabBarVisible: true, tabNavigationLocked: Boolean(state.pendingCommand), snapshot, notice: displayedNotice }}
      actions={{ navigation: { selectTab: setTab }, settings: { open: openSettings }, session: { logout: onLogout } }}
    >
      {displayedNotice || state.refreshRequired ? (
        <View style={s.notice}>
          <Text style={s.noticeText} accessibilityRole="alert">{displayedNotice ?? state.error ?? 'The latest command is recorded, but workspace data must be refreshed.'}</Text>
          {state.pendingCommand ? <Button label={`Inspect exact ${state.pendingCommand.kind} command`} tone="quiet" disabled={state.busy} onPress={() => void inspectPendingCommand()} /> : null}
          {state.refreshRequired ? <Button label="Refresh workspace" tone="quiet" disabled={state.busy} onPress={() => void refresh()} /> : null}
        </View>
      ) : null}
      {state.eraseStatus?.status === 'complete' || state.eraseStatus?.status === 'cancelled' ? <View style={s.notice}>
        <Text style={s.noticeText}>{state.eraseStatus.status === 'complete'
          ? 'Workspace erasure is complete. Your owner login remains available.'
          : 'The previous workspace erasure review was cancelled; saved workspace data remains available.'}</Text>
        <Button label="View erasure status" tone="quiet" onPress={openSettings} />
      </View> : null}
      {state.pendingCommand && !displayedNotice && !state.refreshRequired ? (
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
        connectionCapability={connectionCapability}
        mailCapability={settingsMailCapability}
        backgroundPolicyCapability={settingsBackgroundPolicyCapability}
        webPushCapability={webPushCoordinator ? { available: true, coordinator: webPushCoordinator,
          state: state.webPush ?? webPushCoordinator.getSnapshot(), blocked: state.busy || state.refreshRequired || Boolean(state.pendingCommand) } :
          { available: false, reason: 'Browser notification controls are unavailable in this workspace session.' }}
        workspaceEraseCapability={{ status: state.eraseStatus, busy: state.busy, error: state.error, actions: eraseActions,
          ownerKey: `${snapshot.workspaceId}:${snapshot.privacyEpoch}` }}
        credentials={credentials
          ? { available: true, controller: credentials }
          : { available: false, reason: 'Provider credentials are unavailable in this workspace view.' } satisfies WorkspaceSettingsCredentialCapability}
        onReloadPreferences={settingsConflict || settingsNeedsReload || state.refreshRequired ? reloadSettings : undefined}
        busy={state.busy || settingsSaving} allowCloseWhileBusy={Boolean(state.backgroundPolicies?.heldCommand)} onClose={closeSettings}
      /> : tab === 'chat' ? (
        <ChatSection
          storageLocation="server"
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          turns={selectedConversation?.turns ?? []}
          busy={state.busy}
          enabled={!state.pendingCommand && !state.refreshRequired}
          disabledReason={state.refreshRequired ? 'Refresh the workspace before sending a message.' : 'Chat is unavailable until the workspace is ready.'}
          recoveryMessage={state.pendingCommand ? 'Check the exact pending command before sending another request.' : undefined}
          knowledgeChoices={knowledgeChoices}
          onSelectConversation={setSelectedConversationId}
          onDeleteReviewChange={(open) => {
            if (open && selectedConversationId) {
              const current = store.getSnapshot().snapshot;
              if (current && `${current.workspaceId}:${current.privacyEpoch}` === workspaceOwner) deleteReviewOwner.current = Object.freeze({
                workspaceId: current.workspaceId, privacyEpoch: current.privacyEpoch, revision: current.revision, conversationId: selectedConversationId,
              });
            } else if (!open && !store.getSnapshot().pendingCommand) deleteReviewOwner.current = undefined;
          }}
          onDeleteConversation={deleteChatConversation}
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
          <LibraryScreen key={`${snapshot.workspaceId}:${snapshot.privacyEpoch}`}
            notes={libraryNotes.map((note) => workspaceNoteCardDisplay({ ...note, recordingAvailable: note.audio?.available === true }))}
            query={libraryQuery} setQuery={setLibraryQuery} docs={dto.documents} tasks={dto.tasks}
            busy={state.busy}
            archiveActions={{
              importedKnowledge: importedKnowledgeActions,
              documents: archiveDocumentActions,
              backupImport: backupImportCapability,
              importedChat: importedChatActions,
            }}
            importedBackups={dto.importedBackups} archiveActionsBlocked={state.refreshRequired || Boolean(state.pendingCommand)}
            knowledge={projectKnowledgeDisplay(dto.knowledge)} workspaceRevision={snapshot.revision} references={[]}
            evidenceLabels={{}} chatEvidenceLabels={safeChatMemoryEvidenceLabels(dto.assistantChatConversations)}
            memoryReviewBlocked={state.refreshRequired || Boolean(state.pendingCommand)}
            previewMode={false} sampleBackupMode={false} knowledgeDemoMode={false}
            reminderRecords={dto.reminders.records} reminderAlerts={{}} reminderDemoMode={false}
            reminderAlertChannel="browser_unavailable"
            reminderActions={{ available: false, reason: 'Reminder creation and management are not connected to server commands yet.' }}
            serverReminderPanel={<CloudReminderPanel records={dto.reminders.records} webPush={state.webPush}
              coordinator={reminderCoordinator} state={state.reminders}
              blocked={state.busy || state.refreshRequired || Boolean(state.pendingCommand)} />}
            onComplete={{ available: true, action: (id) => { void actions.tasks.complete(id).catch((error) => setNotice(errText(error))); } }}
            onReopen={{ available: true, action: (id) => { void actions.tasks.reopen(id).catch((error) => setNotice(errText(error))); } }}
            onOpenNote={(id, expectedRevision) => {
              const note = dto.notes.find((item) => item.id === id && item.revision === expectedRevision);
              if (!note) return;
              setSelectedNoteId(id); setDraft('');
            }}
            documentActions={libraryMutationActions.documents}
            knowledgeEntityActions={cloudKnowledgeEntityActions ? { available: true, action: {
              ...cloudKnowledgeEntityActions,
              archive: (kind, id, expectedRevision, archived) => {
                void cloudKnowledgeEntityActions.archive(kind, id, expectedRevision, archived).catch((error) => {
                  const latest = store.getSnapshot().snapshot;
                  if (latest?.workspaceId === snapshot.workspaceId && latest.privacyEpoch === snapshot.privacyEpoch) setNotice(errText(error));
                });
              },
            } } : libraryMutationActions.entities}
            knowledgeSuggestionActions={libraryMutationActions.suggestions}
            onExport={store.exportPortableBackup ? { available: true, action: () => { void exportWorkspace(); } }
              : { available: false, reason: 'Workspace export is unavailable in this workspace session.' }}
          />
          {selectedNote ? <WorkspaceModals
            key={`${selectedNote.id}:${selectedNote.revision}`}
            storageLocation="server"
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
              confirmImportedTimeZone: selectedNote.importOrigin?.originalTimeZoneUnknown === true
                ? { available: !state.busy && !state.pendingCommand && !state.refreshRequired, reason: 'Resolve the current workspace request before confirming this imported note.' }
                : { available: false, reason: 'This note does not need an imported time zone confirmation.' },
              attachRecording: { available: false, reason: 'Attaching a replacement recording is not connected to the server workspace.' },
              playback: selectedMediaId ? { available: true } : { available: false, reason: 'This saved recording has no validated server media reference for playback.' },
              exportAudio: selectedMediaId && store.downloadAudio ? { available: true } : { available: false, reason: 'This saved recording has no available server download.' },
              cancelTranscription: { available: false, reason: 'Transcription cancellation is not connected to the browser workspace yet.' },
              retryTranscriptionCleanup: { available: false, reason: 'Transcription cleanup is managed by the workspace service.' },
              transcribe: { available: true },
              speechSettings: { available: true },
              assistance: dto.settings.mode === 'provider' && dto.settings.llmProvider === 'openrouter'
                ? { available: true }
                : { available: false, reason: 'Enable OpenRouter provider analysis in Settings to queue this note.' },
              memorySuggestion: { available: false, reason: 'Saving a memory suggestion is not connected to a server command.' },
              chatTransfer: { available: true },
              sourceCheck: { available: false, reason: 'Source rechecks are not connected to the browser workspace yet.' },
              openProposals: { available: true },
            }}
            serverManagedAssistance
            onRetryStatus={() => setNotice('Source rechecks are not connected to this browser workspace yet.')}
            onClose={() => setSelectedNoteId(undefined)}
            onUpdate={(text) => void updateNote(selectedNote, text)}
            onConfirmImportedTimeZone={(timeZone, expectedRevision) => void confirmImportedTimeZone(selectedNote, timeZone, expectedRevision)}
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
            onOpenProposals={() => { setSelectedNoteId(undefined); setTab('inbox'); }}
            onTranscribe={(expectedRevision) => void transcribeNote(selectedNote, expectedRevision)}
            onCancelTranscription={() => setNotice('Native transcription attempt cancellation is unavailable without its native attempt mapping.')}
            transcriptionCommandCancellation={pendingTranscriptionCancellation}
            onCheckAssistantBatch={(jobId) => actions.batch.check(jobId)}
            onOpenSpeechSettings={openSettings}
            onAttachRecording={() => setNotice('Attaching a replacement recording is not connected to the server workspace.')}
            onPlay={() => { void audioPlayback.play(); }}
            playbackState={selectedMediaId ? audioPlayback.state : undefined}
            onPausePlayback={() => audioPlayback.pause()}
            onExportAudio={() => { void exportSelectedAudio(); }}
            onDelete={() => setNotice('Note deletion is not connected to a server command.')}
            voiceChatTransfer={{
              ...(transcriptTransferState.planOwner === `${workspaceOwner}:${selectedNote.id}:${selectedNote.revision}` && transcriptTransferPlan ? { plan: transcriptTransferPlan } : {}),
              conversations,
              selectedConversationId,
              blocked: state.refreshRequired,
              busy: state.busy,
              providerReady: dto.settings.mode === 'provider' && dto.settings.llmProvider === 'openrouter' && Boolean(credentials?.presence?.openrouter),
              onPrepare: () => void prepareTranscriptTransfer(selectedNote),
              onSelectConversation: setSelectedConversationId,
              onCreateConversation: async () => {
                const current = store.getSnapshot();
                if (current.busy || current.pendingCommand || current.refreshRequired || !current.snapshot || `${current.snapshot.workspaceId}:${current.snapshot.privacyEpoch}` !== workspaceOwner) return undefined;
                const response = await store.execute({ kind: 'chat.create' });
                const receipt = receiptFor(response, 'chat.create');
                const latest = response.snapshot ?? store.getSnapshot().snapshot;
                return receipt && latest?.state.assistantChatConversations.find((item) => item.id === receipt.objectId);
              },
              onSend: submitTranscriptTransfer,
              onCancel: (planId) => { void cancelTranscriptTransfer(planId); },
              ...(state.pendingCommand && transcriptTransferCommand?.commandId === state.pendingCommand.commandId
                ? { pendingCommand: { label: `The exact ${transcriptTransferCommand.kind} command is awaiting confirmation. It will not be sent again.`, onInspect: () => { void inspectPendingCommand(); } } }
                : {}),
            }}
          /> : null}
        </>
      ) : <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 16, paddingBottom: 8 }} accessibilityRole="tablist">
          {([['inbox', 'Inbox'], ['activity', 'Activity'], ['history', 'History'], ['mail', 'Mail and calendar']] as const).map(([section, label]) => <Pressable key={section}
            accessibilityRole="tab" accessibilityLabel={`${label} section`} accessibilityState={{ selected: inboxSection === section }} onPress={() => setInboxSection(section)}
            style={{ paddingVertical: 8, paddingHorizontal: 11, borderRadius: 14, borderWidth: 1, borderColor: inboxSection === section ? C.sage : C.border, backgroundColor: inboxSection === section ? '#222821' : C.card }}>
            <Text style={{ color: inboxSection === section ? C.text : C.muted, fontSize: 12 }}>{label}</Text>
          </Pressable>)}
        </View>
        {inboxSection === 'inbox' ? <InboxWorkspaceContent
          proposals={dto.proposals.filter((proposal) => inboxFilter === 'pending'
            ? ['draft', 'approved', 'dispatching', 'failed'].includes(proposal.status)
            : ['accepted', 'executed', 'dismissed', 'simulated', 'unknown'].includes(proposal.status)).map(workspaceProposalCardDisplay)}
          accounts={dto.accounts.map(inboxAccountDisplay)} mailbox={dto.mailbox}
          deviceCalendarAccess="unavailable"
          onReplyMessage={mailCoordinator ? { available: true, action: (messageId) => { setInboxSection('mail'); void mailCoordinator.openReply(messageId); } } : { available: false, reason: 'Mail actions are unavailable until the browser workspace is ready.' }}
          proactive={dto.proactive} filter={inboxFilter} setFilter={setInboxFilter} mode={dto.settings.mode}
          onOpen={mailCoordinator ? { available: true, action: (proposalId) => { setInboxSection('mail'); void mailCoordinator.openProposal(proposalId); } } : { available: false, reason: 'Proposal review is unavailable until the browser workspace is ready.' }}
          busy={state.busy || state.refreshRequired}
          onDismissCandidate={{ available: false, reason: 'Proactive item actions are not connected to this browser workspace yet.' }}
          onSnoozeCandidate={{ available: false, reason: 'Proactive item actions are not connected to this browser workspace yet.' }}
          onRemindCandidate={{ available: false, reason: 'Proactive reminders are not connected to this browser workspace yet.' }}
          onGetCandidateSource={{ available: false, reason: 'Proactive source inspection is not connected to this browser workspace yet.' }}
          onClearChatFilter={() => undefined} /> : null}
        {inboxSection === 'activity' ? <ScrollView contentContainerStyle={s.scroll}>
          <Text style={s.kicker}>ACTIVITY</Text><Text style={s.h1}>Workspace activity</Text>
          {dto.activity.slice().reverse().map((item) => <View key={item.id} style={styles.card}><Text style={styles.body}>{item.message}</Text><Text style={styles.meta}>{new Date(item.createdAt).toLocaleString()}</Text></View>)}
          {!dto.activity.length ? <Text style={styles.meta}>No activity has been saved yet.</Text> : null}
        </ScrollView> : null}
        {inboxSection === 'history' ? <ScrollView contentContainerStyle={s.scroll}>
          <Text style={s.kicker}>HISTORY</Text><Text style={s.h1}>Saved requests</Text>
          {dto.assistantBatchJobs.map((job) => <AssistantBatchJobCard key={job.id} job={job} storageLocation="server" busy={state.busy}
            blocked={state.refreshRequired || Boolean(dto.assistantBatchRecoveryStatus)} onCheck={(jobId) => actions.batch.check(jobId)}
            periodSummaryWorkflow={{ ownerKey: JSON.stringify([snapshot.workspaceId, snapshot.privacyEpoch, job.id, job.updatedAt, job.status]),
              blocked: state.refreshRequired || Boolean(dto.assistantBatchRecoveryStatus),
              onPrepare: actions.batch.prepareSummaryMoreCompute, onSubmit: actions.batch.submitSummaryMoreCompute,
              onCancel: actions.batch.cancelSummaryMoreCompute, onRead: actions.batch.readSummary,
              onPrepareApplication: actions.batch.prepareSummaryApplication, onCancelApplication: actions.batch.cancelSummaryApplication,
              onApplyApplication: actions.batch.applySummaryApplication, onReadApplicationPreview: actions.batch.readSummaryApplicationPreview }} />)}
          {!dto.assistantBatchJobs.length ? <Text style={styles.meta}>No Batch requests have been saved.</Text> : null}
          <Text style={s.sectionTitle}>Saved dispatches</Text>
          {dto.dispatchRecords.map((record) => <View key={record.id} style={styles.card}><Text style={styles.cardTitle}>{record.title}</Text><Text style={styles.meta}>{record.operation} · {record.outcome} · {record.dispatchStartedAt}</Text>
            <Button label="Inspect saved dispatch" tone="quiet" disabled={!mailCoordinator || state.busy} onPress={() => { setInboxSection('mail'); void mailCoordinator?.openDispatch(record.id); }} /></View>)}
          {!dto.dispatchRecords.length ? <Text style={styles.meta}>No saved dispatches have been recorded.</Text> : null}
        </ScrollView> : null}
        {inboxSection === 'mail' ? <ScrollView contentContainerStyle={s.scroll}>
          <CloudMailWorkspace coordinator={mailCoordinator} snapshot={snapshot} busy={state.busy} blocked={state.refreshRequired || Boolean(state.pendingCommand)} />
        </ScrollView> : null}
      </View>}
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
};
