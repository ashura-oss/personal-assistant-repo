import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  AppState as NativeAppState,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type {
  Note,
  Proposal,
  AppState,
  AppSettings,
  AppController,
  ContextDocument,
  AccountCapability,
  LocalTask,
  MailboxSnapshotMessage,
  SavedProactiveRule,
  ProactiveState,
  SavePersonInput,
  SaveProjectInput,
  SaveKnowledgeFactInput,
  SaveKnowledgeContactInput,
  SaveKnowledgeSourceLinkInput,
  SaveKnowledgeMemberInput,
  KnowledgeItemCommand,
  ReviewKnowledgeSuggestionInput,
  EditKnowledgeSuggestionInput,
  StartupRecoveryStatus,
  MailReplyBatchReviewPlan,
  MailReplyBatchSourcesRefreshResult,
  MailReplyContextSelection,
  MailReplyConversationContextDiscovery,
} from "./src/core";
import type {
  ProactiveRecoveryPlan,
  ProactiveRecoveryStatus,
} from "./src/proactive/recovery";
import type { DispatchRecoveryPlan, DispatchRecoveryStatus } from "./src/dispatch/recovery";
import type { StartupRecoveryPlan } from "./src/storage/startupRecovery";
import type { KnowledgeEntityKind, KnowledgeReference, KnowledgeSuggestion, KnowledgeSuggestionReview } from "./src/knowledge/types";
import { SpeechTranscriptionError } from "./src/transcription/types";
import { OPENROUTER_SPEECH_DEFAULT_MODEL } from "./src/transcription/openRouterSpeechProfiles";
import { useAudioCapture } from "./src/audio/useAudioCapture";
import { RecordingAutoStopGate } from "./src/audio/autoStop";
import type { AudioCapture } from "./src/audio/types";
import type { PendingCaptureJournalPort, PendingCaptureReceipt, PendingCaptureSafeStatus } from "./src/audio/pendingCaptureService.types";
import type { ProviderCredentialService } from "./src/services/credentials";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { loadAudioForUpload } from "./src/audio/readAudio";
import { ConnectionsSection } from "./src/ui/ConnectionsSection";
import { ProviderCleanupNotice } from "./src/ui/ProviderCleanupNotice";
import { OAuthConnectionIntentOwnership, oauthInstallFailureWithCleanupContext, runOwnedOAuthConnection, type OAuthConnectionIntentSnapshot } from "./src/ui/oauthConnectionIntent";
import { MailboxSection } from "./src/ui/MailboxSection";
import { MailReplyComposer } from "./src/ui/MailReplyComposer";
import { MailReplyBatchOwnership, mailReplyBatchActivationMatchesOperation, mailReplyBatchIsBlocked, mailReplyBatchPlanMatchesOperation, mailReplyBatchReviewSourceIsBlocked, mailReplyBatchKeyIsReady, rethrowMailReplyBatchError, type MailReplyBatchBlockState, type MailReplyBatchKeyStatus, type MailReplyBatchOwner } from "./src/ui/mailReplyBatchOwnership";
import { ProactiveCandidatesSection } from "./src/ui/ProactiveCandidatesSection";
import { ProactiveRulesSection } from "./src/ui/ProactiveRulesSection";
import { ProactiveMailAlertsSection, type EnableProactiveMailAlertsInput } from "./src/ui/ProactiveMailAlertsSection";
import { ProactiveRecoverySheet, shouldShowProactiveRecoverySection } from "./src/ui/ProactiveRecoverySheet";
import { DispatchRecoverySection } from "./src/ui/DispatchRecoverySection";
import { closeOwnedDispatchRecovery, DispatchRecoveryOwnership, openCurrentDispatchRecoveryAfterNotVerified, runOwnedDispatchRecoveryAction } from "./src/ui/dispatchRecoveryOwnership";
import { useProactiveClock } from "./src/ui/useProactiveClock";
import { ReviewSheet } from "./src/ui/ReviewSheet";
import type { MoreComputeReviewActions } from "./src/ui/MoreComputeReview";
import { moreComputeConfigurationFingerprint, moreComputeWorkspaceIsBlocked } from "./src/ui/moreComputeOwnership";
import { NoteDetail as NoteDetailView } from "./src/ui/NoteDetail";
import { BackupImportSheet } from "./src/ui/BackupImportSheet";
import { ImportedBackupsSection } from "./src/ui/ImportedBackupsSection";
import { RecordingAttachmentSheet } from "./src/ui/RecordingAttachmentSheet";
import { KnowledgeSection } from "./src/ui/KnowledgeSection";
import { KnowledgeEntitySheet } from "./src/ui/KnowledgeEntitySheet";
import { KnowledgeSuggestionSheet } from "./src/ui/KnowledgeSuggestionSheet";
import { ImportedKnowledgeReview } from "./src/ui/ImportedKnowledgeReview";
import { ReminderReview } from "./src/ui/ReminderReview";
import { RemindersSection } from "./src/ui/RemindersSection";
import { DeviceCalendarsSection } from "./src/ui/DeviceCalendarsSection";
import { StartupRecoveryScreen } from "./src/ui/StartupRecoveryScreen";
import { PrivacyCleanupScreen } from "./src/ui/PrivacyCleanupScreen";
import { PrivacyEraseReview } from "./src/ui/PrivacyEraseReview";
import { PendingRecordingRecoveryPanel } from "./src/components/PendingRecordingRecoveryPanel";
import { BackgroundRefreshSection, type BackgroundRefreshActionResult } from "./src/components/BackgroundRefreshSection";
import { AssistantBatchHistorySection } from "./src/ui/AssistantBatchHistorySection";
import { ChatSection } from "./src/ui/ChatSection";
import { safeChatMemoryEvidenceLabels } from "./src/ui/chatMemoryReview";
import { prepareKnowledgeSuggestionReviewWithPrivacy } from "./src/ui/knowledgeSuggestionReviewOwnership";
import { isAcceptedChatSubmission, runAcceptedChatSubmission } from "./src/ui/chatSubmission";
import type { ChatConversationDTO, ChatTranscriptTransferPlan, ChatTurnDTO } from "./src/chat/types";
import { VoiceChatTransferOwnership } from "./src/ui/voiceChatTransferOwnership";
import { createSpeechTranscriptionAdmission, runExplicitSpeechTranscriptionAction } from "./src/ui/speechTranscriptionAction";
import type { AssistantBatchJobDTO } from "./src/services/openRouterBatchJobs";
import { MailAlertPreview } from "./src/dev/mailAlertPreview";
import { MailAlertTapPreview } from "./src/dev/mailAlertTapPreview";
import { ProactiveRecoveryPreview } from "./src/dev/proactiveRecoveryPreview";
import { MailAlertTapReviewSheet, MailAlertTapStatusCard, type MailAlertTapStatus } from "./src/ui/MailAlertTapReviewSheet";
import { createMailAlertTapCoordinator } from "./src/proactiveMailAlerts/taps";
import type { MailAlertTapBackend, MailAlertTapKey, MailAlertTapResolution, MailAlertTapCoordinator } from "./src/proactiveMailAlerts/taps";
import type { BackgroundTaskBackend, BackgroundTaskStatus } from "./src/background/backend.types";
import { TasksSection } from "./src/ui/TasksSection";
import { IconButton, Button, Field } from "./src/ui/primitives";
import { C, s } from "./src/ui/theme";
import {
  authorizeWithBrowser,
  configuredProviderAuth,
  exactRedirectUri,
  scopesFor,
  type OAuthProvider,
} from "./src/auth/browser";
import { exchangeAuthorizationCode } from "./src/connectors/oauth";
import { providerCleanupRegistry } from "./src/services/providerResponseLifetime";
import type { ReminderIntent, ReminderRecord } from "./src/reminders";
import type { PrivacyService, PrivacyWorkspaceSession } from "./src/privacy/service";
import type { PrivacyResourceBoundary } from "./src/privacy/resourceBoundary";
import type { PrivacyAudioBoundary } from "./src/privacy/audioBoundary";
import type { PrivacyPublicStatus, PrivacyErasePlan } from "./src/privacy/types";

type Tab = "inbox" | "record" | "chat" | "library";
const EMPTY_CHAT_CONVERSATIONS: NonNullable<AppState["assistantChatConversations"]> = [];

const previewScenario =
  typeof __DEV__ !== "undefined" && __DEV__
    ? process.env.EXPO_PUBLIC_PREVIEW_SCENARIO
    : undefined;
const isDispatchHistoryDemo = previewScenario === "dispatch-history";
const isMailSyncDemo = previewScenario === "mail-sync";
const isBackupImportDemo = previewScenario === "backup-import";
const isKnowledgeDemo = previewScenario === "knowledge";
const isReminderDemo = previewScenario === "reminders";
const isDeviceCalendarsDemo = previewScenario === "device-calendars";
const isTranscriptionDemo = previewScenario === "transcription";
const isStartupRecoveryDemo = previewScenario === "startup-recovery";
const isPrivacyCleanupDemo = previewScenario === "privacy-cleanup";
const isPendingRecoveryDemo = previewScenario === "pending-recovery";
const isBackgroundRefreshDemo = previewScenario === "background-refresh" && Platform.OS === "web";
const isMailAlertDemo = previewScenario === "mail-alerts" && Platform.OS === "web";
const isMailAlertTapsDemo = previewScenario === "mail-alert-taps" && Platform.OS === "web";
const isProactiveRecoveryDemo = previewScenario === "proactive-recovery" && Platform.OS === "web";
const isOpenRouterBatchDemo = previewScenario === "openrouter-batch" && Platform.OS === "web";
const isOpenRouterChatDemo = previewScenario === "openrouter-chat" && Platform.OS === "web";
const isIsolatedDemo = isDispatchHistoryDemo || isMailSyncDemo || isBackupImportDemo || isKnowledgeDemo || isReminderDemo || isDeviceCalendarsDemo || isTranscriptionDemo || isStartupRecoveryDemo || isPrivacyCleanupDemo || isPendingRecoveryDemo || isBackgroundRefreshDemo || isMailAlertDemo || isMailAlertTapsDemo || isProactiveRecoveryDemo || isOpenRouterBatchDemo || isOpenRouterChatDemo;
const productionChatSubmissionEnabled = true;

export function buildLlmProviderSettingsPatch(
  values: { openRouterEffort: "none" | "low" },
): Partial<AppSettings> {
  return {
    llmProvider: "openrouter",
    openRouterModel: "openai/gpt-6-luna:batch",
    openRouterReasoningEffort: values.openRouterEffort,
  };
}

export function resolveTextAssistanceRoute(
  mode: AppSettings["mode"],
  savedProvider: AppSettings["llmProvider"],
): "preview" | "batch" | "setup_required" {
  if (mode !== "provider") return "preview";
  return savedProvider === "openrouter" ? "batch" : "setup_required";
}

export function buildSpeechProviderSettingsPatch(provider: "azure" | "openrouter"): Partial<AppSettings> {
  return { speechProvider: provider };
}

export function buildProviderCredentialInput(
  speechSubscriptionKey: string,
  openRouterApiKey: string,
): { speechSubscriptionKey?: string; openRouterApiKey?: string } {
  const speech = speechSubscriptionKey.trim();
  return {
    ...(speech ? { speechSubscriptionKey: speech } : {}),
    ...(openRouterApiKey.trim()
      ? { openRouterApiKey: openRouterApiKey.trim() }
      : {}),
  };
}

function useAppState(appController: AppController) {
  return useSyncExternalStore(
    (listener) => appController.subscribe(listener),
    () => appController.getSnapshot(),
    () => appController.getSnapshot(),
  );
}

function freshnessAccountState(state: AppState) {
  return {
    accounts: state.accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      displayName: account.displayName,
      email: account.email,
      connected: account.connected,
      authStatus: account.authStatus,
      identity: account.identity
        ? {
            providerNamespace: account.identity.providerNamespace,
            clientId: account.identity.clientId,
            subject: account.identity.subject,
            issuer: account.identity.issuer,
            tenantId: account.identity.tenantId,
            resourceUserId: account.identity.resourceUserId,
          }
        : undefined,
      grantedScopes: account.grantedScopes,
      capabilities: account.capabilities,
      capabilityLimits: account.capabilityLimits,
      connectionGeneration: account.connectionGeneration,
      lastSyncedAt: account.lastSyncedAt,
      syncStatus: account.syncStatus,
    })),
    syncStates: Object.values(state.syncStates)
      .map((sync) => ({
        accountId: sync.accountId,
        status: sync.status,
        messagesCompletedAt: sync.messagesCompletedAt,
        messagesPartial: sync.messagesPartial,
        calendarsCompletedAt: sync.calendarsCompletedAt,
        calendarsPartial: sync.calendarsPartial,
        eventsCompletedAt: sync.eventsCompletedAt,
        lastStartedAt: sync.lastStartedAt,
        lastSuccessAt: sync.lastSuccessAt,
      }))
      .sort((left, right) => left.accountId.localeCompare(right.accountId)),
  };
}

function knowledgeAccountIdentityKey(account: AppState['accounts'][number]) {
  const identity = account.identity;
  if (!account.connected || account.authStatus !== 'connected' || account.provider === 'local' ||
      !identity?.providerNamespace || identity.providerNamespace !== account.provider ||
      !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId)) return undefined;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function knowledgeReferenceOptions(state: AppState) {
  const structuredNarrativePaths = new Set([
    ...state.knowledge.people.map((entity) => entity.narrativePath),
    ...state.knowledge.projects.map((entity) => entity.narrativePath),
  ]);
  const references: { reference: KnowledgeReference; label: string }[] = [
    ...state.notes.filter((note) => note.origin !== 'assistant_chat').map((note) => ({ reference: { kind: 'note' as const, id: note.id }, label: `Note · ${(note.transcript || 'Untitled note').slice(0, 70)}` })),
    ...state.tasks.map((task) => ({ reference: { kind: 'task' as const, id: task.id }, label: `Task · ${task.title}` })),
    ...state.documents.filter((document) => !structuredNarrativePaths.has(document.path)).map((document) => ({ reference: { kind: 'document' as const, id: document.path }, label: `Document · ${friendlyDocumentName(document.path)}` })),
    ...state.knowledge.people.filter((person) => !person.archivedAt).map((person) => ({ reference: { kind: 'person' as const, id: person.id }, label: `Person · ${person.name}${person.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}` })),
    ...state.knowledge.projects.filter((project) => !project.archivedAt).map((project) => ({ reference: { kind: 'project' as const, id: project.id }, label: `Project · ${project.name}${project.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}` })),
  ];
  for (const message of state.mailbox) {
    const account = state.accounts.find((item) => item.id === message.accountId);
    const identityKey = account && knowledgeAccountIdentityKey(account);
    if (!account || !identityKey || !account.capabilities?.includes('mail.read') ||
        typeof message.connectionGeneration !== 'number' || message.providerDeletedAt ||
        message.verifiedIdentityKey !== identityKey || message.identityKey !== `${identityKey}:${message.providerMessageId}` ||
        message.connectionGeneration !== account.connectionGeneration) continue;
    references.push({ reference: { kind: 'mail', id: message.providerMessageId, identityKey, connectionGeneration: message.connectionGeneration }, label: `Saved mail · ${message.subject || message.from || 'No subject'}` });
  }
  for (const event of state.calendarEvents) {
    const account = state.accounts.find((item) => item.id === event.accountId);
    const identityKey = account && knowledgeAccountIdentityKey(account);
    if (!account || !identityKey || !account.capabilities?.includes('calendar.read') ||
        typeof event.connectionGeneration !== 'number' || event.providerDeletedAt ||
        event.verifiedIdentityKey !== identityKey || event.connectionGeneration !== account.connectionGeneration) continue;
    const calendar = state.calendars.find((item) => item.id === event.calendarId && item.accountId === event.accountId && item.connected);
    if (!calendar) continue;
    references.push({ reference: { kind: 'calendar', id: event.providerEventId, calendarId: calendar.providerId ?? calendar.id, identityKey, connectionGeneration: event.connectionGeneration }, label: `Saved calendar item · ${event.subject || 'Untitled event'}` });
  }
  if (state.deviceCalendars.enabled && state.deviceCalendarAccess.status === 'full_access') {
    const now = Date.now();
    for (const event of state.deviceCalendars.events) {
      const calendar = state.deviceCalendars.calendars.find((item) => item.localId === event.calendarId);
      const age = now - Date.parse(event.observedAt);
      if (!calendar || event.cancelled || event.generation !== state.deviceCalendars.generation ||
          !state.deviceCalendars.selectedCalendarIds.includes(event.calendarId) || !Number.isFinite(age) || age < 0 || age > 15 * 60_000) continue;
      references.push({
        reference: { kind: 'device_calendar_event', installationId: state.deviceCalendars.installationId, generation: event.generation,
          calendarId: event.calendarId, eventId: event.nativeEventId, occurrenceStart: event.occurrenceStart },
        label: `On this iPhone · ${calendar.title} · ${event.title || 'Untitled event'}`,
      });
    }
  }
  return references;
}

function knowledgeEvidenceLabels(state: AppState) {
  const labels: Record<string, string> = Object.create(null) as Record<string, string>;
  labels.transcript = 'Saved note transcript';
  for (const note of state.notes.filter((item) => item.origin !== 'assistant_chat')) {
    const label = `Note · ${(note.transcript || 'Untitled note').slice(0, 70)}`;
    labels[note.id] = label;
    labels[`note:${note.id}`] = label;
  }
  for (const task of state.tasks) {
    labels[`task:${encodeURIComponent(task.id)}`] = `Task · ${task.title}`;
  }
  labels['task:index'] = 'Saved task list snapshot';
  for (const document of state.documents) {
    labels[`doc:${document.path}`] = `Document · ${friendlyDocumentName(document.path)}`;
    labels[document.path] = `Document · ${friendlyDocumentName(document.path)}`;
  }
  for (const message of state.mailbox) {
    const account = state.accounts.find((item) => item.id === message.accountId);
    const identityKey = account && knowledgeAccountIdentityKey(account);
    if (!account || !identityKey || !account.capabilities?.includes('mail.read') || message.providerDeletedAt ||
        message.verifiedIdentityKey !== identityKey || message.identityKey !== `${identityKey}:${message.providerMessageId}` ||
        typeof message.connectionGeneration !== 'number' || message.connectionGeneration !== account.connectionGeneration) continue;
    const sourceId = `mail:${encodeURIComponent(identityKey)}:${encodeURIComponent(message.providerMessageId)}`;
    labels[sourceId] = `Saved mail · ${message.subject || message.from || 'No subject'}`;
  }
  for (const event of state.calendarEvents) {
    const account = state.accounts.find((item) => item.id === event.accountId);
    const identityKey = account && knowledgeAccountIdentityKey(account);
    if (!account || !identityKey || !account.capabilities?.includes('calendar.read') || event.providerDeletedAt ||
        event.verifiedIdentityKey !== identityKey || typeof event.connectionGeneration !== 'number' || event.connectionGeneration !== account.connectionGeneration) continue;
    const calendar = state.calendars.find((item) => item.id === event.calendarId && item.accountId === event.accountId);
    const providerCalendarId = calendar?.providerId ?? event.calendarId;
    const sourceId = `calendar-event:${encodeURIComponent(identityKey)}:${encodeURIComponent(providerCalendarId)}:${encodeURIComponent(event.providerEventId)}`;
    labels[sourceId] = `Saved calendar item · ${event.subject || 'Untitled event'}`;
  }
  if (state.deviceCalendars.enabled && state.deviceCalendarAccess.status === 'full_access') {
    const now = Date.now();
    for (const event of state.deviceCalendars.events) {
      const calendar = state.deviceCalendars.calendars.find((item) => item.localId === event.calendarId);
      const age = now - Date.parse(event.observedAt);
      if (!calendar || event.cancelled || event.generation !== state.deviceCalendars.generation ||
          !state.deviceCalendars.selectedCalendarIds.includes(event.calendarId) || !Number.isFinite(age) || age < 0 || age > 15 * 60_000) continue;
      const sourceId = `device_calendar_event:${encodeURIComponent(state.deviceCalendars.installationId)}:${encodeURIComponent(event.calendarId)}:${encodeURIComponent(event.nativeEventId)}:${encodeURIComponent(event.occurrenceStart)}`;
      labels[sourceId] = `On this iPhone · ${calendar.title} · ${event.title || 'Untitled event'}`;
    }
  }
  for (const person of state.knowledge.people) {
    if (!person.archivedAt) labels[`knowledge:person:${person.id}`] = `Person · ${person.name}`;
  }
  for (const project of state.knowledge.projects) {
    if (!project.archivedAt) labels[`knowledge:project:${project.id}`] = `Project · ${project.name}`;
  }
  return labels;
}

function NoteCard({ note, onPress }: { note: Note; onPress: () => void }) {
  const date = new Date(note.capturedAt ?? note.createdAt).toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  );
  const title =
    note.transcript.trim() || (note.audioUri ? "Voice note" : "Untitled note");
  const accessibleTitle =
    title.length > 100 ? `${title.slice(0, 100)}…` : title;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open note ${accessibleTitle}`}
      onPress={onPress}
      style={({ pressed }) => [s.noteCard, pressed && s.pressed]}
    >
      <View style={s.noteTop}>
        <View style={s.noteGlyph}>
          <Ionicons
            accessible={false}
            importantForAccessibility="no"
            name={note.audioUri ? "mic-outline" : "document-text-outline"}
            size={16}
            color={C.muted}
          />
        </View>
        <Text style={s.noteDate}>
        {note.audioAttachment?.durationStatus === "unknown"
          ? `${date} · duration unknown`
          : note.audioUri
          ? `${date} · ${Math.max(1, Math.round(note.durationSeconds))} sec`
            : date}
        </Text>
        <Ionicons
          accessible={false}
          importantForAccessibility="no"
          name="chevron-forward"
          size={16}
          color={C.muted}
        />
      </View>
      <Text numberOfLines={2} style={s.noteTitle}>
        {title}
      </Text>
      <Text style={s.noteSub}>
        {note.importOrigin?.kind === "backup_import" ? (
          [
            "Imported",
            note.importOrigin.audioMissing ? "recording not included" : "unverified source",
            note.importOrigin.originalTimeZoneUnknown ? "time zone unknown" : "",
          ].filter(Boolean).join(" · ")
        ) : note.status === "processed"
          ? "Reviewed"
          : note.status === "error"
            ? "Needs attention"
            : note.transcript
              ? "Transcript saved"
              : "Audio saved · add a transcript when ready"}
      </Text>
    </Pressable>
  );
}

function ProposalCard({
  proposal,
  accounts,
  onPress,
}: {
  proposal: Proposal;
  accounts: AppState["accounts"];
  onPress: () => void;
}) {
  const provider = accounts.find(
    (account) => account.id === proposal.accountId,
  )?.provider;
  const status =
    proposal.status === "dispatching"
      ? "In progress"
      : proposal.status === "unknown"
        ? "Outcome unknown"
        : proposal.status === "failed"
          ? "Needs attention"
          : proposal.status === "simulated"
            ? "Local preview"
            : proposal.status === "accepted"
              ? `Accepted by ${provider === "google" ? "Gmail" : provider === "microsoft" ? "Microsoft" : "provider"}`
              : proposal.status;
  return (
    <Pressable
      onPress={onPress}
      style={s.proposalCard}
      accessibilityRole="button"
    >
      <View style={s.proposalHead}>
        <Text style={s.kind}>
          {proposal.provenance &&
          "kind" in proposal.provenance &&
          proposal.provenance.kind === "mail_reply"
            ? "REPLY DRAFT"
            : proposal.kind.toUpperCase()}
        </Text>
        <Text style={s.status}>{status}</Text>
      </View>
      <Text style={s.proposalTitle}>{proposal.title}</Text>
      <Text style={s.proposalBody} numberOfLines={2}>
        {proposal.body}
      </Text>
      {proposal.lastError ? (
        <Text style={s.errorText}>{proposal.lastError}</Text>
      ) : null}
      <Text style={s.reviewLink}>
        Review details{" "}
        <Ionicons
          accessible={false}
          name="arrow-forward"
          size={13}
          color={C.text}
        />
      </Text>
    </Pressable>
  );
}

type WorkspaceBindings = {
  controller: AppController;
  captureJournal?: PendingCaptureJournalPort;
  backgroundTasks?: BackgroundTaskBackend;
  credentials: ProviderCredentialService;
  audioBoundary?: PrivacyAudioBoundary;
  privacy?: PrivacyService;
  session?: PrivacyWorkspaceSession;
  resources?: PrivacyResourceBoundary;
  mailAlertTaps?: MailAlertTapBackend;
  privacyPreview?: boolean;
  batchPreviewMetrics?: () => { postCount: number; getCount: number };
  chatPreviewMetrics?: () => { postCount: number; getCount: number };
  isolated: boolean;
};

type BootstrapState =
  | { kind: "opening" }
  | { kind: "pending_capture_preview" }
  | { kind: "background_refresh_preview" }
  | { kind: "mail_alert_preview" }
  | { kind: "mail_alert_taps_preview" }
  | { kind: "proactive_recovery_preview" }
  | { kind: "workspace"; bindings: WorkspaceBindings }
  | { kind: "cleanup"; privacy: PrivacyService; status: PrivacyPublicStatus; reason?: "dedicated_ios_build_required" | "secure_context_and_web_locks_required"; failure?: "storage_unavailable" | "lease_lost" | "verification_incomplete"; samplePreview?: boolean }
  | { kind: "unavailable"; reason: "dedicated_ios_build_required" | "secure_context_and_web_locks_required" | "active_work" | "full_restart_required" | "storage_unavailable"; privacy?: PrivacyService; status?: PrivacyPublicStatus }
  | { kind: "preview_error" };

const previewCredentialService: ProviderCredentialService = {
  currentSpeechCredentialGeneration: () => 0,
  assertSpeechCredentialGeneration: () => { throw new Error("Provider credentials are unavailable in sample previews."); },
  readSpeechCredentialSnapshot: async () => ({ key: null, generation: 0 }),
  currentProviderCredentialGeneration: () => 0,
  assertProviderCredentialGeneration: () => { throw new Error("Provider credentials are unavailable in sample previews."); },
  readProviderCredentialSnapshot: async () => ({ key: null, generation: 0 }),
  getCredentials: async () => ({ speechConfigured: false, openAiConfigured: false }),
  readProviderCredential: async () => null,
  setCredentials: async () => { throw new Error("Provider credentials are unavailable in sample previews."); },
  deleteCredentials: async () => ({ speechConfigured: false, openAiConfigured: false }),
};

function isPrivacyBootstrapError(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ["stale_epoch", "cleanup_in_progress", "unsupported_runtime", "control_unavailable"].includes(String((error as { code?: unknown }).code));
}

function isUsableCaptureTimeZone(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function matchesSavedTranscriptPlan(note: Note | undefined, plan: ChatTranscriptTransferPlan): boolean {
  return Boolean(note && note.id === plan.noteId && note.revision === plan.noteRevision &&
    note.transcript === plan.transcript && note.transcript.trim() &&
    note.importOrigin?.originalTimeZoneUnknown !== true &&
    isUsableCaptureTimeZone(note.captureTimeZone) && note.captureTimeZone === plan.captureTimeZone &&
    (note.capturedAt ?? note.createdAt) === plan.capturedAt);
}

function matchesSavedTranscriptNote(note: Note | undefined, expected: Note): boolean {
  return Boolean(note && note.id === expected.id && note.revision === expected.revision &&
    note.transcript === expected.transcript && note.transcript.trim() &&
    note.importOrigin?.originalTimeZoneUnknown !== true &&
    isUsableCaptureTimeZone(note.captureTimeZone) && note.captureTimeZone === expected.captureTimeZone &&
    (note.capturedAt ?? note.createdAt) === (expected.capturedAt ?? expected.createdAt));
}

function oauthAccountLifecycleFingerprint(accounts: readonly AppState["accounts"][number][], provider: OAuthProvider): string {
  return JSON.stringify(accounts.filter((account) => account.provider === provider).map((account) => ({
    id: account.id,
    provider: account.provider,
    connected: account.connected,
    authStatus: account.authStatus,
    connectionGeneration: account.connectionGeneration ?? 0,
    tokenRef: account.tokenRef ?? null,
    capabilities: [...(account.capabilities ?? [])].sort(),
    capabilityLimits: [...(account.capabilityLimits ?? [])].sort(),
    identity: account.identity ? {
      providerNamespace: account.identity.providerNamespace ?? null,
      clientId: account.identity.clientId ?? null,
      subject: account.identity.subject,
      issuer: account.identity.issuer ?? null,
      tenantId: account.identity.tenantId ?? null,
      resourceUserId: account.identity.resourceUserId ?? null,
    } : null,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function ProviderCleanupFallback({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1 }}>
      {children}
      <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 10, zIndex: 20 }}>
        <ProviderCleanupNotice registry={providerCleanupRegistry} scope="all" />
      </View>
    </View>
  );
}

function unavailableReason(): "dedicated_ios_build_required" | "secure_context_and_web_locks_required" {
  return Platform.OS === "web" ? "secure_context_and_web_locks_required" : "dedicated_ios_build_required";
}

function toCleanupPhase(status: PrivacyPublicStatus): "running" | "paused" | "failed" | "complete" {
  if (status.phase === "complete") return "complete";
  if (status.phase === "erasing" || status.phase === "writer_active") return "running";
  if (status.phase === "paused") return "paused";
  return "failed";
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ kind: "opening" });
  const [attempt, setAttempt] = useState(0);
  const [eraseReviewOpen, setEraseReviewOpen] = useState(false);
  const [erasePlan, setErasePlan] = useState<PrivacyErasePlan | undefined>();
  const [erasePhase, setErasePhase] = useState<"prepare" | "preparing" | "ready" | "error" | "unavailable" | "committing">("prepare");
  const [eraseErrorKind, setEraseErrorKind] = useState<"prepare_failed" | "review_expired" | "confirm_failed" | "runtime_unavailable" | undefined>();
  const [eraseBusy, setEraseBusy] = useState(false);
  const [eraseOutcomeUnknown, setEraseOutcomeUnknown] = useState(false);
  const [eraseStatusBusy, setEraseStatusBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const cleanupRunning = useRef(false);
  const freshAllowed = useRef(false);
  const privacyPreviewRef = useRef<import("./src/dev/privacyPreview").PrivacyCleanupPreview | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (isIsolatedDemo) {
          if (isMailAlertDemo) {
            if (alive) setBootstrap({ kind: "mail_alert_preview" });
            return;
          }
          if (isMailAlertTapsDemo) {
            if (alive) setBootstrap({ kind: "mail_alert_taps_preview" });
            return;
          }
          if (isProactiveRecoveryDemo) {
            if (alive) setBootstrap({ kind: "proactive_recovery_preview" });
            return;
          }
          if (isOpenRouterBatchDemo) {
            const { createOpenRouterBatchPreview } = await import("./src/dev/openRouterBatchPreview");
            const selected = await createOpenRouterBatchPreview();
            if (alive) setBootstrap({ kind: "workspace", bindings: { controller: selected.controller, credentials: previewCredentialService, batchPreviewMetrics: selected.getMetrics, isolated: true } });
            return;
          }
          if (isOpenRouterChatDemo) {
            const { createOpenRouterChatPreview } = await import("./src/dev/openRouterBatchPreview");
            const selected = await createOpenRouterChatPreview();
            if (alive) setBootstrap({ kind: "workspace", bindings: { controller: selected.controller, credentials: previewCredentialService, chatPreviewMetrics: selected.getMetrics, isolated: true } });
            return;
          }
          if (isBackgroundRefreshDemo) {
            if (alive) setBootstrap({ kind: "background_refresh_preview" });
            return;
          }
          if (isPendingRecoveryDemo) {
            if (alive) setBootstrap({ kind: "pending_capture_preview" });
            return;
          }
          if (isPrivacyCleanupDemo) {
            const preview = await import("./src/dev/privacyPreview");
            const selected = privacyPreviewRef.current ?? await preview.createPrivacyCleanupPreview();
            privacyPreviewRef.current = selected;
            const status = await selected.privacy.getStatus();
            if (!alive) return;
            if (["erasing", "paused", "complete"].includes(status.phase)) {
              setBootstrap({ kind: "cleanup", privacy: selected.privacy, status, samplePreview: true });
              return;
            }
            setBootstrap({ kind: "workspace", bindings: {
              controller: selected.controller,
              credentials: previewCredentialService,
              privacy: selected.privacy,
              session: selected.session,
              isolated: true,
              privacyPreview: true,
            } });
            return;
          }
          const selected = isDispatchHistoryDemo
            ? await (await import("./src/dev/receiptScenario")).createDispatchHistoryScenario()
            : isMailSyncDemo
              ? await (await import("./src/dev/mailSyncScenario")).createMailSyncScenario({ mockGeneration: true })
              : isBackupImportDemo
                ? await (await import("./src/dev/backupScenario")).createBackupScenario()
                : isKnowledgeDemo
                  ? await (await import("./src/dev/knowledgeScenario")).createKnowledgeScenario()
                  : isReminderDemo
                    ? await (await import("./src/dev/reminderPreview")).createReminderPreview()
                    : isDeviceCalendarsDemo
                      ? await (await import("./src/dev/deviceCalendarPreview")).createDeviceCalendarPreview()
                      : isTranscriptionDemo
                        ? await (await import("./src/dev/transcriptionPreview")).createTranscriptionPreview()
                        : await (await import("./src/dev/startupRecoveryPreview")).createStartupRecoveryPreview();
          if (alive) setBootstrap({ kind: "workspace", bindings: { controller: selected, credentials: previewCredentialService, isolated: true } });
          return;
        }

        const privacyModule = await import("./src/privacy/service");
        const privacy = await privacyModule.getDefaultPrivacyService();
        const status = await privacy.reconcileStartupWriters();
        if (!alive) return;
        if (status.phase === "writer_active") {
          setBootstrap({ kind: "unavailable", reason: "active_work", privacy, status });
          return;
        }
        if (status.phase === "blocked") {
          setBootstrap({ kind: "unavailable", reason: unavailableReason(), privacy, status });
          return;
        }
        if (["erasing", "paused", "complete"].includes(status.phase) && !(status.phase === "complete" && freshAllowed.current)) {
          setBootstrap({ kind: "cleanup", privacy, status });
          return;
        }

        let session: PrivacyWorkspaceSession;
        try {
          session = await privacy.openWorkspace();
        } catch (error) {
          if (isPrivacyBootstrapError(error)) {
            const code = String((error as { code?: unknown }).code ?? "");
            const reason = code === "control_unavailable"
              ? "storage_unavailable"
              : code === "cleanup_in_progress"
                ? "active_work"
                : code === "unsupported_runtime"
                  ? unavailableReason()
                  : "storage_unavailable";
            setBootstrap({ kind: "unavailable", reason, privacy, status });
            return;
          }
          throw error;
        }
        const [{ createPrivacyResourceBoundary }, { createPrivacyAudioBoundary }, credentialModule, recoveryModule] = await Promise.all([
          import("./src/privacy/resourceBoundary"),
          import("./src/privacy/audioBoundary"),
          import("./src/services/credentials"),
          import("./src/audio/recovery"),
        ]);
        const resources = createPrivacyResourceBoundary({ privacy, session });
        const audioBoundary = createPrivacyAudioBoundary({
          privacy,
          session,
          captureNamespace: Platform.OS === "web" ? "browser_audio" : "native_recordings",
        });
        const { credentialStore } = await import("./src/storage/credentials");
        const credentials = credentialModule.createProviderCredentialService(resources.credentialStore(credentialStore));
        const recordingRecovery = await recoveryModule.getRecordingRecoveryService();
        const { createProductionWorkspace } = await import("./src/services/controller");
        const { controller, captureJournal, backgroundTasks, mailAlertTaps } = await createProductionWorkspace({
          privacy,
          session,
          resources,
          credentials,
          audioBoundary,
          integration: { recordingRecovery },
        });
        if (alive) setBootstrap({
          kind: "workspace",
          bindings: { controller, captureJournal, backgroundTasks, mailAlertTaps, privacy, session, resources, audioBoundary, credentials, isolated: false },
        });
      } catch {
        if (!alive) return;
        if (isIsolatedDemo) {
          setBootstrap({ kind: "preview_error" });
          return;
        }
        setBootstrap({ kind: "unavailable", reason: "storage_unavailable" });
      }
    })();
    return () => { alive = false; };
  }, [attempt]);

  const runCleanup = useCallback(async (privacy: PrivacyService, explicit: boolean) => {
    if (cleanupRunning.current) return;
    cleanupRunning.current = true;
    setCleanupBusy(true);
    try {
      if (explicit) {
        setBootstrap((current) => current.kind === "cleanup" ? { ...current, status: { ...current.status, phase: "erasing" } } : current);
      }
      for (let pass = 0; pass < 321; pass += 1) {
        const foreground = Platform.OS === "web"
          ? typeof document !== "undefined" && document.visibilityState === "visible"
          : NativeAppState.currentState === "active";
        if (!foreground) return;
        const result = await privacy.runCleanupPass();
        const status = await privacy.getStatus();
        setBootstrap((current) => current.kind === "cleanup" ? { ...current, status } : current);
        if (status.phase === "complete" || result.phase !== "erasing" || result.attempted === 0 || result.completed === 0) return;
      }
    } catch {
      const status = await privacy.getStatus().catch(() => undefined);
      if (status) setBootstrap({ kind: "cleanup", privacy, status, failure: "storage_unavailable" });
      else setBootstrap({ kind: "unavailable", reason: unavailableReason(), privacy });
    } finally {
      cleanupRunning.current = false;
      setCleanupBusy(false);
    }
  }, []);

  useEffect(() => {
    if (bootstrap.kind === "cleanup" && bootstrap.status.phase === "erasing") {
      const timer = setTimeout(() => { void runCleanup(bootstrap.privacy, false); }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [bootstrap, runCleanup]);

  const requestFreshWorkspace = () => {
    if (bootstrap.kind === "cleanup" && bootstrap.samplePreview && privacyPreviewRef.current) {
      setBootstrap({ kind: "opening" });
      void privacyPreviewRef.current.openFreshWorkspace().then(({ controller, session }) => {
        if (privacyPreviewRef.current) {
          setBootstrap({ kind: "workspace", bindings: {
            controller, credentials: previewCredentialService,
            privacy: privacyPreviewRef.current.privacy, session, isolated: true, privacyPreview: true,
          } });
        }
      }).catch(() => setBootstrap({ kind: "preview_error" }));
      return;
    }
    freshAllowed.current = true;
    setAttempt((value) => value + 1);
  };

  const requestDelete = () => {
    if (bootstrap.kind !== "workspace" || (bootstrap.bindings.isolated && !bootstrap.bindings.privacyPreview)) return;
    setErasePlan(undefined);
    setErasePhase("prepare");
    setEraseErrorKind(undefined);
    setEraseReviewOpen(true);
  };

  const prepareErase = async () => {
    if (bootstrap.kind !== "workspace" || !bootstrap.bindings.privacy || eraseBusy) return;
    setEraseBusy(true); setErasePhase("preparing"); setEraseErrorKind(undefined);
    try {
      const plan = await bootstrap.bindings.privacy.prepareErase();
      setErasePlan(plan); setErasePhase("ready");
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? "");
      if (code === "unsupported_owner") { setErasePhase("unavailable"); setEraseErrorKind("runtime_unavailable"); }
      else { setErasePhase("error"); setEraseErrorKind("prepare_failed"); }
    } finally { setEraseBusy(false); }
  };

  const cancelErase = async () => {
    if (eraseBusy) return;
    setEraseBusy(true);
    try {
      if (erasePlan && bootstrap.kind === "workspace") await bootstrap.bindings.privacy?.cancelErase(erasePlan.sessionId);
      setErasePlan(undefined); setErasePhase("prepare"); setEraseReviewOpen(false); setEraseErrorKind(undefined);
    } catch { setErasePhase("error"); setEraseErrorKind("confirm_failed"); }
    finally { setEraseBusy(false); }
  };

  const confirmErase = async () => {
    if (!erasePlan || bootstrap.kind !== "workspace" || !bootstrap.bindings.privacy || eraseBusy) return;
    const { privacy, controller } = bootstrap.bindings;
    setEraseBusy(true); setErasePhase("committing"); setEraseErrorKind(undefined);
    try {
      await privacy.commitErase({ sessionId: erasePlan.sessionId, planHash: erasePlan.planHash });
      await controller.disposeForPrivacy?.().catch(() => undefined);
      const status = await privacy.getStatus();
      setEraseOutcomeUnknown(false);
      setEraseReviewOpen(false); setErasePlan(undefined);
      setBootstrap({ kind: "cleanup", privacy, status, samplePreview: bootstrap.bindings.privacyPreview });
    } catch {
      const status = await privacy.getStatus().catch(() => undefined);
      if (status && ["erasing", "paused", "complete"].includes(status.phase)) {
        await controller.disposeForPrivacy?.().catch(() => undefined);
        setEraseOutcomeUnknown(false);
        setEraseReviewOpen(false); setErasePlan(undefined);
        setBootstrap({ kind: "cleanup", privacy, status, samplePreview: bootstrap.bindings.privacyPreview });
      } else if (!status || status.epoch !== bootstrap.bindings.session?.epoch) {
        // The commit response or status read may have been lost. Keep the
        // workspace mounted under a blocking screen until status is known.
        setEraseReviewOpen(false);
        setEraseOutcomeUnknown(true);
      } else {
        setErasePhase("error"); setEraseErrorKind("confirm_failed");
      }
    } finally { setEraseBusy(false); }
  };

  const retryEraseStatus = async () => {
    if (eraseStatusBusy || bootstrap.kind !== "workspace" || !bootstrap.bindings.privacy) return;
    setEraseStatusBusy(true);
    try {
      const status = await bootstrap.bindings.privacy.getStatus();
      if (["erasing", "paused", "complete"].includes(status.phase) || status.epoch !== bootstrap.bindings.session?.epoch) {
        await bootstrap.bindings.controller.disposeForPrivacy?.().catch(() => undefined);
        setEraseOutcomeUnknown(false);
        setErasePlan(undefined);
        setBootstrap({ kind: "cleanup", privacy: bootstrap.bindings.privacy, status, samplePreview: bootstrap.bindings.privacyPreview });
      } else {
        setEraseOutcomeUnknown(false);
        setErasePhase("error");
        setEraseErrorKind("confirm_failed");
        setEraseReviewOpen(true);
      }
    } catch {
      // Keep the blocking status-only screen. In particular, never recommit.
    } finally { setEraseStatusBusy(false); }
  };

  if (bootstrap.kind === "opening") return (
    <SafeAreaProvider><SafeAreaView style={s.safe}><ProviderCleanupFallback><View style={[s.viewport, { alignItems: "center", justifyContent: "center", gap: 12 }]}><ActivityIndicator color={C.sage} /><Text style={s.accountSub}>Checking local privacy controls…</Text></View></ProviderCleanupFallback></SafeAreaView></SafeAreaProvider>
  );
  if (bootstrap.kind === "pending_capture_preview") return <PendingCapturePreview />;
  if (bootstrap.kind === "background_refresh_preview") return <BackgroundRefreshPreview />;
  if (bootstrap.kind === "mail_alert_preview") return <MailAlertPreview />;
  if (bootstrap.kind === "mail_alert_taps_preview") return <MailAlertTapPreview />;
  if (bootstrap.kind === "proactive_recovery_preview") return <ProactiveRecoveryPreview />;
  if (bootstrap.kind === "preview_error") return (
    <SafeAreaProvider><SafeAreaView style={s.safe}><View style={s.viewport}><Text style={s.kicker}>ISOLATED PREVIEW</Text><Text style={s.h1}>Sample preview could not load.</Text><Text accessibilityRole="alert" style={s.analysisText}>The sample remained isolated. Reload to try again.</Text><Button label="Reload preview" onPress={() => { if (Platform.OS === "web" && typeof window !== "undefined") window.location.reload(); }} /></View></SafeAreaView></SafeAreaProvider>
  );
  if (bootstrap.kind === "unavailable") return (
    <ProviderCleanupFallback><PrivacyCleanupScreen phase="unavailable" unavailableReason={bootstrap.reason} onRetry={() => setAttempt((value) => value + 1)} onOpenFreshWorkspace={() => setAttempt((value) => value + 1)} /></ProviderCleanupFallback>
  );
  if (bootstrap.kind === "cleanup") return (
    <ProviderCleanupFallback><PrivacyCleanupScreen
      phase={toCleanupPhase(bootstrap.status)}
      steps={bootstrap.status.categoryStates}
      failureKind={bootstrap.failure}
      unavailableReason={bootstrap.reason}
      busy={cleanupBusy}
      completedAt={bootstrap.status.completedAt}
      samplePreview={bootstrap.samplePreview}
      onRetry={() => void runCleanup(bootstrap.privacy, true)}
      onOpenFreshWorkspace={requestFreshWorkspace}
    /></ProviderCleanupFallback>
  );

  return <>
    <Workspace
      key={attempt}
      workspaceGeneration={attempt}
      {...bootstrap.bindings}
      privacyReviewOpen={eraseReviewOpen || eraseOutcomeUnknown}
      privacyOutcomeUnknown={eraseOutcomeUnknown}
      onPrivacyReview={requestDelete}
      onPrivacyInvalidated={() => { setEraseReviewOpen(false); setBootstrap({ kind: "opening" }); setAttempt((value) => value + 1); }}
    />
    {(!bootstrap.bindings.isolated || bootstrap.bindings.privacyPreview) && bootstrap.bindings.privacy ? <PrivacyEraseReview
      open={eraseReviewOpen}
      phase={erasePhase}
      planKey={erasePlan?.sessionId}
      reviewExpiresAt={erasePlan?.expiresAt}
      errorKind={eraseErrorKind}
      samplePreview={bootstrap.bindings.privacyPreview}
      onPrepare={() => void prepareErase()}
      onConfirm={() => void confirmErase()}
      onCancelReview={() => void cancelErase()}
      onClose={() => setEraseReviewOpen(false)}
    /> : null}
    {eraseOutcomeUnknown ? <Modal visible transparent animationType="fade" onRequestClose={() => undefined}>
      <View style={s.privacyUnknownScrim}>
        <View style={s.privacyUnknownCard}>
          <Text style={s.kicker}>STILL · PRIVACY</Text>
          <Text style={s.h1}>Deletion status needs checking.</Text>
          <Text style={s.analysisText}>The confirmation result could not be verified. Your workspace is paused. Check the local deletion status before continuing; this will not submit deletion again.</Text>
          <Button label={eraseStatusBusy ? "Checking deletion status…" : "Retry deletion status"} onPress={() => void retryEraseStatus()} disabled={eraseStatusBusy} />
        </View>
      </View>
    </Modal> : null}
  </>;
}

type WorkspaceProps = WorkspaceBindings & {
  workspaceGeneration: number;
  privacyReviewOpen: boolean;
  privacyOutcomeUnknown?: boolean;
  onPrivacyReview: () => void;
  onPrivacyInvalidated: () => void;
};

function Workspace({ controller, captureJournal, backgroundTasks, mailAlertTaps, credentials, audioBoundary, privacy, session, resources, workspaceGeneration, batchPreviewMetrics, chatPreviewMetrics, isolated: isIsolatedDemo, privacyReviewOpen, privacyOutcomeUnknown = false, onPrivacyReview, onPrivacyInvalidated }: WorkspaceProps) {
  const state = useAppState(controller);
  const [tab, setTab] = useState<Tab>(isOpenRouterChatDemo ? "chat" : isBackupImportDemo || isKnowledgeDemo || isReminderDemo || isTranscriptionDemo ? "library" : isIsolatedDemo ? "inbox" : "record");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backgroundStatusRefreshKey, setBackgroundStatusRefreshKey] = useState(0);
  const [detail, setDetail] = useState<Note | null>(null);
  const [recordingAttachmentNoteId, setRecordingAttachmentNoteId] = useState<string | null>(null);
  const [cancelingTranscriptionId, setCancelingTranscriptionId] = useState<string | undefined>();
  const [retryingTranscriptionCleanupId, setRetryingTranscriptionCleanupId] = useState<string | undefined>();
  const transcriptionCleanupActionRef = useRef<string | undefined>(undefined);
  const [transcribingNoteId, setTranscribingNoteId] = useState<string | undefined>();
  const [review, setReview] = useState<Proposal | null>(null);
  const reviewRef = useRef<Proposal | null>(review);
  const reviewedMailSourceOwnershipRef = useRef(new MailReplyBatchOwnership());
  const reviewedMailSourceBusyTicketRef = useRef<object | undefined>(undefined);
  useLayoutEffect(() => {
    reviewRef.current = review;
    reviewedMailSourceOwnershipRef.current.publishOwner(review ? JSON.stringify([review.id, review.revision]) : null);
  }, [review]);
  const [replyMessageId, setReplyMessageId] = useState<string | null>(null);
  const mailReplyBatchOwnershipRef = useRef<MailReplyBatchOwnership | null>(null);
  if (mailReplyBatchOwnershipRef.current == null) mailReplyBatchOwnershipRef.current = new MailReplyBatchOwnership();
  const mailReplyContextSessionsRef = useRef(new Map<string, MailReplyBatchOwner>());
  const [mailReplyOwnerGeneration, setMailReplyOwnerGeneration] = useState(0);
  const [reminderReviewId, setReminderReviewId] = useState<string | null>(null);
  const [reminderSourceAccountLabel, setReminderSourceAccountLabel] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [isolatedPreviewFailed, setIsolatedPreviewFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const oauthIntentOwnershipRef = useRef<OAuthConnectionIntentOwnership | null>(null);
  if (oauthIntentOwnershipRef.current == null) oauthIntentOwnershipRef.current = new OAuthConnectionIntentOwnership();
  const workspaceMountedRef = useRef(false);
  const moreComputeRuntimeRef = useRef({ controller, resources, privacy, session, workspaceGeneration,
    sessionEpoch: session?.epoch ?? null, sessionRuntimeId: session?.runtimeId ?? null });
  const [loading, setLoading] = useState(true);
  const [startupReady, setStartupReady] = useState(false);
  const oauthGateRef = useRef({ workspaceGeneration, privacyReviewOpen, privacyOutcomeUnknown, startupReady, loading, isolated: isIsolatedDemo });
  useLayoutEffect(() => {
    oauthGateRef.current = { workspaceGeneration, privacyReviewOpen, privacyOutcomeUnknown, startupReady, loading, isolated: isIsolatedDemo };
  }, [workspaceGeneration, privacyReviewOpen, privacyOutcomeUnknown, startupReady, loading, isIsolatedDemo]);
  useLayoutEffect(() => {
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
      oauthIntentOwnershipRef.current?.invalidate();
    };
  }, [controller, resources, privacy, session, workspaceGeneration]);
  useLayoutEffect(() => {
    moreComputeRuntimeRef.current = { controller, resources, privacy, session, workspaceGeneration,
      sessionEpoch: session?.epoch ?? null, sessionRuntimeId: session?.runtimeId ?? null };
  }, [controller, resources, privacy, session, workspaceGeneration]);
  const [startupRecoveryStatus, setStartupRecoveryStatus] = useState<StartupRecoveryStatus | undefined>();
  const [startupRecoveryPlan, setStartupRecoveryPlan] = useState<StartupRecoveryPlan | undefined>();
  const [startupRecoveryBusy, setStartupRecoveryBusy] = useState(false);
  const [startupRecoveryError, setStartupRecoveryError] = useState("");
  const [pendingCaptureStatus, setPendingCaptureStatus] = useState<PendingCaptureSafeStatus | null>(null);
  const [pendingCaptureLoading, setPendingCaptureLoading] = useState(Boolean(captureJournal));
  const [pendingCaptureBusy, setPendingCaptureBusy] = useState(false);
  const [pendingCaptureError, setPendingCaptureError] = useState("");
  const mailAlertTapCoordinatorRef = useRef<MailAlertTapCoordinator | null>(null);
  const [mailAlertTapPending, setMailAlertTapPending] = useState(false);
  const [mailAlertTapResolution, setMailAlertTapResolution] = useState<MailAlertTapResolution | null>(null);
  const [mailAlertTapStatus, setMailAlertTapStatus] = useState<MailAlertTapStatus | undefined>();
  const [mailAlertTapReviewRequested, setMailAlertTapReviewRequested] = useState(false);
  const [proactiveRecoveryPlan, setProactiveRecoveryPlan] = useState<ProactiveRecoveryPlan | undefined>();
  const [proactiveRecoveryBusy, setProactiveRecoveryBusy] = useState(false);
  const [proactiveRecoveryError, setProactiveRecoveryError] = useState("");
  const [proactiveRecoveryRequiresRefresh, setProactiveRecoveryRequiresRefresh] = useState(false);
  const [proactiveRecoveryUnknownId, setProactiveRecoveryUnknownId] = useState<string | undefined>();
  const [proactiveRecoveryRefreshedId, setProactiveRecoveryRefreshedId] = useState<string | undefined>();
  const [proactiveRecoverySheetOpen, setProactiveRecoverySheetOpen] = useState(false);
  const [dispatchRecoveryPlan, setDispatchRecoveryPlan] = useState<DispatchRecoveryPlan | undefined>();
  const [dispatchRecoveryBusy, setDispatchRecoveryBusy] = useState(false);
  const [dispatchRecoveryError, setDispatchRecoveryError] = useState("");
  const [dispatchRecoverySheetOpen, setDispatchRecoverySheetOpen] = useState(false);
  const [dispatchRecoveryOwner, setDispatchRecoveryOwner] = useState(0);
  const [dispatchRecoveryUnknownId, setDispatchRecoveryUnknownId] = useState<string | undefined>();
  const [dispatchRecoveryRefreshedId, setDispatchRecoveryRefreshedId] = useState<string | undefined>();
  const privacyInvalidatedCallbackRef = useRef(onPrivacyInvalidated);
  const dispatchRecoveryReadBlockedRef = useRef(true);
  const dispatchRecoveryMutationBlockedRef = useRef(true);
  const [selectedChatConversationId, setSelectedChatConversationId] = useState<string | undefined>();
  const [moreComputeFocusTurnId, setMoreComputeFocusTurnId] = useState<string | undefined>();
  const [knowledgeReviewRequest, setKnowledgeReviewRequest] = useState<{ suggestionId: string; requestId: number } | undefined>();
  const knowledgeReviewRequestSequence = useRef(0);
  const [chatTranscriptTransferPlan, setChatTranscriptTransferPlan] = useState<ChatTranscriptTransferPlan | undefined>();
  const [chatTranscriptTransferPreparedAt, setChatTranscriptTransferPreparedAt] = useState<number | undefined>();
  const [chatTranscriptTransferBusy, setChatTranscriptTransferBusy] = useState(false);
  const [chatTranscriptTransferKeyReady, setChatTranscriptTransferKeyReady] = useState(false);
  const chatTranscriptTransferPlanRef = useRef<ChatTranscriptTransferPlan | undefined>(undefined);
  const chatTranscriptTransferActionRef = useRef(false);
  const chatTranscriptTransferGenerationRef = useRef(0);
  const chatTranscriptTransferActionTokenRef = useRef(0);
  const chatTranscriptTransferOwnershipRef = useRef<VoiceChatTransferOwnership | null>(null);
  if (chatTranscriptTransferOwnershipRef.current == null) chatTranscriptTransferOwnershipRef.current = new VoiceChatTransferOwnership();
  const [chatDeleteReviewOpen, setChatDeleteReviewOpen] = useState(false);
  const [chatInteractionLocked, setChatInteractionLocked] = useState(false);
  const chatInteractionLock = useRef(false);
  const [chatActionFilterNoteId, setChatActionFilterNoteId] = useState<string | undefined>();
  const [foregroundResumeRefreshing, setForegroundResumeRefreshing] = useState(false);
  const [foregroundCatchupComplete, setForegroundCatchupComplete] = useState(isIsolatedDemo);
  const reminderReviewRecord = reminderReviewId
    ? state.reminders.records.find((item) => item.id === reminderReviewId)
    : undefined;
  useProactiveClock(
    controller,
    loading || !startupReady || isIsolatedDemo || privacyReviewOpen,
    state.proactive.lastEvaluation?.nextCheckAt,
  );
  const foregroundMailBusy = useRef(false);
  const foregroundResumeBusy = useRef(false);
  const reminderReconcileBusy = useRef(false);
  const initialForegroundRefreshStarted = useRef(false);
  const audio = useAudioCapture(audioBoundary, captureJournal, { ready: startupReady, maxAudioSeconds: state.settings.maxAudioSeconds });
  const refreshAudioPendingRecovery = audio.refreshPendingRecovery;
  const commitAudioCapture = audio.commit;
  const refreshPendingCaptureStatus = useCallback(async () => {
    if (!captureJournal || isIsolatedDemo) return undefined;
    setPendingCaptureLoading(true);
    try {
      const safe = await controller.getPendingCaptureStatus();
      setPendingCaptureStatus(safe);
      setPendingCaptureError("");
      await refreshAudioPendingRecovery?.();
      return safe;
    } catch {
      const safe: PendingCaptureSafeStatus = { kind: "blocked", reason: "unreadable" };
      setPendingCaptureStatus(safe);
      setPendingCaptureError("The local recording status could not be checked. Retry before starting another recording.");
      return safe;
    } finally { setPendingCaptureLoading(false); }
  }, [captureJournal, controller, isIsolatedDemo, refreshAudioPendingRecovery]);
  useEffect(() => {
    if (!startupReady || !captureJournal || isIsolatedDemo) return;
    let current = true;
    void controller.getPendingCaptureStatus().then(async (safe) => {
      if (!current) return;
      setPendingCaptureStatus(safe);
      setPendingCaptureError("");
      await refreshAudioPendingRecovery?.();
    }).catch(() => {
      if (!current) return;
      setPendingCaptureStatus({ kind: "blocked", reason: "unreadable" });
      setPendingCaptureError("The local recording status could not be checked. Retry before starting another recording.");
    }).finally(() => { if (current) setPendingCaptureLoading(false); });
    return () => { current = false; };
  }, [captureJournal, controller, isIsolatedDemo, refreshAudioPendingRecovery, startupReady]);
  const openPrivacyReview = useCallback(() => {
    if (privacyOutcomeUnknown) return;
    if (busy || audio.status === "recording" || audio.status === "paused") {
      setNotice("Finish or stop active work before reviewing local deletion.");
      return;
    }
    onPrivacyReview();
  }, [audio.status, busy, onPrivacyReview, privacyOutcomeUnknown]);
  const [inboxFilter, setInboxFilter] = useState<"pending" | "done">(
    isDispatchHistoryDemo ? "done" : "pending",
  );
  const [query, setQuery] = useState("");
  const [doc, setDoc] = useState<{ path: string; content: string } | null>(
    null,
  );
  const [docDraft, setDocDraft] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [analysisStatusError, setAnalysisStatusError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [analysisStatusRetry, setAnalysisStatusRetry] = useState(0);
  const [analysisStatusCheckedKey, setAnalysisStatusCheckedKey] = useState("");
  const [reviewFreshnessCheckedKey, setReviewFreshnessCheckedKey] =
    useState("");
  const [reviewFreshnessResult, setReviewFreshnessResult] = useState<{
    key: string;
    current: boolean;
    reason?: string;
  } | null>(null);
  const [reviewFreshnessError, setReviewFreshnessError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [reviewFreshnessRetry, setReviewFreshnessRetry] = useState(0);
  const [answerWindowTick, setAnswerWindowTick] = useState(0);
  const busyLock = useRef(false);
  const moreComputeTicketRef = useRef<object | undefined>(undefined);
  const moreComputePlansRef = useRef(new Map<string, { planId: string; jobId: string; ownerKey: string; controller: AppController }>());
  const moreComputeOwnerViewRef = useRef({ detail: null as Note | null, selectedConversationId: undefined as string | undefined, replyMessageId: null as string | null, mailGeneration: 0, tab: "record" as Tab, globalBlocked: true });
  const [dispatchRecoveryOwnership] = useState(() => new DispatchRecoveryOwnership());
  const speechTranscriptionAdmission = useRef<ReturnType<typeof createSpeechTranscriptionAdmission> | null>(null);
  if (speechTranscriptionAdmission.current == null) speechTranscriptionAdmission.current = createSpeechTranscriptionAdmission();
  const checkedAnalysisKey = useRef("");
  const checkedReviewFreshnessKey = useRef("");
  const mailAlertTapOverlaysOpen = settingsOpen || Boolean(detail) || manualOpen || Boolean(review) ||
    Boolean(replyMessageId) || Boolean(reminderReviewId) || Boolean(doc) || Boolean(recordingAttachmentNoteId) ||
    Boolean(mailAlertTapResolution) || proactiveRecoverySheetOpen || privacyReviewOpen || privacyOutcomeUnknown ||
    chatDeleteReviewOpen || chatInteractionLocked;
  const mailAlertTapCaptureBlocked = audio.status !== "idle" || Boolean(captureJournal &&
    (pendingCaptureLoading || pendingCaptureStatus?.kind !== "empty"));
  const mailAlertTapAutoReady = !isIsolatedDemo && !privacyReviewOpen && !privacyOutcomeUnknown &&
    startupReady && !loading && foregroundCatchupComplete && !busy && !foregroundResumeRefreshing &&
    !mailAlertTapCaptureBlocked && !mailAlertTapOverlaysOpen && (tab === "record" || tab === "inbox");
  const mailAlertTapExplicitReady = !isIsolatedDemo && !privacyReviewOpen && !privacyOutcomeUnknown &&
    startupReady && !loading && foregroundCatchupComplete && !busy && !foregroundResumeRefreshing &&
    !mailAlertTapCaptureBlocked && !mailAlertTapOverlaysOpen;
  const mailAlertTapReady = mailAlertTapAutoReady || (mailAlertTapReviewRequested && mailAlertTapExplicitReady);
  const mailAlertTapReadyRef = useRef(mailAlertTapReady);
  useEffect(() => { mailAlertTapReadyRef.current = mailAlertTapReady; }, [mailAlertTapReady]);

  useEffect(() => {
    if (isIsolatedDemo || Platform.OS === "web" || !mailAlertTaps || !startupReady || loading) return;
    const coordinator = createMailAlertTapCoordinator(mailAlertTaps);
    mailAlertTapCoordinatorRef.current = coordinator;
    void coordinator.start({
      installationId: state.proactiveMailAlerts.installationId,
      isReady: mailAlertTapReadyRef.current,
      resolve: (key: MailAlertTapKey) => controller.resolveProactiveMailAlertTap(key),
      onPendingChange: setMailAlertTapPending,
      onResolution: (_key, resolution) => {
        if (resolution.kind === "mail") {
          setMailAlertTapStatus(undefined);
          setMailAlertTapResolution(resolution);
        } else if (resolution.kind === "status") {
          setMailAlertTapResolution(null);
          setMailAlertTapStatus(resolution);
          setNotice("A mail alert needs review in Settings.");
          setSettingsOpen(true);
        }
        if (resolution.kind !== "blocked") setMailAlertTapReviewRequested(false);
      },
    });
    return () => {
      coordinator.dispose();
      if (mailAlertTapCoordinatorRef.current === coordinator) mailAlertTapCoordinatorRef.current = null;
      setMailAlertTapPending(false);
    };
  }, [controller, isIsolatedDemo, loading, mailAlertTaps, startupReady, state.proactiveMailAlerts.installationId]);

  useEffect(() => {
    mailAlertTapCoordinatorRef.current?.setReady(mailAlertTapReady);
  }, [mailAlertTapReady]);

  const reviewPendingMailAlertTap = useCallback(() => {
    if (!mailAlertTapPending || !mailAlertTapExplicitReady || busyLock.current) return;
    setMailAlertTapReviewRequested(true);
    mailAlertTapCoordinatorRef.current?.setReady(true);
    mailAlertTapCoordinatorRef.current?.retryPending();
  }, [mailAlertTapExplicitReady, mailAlertTapPending]);

  const dismissMailAlertTapStatus = useCallback(() => setMailAlertTapStatus(undefined), []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      let loadStarted = false;
      try {
        loadStarted = true;
        await controller.load();
        if (mounted) {
          const recoveryStatus = await controller.getStartupRecoveryStatus();
          setStartupRecoveryStatus(recoveryStatus);
          setStartupReady(recoveryStatus.phase === "ready");
        }
      } catch {
        if (mounted) {
          if (loadStarted) {
            try {
              const recoveryStatus = await controller.getStartupRecoveryStatus();
              if (mounted) setStartupRecoveryStatus(recoveryStatus);
            } catch {
              if (mounted) setStartupRecoveryStatus({ phase: "unavailable" });
            }
          } else if (isIsolatedDemo) {
            setNotice("The sample remained isolated. Reload to try again.");
            setIsolatedPreviewFailed(true);
          }
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [controller, isIsolatedDemo]);

  const refreshStartupRecoveryStatus = useCallback(async () => {
    try {
      const status = await controller.getStartupRecoveryStatus();
      setStartupRecoveryStatus(status);
      if (status.phase === "ready") {
        setStartupReady(true);
        setStartupRecoveryPlan(undefined);
      }
      return status;
    } catch {
      const status: StartupRecoveryStatus = { phase: "unavailable" };
      setStartupRecoveryStatus(status);
      return status;
    }
  }, [controller]);

  const retryStartup = useCallback(async () => {
    if (startupRecoveryBusy) return;
    setStartupRecoveryBusy(true);
    setStartupRecoveryError("");
    try {
      await controller.retryStartup();
      await refreshStartupRecoveryStatus();
    } catch {
      await refreshStartupRecoveryStatus();
      setStartupRecoveryError("Still could not open the saved data. You can try again.");
    } finally {
      setStartupRecoveryBusy(false);
    }
  }, [controller, refreshStartupRecoveryStatus, startupRecoveryBusy]);

  const prepareStartupRecovery = useCallback(async () => {
    if (startupRecoveryBusy) return;
    setStartupRecoveryBusy(true);
    setStartupRecoveryError("");
    try {
      const plan = await controller.prepareStartupRecovery();
      setStartupRecoveryPlan(plan);
      const status = await controller.getStartupRecoveryStatus();
      setStartupRecoveryStatus(status);
    } catch {
      setStartupRecoveryPlan(undefined);
      await refreshStartupRecoveryStatus();
      setStartupRecoveryError("Could not prepare a recovery plan. No replacement was requested.");
    } finally {
      setStartupRecoveryBusy(false);
    }
  }, [controller, refreshStartupRecoveryStatus, startupRecoveryBusy]);

  const commitStartupRecovery = useCallback(async () => {
    if (startupRecoveryBusy || !startupRecoveryPlan) return;
    setStartupRecoveryBusy(true);
    setStartupRecoveryError("");
    setStartupRecoveryStatus({ phase: "committing", inspection: startupRecoveryStatus?.inspection });
    try {
      await controller.commitStartupRecovery({ sessionId: startupRecoveryPlan.sessionId, planHash: startupRecoveryPlan.planHash });
      setStartupRecoveryPlan(undefined);
      await refreshStartupRecoveryStatus();
    } catch {
      const status = await refreshStartupRecoveryStatus();
      if (status.phase !== "prepared") setStartupRecoveryPlan(undefined);
      setStartupRecoveryError("Recovery could not be confirmed. Retry or cancel this review.");
    } finally {
      setStartupRecoveryBusy(false);
    }
  }, [controller, refreshStartupRecoveryStatus, startupRecoveryBusy, startupRecoveryPlan, startupRecoveryStatus?.inspection]);

  const cancelStartupRecovery = useCallback(async () => {
    if (startupRecoveryBusy) return;
    setStartupRecoveryBusy(true);
    setStartupRecoveryError("");
    try {
      await controller.cancelStartupRecovery();
      setStartupRecoveryPlan(undefined);
      await refreshStartupRecoveryStatus();
    } catch {
      await refreshStartupRecoveryStatus();
      setStartupRecoveryError("The review could not be closed. Your saved data is unchanged.");
    } finally {
      setStartupRecoveryBusy(false);
    }
  }, [controller, refreshStartupRecoveryStatus, startupRecoveryBusy]);

  const notes = [...state.notes].filter((note) => note.origin !== "assistant_chat").sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const filteredNotes = notes.filter((n) =>
    `${n.title} ${n.transcript}`.toLowerCase().includes(query.toLowerCase()),
  );
  const proposals = state.proposals.filter((p) =>
    (!chatActionFilterNoteId || p.noteId === chatActionFilterNoteId) && (inboxFilter === "pending"
      ? ["draft", "approved", "dispatching", "failed"].includes(p.status)
      : ["accepted", "executed", "dismissed", "simulated", "unknown"].includes(
          p.status,
        )),
  );
  const chatConversations = state.assistantChatConversations ?? EMPTY_CHAT_CONVERSATIONS;
  const selectedChatConversation = chatConversations.find((item) => item.id === selectedChatConversationId);
  const chatRecoveryMessage = state.assistantChatRecoveryStatus?.message ?? state.assistantBatchRecoveryStatus?.message ??
    (state.mailAlertRefreshRequired ? "Saved data changed. Refresh local data before continuing." : undefined) ??
    state.proactiveMailAlertRecoveryStatus?.message ?? state.backupRecoveryStatus?.message ??
    state.knowledgeRecoveryStatus?.message ?? state.reminderRecoveryStatus?.message ??
    (captureJournal && pendingCaptureStatus?.kind === "blocked" ? "Recording recovery needs attention before Chat can continue." : undefined);
  const chatAppBlocked = !startupReady || loading || isolatedPreviewFailed || privacyReviewOpen || privacyOutcomeUnknown ||
    audio.status !== "idle" || pendingCaptureLoading || Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty") ||
    foregroundResumeRefreshing || !foregroundCatchupComplete || proactiveRecoverySheetOpen || proactiveRecoveryRequiresRefresh ||
    Boolean(review || replyMessageId || reminderReviewId || detail || doc || recordingAttachmentNoteId || manualOpen || settingsOpen || mailAlertTapResolution);
  const knowledgeReviewBlocked = !startupReady || loading || isIsolatedDemo || isolatedPreviewFailed || privacyReviewOpen || privacyOutcomeUnknown ||
    audio.status !== "idle" || pendingCaptureLoading || Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty") ||
    foregroundResumeRefreshing || !foregroundCatchupComplete || proactiveRecoverySheetOpen || proactiveRecoveryRequiresRefresh ||
    Boolean(state.mailAlertRefreshRequired || state.assistantChatRecoveryStatus || state.assistantBatchRecoveryStatus ||
      state.proactiveMailAlertRecoveryStatus || state.backupRecoveryStatus || state.knowledgeRecoveryStatus || state.reminderRecoveryStatus) ||
    Boolean(review || replyMessageId || reminderReviewId || detail || doc || recordingAttachmentNoteId || manualOpen || settingsOpen ||
      mailAlertTapResolution || mailAlertTapPending || chatDeleteReviewOpen || chatInteractionLocked);
  const knowledgeReviewBlockedRef = useRef(knowledgeReviewBlocked);
  useLayoutEffect(() => { knowledgeReviewBlockedRef.current = knowledgeReviewBlocked; }, [knowledgeReviewBlocked]);
  const chatDisabledReason = isOpenRouterChatDemo
    ? undefined
    : !productionChatSubmissionEnabled
      ? "Chat submission is temporarily disabled while the request path completes its final review. You can still create and read local conversations."
      : chatRecoveryMessage ?? (chatAppBlocked
        ? "Finish recovery or close the current review before using Chat."
        : state.settings.mode !== "provider" || state.settings.llmProvider !== "openrouter"
          ? "Choose OpenRouter in Provider mode to enable queued chat."
          : undefined);
  const chatEnabled = isOpenRouterChatDemo || (productionChatSubmissionEnabled && !isIsolatedDemo && !chatDisabledReason &&
    !chatAppBlocked && !busy &&
    !chatDeleteReviewOpen && !state.assistantChatRecoveryStatus && !state.assistantBatchRecoveryStatus && !state.mailAlertRefreshRequired &&
    state.settings.mode === "provider" && state.settings.llmProvider === "openrouter");
  const activeDetailNote = detail
    ? state.notes.find((note) => note.id === detail.id)
    : undefined;
  const voiceTransferHardBlocked = !startupReady || loading || isIsolatedDemo || isolatedPreviewFailed ||
    privacyReviewOpen || privacyOutcomeUnknown || (busy && !chatTranscriptTransferBusy) ||
    audio.status !== "idle" || pendingCaptureLoading || Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty") ||
    foregroundResumeRefreshing || !foregroundCatchupComplete || proactiveRecoverySheetOpen || proactiveRecoveryRequiresRefresh ||
    Boolean(state.mailAlertRefreshRequired || state.assistantChatRecoveryStatus || state.assistantBatchRecoveryStatus ||
      state.proactiveMailAlertRecoveryStatus || state.backupRecoveryStatus || state.knowledgeRecoveryStatus || state.reminderRecoveryStatus) ||
    Boolean(review || replyMessageId || reminderReviewId || doc || recordingAttachmentNoteId || manualOpen || settingsOpen ||
      mailAlertTapResolution || mailAlertTapPending || chatDeleteReviewOpen || chatInteractionLocked);
  const voiceTransferBlockedRef = useRef(voiceTransferHardBlocked);
  useEffect(() => {
    voiceTransferBlockedRef.current = voiceTransferHardBlocked;
    if (voiceTransferHardBlocked) chatTranscriptTransferGenerationRef.current += 1;
  }, [voiceTransferHardBlocked]);
  const cancelVoiceTransferPlan = useCallback((expectedPlanId?: string) => {
    const current = chatTranscriptTransferPlanRef.current;
    if (!current || (expectedPlanId && current.planId !== expectedPlanId)) return;
    chatTranscriptTransferPlanRef.current = undefined;
    chatTranscriptTransferOwnershipRef.current?.clearPlan(current.planId);
    setChatTranscriptTransferPlan(undefined);
    setChatTranscriptTransferPreparedAt(undefined);
    setChatTranscriptTransferKeyReady(false);
    chatTranscriptTransferGenerationRef.current += 1;
    void controller.cancelChatFromTranscript(current.planId).catch(() => undefined);
  }, [controller]);
  const publishDetailOwner = useCallback((next: Note | null) => {
    const ownership = chatTranscriptTransferOwnershipRef.current!;
    const currentOwner = next ? ownership.captureOwner(next) : undefined;
    if (!currentOwner) {
      cancelVoiceTransferPlan();
      ownership.publishOwner(next);
      chatTranscriptTransferGenerationRef.current += 1;
      chatTranscriptTransferActionTokenRef.current += 1;
      chatTranscriptTransferActionRef.current = false;
      setChatTranscriptTransferBusy(false);
    }
    setDetail(next);
  }, [cancelVoiceTransferPlan]);
  const closeDetail = useCallback(() => publishDetailOwner(null), [publishDetailOwner]);
  useEffect(() => {
    const plan = chatTranscriptTransferPlan;
    if (!plan) return;
    const preparedAt = chatTranscriptTransferPreparedAt;
    const now = Date.now();
    const expiry = Date.parse(plan.expiresAt);
    const currentNote = controller.getSnapshot().notes.find((note) => note.id === plan.noteId);
    if (voiceTransferHardBlocked || !preparedAt || now < preparedAt || !Number.isFinite(expiry) || now >= expiry ||
        !matchesSavedTranscriptPlan(activeDetailNote, plan) || !matchesSavedTranscriptPlan(currentNote, plan)) {
      cancelVoiceTransferPlan(plan.planId);
    }
  }, [activeDetailNote, cancelVoiceTransferPlan, chatTranscriptTransferPlan, chatTranscriptTransferPreparedAt, controller, voiceTransferHardBlocked]);
  useEffect(() => {
    const plan = chatTranscriptTransferPlan;
    if (!plan) return;
    const expiresAt = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      cancelVoiceTransferPlan(plan.planId);
      return;
    }
    const timer = setTimeout(() => cancelVoiceTransferPlan(plan.planId), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [cancelVoiceTransferPlan, chatTranscriptTransferPlan]);
  useEffect(() => () => {
    const current = chatTranscriptTransferPlanRef.current;
    if (current) {
      chatTranscriptTransferPlanRef.current = undefined;
      chatTranscriptTransferOwnershipRef.current?.clearPlan(current.planId);
      void controller.cancelChatFromTranscript(current.planId).catch(() => undefined);
      setChatTranscriptTransferPlan(undefined);
      setChatTranscriptTransferPreparedAt(undefined);
    }
    chatTranscriptTransferGenerationRef.current += 1;
  }, [controller, session?.epoch]);
  const recordingAttachmentNote = recordingAttachmentNoteId
    ? state.notes.find((note) => note.id === recordingAttachmentNoteId)
    : undefined;
  const activeAnalysis = activeDetailNote?.analysis;
  const activeDetailNoteId = activeDetailNote?.id;
  const activeAnalysisFingerprint = activeAnalysis?.fingerprint;
  const currentReviewProposal = review
    ? (state.proposals.find((proposal) => proposal.id === review.id) ?? review)
    : null;
  const reviewMailReplyBatchJobId = currentReviewProposal?.provenance && 'kind' in currentReviewProposal.provenance &&
    currentReviewProposal.provenance.kind === 'mail_reply' && currentReviewProposal.provenance.version === 2 &&
    'batchJobId' in currentReviewProposal.provenance ? currentReviewProposal.provenance.batchJobId : undefined;
  const reviewProposalId = currentReviewProposal?.id;
  const reviewProposalRevision = currentReviewProposal?.revision;
  const reviewProposalStatus = currentReviewProposal?.status;
  const reviewProposalRequiresRebuild = currentReviewProposal?.requiresRebuild;
  const reviewSourceNote = currentReviewProposal
    ? state.notes.find((note) => note.id === currentReviewProposal.noteId)
    : undefined;
  const reviewExpiresAt = currentReviewProposal?.provenance?.expiresAt;
  const answerWindowKey = activeAnalysis?.answeredAsOf ?? "";
  const analysisFreshnessKey = activeAnalysis
    ? JSON.stringify({
        noteId: activeDetailNote?.id,
        noteRevision: activeDetailNote?.revision,
        fingerprint: activeAnalysis.fingerprint,
        sourceVersions: activeAnalysis.sourceVersions,
        settings: state.settings,
        documents: state.documents.map(
          ({ path, revision, content, updatedAt }) => [
            path,
            revision,
            content,
            updatedAt,
          ],
        ),
        tasks: state.tasks.map(
          ({ id, title, body, status, dueAt, createdAt, completedAt }) => [
            id,
            title,
            body,
            status,
            dueAt,
            createdAt,
            completedAt,
          ],
        ),
        calendars: state.calendars.map(
          ({ id, accountId, providerId, name, connected, writable }) => [
            id,
            accountId,
            providerId,
            name,
            connected,
            writable,
          ],
        ),
        events: state.calendarEvents,
        mailbox: state.mailbox,
        ...freshnessAccountState(state),
        answerWindowTick,
      })
    : "";
  const reviewFreshnessKey = currentReviewProposal
    ? JSON.stringify({
        proposalId: currentReviewProposal.id,
        proposalRevision: currentReviewProposal.revision,
        proposalStatus: currentReviewProposal.status,
        requiresRebuild: currentReviewProposal.requiresRebuild,
        provenance: currentReviewProposal.provenance,
        answerWindowTick,
        noteId: reviewSourceNote?.id,
        noteRevision: reviewSourceNote?.revision,
        capturedAt: reviewSourceNote?.capturedAt ?? reviewSourceNote?.createdAt,
        captureTimeZone: reviewSourceNote?.captureTimeZone,
        settings: state.settings,
        documents: state.documents.map(
          ({ path, revision, content, updatedAt }) => [
            path,
            revision,
            content,
            updatedAt,
          ],
        ),
        tasks: state.tasks.map(
          ({ id, title, body, status, dueAt, createdAt, completedAt }) => [
            id,
            title,
            body,
            status,
            dueAt,
            createdAt,
            completedAt,
          ],
        ),
        calendars: state.calendars.map(
          ({ id, accountId, providerId, name, connected, writable }) => [
            id,
            accountId,
            providerId,
            name,
            connected,
            writable,
          ],
        ),
        events: state.calendarEvents,
        mailbox: state.mailbox,
        ...freshnessAccountState(state),
      })
    : "";

  useEffect(() => {
    if (
      !startupReady || privacyReviewOpen ||
      !activeDetailNoteId ||
      !activeAnalysisFingerprint ||
      !analysisFreshnessKey
    )
      return;
    if (checkedAnalysisKey.current === analysisFreshnessKey) return;
    checkedAnalysisKey.current = analysisFreshnessKey;
    let current = true;
    void controller
      .refreshAnalysisStatus(activeDetailNoteId)
      .then(() => {
        if (current) {
          setAnalysisStatusError(null);
          setAnalysisStatusCheckedKey(analysisFreshnessKey);
        }
      })
      .catch(() => {
        if (current) {
          setAnalysisStatusError({
            key: analysisFreshnessKey,
            message:
              "Could not check whether the sources changed. Your saved response is still here.",
          });
          setAnalysisStatusCheckedKey(analysisFreshnessKey);
        }
      });
    return () => {
      current = false;
    };
  }, [
    activeAnalysisFingerprint,
    activeDetailNoteId,
    analysisFreshnessKey,
    analysisStatusRetry,
    controller,
    startupReady,
    privacyReviewOpen,
  ]);

  useEffect(() => {
    if (
      !startupReady || privacyReviewOpen ||
      !reviewProposalId ||
      !reviewProposalStatus ||
      reviewProposalRevision === undefined ||
      !reviewFreshnessKey
    )
      return;
    if (
      ["accepted", "executed", "simulated", "dismissed", "unknown"].includes(
        reviewProposalStatus,
      )
    )
      return;
    if (checkedReviewFreshnessKey.current === reviewFreshnessKey) return;
    checkedReviewFreshnessKey.current = reviewFreshnessKey;
    let current = true;
    void controller
      .checkProposalFreshness(reviewProposalId)
      .then((freshness) => {
        if (current) {
          const latest = controller
            .getSnapshot()
            .proposals.find((proposal) => proposal.id === reviewProposalId);
          if (latest) setReview(latest);
          setReviewFreshnessResult({
            key: reviewFreshnessKey,
            current: freshness.current,
            reason: freshness.reason,
          });
          setReviewFreshnessError(null);
          setReviewFreshnessCheckedKey(reviewFreshnessKey);
        }
      })
      .catch(() => {
        if (current) {
          setReviewFreshnessError({
            key: reviewFreshnessKey,
            message:
              "Could not check whether the sources changed. Actions are paused until the check succeeds.",
          });
          setReviewFreshnessCheckedKey(reviewFreshnessKey);
        }
      });
    return () => {
      current = false;
    };
  }, [
    reviewFreshnessKey,
    reviewProposalId,
    reviewProposalRevision,
    reviewProposalRequiresRebuild,
    reviewProposalStatus,
    reviewFreshnessRetry,
    controller,
    startupReady,
    privacyReviewOpen,
  ]);

  useEffect(() => {
    if (!answerWindowKey) return;
    const answeredAt = Date.parse(answerWindowKey);
    const expiry = (Math.floor(answeredAt / 900_000) + 1) * 900_000;
    const delay = expiry - Date.now() + 20;
    if (!Number.isFinite(expiry) || delay <= 0) {
      const timer = setTimeout(
        () => setAnswerWindowTick(Math.floor(Date.now() / 900_000)),
        0,
      );
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(
      () => setAnswerWindowTick(Math.floor(Date.now() / 900_000)),
      delay,
    );
    return () => clearTimeout(timer);
  }, [answerWindowKey]);

  useEffect(() => {
    if (!reviewExpiresAt) return;
    const expiry = Date.parse(reviewExpiresAt);
    if (!Number.isFinite(expiry)) return;
    const delay = expiry - Date.now() + 20;
    const timer = setTimeout(
      () => setAnswerWindowTick(Math.floor(Date.now() / 900_000)),
      Math.max(0, delay),
    );
    return () => clearTimeout(timer);
  }, [reviewExpiresAt]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (privacyOutcomeUnknown) return undefined;
      if (!startupReady) return undefined;
      if (busyLock.current) return undefined;
      busyLock.current = true;
      setBusy(true);
      setNotice("");
      try {
        return await fn();
      } catch (e) {
        if (isPrivacyBootstrapError(e)) onPrivacyInvalidated();
        else setNotice(messageOf(e));
      } finally {
        busyLock.current = false;
        setBusy(false);
      }
    },
    [onPrivacyInvalidated, privacyOutcomeUnknown, startupReady],
  );
  const proactiveRecoveryBlocked = !startupReady || loading || privacyReviewOpen || privacyOutcomeUnknown ||
    isolatedPreviewFailed || isIsolatedDemo || busy ||
    Boolean(state.mailAlertRefreshRequired) || proactiveRecoveryRequiresRefresh ||
    audio.status !== "idle" || pendingCaptureLoading || foregroundResumeRefreshing || !foregroundCatchupComplete ||
    Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty") ||
    Boolean(review || replyMessageId || reminderReviewId || detail || doc || recordingAttachmentNoteId || manualOpen);
  const dispatchRecoveryReadBlocked = !startupReady || loading || privacyReviewOpen || privacyOutcomeUnknown ||
    isolatedPreviewFailed || isIsolatedDemo || (busy && !dispatchRecoveryBusy) ||
    Boolean(state.assistantChatRecoveryStatus || state.assistantBatchRecoveryStatus ||
      state.proactiveMailAlertRecoveryStatus || state.backupRecoveryStatus || state.knowledgeRecoveryStatus || state.reminderRecoveryStatus) ||
    audio.status !== "idle" || pendingCaptureLoading || foregroundResumeRefreshing || !foregroundCatchupComplete ||
    Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty") || proactiveRecoverySheetOpen ||
    Boolean(review || replyMessageId || reminderReviewId || detail || doc || recordingAttachmentNoteId || manualOpen ||
      mailAlertTapResolution || mailAlertTapPending || chatDeleteReviewOpen || chatInteractionLocked);
  const dispatchRecoveryMutationBlocked = dispatchRecoveryReadBlocked || Boolean(state.mailAlertRefreshRequired || proactiveRecoveryRequiresRefresh);
  const dispatchRecoveryStatus: DispatchRecoveryStatus | undefined = startupReady
    ? controller.getDispatchRecoveryStatus()
    : undefined;
  useLayoutEffect(() => { privacyInvalidatedCallbackRef.current = onPrivacyInvalidated; }, [onPrivacyInvalidated]);
  const dispatchRecoveryReadAllowed = useCallback(() => {
    const ownership = dispatchRecoveryOwnership;
    return !dispatchRecoveryReadBlockedRef.current && (!busyLock.current || ownership?.isBusy === true);
  }, [dispatchRecoveryOwnership]);
  const dispatchRecoveryMutationAllowed = useCallback(() => {
    const ownership = dispatchRecoveryOwnership;
    return !dispatchRecoveryMutationBlockedRef.current && (!busyLock.current || ownership?.isBusy === true);
  }, [dispatchRecoveryOwnership]);
  const reflectDispatchRecoveryBusy = useCallback((actionBusy = dispatchRecoveryOwnership.isBusy) => {
    busyLock.current = actionBusy;
    setBusy(actionBusy);
    setDispatchRecoveryBusy(actionBusy);
  }, [dispatchRecoveryOwnership]);
  useLayoutEffect(() => {
    dispatchRecoveryOwnership.setBackgroundErrorHandler((error) => {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
    });
    dispatchRecoveryReadBlockedRef.current = dispatchRecoveryReadBlocked;
    dispatchRecoveryMutationBlockedRef.current = dispatchRecoveryMutationBlocked;
    const ownership = dispatchRecoveryOwnership;
    if (dispatchRecoveryReadBlocked && ownership.isOpen) {
      const operationId = ownership.invalidate();
      const invalidatedOwner = ownership.owner;
      queueMicrotask(() => {
        if (ownership.owner !== invalidatedOwner || ownership.isOpen) return;
        setDispatchRecoveryOwner(invalidatedOwner);
        setDispatchRecoveryPlan(undefined);
        setDispatchRecoverySheetOpen(false);
      });
      if (operationId) void controller.cancelDispatchRecovery(operationId).catch((error) => {
        if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      });
    } else if (dispatchRecoveryMutationBlocked && ownership.isOpen && ownership.plan) {
      const operationId = ownership.discardPlan(ownership.owner);
      const currentOwner = ownership.owner;
      queueMicrotask(() => {
        if (ownership.owner !== currentOwner || !ownership.isOpen || ownership.plan) return;
        setDispatchRecoveryPlan(undefined);
        setDispatchRecoverySheetOpen(false);
      });
      if (operationId) void controller.cancelDispatchRecovery(operationId).catch((error) => {
        if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      });
    }
  }, [controller, dispatchRecoveryMutationBlocked, dispatchRecoveryOwnership, dispatchRecoveryReadBlocked, onPrivacyInvalidated]);
  useEffect(() => () => {
    const operationId = dispatchRecoveryOwnership.invalidate();
    if (operationId) void controller.cancelDispatchRecovery(operationId).catch((error) => {
      if (isPrivacyBootstrapError(error)) privacyInvalidatedCallbackRef.current();
    });
  }, [controller, dispatchRecoveryOwnership]);
  const openDispatchRecovery = useCallback(() => {
    const status = controller.getDispatchRecoveryStatus();
    const owner = dispatchRecoveryOwnership.open(dispatchRecoveryMutationAllowed, status.plan);
    if (owner === undefined) return;
    setDispatchRecoveryOwner(owner);
    setDispatchRecoveryPlan(status.plan);
    setDispatchRecoveryError("");
    setDispatchRecoverySheetOpen(true);
  }, [controller, dispatchRecoveryMutationAllowed, dispatchRecoveryOwnership]);
  const closeDispatchRecovery = useCallback((owner: number, expectedOperationId?: string) => {
    const closed = closeOwnedDispatchRecovery(dispatchRecoveryOwnership, owner, expectedOperationId);
    if (!closed) return;
    const operationId = closed.operationId;
    setDispatchRecoveryOwner(dispatchRecoveryOwnership.owner);
    setDispatchRecoveryPlan(undefined);
    setDispatchRecoverySheetOpen(false);
    setDispatchRecoveryError("");
    if (operationId) void controller.cancelDispatchRecovery(operationId).catch((error) => {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
    });
  }, [controller, dispatchRecoveryOwnership, onPrivacyInvalidated]);
  const onPrepareDispatchRecovery = useCallback(async (owner: number) => {
    if (!dispatchRecoveryOwnership.isCurrent(owner) || !dispatchRecoveryMutationAllowed()) return;
    setDispatchRecoveryError("");
    try {
      const plan = await runOwnedDispatchRecoveryAction(
        (onAdmitted) => dispatchRecoveryOwnership.prepare(owner, controller, dispatchRecoveryMutationAllowed, onAdmitted),
        reflectDispatchRecoveryBusy,
      );
      if (plan) setDispatchRecoveryPlan(plan);
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else if (dispatchRecoveryOwnership.isCurrent(owner)) setDispatchRecoveryError("The retirement review could not be prepared. No changes were made.");
    }
  }, [controller, dispatchRecoveryMutationAllowed, dispatchRecoveryOwnership, onPrivacyInvalidated, reflectDispatchRecoveryBusy]);
  const onCancelDispatchRecovery = useCallback(async (owner: number, operationId: string) => {
    const ownership = dispatchRecoveryOwnership;
    if (ownership.plan?.operationId !== operationId) return;
    try {
      const canceled = await runOwnedDispatchRecoveryAction(
        (onAdmitted) => ownership.cancel(owner, operationId, controller, dispatchRecoveryReadAllowed, onAdmitted),
        reflectDispatchRecoveryBusy,
      );
      if (canceled && ownership.isCurrent(owner)) {
        const id = ownership.invalidate(owner);
        if (id) void controller.cancelDispatchRecovery(id).catch(() => undefined);
        setDispatchRecoveryOwner(ownership.owner);
        setDispatchRecoveryPlan(undefined);
        setDispatchRecoverySheetOpen(false);
      }
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else if (ownership.isCurrent(owner)) setDispatchRecoveryError("The review could not be cancelled locally. Close and reopen Settings before continuing.");
    }
  }, [controller, dispatchRecoveryReadAllowed, dispatchRecoveryOwnership, onPrivacyInvalidated, reflectDispatchRecoveryBusy]);
  const onConfirmDispatchRecovery = useCallback(async (owner: number, operationId: string) => {
    const ownership = dispatchRecoveryOwnership;
    if (ownership.plan?.operationId !== operationId) return;
    try {
      const result = await runOwnedDispatchRecoveryAction((onAdmitted) => {
        const pending = ownership.confirm(owner, operationId, controller, dispatchRecoveryMutationAllowed, dispatchRecoveryReadAllowed, onAdmitted);
        // The coordinator consumes the exact plan synchronously before its first await.
        if (ownership.plan !== undefined) return Promise.resolve(undefined);
        setDispatchRecoveryPlan(undefined);
        setDispatchRecoveryUnknownId(undefined);
        setDispatchRecoveryRefreshedId(undefined);
        return pending;
      }, reflectDispatchRecoveryBusy);
      if (!result) return;
      if (!ownership.isCurrent(owner)) return;
      setDispatchRecoverySheetOpen(false);
      if (result.status === "applied") {
        ownership.invalidate(owner);
        setDispatchRecoveryOwner(ownership.owner);
        setDispatchRecoveryUnknownId(undefined);
        setDispatchRecoveryRefreshedId(undefined);
        setNotice("Damaged action history was archived locally. Existing remote proposals are permanently read-only.");
      } else {
        setDispatchRecoveryUnknownId(result.operationId);
        setDispatchRecoveryRefreshedId(undefined);
        setDispatchRecoveryError("The retirement outcome is unresolved. Refresh saved data, then inspect the receipt. No action was resent.");
      }
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else if (dispatchRecoveryOwnership.isCurrent(owner)) {
        setDispatchRecoveryError("The retirement outcome could not be confirmed. Refresh saved data and inspect the receipt; do not repeat this review.");
        setDispatchRecoveryUnknownId(operationId);
        setDispatchRecoveryRefreshedId(undefined);
        setDispatchRecoverySheetOpen(false);
      }
    }
  }, [controller, dispatchRecoveryMutationAllowed, dispatchRecoveryOwnership, dispatchRecoveryReadAllowed, onPrivacyInvalidated, reflectDispatchRecoveryBusy]);
  const onRefreshDispatchRecovery = useCallback(async (owner: number, operationId: string) => {
    const isExpected = () => dispatchRecoveryUnknownId === operationId || dispatchRecoveryStatus?.lastOperationId === operationId;
    if (!dispatchRecoveryOwnership.isCurrent(owner) || !dispatchRecoveryReadAllowed() || !isExpected()) return;
    setDispatchRecoveryRefreshedId(undefined);
    try {
      const refreshed = await runOwnedDispatchRecoveryAction(
        (onAdmitted) => dispatchRecoveryOwnership.refresh(owner, operationId, controller, dispatchRecoveryReadAllowed, isExpected, onAdmitted),
        reflectDispatchRecoveryBusy,
      );
      if (refreshed && dispatchRecoveryOwnership.isCurrent(owner) && isExpected()) setDispatchRecoveryRefreshedId(operationId);
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else if (dispatchRecoveryOwnership.isCurrent(owner)) setDispatchRecoveryError("Saved data could not be refreshed. The receipt was not inspected.");
    }
  }, [controller, dispatchRecoveryReadAllowed, dispatchRecoveryOwnership, dispatchRecoveryStatus?.lastOperationId, dispatchRecoveryUnknownId, onPrivacyInvalidated, reflectDispatchRecoveryBusy]);
  const onInspectDispatchRecovery = useCallback(async (owner: number, operationId: string) => {
    const isExpected = () => dispatchRecoveryUnknownId === operationId || dispatchRecoveryStatus?.lastOperationId === operationId;
    try {
      const receipt = await runOwnedDispatchRecoveryAction(
        (onAdmitted) => dispatchRecoveryOwnership.inspect(owner, operationId, dispatchRecoveryRefreshedId, controller, dispatchRecoveryReadAllowed, isExpected, onAdmitted),
        reflectDispatchRecoveryBusy,
      );
      if (!receipt) return;
      if (!dispatchRecoveryOwnership.isCurrent(owner) || !isExpected()) return;
      if (receipt.status === "applied") {
        setDispatchRecoveryUnknownId(undefined);
        setDispatchRecoveryRefreshedId(undefined);
        setDispatchRecoveryError("");
        setNotice("The saved receipt confirms the action history was retired. No remote action was resent.");
      } else if (receipt.status === "not_verified") {
        setDispatchRecoveryRefreshedId(undefined);
        setDispatchRecoveryError("The previous local retirement could not be verified. This starts a separate review of the current damaged history.");
      } else {
        setDispatchRecoveryRefreshedId(undefined);
        setDispatchRecoveryError("The saved receipt is unavailable and does not establish an outcome. Refresh local data before inspecting again.");
      }
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else if (dispatchRecoveryOwnership.isCurrent(owner)) setDispatchRecoveryError("The saved receipt could not be inspected. Refresh local data before trying again.");
    }
  }, [controller, dispatchRecoveryOwnership, dispatchRecoveryReadAllowed, dispatchRecoveryRefreshedId, dispatchRecoveryStatus?.lastOperationId, dispatchRecoveryUnknownId, onPrivacyInvalidated, reflectDispatchRecoveryBusy]);
  const onReviewCurrentDispatchRecovery = useCallback((owner: number, previousOperationId: string) => {
    if (dispatchRecoveryUnknownId !== previousOperationId) return;
    const currentStatus = controller.getDispatchRecoveryStatus();
    const newOwner = openCurrentDispatchRecoveryAfterNotVerified(
      dispatchRecoveryOwnership,
      owner,
      previousOperationId,
      () => currentStatus,
      dispatchRecoveryMutationAllowed,
    );
    if (newOwner === undefined) return;
    setDispatchRecoveryOwner(newOwner);
    setDispatchRecoveryPlan(undefined);
    setDispatchRecoveryUnknownId(undefined);
    setDispatchRecoveryRefreshedId(undefined);
    setDispatchRecoveryError("The previous local retirement could not be verified. This starts a separate review of the current damaged history.");
    setDispatchRecoverySheetOpen(true);
  }, [controller, dispatchRecoveryMutationAllowed, dispatchRecoveryOwnership, dispatchRecoveryUnknownId]);
  const runProactiveRecovery = useCallback(async <T,>(fallback: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (proactiveRecoveryBlocked || busyLock.current) return undefined;
    busyLock.current = true;
    setBusy(true);
    setProactiveRecoveryBusy(true);
    setProactiveRecoveryError("");
    try {
      return await action();
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else setProactiveRecoveryError(fallback);
      return undefined;
    } finally {
      busyLock.current = false;
      setBusy(false);
      setProactiveRecoveryBusy(false);
    }
  }, [onPrivacyInvalidated, proactiveRecoveryBlocked]);
  const onPrepareProactiveRecovery = useCallback(async () => {
    const plan = await runProactiveRecovery("Could not prepare a recovery review. No changes were made.", () => controller.prepareProactiveRecovery());
    if (plan) setProactiveRecoveryPlan(plan);
  }, [controller, runProactiveRecovery]);
  const onCancelProactiveRecovery = useCallback(async (operationId?: string): Promise<boolean> => {
    if (operationId) {
      try {
        await controller.cancelProactiveRecovery(operationId);
      } catch {
        setProactiveRecoveryError("The recovery review could not be closed. Try again.");
        return false;
      }
    }
    setProactiveRecoveryPlan(undefined);
    setProactiveRecoveryError("");
    setProactiveRecoverySheetOpen(false);
    return true;
  }, [controller]);
  const closeSettings = useCallback(async () => {
    const dispatchRecoveryWasOpen = dispatchRecoveryOwnership.isOpen;
    const dispatchOperationId = dispatchRecoveryOwnership.invalidate();
    if (dispatchRecoveryWasOpen) {
      setDispatchRecoveryOwner(dispatchRecoveryOwnership.owner);
      setDispatchRecoveryPlan(undefined);
      setDispatchRecoverySheetOpen(false);
      if (dispatchOperationId) void controller.cancelDispatchRecovery(dispatchOperationId).catch((error) => {
        if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      });
    }
    if (proactiveRecoverySheetOpen) {
      const operationId = proactiveRecoveryPlan?.operationId ?? controller.getProactiveRecoveryStatus().plan?.operationId;
      const cancelled = await onCancelProactiveRecovery(operationId);
      if (!cancelled) return;
    }
    setSettingsOpen(false);
  }, [controller, dispatchRecoveryOwnership, onCancelProactiveRecovery, onPrivacyInvalidated, proactiveRecoveryPlan?.operationId, proactiveRecoverySheetOpen]);
  const onConfirmProactiveRecovery = useCallback(async (operationId: string) => {
    if (proactiveRecoveryBlocked || busyLock.current) return;
    busyLock.current = true; setBusy(true); setProactiveRecoveryBusy(true); setProactiveRecoveryError("");
    try {
      const result = await controller.confirmProactiveRecovery({ operationId, confirmation: "RESET RULES" });
      setProactiveRecoveryPlan(undefined);
      setProactiveRecoverySheetOpen(false);
      if (result.status === "applied") {
        setProactiveRecoveryUnknownId(undefined);
        setProactiveRecoveryRefreshedId(undefined);
        setNotice("Attention rules and local attention state were reset. The private recovery copy was retained.");
      } else {
        setProactiveRecoveryUnknownId(result.operationId);
        setProactiveRecoveryRefreshedId(undefined);
      }
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else {
        setProactiveRecoveryPlan(undefined);
        setProactiveRecoveryRequiresRefresh(true);
        setProactiveRecoveryError("This review is no longer current. Prepare a new recovery review before continuing.");
      }
    } finally {
      busyLock.current = false; setBusy(false); setProactiveRecoveryBusy(false);
    }
  }, [controller, onPrivacyInvalidated, proactiveRecoveryBlocked]);
  const openSettings = useCallback(() => {
    if (audio.status === "recording" || audio.status === "paused") {
      setNotice("Stop the recording before changing background checks.");
      return;
    }
    setBackgroundStatusRefreshKey((value) => value + 1);
    setSettingsOpen(true);
    if ((dispatchRecoveryStatus?.status === "refresh_required" && dispatchRecoveryStatus.lastOperationId) || dispatchRecoveryUnknownId) {
      const current = dispatchRecoveryOwnership;
      if (!current.isOpen) {
        const owner = current.open(dispatchRecoveryReadAllowed);
        if (owner !== undefined) setDispatchRecoveryOwner(owner);
      }
    }
  }, [audio.status, dispatchRecoveryOwnership, dispatchRecoveryReadAllowed, dispatchRecoveryStatus, dispatchRecoveryUnknownId]);
  const chatCreateConversation = useCallback(async () => {
    if (chatAppBlocked || busy || chatDeleteReviewOpen || Boolean(mailAlertTapResolution)) {
      setNotice("Chat is unavailable until startup and recovery are ready.");
      return;
    }
    const created = await run(async () => {
      const conversation = await controller.createChatConversation();
      setSelectedChatConversationId(conversation.id);
      setNotice("Conversation created on this device.");
      return conversation;
    });
    if (!created) setNotice("The conversation could not be created yet. Wait for startup or recovery to finish, then try again.");
  }, [busy, chatAppBlocked, chatDeleteReviewOpen, controller, mailAlertTapResolution, run]);
  const prepareTranscriptForChat = useCallback(async () => {
    const noteAtPress = activeDetailNote;
    const ownership = chatTranscriptTransferOwnershipRef.current!;
    const owner = noteAtPress ? ownership.captureOwner(noteAtPress) : undefined;
    if (!noteAtPress || voiceTransferHardBlocked || busyLock.current || chatTranscriptTransferActionRef.current ||
        !owner ||
        noteAtPress.origin === "assistant_chat" || noteAtPress.importOrigin?.originalTimeZoneUnknown === true ||
        !noteAtPress.transcript.trim() || !isUsableCaptureTimeZone(noteAtPress.captureTimeZone)) {
      setNotice("Save a complete transcript with a confirmed capture time zone before reviewing it in Chat.");
      return;
    }
    chatTranscriptTransferActionRef.current = true;
    const actionToken = ++chatTranscriptTransferActionTokenRef.current;
    setChatTranscriptTransferBusy(true);
    const generation = ++chatTranscriptTransferGenerationRef.current;
    try {
      const prepared = await run(async () => {
        const current = controller.getSnapshot().notes.find((note) => note.id === noteAtPress.id);
        if (!matchesSavedTranscriptNote(current, noteAtPress)) throw new Error("The saved transcript changed. Reopen the note before reviewing it in Chat.");
        const outcome = await ownership.prepareOwnedPlan({
          owner,
          readReadiness: async () => {
            const settingsBeforeKeyCheck = controller.getSnapshot().settings;
            let keyReady = false;
            try {
              keyReady = settingsBeforeKeyCheck.mode === "provider" && settingsBeforeKeyCheck.llmProvider === "openrouter" &&
                (await credentials.getCredentials()).openRouterConfigured === true;
            } catch { keyReady = false; }
            return { keyReady, settingsBeforeKeyCheck };
          },
          prepare: async (readiness) => {
            const snapshotAfterKeyCheck = controller.getSnapshot();
            const currentAfterKeyCheck = snapshotAfterKeyCheck.notes.find((note) => note.id === noteAtPress.id);
            if (generation !== chatTranscriptTransferGenerationRef.current || voiceTransferBlockedRef.current ||
                !matchesSavedTranscriptNote(currentAfterKeyCheck, noteAtPress)) {
              throw new Error("The saved transcript or workspace changed. Prepare a fresh review from the note.");
            }
            const keyReady = readiness.keyReady && snapshotAfterKeyCheck.settings.mode === readiness.settingsBeforeKeyCheck.mode &&
              snapshotAfterKeyCheck.settings.llmProvider === readiness.settingsBeforeKeyCheck.llmProvider;
            const plan = await controller.prepareChatFromTranscript({ noteId: noteAtPress.id, expectedRevision: noteAtPress.revision });
            return { plan, keyReady };
          },
          cancelLatePlan: ({ plan }) => controller.cancelChatFromTranscript(plan.planId),
        });
        if (outcome.kind === "stale") throw new Error("The note review changed. Prepare a fresh review from the note.");
        const { plan, keyReady } = outcome.plan;
        const latest = controller.getSnapshot().notes.find((note) => note.id === plan.noteId);
        const expiresAt = Date.parse(plan.expiresAt);
        if (!ownership.owns(owner) || generation !== chatTranscriptTransferGenerationRef.current || voiceTransferBlockedRef.current || plan.noteId !== noteAtPress.id ||
            !matchesSavedTranscriptPlan(latest, plan) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          void controller.cancelChatFromTranscript(plan.planId).catch(() => undefined);
          throw new Error("The saved transcript changed before review. Prepare a fresh review from the note.");
        }
        if (!ownership.publishPlan(plan, owner)) {
          void controller.cancelChatFromTranscript(plan.planId).catch(() => undefined);
          throw new Error("The note review changed before it could be shown. Prepare a fresh review from the note.");
        }
        chatTranscriptTransferPlanRef.current = plan;
        setChatTranscriptTransferPreparedAt(Date.now());
        setChatTranscriptTransferKeyReady(keyReady);
        setChatTranscriptTransferPlan(plan);
        return plan;
      });
      if (!prepared) setNotice("The transcript review could not be prepared. Check the note and try again.");
    } finally {
      if (chatTranscriptTransferActionTokenRef.current === actionToken) {
        chatTranscriptTransferActionRef.current = false;
        setChatTranscriptTransferBusy(false);
      }
    }
  }, [activeDetailNote, controller, credentials, run, voiceTransferHardBlocked]);
  const createTranscriptChatConversation = useCallback(async (expectedPlanId: string) => {
    const ownership = chatTranscriptTransferOwnershipRef.current!;
    const plan = ownership.getPlan(expectedPlanId);
    const owner = plan ? ownership.captureOwner({ id: plan.noteId, revision: plan.noteRevision }) : undefined;
    if (!plan || !owner || chatTranscriptTransferPlanRef.current?.planId !== expectedPlanId ||
        voiceTransferHardBlocked || busyLock.current || chatTranscriptTransferActionRef.current ||
        !matchesSavedTranscriptPlan(controller.getSnapshot().notes.find((note) => note.id === plan.noteId), plan)) return undefined;
    chatTranscriptTransferActionRef.current = true;
    const actionToken = ++chatTranscriptTransferActionTokenRef.current;
    setChatTranscriptTransferBusy(true);
    const generation = chatTranscriptTransferGenerationRef.current;
    try {
      const conversation = await run(async () => controller.createChatConversation());
      if (!conversation || !ownership.owns(owner) || ownership.getPlan(expectedPlanId) !== plan ||
          chatTranscriptTransferPlanRef.current?.planId !== expectedPlanId ||
          generation !== chatTranscriptTransferGenerationRef.current || voiceTransferBlockedRef.current) return undefined;
      if (!controller.getSnapshot().assistantChatConversations?.some((item) => item.id === conversation.id)) {
        throw new Error("The new conversation could not be confirmed in saved Chat history.");
      }
      if (!ownership.owns(owner) || ownership.getPlan(expectedPlanId) !== plan) return undefined;
      setSelectedChatConversationId(conversation.id);
      return conversation;
    } finally {
      if (chatTranscriptTransferActionTokenRef.current === actionToken) {
        chatTranscriptTransferActionRef.current = false;
        setChatTranscriptTransferBusy(false);
      }
    }
  }, [controller, run, voiceTransferHardBlocked]);
  const sendTranscriptToChat = useCallback(async (expectedPlanId: string, conversationId: string) => {
    const ownership = chatTranscriptTransferOwnershipRef.current!;
    const plan = ownership.getPlan(expectedPlanId);
    const owner = plan ? ownership.captureOwner({ id: plan.noteId, revision: plan.noteRevision }) : undefined;
    if (!plan || !owner || chatTranscriptTransferPlanRef.current?.planId !== expectedPlanId ||
        voiceTransferHardBlocked || busyLock.current || chatTranscriptTransferActionRef.current) {
      throw new Error("The transcript review is no longer available. Prepare it again from the note.");
    }
    const preparedAt = chatTranscriptTransferPreparedAt;
    const generation = chatTranscriptTransferGenerationRef.current;
    const expiresAt = Date.parse(plan.expiresAt);
    const now = Date.now();
    if (!preparedAt || now < preparedAt || !Number.isFinite(expiresAt) || now >= expiresAt ||
        !matchesSavedTranscriptPlan(controller.getSnapshot().notes.find((note) => note.id === plan.noteId), plan) ||
        !chatConversations.some((item) => item.id === conversationId)) {
      cancelVoiceTransferPlan(plan.planId);
      throw new Error("The transcript or conversation changed. Prepare a fresh review before sending.");
    }
    chatTranscriptTransferActionRef.current = true;
    const actionToken = ++chatTranscriptTransferActionTokenRef.current;
    setChatTranscriptTransferBusy(true);
    let enteredControllerPath = false;
    try {
      const accepted = await run(async () => {
        if (!ownership.owns(owner) || ownership.getPlan(expectedPlanId) !== plan ||
            chatTranscriptTransferPlanRef.current?.planId !== expectedPlanId || generation !== chatTranscriptTransferGenerationRef.current) {
          throw new Error("The note review changed. Prepare it again from the note.");
        }
        enteredControllerPath = true;
        // The controller consumes the one-use plan at submission admission, before key checks or queued work.
        chatTranscriptTransferPlanRef.current = undefined;
        ownership.clearPlan(expectedPlanId);
        setChatTranscriptTransferPlan(undefined);
        setChatTranscriptTransferPreparedAt(undefined);
        setChatTranscriptTransferKeyReady(false);
        const currentSettings = controller.getSnapshot().settings;
        if (currentSettings.mode !== "provider" || currentSettings.llmProvider !== "openrouter") {
          void controller.cancelChatFromTranscript(plan.planId).catch(() => undefined);
          openSettings();
          throw new Error("Choose OpenRouter in Provider mode before sending a transcript to Chat.");
        }
        const current = controller.getSnapshot().notes.find((note) => note.id === plan.noteId);
        if (now < preparedAt || Date.now() >= expiresAt || !matchesSavedTranscriptPlan(current, plan) ||
            !ownership.owns(owner) ||
            !controller.getSnapshot().assistantChatConversations?.some((item) => item.id === conversationId)) {
          throw new Error("The transcript review expired or changed. Prepare it again before sending.");
        }
        const result = await controller.submitChatFromTranscript({ planId: plan.planId, conversationId });
        if (!isAcceptedChatSubmission(result) || result.conversationId !== conversationId) {
          throw new Error("The saved Chat message could not be confirmed.");
        }
        if (!ownership.owns(owner) || generation !== chatTranscriptTransferGenerationRef.current || voiceTransferBlockedRef.current) {
          throw new Error("The workspace changed while the message was being saved. Check the conversation request status.");
        }
        setSelectedChatConversationId(conversationId);
        setTab("chat");
        closeDetail();
        setNotice("Transcript saved in Chat. Its request status is shown in the conversation.");
        return result;
      });
      if (!enteredControllerPath || !isAcceptedChatSubmission(accepted) || accepted.conversationId !== conversationId) {
        throw new Error("Could not confirm the Chat message. Check the conversation request status before trying again.");
      }
      return accepted;
    } finally {
      if (chatTranscriptTransferActionTokenRef.current === actionToken) {
        chatTranscriptTransferActionRef.current = false;
        setChatTranscriptTransferBusy(false);
      }
    }
  }, [cancelVoiceTransferPlan, chatConversations, chatTranscriptTransferPreparedAt, closeDetail, controller, openSettings, run, voiceTransferHardBlocked]);
  const closeTranscriptTransfer = useCallback((expectedPlanId: string) => {
    if (!chatTranscriptTransferOwnershipRef.current?.getPlan(expectedPlanId)) return;
    cancelVoiceTransferPlan(expectedPlanId);
  }, [cancelVoiceTransferPlan]);
  const chatSend = useCallback(async (text: string) => {
    return runAcceptedChatSubmission(run, async () => {
      if (!isOpenRouterChatDemo && !productionChatSubmissionEnabled) {
        throw new Error("Chat submission is temporarily disabled.");
      }
      if (!isOpenRouterChatDemo && (state.settings.mode !== "provider" || state.settings.llmProvider !== "openrouter")) {
        openSettings();
        throw new Error("Choose OpenRouter in Provider mode before sending a chat message.");
      }
      if (!isOpenRouterChatDemo) {
        const credentialStatus = await credentials.getCredentials();
        if (credentialStatus.openRouterConfigured !== true) {
          openSettings();
          throw new Error("Save an OpenRouter API key in Settings before sending a chat message.");
        }
      }
      if (!selectedChatConversation) throw new Error("Create or select a conversation before sending a message.");
      const accepted = await controller.submitChatTurn({ conversationId: selectedChatConversation.id, text });
      if (!accepted || accepted.kind !== "accepted") throw new Error("The chat request was not explicitly accepted.");
      setNotice(isOpenRouterChatDemo
        ? "SAMPLE · Simulated message saved. Its request status is shown below. No provider or external service was contacted."
        : "Message saved. Its request status is shown below.");
      return accepted;
    });
  }, [controller, credentials, openSettings, run, selectedChatConversation, state.settings.llmProvider, state.settings.mode]);
  const chatRefineTurn = useCallback(async (request: {
    conversationId: string;
    parentTurnId: string;
    parentJobId: string;
    effort: 'medium' | 'high' | 'max';
  }) => runAcceptedChatSubmission(run, async () => {
    if ((!isOpenRouterChatDemo && (!productionChatSubmissionEnabled ||
        state.settings.mode !== 'provider' || state.settings.llmProvider !== 'openrouter')) || chatAppBlocked) {
      throw new Error('Chat refinement is unavailable until the workspace is ready.');
    }
    const liveConversation = (state.assistantChatConversations ?? []).find((item) => item.id === request.conversationId);
    const parent = liveConversation?.turns.find((turn) => turn.id === request.parentTurnId);
    if (!liveConversation || selectedChatConversationId !== request.conversationId || !parent?.reply ||
        parent.job?.status !== 'completed' || parent.job.id !== request.parentJobId) {
      throw new Error('The saved answer changed. Reopen the refinement review.');
    }
    if (!isOpenRouterChatDemo) {
      const credentialStatus = await credentials.getCredentials();
      if (credentialStatus.openRouterConfigured !== true) {
        openSettings();
        throw new Error('Save an OpenRouter API key in Settings before refining a chat answer.');
      }
    }
    const accepted = await controller.refineChatTurn({
      conversationId: request.conversationId,
      parentTurnId: request.parentTurnId,
      effort: request.effort,
    });
    if (!accepted || accepted.kind !== 'accepted' || accepted.conversationId !== request.conversationId) {
      throw new Error('The refinement request was not explicitly accepted.');
    }
    setNotice(isOpenRouterChatDemo
      ? 'SAMPLE · Simulated refinement saved. Its request status is shown below. No provider or external service was contacted.'
      : 'Refinement request saved. Its request status is shown below.');
    return accepted;
  }), [chatAppBlocked, controller, credentials, openSettings, run, selectedChatConversationId, state.assistantChatConversations, state.settings.llmProvider, state.settings.mode]);
  const openChatMemorySuggestion = useCallback((suggestionId: string, conversation: ChatConversationDTO, turn: ChatTurnDTO) => {
    if (knowledgeReviewBlockedRef.current || selectedChatConversationId !== conversation.id || turn.operation === 'chat_refinement' ||
        !(turn.memorySuggestionIds ?? []).includes(suggestionId)) return;
    const currentConversation = (controller.getSnapshot().assistantChatConversations ?? []).find((item) => item.id === conversation.id);
    const currentTurn = currentConversation?.turns.find((item) => item.id === turn.id);
    if (!currentConversation || !currentTurn || currentTurn.operation === 'chat_refinement' || currentTurn.noteId !== turn.noteId ||
        currentTurn.createdAt !== turn.createdAt || currentTurn.userText !== turn.userText ||
        !(currentTurn.memorySuggestionIds ?? []).includes(suggestionId)) return;
    const requestId = ++knowledgeReviewRequestSequence.current;
    setKnowledgeReviewRequest({ suggestionId, requestId });
    setTab('library');
  }, [controller, selectedChatConversationId]);
  const handleKnowledgeReviewRequest = useCallback((requestId: number) => {
    setKnowledgeReviewRequest((current) => current?.requestId === requestId ? undefined : current);
  }, []);
  const prepareKnowledgeSuggestionReview = useCallback(async (id: string, input: { expectedRevision: number }): Promise<KnowledgeSuggestionReview> => {
    if (knowledgeReviewBlockedRef.current) throw new Error('Memory review is unavailable while the workspace is blocked.');
    return prepareKnowledgeSuggestionReviewWithPrivacy({
      prepare: async () => {
      const result = await controller.prepareKnowledgeSuggestionReview(id, input);
      if (knowledgeReviewBlockedRef.current) throw new Error('Memory review changed while the workspace was blocked. Reopen the current suggestion.');
      return result;
      },
      isPrivacyError: isPrivacyBootstrapError,
      onPrivacyInvalidated: () => onPrivacyInvalidated(),
    });
  }, [controller, onPrivacyInvalidated]);
  const chatDeleteConversation = useCallback(async (conversationId: string) => {
    const result = await run(async () => {
      await controller.deleteChatConversation(conversationId);
      if (selectedChatConversationId === conversationId) setSelectedChatConversationId(undefined);
      setNotice("Conversation removed from this device. Billing and submission receipts remain.");
      return true;
    });
    if (result !== true) throw new Error("Conversation removal could not be confirmed.");
    return result;
  }, [controller, run, selectedChatConversationId]);
  const setChatInteraction = useCallback((active: boolean) => {
    chatInteractionLock.current = active;
    setChatInteractionLocked(active);
  }, []);
  const openChatActions = useCallback((noteId: string) => {
    setChatActionFilterNoteId(noteId);
    setInboxFilter("pending");
    setTab("inbox");
  }, []);
  const backgroundActionBlockedReason = audio.status === "recording" || audio.status === "paused"
    ? "Stop the recording before changing background checks."
    : pendingCaptureLoading
      ? "Check the local recording status before changing background checks."
      : pendingCaptureStatus?.kind === "blocked"
        ? pendingCaptureStatus.reason === "cleanup_required"
          ? "Finish pending recording cleanup before changing background checks."
          : "Check the local recording status before changing background checks."
      : pendingCaptureStatus?.kind === "pending" && pendingCaptureStatus.phase === "discarding"
        ? "Finish pending recording cleanup before changing background checks."
      : undefined;
  const openReminder = (record: ReminderRecord) => {
    if (record.origin.kind === "proactive" && record.origin.deviceBinding) {
      const binding = record.origin.deviceBinding;
      const device = state.deviceCalendars;
      const calendar = device.installationId === binding.installationId && device.generation === binding.generation
        ? device.calendars.find((item) => item.localId === binding.calendarId)
        : undefined;
      setReminderSourceAccountLabel(calendar
        ? `On this iPhone · ${calendar.title || "Calendar"}`
        : "On this iPhone · original calendar unavailable");
    } else if (record.origin.kind === "proactive" && record.origin.binding) {
      const binding = record.origin.binding;
      const account = state.accounts.find((item) => {
        const identity = item.identity;
        if (!identity) return false;
        const key = [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ""].join(":");
        return item.id === binding.accountId && item.provider === binding.namespace && key === binding.identityKey && (item.connectionGeneration ?? 0) === binding.connectionGeneration;
      });
      setReminderSourceAccountLabel(account
        ? `${binding.namespace === "google" ? "Google" : "Microsoft"} · ${account.verifiedEmail || `account label: ${account.displayName}`}`
        : `${binding.namespace === "google" ? "Google" : "Microsoft"} · original account unavailable`);
    } else setReminderSourceAccountLabel(undefined);
    setReminderReviewId(record.id);
    setTab("library");
  };
  const createReminder = async (candidateId?: string) => {
    const created = await run(() => controller.createReminderDraft(candidateId ? { candidateId } : undefined));
    if (created) openReminder(created);
  };

  const reconcileReminderAlerts = useCallback(async (duringResume = false) => {
    if (!startupReady || loading || privacyReviewOpen || isolatedPreviewFailed || (isIsolatedDemo && !isReminderDemo) ||
        (foregroundResumeBusy.current && !duringResume) || foregroundMailBusy.current || reminderReconcileBusy.current || busyLock.current) return false;
    reminderReconcileBusy.current = true;
    try {
      await controller.reconcileReminderAlerts();
      return true;
    } catch {
      return false;
    } finally {
      reminderReconcileBusy.current = false;
    }
  }, [controller, isolatedPreviewFailed, isIsolatedDemo, loading, privacyReviewOpen, startupReady]);

  useEffect(() => {
    if (!startupReady || loading || privacyReviewOpen || isolatedPreviewFailed || (isIsolatedDemo && !isReminderDemo)) return;
    if (!isIsolatedDemo) return;
    const reconcile = () => { void reconcileReminderAlerts(); };
    const initial = setTimeout(reconcile, 0);
    let wasActive = NativeAppState.currentState === "active";
    const native = NativeAppState.addEventListener("change", (next) => {
      const active = next === "active";
      if (!wasActive && active) reconcile();
      wasActive = active;
    });
    let removeWeb: (() => void) | undefined;
    if (Platform.OS === "web" && typeof document !== "undefined") {
      let visible = document.visibilityState === "visible";
      const onVisibility = () => {
        const nextVisible = document.visibilityState === "visible";
        if (!visible && nextVisible) reconcile();
        visible = nextVisible;
      };
      document.addEventListener("visibilitychange", onVisibility);
      removeWeb = () => document.removeEventListener("visibilitychange", onVisibility);
    }
    return () => { clearTimeout(initial); native.remove(); removeWeb?.(); };
  }, [controller, isolatedPreviewFailed, isIsolatedDemo, loading, privacyReviewOpen, reconcileReminderAlerts, startupReady]);

  const refreshForegroundMail = useCallback(async (duringResume = false) => {
    if (isIsolatedDemo || privacyReviewOpen || !startupReady || loading || backgroundActionBlockedReason || busyLock.current ||
        (foregroundResumeBusy.current && !duringResume) || foregroundMailBusy.current || reminderReconcileBusy.current) return false;
    foregroundMailBusy.current = true;
    try {
      await controller.refreshForegroundMail();
      return true;
    } catch (error) {
      setNotice(messageOf(error));
      return false;
    } finally {
      foregroundMailBusy.current = false;
    }
  }, [backgroundActionBlockedReason, controller, isIsolatedDemo, loading, privacyReviewOpen, startupReady]);

  const refreshOnForegroundResume = useCallback(async () => {
    if (isIsolatedDemo || privacyReviewOpen || !startupReady || loading || backgroundActionBlockedReason || busyLock.current ||
        foregroundResumeBusy.current || foregroundMailBusy.current || reminderReconcileBusy.current) return;
    const recoveryStatus = controller.getProactiveRecoveryStatus();
    if (controller.getSnapshot().mailAlertRefreshRequired || proactiveRecoveryUnknownId || proactiveRecoverySheetOpen || proactiveRecoveryPlan || recoveryStatus.status === "prepared") return;
    foregroundResumeBusy.current = true;
    setForegroundResumeRefreshing(true);
    mailAlertTapCoordinatorRef.current?.setReady(false);
    try {
      await controller.refreshPersistedWorkspace();
      if (privacyReviewOpen || backgroundActionBlockedReason || busyLock.current) return;
      const reconciled = await reconcileReminderAlerts(true);
      if (!reconciled) return;
      if (privacyReviewOpen || backgroundActionBlockedReason || busyLock.current) return;
      if (Platform.OS !== "web") {
        try {
          await controller.reconcileProactiveMailAlerts();
        } catch {
          // Alert cancellation status remains available in Settings for a manual retry.
        }
      }
      if (privacyReviewOpen || backgroundActionBlockedReason || busyLock.current) return;
      await refreshForegroundMail(true);
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else setNotice("Local data could not be refreshed after returning. Open Settings to retry when other work has finished.");
    } finally {
      foregroundResumeBusy.current = false;
      setForegroundResumeRefreshing(false);
    }
  }, [backgroundActionBlockedReason, controller, isIsolatedDemo, loading, onPrivacyInvalidated, proactiveRecoveryPlan, proactiveRecoverySheetOpen, proactiveRecoveryUnknownId, privacyReviewOpen, reconcileReminderAlerts, refreshForegroundMail, startupReady]);

  useEffect(() => {
    if (!startupReady || loading || isIsolatedDemo || privacyReviewOpen) return;
    const initialRefresh = initialForegroundRefreshStarted.current ? undefined : setTimeout(() => {
      if (initialForegroundRefreshStarted.current) return;
      initialForegroundRefreshStarted.current = true;
      void (async () => {
        setForegroundResumeRefreshing(true);
        mailAlertTapCoordinatorRef.current?.setReady(false);
        try {
          const reconciled = await reconcileReminderAlerts();
          if (reconciled) await refreshForegroundMail();
        } finally {
          setForegroundResumeRefreshing(false);
          setForegroundCatchupComplete(true);
        }
      })();
    }, 0);
    if (Platform.OS === "web" && typeof document !== "undefined") {
      let wasVisible = document.visibilityState === "visible";
      const onVisibilityChange = () => {
        const isVisible = document.visibilityState === "visible";
        if (!wasVisible && isVisible) void refreshOnForegroundResume();
        wasVisible = isVisible;
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        if (initialRefresh !== undefined) clearTimeout(initialRefresh);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }
    let previousNativeState = NativeAppState.currentState;
    const nativeSubscription = NativeAppState.addEventListener("change", (nextState) => {
      if (previousNativeState !== "active" && nextState === "active") void refreshOnForegroundResume();
      previousNativeState = nextState;
    });
    return () => { if (initialRefresh !== undefined) clearTimeout(initialRefresh); nativeSubscription.remove(); };
  }, [isIsolatedDemo, loading, privacyReviewOpen, reconcileReminderAlerts, refreshForegroundMail, refreshOnForegroundResume, startupReady]);
  useEffect(() => {
    if (!startupReady || loading || isIsolatedDemo || privacyReviewOpen) return;
    const checkPermission = () => {
      if (controller.getSnapshot().deviceCalendars.enabled) {
        void controller.checkDeviceCalendarAccess().catch(() => undefined);
      }
    };
    const initial = setTimeout(checkPermission, 0);
    let removeNative: (() => void) | undefined;
    let removeWeb: (() => void) | undefined;
    if (Platform.OS === "web" && typeof document !== "undefined") {
      let visible = document.visibilityState === "visible";
      const onVisibility = () => {
        const nextVisible = document.visibilityState === "visible";
        if (!visible && nextVisible) checkPermission();
        visible = nextVisible;
      };
      document.addEventListener("visibilitychange", onVisibility);
      removeWeb = () => document.removeEventListener("visibilitychange", onVisibility);
    } else {
      let wasActive = NativeAppState.currentState === "active";
      const native = NativeAppState.addEventListener("change", (next) => {
        const active = next === "active";
        if (!wasActive && active) checkPermission();
        wasActive = active;
      });
      removeNative = () => native.remove();
    }
    return () => { clearTimeout(initial); removeNative?.(); removeWeb?.(); };
  }, [controller, isIsolatedDemo, loading, privacyReviewOpen, startupReady]);

  useEffect(() => {
    if (!privacy || !session || isIsolatedDemo || !startupReady || loading) return;
    const verifySession = () => {
      void privacy.assertWorkspaceEpoch(session.epoch).catch(() => onPrivacyInvalidated());
    };
    let removeWeb: (() => void) | undefined;
    let previousNativeState = NativeAppState.currentState;
    const native = NativeAppState.addEventListener("change", (next) => {
      if (previousNativeState !== "active" && next === "active") verifySession();
      previousNativeState = next;
    });
    if (Platform.OS === "web" && typeof document !== "undefined") {
      let visible = document.visibilityState === "visible";
      const onVisibility = () => {
        const next = document.visibilityState === "visible";
        if (!visible && next) verifySession();
        visible = next;
      };
      document.addEventListener("visibilitychange", onVisibility);
      removeWeb = () => document.removeEventListener("visibilitychange", onVisibility);
    }
    return () => { native.remove(); removeWeb?.(); };
  }, [isIsolatedDemo, loading, onPrivacyInvalidated, privacy, session, startupReady]);
  const openNote = useCallback((note: Note) => {
    publishDetailOwner(note);
    setTab("record");
  }, [publishDetailOwner]);
  const openProposal = (proposal: Proposal) => {
    const latest = controller
      .getSnapshot()
      .proposals.find((item) => item.id === proposal.id);
    setReview(latest ?? proposal);
  };
  const saveMailReply = async (input: {
    messageId: string;
    mode: "reply" | "reply_all";
    sourceDigest: string;
    text: string;
    to?: string[];
    cc?: string[];
  }) => {
    if (busyLock.current) return undefined;
    busyLock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const proposal = await controller.createMailReplyProposal(input);
      setInboxFilter("pending");
      setReview(proposal);
      return proposal;
    } finally {
      busyLock.current = false;
      setBusy(false);
    }
  };
  const [mailReplyBatchActionBusy, setMailReplyBatchActionBusy] = useState(false);
  const mailReplyBatchBlockState: MailReplyBatchBlockState = {
    startupReady,
    loading,
    demo: isIsolatedDemo,
    previewFailed: isolatedPreviewFailed,
    privacyReviewOpen,
    privacyOutcomeUnknown,
    busy,
    ownActionBusy: mailReplyBatchActionBusy,
    audioActive: audio.status !== "idle",
    pendingCaptureLoading,
    pendingCapturePending: Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty"),
    foregroundResumeRefreshing,
    foregroundCatchupComplete,
    proactiveRecoverySheetOpen,
    proactiveRecoveryRequiresRefresh,
    mailAlertRefreshRequired: Boolean(backgroundActionBlockedReason || state.mailAlertRefreshRequired),
    assistantChatRecovery: Boolean(state.assistantChatRecoveryStatus),
    assistantBatchRecovery: Boolean(state.assistantBatchRecoveryStatus),
    proactiveMailAlertRecovery: Boolean(state.proactiveMailAlertRecoveryStatus),
    backupRecovery: Boolean(state.backupRecoveryStatus),
    knowledgeRecovery: Boolean(state.knowledgeRecoveryStatus),
    reminderRecovery: Boolean(state.reminderRecoveryStatus),
    competingReviewOpen: Boolean(review),
    reminderReviewOpen: Boolean(reminderReviewId),
    noteDetailOpen: Boolean(detail),
    documentOpen: Boolean(doc),
    recordingAttachmentOpen: Boolean(recordingAttachmentNoteId),
    manualChatOpen: manualOpen,
    settingsOpen,
    mailAlertTapResolutionOpen: Boolean(mailAlertTapResolution),
    mailAlertTapPending,
    chatDeleteReviewOpen,
    chatInteractionLocked,
  };
  const mailReplyBatchHardBlocked = mailReplyBatchIsBlocked(mailReplyBatchBlockState);
  const mailReplyBatchBlockStateRef = useRef(mailReplyBatchBlockState);
  useLayoutEffect(() => { mailReplyBatchBlockStateRef.current = mailReplyBatchBlockState; });
  const mailReplyBatchHardBlockedRef = useRef(mailReplyBatchHardBlocked);
  useLayoutEffect(() => { mailReplyBatchHardBlockedRef.current = mailReplyBatchHardBlocked; }, [mailReplyBatchHardBlocked]);
  const [mailReplyBatchKeyStatus, setMailReplyBatchKeyStatus] = useState<MailReplyBatchKeyStatus | null>(null);
  const mailReplyBatchKeyReady = mailReplyBatchKeyIsReady(mailReplyBatchKeyStatus, {
    generation: mailReplyOwnerGeneration,
    mode: state.settings.mode,
    provider: state.settings.llmProvider ?? "",
    blocked: mailReplyBatchHardBlocked,
  });
  const ownsMailReplyOwner = useCallback((owner: MailReplyBatchOwner) =>
    mailReplyBatchOwnershipRef.current!.owns(owner),
  []);
  const runOwnedMailReplyContextAction = useCallback(async <TValue,>(input: {
    owner: MailReplyBatchOwner;
    isCurrent: () => boolean;
    action: () => Promise<TValue>;
    cancelLateValue?: (value: TValue) => Promise<unknown> | unknown;
  }): Promise<TValue | undefined> => {
    const ownership = mailReplyBatchOwnershipRef.current!;
    if (!ownership.owns(input.owner) || mailReplyBatchHardBlockedRef.current || !input.isCurrent() || busyLock.current) return undefined;
    const ticket = ownership.beginAction(input.owner);
    if (!ticket) return undefined;
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const outcome = await ownership.runOwnedAction({
        owner: input.owner,
        isCurrent: () => ownership.actionIsCurrent(ticket) && !mailReplyBatchHardBlockedRef.current && input.isCurrent(),
        readReadiness: async () => undefined,
        action: async () => {
          if (!ownership.actionIsCurrent(ticket) || mailReplyBatchHardBlockedRef.current || !input.isCurrent()) throw new Error("The selected message or workspace changed. Reopen the reply composer.");
          return input.action();
        },
        cancelLateValue: input.cancelLateValue,
      });
      return outcome.kind === "complete" ? outcome.value : undefined;
    } catch (cause) {
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally {
      if (ownership.finishAction(ticket)) {
        busyLock.current = false;
        setMailReplyBatchActionBusy(false);
        setBusy(false);
      }
    }
  }, [onPrivacyInvalidated]);
  const moreComputeGlobalBlocked = moreComputeWorkspaceIsBlocked({
    startupReady, loading, demo: isIsolatedDemo, previewFailed: isolatedPreviewFailed,
    privacyBlocked: privacyReviewOpen || privacyOutcomeUnknown, settingsOpen, backgroundActionBlocked: Boolean(backgroundActionBlockedReason),
    audioActive: audio.status !== "idle", captureLoading: pendingCaptureLoading,
    capturePending: Boolean(captureJournal && pendingCaptureStatus?.kind !== "empty"),
    foregroundBlocked: foregroundResumeRefreshing || !foregroundCatchupComplete,
    recoveryBlocked: proactiveRecoverySheetOpen || proactiveRecoveryRequiresRefresh || dispatchRecoverySheetOpen || Boolean(dispatchRecoveryPlan) ||
      Boolean(state.mailAlertRefreshRequired || state.assistantChatRecoveryStatus || state.assistantBatchRecoveryStatus ||
        state.proactiveMailAlertRecoveryStatus || state.backupRecoveryStatus || state.knowledgeRecoveryStatus || state.reminderRecoveryStatus),
    proposalReviewOpen: Boolean(review), reminderReviewOpen: Boolean(reminderReviewId), documentOpen: Boolean(doc),
    recordingAttachmentOpen: Boolean(recordingAttachmentNoteId), manualChatOpen: manualOpen,
    mailAlertTapOpen: Boolean(mailAlertTapResolution || mailAlertTapPending || mailAlertTapReviewRequested),
    chatDeleteReviewOpen, chatInteractionLocked, dispatchRecoveryOpen: dispatchRecoverySheetOpen || Boolean(dispatchRecoveryPlan),
    knowledgeReviewOpen: Boolean(knowledgeReviewRequest), voiceTransferReviewOpen: Boolean(chatTranscriptTransferPlan),
    startupRecoveryOpen: Boolean(startupRecoveryPlan),
  });
  useLayoutEffect(() => {
    moreComputeOwnerViewRef.current = { detail, selectedConversationId: selectedChatConversationId, replyMessageId, mailGeneration: mailReplyOwnerGeneration, tab, globalBlocked: moreComputeGlobalBlocked };
  });
  const parseMoreComputeOwner = useCallback((ownerKey: string): unknown[] | undefined => {
    try {
      const parsed: unknown = JSON.parse(ownerKey);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch { return undefined; }
  }, []);
  const moreComputeConfigKey = useCallback((snapshot: AppState = controller.getSnapshot()) =>
    moreComputeConfigurationFingerprint(snapshot.settings, snapshot.accounts, {
      workspaceGeneration, sessionEpoch: session?.epoch ?? null, sessionRuntimeId: session?.runtimeId ?? null,
    }), [controller, session?.epoch, session?.runtimeId, workspaceGeneration]);
  const isMoreComputeRuntimeCurrent = useCallback(() => {
    const runtime = moreComputeRuntimeRef.current;
    return workspaceMountedRef.current && runtime.controller === controller && runtime.resources === resources &&
      runtime.privacy === privacy && runtime.session === session && runtime.workspaceGeneration === workspaceGeneration &&
      runtime.sessionEpoch === (session?.epoch ?? null) && runtime.sessionRuntimeId === (session?.runtimeId ?? null);
  }, [controller, privacy, resources, session, workspaceGeneration]);
  const isMoreComputeOwnerCurrent = useCallback((ownerKey: string, jobId: string) => {
    const view = moreComputeOwnerViewRef.current;
    if (!isMoreComputeRuntimeCurrent() || view.globalBlocked) return false;
    const owner = parseMoreComputeOwner(ownerKey);
    const snapshot = controller.getSnapshot();
    if (!owner || owner[owner.length - 1] !== moreComputeConfigKey(snapshot)) return false;
    const jobs = snapshot.assistantBatchJobs ?? [];
    if (owner[0] === "note" && typeof owner[1] === "string" && typeof owner[2] === "number" && owner[3] === jobId) {
      const liveNote = snapshot.notes.find((item) => item.id === owner[1]);
      return view.tab === "record" && view.detail?.id === owner[1] &&
        liveNote?.revision === owner[2] && jobs.some((item) => item.id === jobId && item.kind === "note_assistance" && item.noteId === owner[1]);
    }
    if (owner[0] === "chat" && typeof owner[1] === "string" && typeof owner[2] === "string" && owner[3] === jobId) {
      const conversation = snapshot.assistantChatConversations?.find((item) => item.id === owner[1]);
      return view.tab === "chat" && !view.detail && view.selectedConversationId === owner[1] &&
        Boolean(conversation?.turns.some((turn) => turn.id === owner[2] && turn.job?.id === jobId));
    }
    if (owner[0] === "mail" && typeof owner[1] === "string" && typeof owner[2] === "number" && typeof owner[3] === "number" && owner[4] === jobId) {
      return view.tab === "inbox" && !view.detail && view.replyMessageId === owner[1] && view.mailGeneration === owner[2] &&
        jobs.some((item) => item.id === jobId && item.kind === "mail_reply" && item.mailMessageId === owner[1]);
    }
    return false;
  }, [controller, isMoreComputeRuntimeCurrent, moreComputeConfigKey, parseMoreComputeOwner]);
  const moreComputePlans = moreComputePlansRef.current;
  const moreComputeAction = useCallback(async <TValue,>(ownerKey: string, jobId: string, action: () => Promise<TValue>, cancelLate?: (value: TValue) => void, extraCurrent: () => boolean = () => true): Promise<TValue | undefined> => {
    if (!isMoreComputeOwnerCurrent(ownerKey, jobId) || !extraCurrent() || busyLock.current) return undefined;
    const mailAction = parseMoreComputeOwner(ownerKey)?.[0] === "mail";
    const ticket = {};
    moreComputeTicketRef.current = ticket;
    busyLock.current = true;
    if (mailAction) setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const value = await action();
      if (!isMoreComputeOwnerCurrent(ownerKey, jobId) || !extraCurrent()) {
        cancelLate?.(value);
        return undefined;
      }
      return value;
    } catch (error) {
      if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
      else if (isMoreComputeOwnerCurrent(ownerKey, jobId) && extraCurrent()) setNotice(messageOf(error));
      throw error;
    } finally {
      if (moreComputeTicketRef.current === ticket) {
        moreComputeTicketRef.current = undefined;
        busyLock.current = false;
        if (mailAction) setMailReplyBatchActionBusy(false);
        setBusy(false);
      }
    }
  }, [isMoreComputeOwnerCurrent, onPrivacyInvalidated, parseMoreComputeOwner]);
  const cancelMoreCompute = useCallback((planId: string, ownerKey: string) => {
    const stored = moreComputePlans.get(ownerKey);
    if (!stored || stored.planId !== planId) return;
    moreComputePlans.delete(ownerKey);
    stored.controller.cancelMoreCompute(planId);
  }, [moreComputePlans]);
  const moreComputeActions: MoreComputeReviewActions = {
    ownerKey: moreComputeConfigKey(),
    blocked: moreComputeGlobalBlocked,
    submitReady: state.settings.mode === "provider" && state.settings.llmProvider === "openrouter",
    onPrepare: async (jobId, effort, ownerKey, isOwnerCurrent) => {
      const plan = await moreComputeAction(ownerKey, jobId, () => controller.prepareMoreCompute({ jobId, effort }), (late) => controller.cancelMoreCompute(late.planId), isOwnerCurrent);
      if (!plan) return undefined;
      if (plan.jobId !== jobId || plan.requestedEffort !== effort || !plan.planId || !isMoreComputeOwnerCurrent(ownerKey, jobId)) {
        controller.cancelMoreCompute(plan.planId);
        return undefined;
      }
      moreComputePlans.set(ownerKey, { planId: plan.planId, jobId, ownerKey, controller });
      return plan;
    },
    onSubmit: async (planId, jobId, ownerKey, isOwnerCurrent) => {
      const stored = moreComputePlans.get(ownerKey);
      if (!stored || stored.planId !== planId || stored.jobId !== jobId || stored.controller !== controller || !isMoreComputeOwnerCurrent(ownerKey, jobId) || !isOwnerCurrent()) return undefined;
      return moreComputeAction(ownerKey, jobId, async () => {
        const discardPlan = () => {
          const live = moreComputePlans.get(ownerKey);
          if (live?.planId === planId) {
            moreComputePlans.delete(ownerKey);
            live.controller.cancelMoreCompute(planId);
          }
        };
        const settingsAtAdmission = controller.getSnapshot().settings;
        if (settingsAtAdmission.mode !== "provider" || settingsAtAdmission.llmProvider !== "openrouter") {
          discardPlan();
          openSettings();
          setNotice("Choose OpenRouter in Provider mode before submitting this paid request.");
          throw new Error("Choose OpenRouter in Provider mode before submitting this paid request.");
        }
        let keyReady = false;
        try { keyReady = (await credentials.getCredentials()).openRouterConfigured === true; }
        catch (error) { if (isPrivacyBootstrapError(error)) throw error; }
        const currentSettings = controller.getSnapshot().settings;
        if (!isOwnerCurrent() || !isMoreComputeOwnerCurrent(ownerKey, jobId) || currentSettings.mode !== settingsAtAdmission.mode || currentSettings.llmProvider !== settingsAtAdmission.llmProvider ||
            currentSettings.openRouterModel !== settingsAtAdmission.openRouterModel || currentSettings.openRouterReasoningEffort !== settingsAtAdmission.openRouterReasoningEffort) {
          discardPlan();
          throw new Error("Workspace or OpenRouter settings changed. Prepare a fresh review.");
        }
        if (!keyReady) {
          discardPlan();
          openSettings();
          setNotice("Save an OpenRouter API key in Settings before submitting this paid request.");
          throw new Error("Save an OpenRouter API key in Settings before submitting this paid request.");
        }
        moreComputePlans.delete(ownerKey);
        return controller.submitMoreCompute({ planId });
      }, undefined, isOwnerCurrent);
    },
    onCancel: cancelMoreCompute,
    onSubmitted: (result, ownerKey) => {
      const owner = parseMoreComputeOwner(ownerKey);
      const recovered = result as { recoveredConversationId?: unknown; recoveredTurnId?: unknown } | undefined;
      const parentJobId = owner?.[0] === "chat" && typeof owner[3] === "string" ? owner[3] : undefined;
      if (parentJobId && !isMoreComputeOwnerCurrent(ownerKey, parentJobId)) return;
      if (owner?.[0] === "chat" && typeof recovered?.recoveredConversationId === "string" && typeof recovered.recoveredTurnId === "string" &&
          controller.getSnapshot().assistantChatConversations?.some((conversation) => conversation.id === recovered.recoveredConversationId)) {
        setSelectedChatConversationId(recovered.recoveredConversationId);
        setMoreComputeFocusTurnId(recovered.recoveredTurnId);
      }
    },
  };
  useEffect(() => {
    const owner = replyMessageId ? mailReplyBatchOwnershipRef.current!.captureOwner(replyMessageId) : undefined;
    const mode = state.settings.mode;
    const provider = state.settings.llmProvider;
    if (!replyMessageId || !owner || mode !== "provider" || provider !== "openrouter" || mailReplyBatchHardBlocked) return;
    let active = true;
    void credentials.getCredentials().then((result) => {
      const liveSettings = controller.getSnapshot().settings;
      if (active && ownsMailReplyOwner(owner) &&
          liveSettings.mode === mode && liveSettings.llmProvider === provider && !mailReplyBatchHardBlockedRef.current) {
        setMailReplyBatchKeyStatus({ generation: owner.generation, mode, provider, ready: result.openRouterConfigured === true });
      }
    }).catch((cause) => {
      if (isPrivacyBootstrapError(cause)) { onPrivacyInvalidated(); return; }
      if (active && ownsMailReplyOwner(owner) && !mailReplyBatchHardBlockedRef.current) {
        setMailReplyBatchKeyStatus({ generation: owner.generation, mode, provider, ready: false });
      }
    });
    return () => { active = false; };
  }, [controller, credentials, mailReplyBatchHardBlocked, mailReplyOwnerGeneration, onPrivacyInvalidated, ownsMailReplyOwner, replyMessageId, settingsOpen, state.settings.llmProvider, state.settings.mode]);
  const cancelOwnedMailReplyBatchPlan = useCallback((planId: string, owner?: { messageId: string; generation: number }) => {
    const ownership = mailReplyBatchOwnershipRef.current!;
    if (!ownership.getPlan(planId) || (owner && !ownership.owns(owner))) return;
    ownership.clearPlan(planId);
    void controller.cancelMailReplyBatchReview(planId).catch(() => undefined);
  }, [controller]);
  useEffect(() => {
    if (mailReplyBatchHardBlocked) {
      const plan = mailReplyBatchOwnershipRef.current!.currentPlan();
      if (plan) cancelOwnedMailReplyBatchPlan(plan.planId);
    }
  }, [cancelOwnedMailReplyBatchPlan, mailReplyBatchHardBlocked]);
  const cancelMailReplyBatchReview = useCallback((planId: string, owner: { messageId: string; generation: number }) => {
    cancelOwnedMailReplyBatchPlan(planId, owner);
  }, [cancelOwnedMailReplyBatchPlan]);
  const releaseMailReplyContextAction = useCallback((owner: MailReplyBatchOwner | undefined) => {
    if (!owner) return;
    const ownership = mailReplyBatchOwnershipRef.current!;
    const ticket = ownership.currentAction();
    if (ticket?.owner.messageId === owner.messageId && ticket.owner.generation === owner.generation && ownership.finishAction(ticket)) {
      busyLock.current = false;
      setMailReplyBatchActionBusy(false);
      setBusy(false);
    }
  }, []);
  const cancelMailReplyContextOwnerSessions = useCallback((owner: MailReplyBatchOwner | undefined) => {
    if (!owner) return;
    for (const [sessionId, sessionOwner] of mailReplyContextSessionsRef.current) {
      if (sessionOwner.messageId !== owner.messageId || sessionOwner.generation !== owner.generation) continue;
      mailReplyContextSessionsRef.current.delete(sessionId);
      void controller.cancelMailReplyContextDiscovery(sessionId).catch(() => undefined);
    }
  }, [controller]);
  const openMailReply = useCallback((messageId: string) => {
    const previousOwner = replyMessageId ? mailReplyBatchOwnershipRef.current!.captureOwner(replyMessageId) : undefined;
    releaseMailReplyContextAction(previousOwner);
    cancelMailReplyContextOwnerSessions(previousOwner);
    const previous = mailReplyBatchOwnershipRef.current!.currentPlan();
    if (previous) cancelOwnedMailReplyBatchPlan(previous.planId);
    const owner = mailReplyBatchOwnershipRef.current!.publishOwner(messageId)!;
    setMailReplyOwnerGeneration(owner.generation);
    setReplyMessageId(messageId);
  }, [cancelMailReplyContextOwnerSessions, cancelOwnedMailReplyBatchPlan, releaseMailReplyContextAction, replyMessageId]);
  const closeMailReply = useCallback((expectedOwner?: MailReplyBatchOwner) => {
    const liveOwner = replyMessageId ? mailReplyBatchOwnershipRef.current!.captureOwner(replyMessageId) : undefined;
    if (expectedOwner && (!liveOwner || !mailReplyBatchOwnershipRef.current!.owns(expectedOwner))) return;
    releaseMailReplyContextAction(liveOwner);
    cancelMailReplyContextOwnerSessions(liveOwner);
    const previous = mailReplyBatchOwnershipRef.current!.currentPlan();
    if (previous) cancelOwnedMailReplyBatchPlan(previous.planId);
    mailReplyBatchOwnershipRef.current!.publishOwner(null);
    setMailReplyOwnerGeneration(mailReplyBatchOwnershipRef.current!.currentGeneration);
    setReplyMessageId(null);
  }, [cancelMailReplyContextOwnerSessions, cancelOwnedMailReplyBatchPlan, releaseMailReplyContextAction, replyMessageId]);
  const submitMailReplyBatch = useCallback(async (
    input: Parameters<AppController["submitMailReplyBatch"]>[0],
    owner: MailReplyBatchOwner,
    isComposerCurrent: () => boolean,
  ) => {
    if (!ownsMailReplyOwner(owner) || mailReplyBatchHardBlockedRef.current || !isComposerCurrent() || busyLock.current) return undefined;
    const settingsAtAdmission = controller.getSnapshot().settings;
    if (settingsAtAdmission.mode !== "provider" || settingsAtAdmission.llmProvider !== "openrouter") {
      openSettings();
      throw new Error("Choose OpenRouter in Provider mode before submitting a Batch reply request.");
    }
    if (input.messageId !== owner.messageId) throw new Error("The selected message changed. Reopen its reply composer.");
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const outcome = await mailReplyBatchOwnershipRef.current!.runOwnedAction({
        owner,
        isCurrent: () => !mailReplyBatchHardBlockedRef.current && isComposerCurrent(),
        readReadiness: async () => {
          let keyReady = false;
          try { keyReady = (await credentials.getCredentials()).openRouterConfigured === true; }
          catch (cause) { if (isPrivacyBootstrapError(cause)) throw cause; }
          return { keyReady, settings: controller.getSnapshot().settings };
        },
        action: async (readiness) => {
          const settings = controller.getSnapshot().settings;
          if (mailReplyBatchHardBlockedRef.current || !isComposerCurrent() || settings.mode !== settingsAtAdmission.mode || settings.llmProvider !== settingsAtAdmission.llmProvider ||
              settings.openRouterModel !== settingsAtAdmission.openRouterModel || settings.openRouterReasoningEffort !== settingsAtAdmission.openRouterReasoningEffort ||
              readiness.settings.mode !== settingsAtAdmission.mode || readiness.settings.llmProvider !== settingsAtAdmission.llmProvider ||
              readiness.settings.openRouterModel !== settingsAtAdmission.openRouterModel || readiness.settings.openRouterReasoningEffort !== settingsAtAdmission.openRouterReasoningEffort) {
            throw new Error("Workspace readiness or OpenRouter settings changed. Reopen the composer and review the request again.");
          }
          if (!readiness.keyReady) {
            openSettings();
            throw new Error("Save an OpenRouter API key in Settings before submitting a Batch reply request.");
          }
          if (input.messageId !== owner.messageId) throw new Error("The selected message changed. Reopen its reply composer.");
          return controller.submitMailReplyBatch(input);
        },
      });
      return outcome.kind === "complete" ? outcome.value : undefined;
    } catch (cause) {
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally {
      busyLock.current = false;
      setMailReplyBatchActionBusy(false);
      setBusy(false);
    }
  }, [controller, credentials, onPrivacyInvalidated, openSettings, ownsMailReplyOwner]);
  const checkMailReplyBatch = useCallback(async (jobId: string, owner: MailReplyBatchOwner) => {
    if (!ownsMailReplyOwner(owner) || mailReplyBatchHardBlockedRef.current || busyLock.current) return undefined;
    const job = (controller.getSnapshot().assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === "mail_reply" && item.mailMessageId === owner.messageId);
    if (!job || !job.canCheck) return undefined;
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const outcome = await mailReplyBatchOwnershipRef.current!.runOwnedAction({
        owner,
        isCurrent: () => !mailReplyBatchHardBlockedRef.current,
        readReadiness: async () => {
          const settings = controller.getSnapshot().settings;
          if (settings.mode !== "provider" || settings.llmProvider !== "openrouter") throw new Error("Select OpenRouter in Provider mode before checking this request.");
          try { return (await credentials.getCredentials()).openRouterConfigured === true; }
          catch (cause) { if (isPrivacyBootstrapError(cause)) throw cause; return false; }
        },
        action: async (keyReady) => {
          if (!keyReady) {
            openSettings();
            throw new Error("Save an OpenRouter API key in Settings before checking this request.");
          }
          return controller.refreshAssistantBatch(jobId);
        },
      });
      if (outcome.kind !== "complete") return undefined;
      const updated = outcome.value;
      return updated.id === jobId && updated.mailMessageId === owner.messageId ? updated : undefined;
    } catch (cause) {
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally { busyLock.current = false; setMailReplyBatchActionBusy(false); setBusy(false); }
  }, [controller, credentials, onPrivacyInvalidated, openSettings, ownsMailReplyOwner]);
  const reviewMailReplyBatch = useCallback(async (jobId: string, operation: "draft" | "send", owner: MailReplyBatchOwner, isComposerCurrent: () => boolean) => {
    if (!ownsMailReplyOwner(owner) || mailReplyBatchHardBlockedRef.current || !isComposerCurrent() || busyLock.current) return undefined;
    const job = (controller.getSnapshot().assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === "mail_reply" && item.mailMessageId === owner.messageId && item.canReviewMailReply);
    if (!job) return undefined;
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const outcome = await mailReplyBatchOwnershipRef.current!.prepareOwnedReview({
        owner,
        isCurrent: () => !mailReplyBatchHardBlockedRef.current && isComposerCurrent(),
        prepare: () => controller.reviewMailReplyBatch(jobId, { operation }),
        cancelLatePlan: (plan) => controller.cancelMailReplyBatchReview(plan.planId),
      });
      if (outcome.kind === "stale") return undefined;
      const plan: MailReplyBatchReviewPlan = outcome.plan;
      if (plan.jobId !== jobId || plan.messageId !== owner.messageId || !mailReplyBatchPlanMatchesOperation(plan, operation) || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now()) {
        void controller.cancelMailReplyBatchReview(plan.planId).catch(() => undefined);
        return undefined;
      }
      const current = mailReplyBatchOwnershipRef.current!.currentPlan();
      if (current) cancelOwnedMailReplyBatchPlan(current.planId);
      if (!mailReplyBatchOwnershipRef.current!.publishPlan(plan, owner)) {
        void controller.cancelMailReplyBatchReview(plan.planId).catch(() => undefined);
        return undefined;
      }
      return plan;
    } catch (cause) {
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally { busyLock.current = false; setMailReplyBatchActionBusy(false); setBusy(false); }
  }, [cancelOwnedMailReplyBatchPlan, controller, onPrivacyInvalidated, ownsMailReplyOwner]);
  const activateMailReplyBatch = useCallback(async (planId: string, jobId: string, operation: "draft" | "send", owner: MailReplyBatchOwner, isComposerCurrent: () => boolean) => {
    const live = mailReplyBatchOwnershipRef.current!.getPlan(planId);
    if (!live || live.jobId !== jobId || live.messageId !== owner.messageId || !mailReplyBatchPlanMatchesOperation(live, operation) ||
        !ownsMailReplyOwner(owner) || mailReplyBatchHardBlockedRef.current || !isComposerCurrent() || busyLock.current) return undefined;
    const consumedPlan = mailReplyBatchOwnershipRef.current!.clearPlan(planId);
    if (!consumedPlan) return undefined;
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const result = await controller.activateMailReplyBatch({ planId });
      if (!ownsMailReplyOwner(owner) || !isComposerCurrent() || mailReplyBatchHardBlockedRef.current) return undefined;
      const createdSnapshot = controller.getSnapshot();
      const proposal = createdSnapshot.proposals.find((item) => item.id === result.proposalId);
      const activatedJob = (createdSnapshot.assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === "mail_reply");
      if (result.kind !== "created" || result.jobId !== jobId || !proposal || proposal.provenance?.version !== 2 || proposal.provenance.kind !== "mail_reply" || proposal.provenance.batchJobId !== jobId || !activatedJob || activatedJob.proposalId !== proposal.id || !mailReplyBatchActivationMatchesOperation(proposal.email?.operation, activatedJob.mailReplyActivationOperation, operation, false, activatedJob.proposalId === proposal.id)) {
        throw new Error(`${operation === "send" ? "Send proposal" : "Draft"} creation could not be confirmed for this request. Check saved request status before taking another action.`);
      }
      setInboxFilter("pending");
      setReview(proposal);
      closeMailReply(owner);
      return result;
    } catch (cause) {
      void controller.cancelMailReplyBatchReview(planId).catch(() => undefined);
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally { busyLock.current = false; setMailReplyBatchActionBusy(false); setBusy(false); }
  }, [closeMailReply, controller, onPrivacyInvalidated, ownsMailReplyOwner]);
  const deleteMailReplyBatch = useCallback(async (jobId: string, owner: MailReplyBatchOwner) => {
    if (!ownsMailReplyOwner(owner) || mailReplyBatchHardBlockedRef.current || busyLock.current) return undefined;
    const job = (controller.getSnapshot().assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === "mail_reply" && item.mailMessageId === owner.messageId);
    if (!job || job.sourceRemoved) return undefined;
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      await controller.deleteMailReplyBatch(jobId);
      return ownsMailReplyOwner(owner) ? true : undefined;
    } catch (cause) {
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally { busyLock.current = false; setMailReplyBatchActionBusy(false); setBusy(false); }
  }, [controller, onPrivacyInvalidated, ownsMailReplyOwner]);
  const discoverMailReplyContext = useCallback(async (
    input: { messageId: string; sourceDigest: string }, owner: MailReplyBatchOwner, isComposerCurrent: () => boolean,
  ): Promise<MailReplyConversationContextDiscovery | undefined> => {
    if (input.messageId !== owner.messageId) return undefined;
    const result = await runOwnedMailReplyContextAction({ owner, isCurrent: isComposerCurrent,
      action: () => controller.discoverMailReplyContext(input),
      cancelLateValue: (value) => controller.cancelMailReplyContextDiscovery(value.sessionId) });
    if (!result || !ownsMailReplyOwner(owner) || !isComposerCurrent()) return undefined;
    mailReplyContextSessionsRef.current.set(result.sessionId, owner);
    return result;
  }, [controller, ownsMailReplyOwner, runOwnedMailReplyContextAction]);
  const continueMailReplyContext = useCallback(async (
    sessionId: string, owner: MailReplyBatchOwner, isComposerCurrent: () => boolean,
  ): Promise<MailReplyConversationContextDiscovery | undefined> => {
    const sessionOwner = mailReplyContextSessionsRef.current.get(sessionId);
    if (!sessionOwner || sessionOwner.messageId !== owner.messageId || sessionOwner.generation !== owner.generation) return undefined;
    return runOwnedMailReplyContextAction({ owner, isCurrent: isComposerCurrent,
      action: () => controller.continueMailReplyContextDiscovery({ sessionId }),
      cancelLateValue: () => controller.cancelMailReplyContextDiscovery(sessionId) });
  }, [controller, runOwnedMailReplyContextAction]);
  const loadMailReplyContextMessage = useCallback(async (
    sessionId: string, rowId: string, owner: MailReplyBatchOwner, isComposerCurrent: () => boolean,
  ): Promise<MailReplyContextSelection | undefined> => {
    const sessionOwner = mailReplyContextSessionsRef.current.get(sessionId);
    if (!sessionOwner || sessionOwner.messageId !== owner.messageId || sessionOwner.generation !== owner.generation) return undefined;
    return runOwnedMailReplyContextAction({ owner, isCurrent: isComposerCurrent,
      action: () => controller.loadMailReplyContextMessage({ sessionId, rowId }) });
  }, [controller, runOwnedMailReplyContextAction]);
  const cancelMailReplyContext = useCallback((sessionId: string, owner: MailReplyBatchOwner) => {
    const sessionOwner = mailReplyContextSessionsRef.current.get(sessionId);
    if (!sessionOwner || sessionOwner.messageId !== owner.messageId || sessionOwner.generation !== owner.generation) return;
    mailReplyContextSessionsRef.current.delete(sessionId);
    void controller.cancelMailReplyContextDiscovery(sessionId).catch(() => undefined);
  }, [controller]);
  const refreshComposerMailReplySources = useCallback(async (
    jobId: string, owner: MailReplyBatchOwner, isComposerCurrent: () => boolean,
  ): Promise<MailReplyBatchSourcesRefreshResult | undefined> => {
    const job = (controller.getSnapshot().assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === 'mail_reply' && item.mailMessageId === owner.messageId);
    if (!job || job.sourceRemoved || (job.status !== 'completed' && job.status !== 'result_truncated') || (job.status === 'completed' && !job.hasMailReplyResult) || (job.mailReplyContextCount ?? 0) < 1) return undefined;
    const result = await runOwnedMailReplyContextAction({ owner, isCurrent: isComposerCurrent,
      action: () => controller.refreshMailReplyBatchSources(jobId) });
    return result?.jobId === jobId ? result : undefined;
  }, [controller, runOwnedMailReplyContextAction]);
  const refreshReviewedMailReplySources = useCallback(async (
    jobId: string, proposalId: string, proposalRevision: number, isReviewCurrent: () => boolean,
  ): Promise<MailReplyBatchSourcesRefreshResult | undefined> => {
    const proposal = reviewRef.current;
    const provenance = proposal?.provenance;
    const batchId = provenance && 'kind' in provenance && provenance.kind === 'mail_reply' && provenance.version === 2
      ? provenance.batchJobId : undefined;
    const sourceOwnership = reviewedMailSourceOwnershipRef.current;
    const owner = sourceOwnership.captureOwner(JSON.stringify([proposalId, proposalRevision]));
    const liveSnapshot = controller.getSnapshot();
    const liveProposal = liveSnapshot.proposals.find((item) => item.id === proposalId);
    const job = (liveSnapshot.assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === 'mail_reply');
    const operation = proposal?.email?.operation;
    const normalizedOperation = operation === 'send' ? 'send' : 'draft';
    const legacyDraftActivation = job?.mailReplyActivationOperation === undefined && job?.proposalId === proposalId &&
      (operation === 'draft' || operation === undefined);
    const ownsExactLinkedReview = () => {
      const currentReview = reviewRef.current;
      const snapshot = controller.getSnapshot();
      const currentProposal = snapshot.proposals.find((item) => item.id === proposalId);
      const currentProvenance = currentProposal?.provenance;
      const currentBatchId = currentProvenance && 'kind' in currentProvenance && currentProvenance.kind === 'mail_reply' && currentProvenance.version === 2
        ? currentProvenance.batchJobId : undefined;
      const currentJob = (snapshot.assistantBatchJobs ?? []).find((item) => item.id === jobId && item.kind === 'mail_reply');
      const currentOperation = currentProposal?.email?.operation;
      const currentLegacyDraft = currentJob?.mailReplyActivationOperation === undefined && currentJob?.proposalId === proposalId &&
        (currentOperation === 'draft' || currentOperation === undefined);
      return Boolean(currentReview?.id === proposalId && currentReview.revision === proposalRevision &&
        currentProposal?.revision === proposalRevision && currentBatchId === jobId && currentJob?.proposalId === proposalId &&
        currentJob.status === 'completed' && currentJob.hasMailReplyResult &&
        mailReplyBatchActivationMatchesOperation(currentOperation, currentJob.mailReplyActivationOperation, normalizedOperation, currentLegacyDraft, currentJob.proposalId === proposalId));
    };
    const isCurrent = () => Boolean(owner && sourceOwnership.owns(owner) && ownsExactLinkedReview() &&
      !mailReplyBatchReviewSourceIsBlocked(mailReplyBatchBlockStateRef.current, true) && isReviewCurrent());
    if (!proposal || proposal.id !== proposalId || proposal.revision !== proposalRevision || !liveProposal || liveProposal.revision !== proposalRevision ||
        proposal.kind !== 'email' || (operation !== 'draft' && operation !== 'send' && !legacyDraftActivation) || batchId !== jobId ||
        !job || job.status !== 'completed' || !job.hasMailReplyResult || !job.proposalId || job.proposalId !== proposalId || (job.mailReplyContextCount ?? 0) < 1 ||
        !mailReplyBatchActivationMatchesOperation(operation, job.mailReplyActivationOperation, normalizedOperation, legacyDraftActivation, job.proposalId === proposalId) ||
        controller.getMailReplyBatchSourcesStatus(jobId).status === 'invalid' ||
        !owner || !isCurrent() || busyLock.current) return undefined;
    const ticket = sourceOwnership.beginAction(owner);
    if (!ticket) return undefined;
    const appTicket = {};
    reviewedMailSourceBusyTicketRef.current = appTicket;
    busyLock.current = true;
    setMailReplyBatchActionBusy(true);
    setBusy(true);
    try {
      const outcome = await sourceOwnership.runOwnedAction({
        owner,
        isCurrent: () => sourceOwnership.actionIsCurrent(ticket) && isCurrent(),
        readReadiness: async () => undefined,
        action: async () => {
          if (!sourceOwnership.actionIsCurrent(ticket) || !isCurrent()) throw new Error('The selected proposal changed. Reopen its review before refreshing sources.');
          const sources = await controller.refreshMailReplyBatchSources(jobId);
          if (sources.jobId !== jobId || sources.status !== 'current') return { sources };
          if (!sourceOwnership.actionIsCurrent(ticket) || !isCurrent()) throw new Error('The selected proposal changed. Reopen its review before checking it.');
          const freshness = await controller.checkProposalFreshness(proposalId);
          return { sources, freshness };
        },
      });
      if (outcome.kind !== 'complete' || !isCurrent() || !('freshness' in outcome.value) || !outcome.value.freshness ||
          outcome.value.sources.jobId !== jobId || outcome.value.sources.status !== 'current') return undefined;
      const latest = controller.getSnapshot().proposals.find((item) => item.id === proposalId);
      if (!latest || latest.revision !== proposalRevision || !isCurrent()) return undefined;
      setReview(latest);
      setReviewFreshnessResult({ key: reviewFreshnessKey, current: outcome.value.freshness.current, reason: outcome.value.freshness.reason });
      setReviewFreshnessError(null);
      setReviewFreshnessCheckedKey(reviewFreshnessKey);
      checkedReviewFreshnessKey.current = reviewFreshnessKey;
      return outcome.value.sources;
    } catch (cause) {
      rethrowMailReplyBatchError(cause, isPrivacyBootstrapError, onPrivacyInvalidated);
    } finally {
      sourceOwnership.finishAction(ticket);
      if (reviewedMailSourceBusyTicketRef.current === appTicket) {
        reviewedMailSourceBusyTicketRef.current = undefined;
        busyLock.current = false;
        setMailReplyBatchActionBusy(false);
        setBusy(false);
      }
    }
  }, [controller, onPrivacyInvalidated, reviewFreshnessKey]);
  const saveInspectedPendingCapture = useCallback(async (receipt: PendingCaptureReceipt, durationSeconds: number): Promise<boolean> => {
    setPendingCaptureBusy(true);
    try {
      const note = await controller.savePendingCapture(receipt);
      commitAudioCapture(note.id);
      openNote(note);
      setNotice(durationSeconds > state.settings.maxAudioSeconds
        ? "Saved locally. This recording exceeds your Speech limit; adjust it in Settings before transcribing."
        : "Recording saved on this device. Add a transcript to create a reviewable proposal.");
      await refreshPendingCaptureStatus();
      return true;
    } catch (error) {
      setPendingCaptureError("The recording could not be saved from its current recovery state. Review the refreshed status.");
      await refreshPendingCaptureStatus();
      throw error;
    } finally { setPendingCaptureBusy(false); }
  }, [commitAudioCapture, controller, openNote, refreshPendingCaptureStatus, state.settings.maxAudioSeconds]);

  const applyPendingCaptureResult = useCallback(async (receipt: PendingCaptureReceipt): Promise<boolean> => {
    setPendingCaptureBusy(true);
    try {
      const inspected = await controller.inspectPendingCapture(receipt);
      setPendingCaptureStatus(inspected);
      if (inspected.kind !== "pending" || inspected.inspection !== "known" || !inspected.canSave) {
        setNotice(inspected.kind === "pending" && inspected.inspection === "known" && (inspected.durationSeconds ?? 0) > 600
          ? "This recording exceeds 10 minutes and cannot be saved as a note. Export or discard it from the recovery panel."
          : "The recording needs review before it can be saved. Use the recovery panel to inspect it.");
        await refreshAudioPendingRecovery?.();
        return false;
      }
      return await saveInspectedPendingCapture(inspected.receipt, inspected.durationSeconds ?? 0);
    } catch {
      setPendingCaptureError("The recording could not be inspected. Its original audio remains in recovery.");
      await refreshPendingCaptureStatus();
      setNotice("Recording inspection failed. Retry from the recovery panel.");
      return false;
    } finally { setPendingCaptureBusy(false); }
  }, [controller, refreshAudioPendingRecovery, refreshPendingCaptureStatus, saveInspectedPendingCapture]);

  const inspectPendingCapture = useCallback((receipt: PendingCaptureReceipt) => {
    void run(async () => {
      setPendingCaptureBusy(true);
      try {
        const safe = await controller.inspectPendingCapture(receipt);
        setPendingCaptureStatus(safe);
        setPendingCaptureError("");
        setNotice(safe.kind === "pending" && safe.inspection === "known"
          ? "Recording status checked. Review the measured duration before saving."
          : "Recording status checked. Its duration could not be confirmed.");
        await refreshAudioPendingRecovery?.();
      } catch {
        setPendingCaptureError("The recording could not be inspected. Its original audio remains in recovery.");
        setNotice("Recording inspection failed. Retry from the recovery panel.");
        await refreshPendingCaptureStatus();
      } finally { setPendingCaptureBusy(false); }
    });
  }, [controller, refreshAudioPendingRecovery, refreshPendingCaptureStatus, run]);

  const exportPendingCapture = useCallback((receipt: PendingCaptureReceipt) => {
    void run(async () => {
      setPendingCaptureBusy(true);
      try {
        await controller.exportPendingCapture(receipt);
        setNotice("Export sheet closed. The original recording remains on this device.");
      } finally {
        await refreshPendingCaptureStatus();
        setPendingCaptureBusy(false);
      }
    });
  }, [controller, refreshPendingCaptureStatus, run]);

  const discardPendingCapture = useCallback((receipt?: PendingCaptureReceipt) => {
    void run(async () => {
      setPendingCaptureBusy(true);
      try {
        if (receipt) {
          const safe = await controller.discardPendingCapture(receipt);
          setPendingCaptureStatus(safe);
        } else {
          await audio.cancel();
        }
        setNotice("Recording discard was checked. Review the local status below.");
      } finally {
        await refreshPendingCaptureStatus();
        setPendingCaptureBusy(false);
      }
    });
  }, [audio, controller, refreshPendingCaptureStatus, run]);

  const retryPendingCaptureCleanup = useCallback(() => {
    void run(async () => {
      setPendingCaptureBusy(true);
      try {
        const safe = await controller.retryPendingCaptureSourceRelease();
        setPendingCaptureStatus(safe);
        setPendingCaptureError("");
      } finally {
        await refreshPendingCaptureStatus();
        setPendingCaptureBusy(false);
      }
    });
  }, [controller, refreshPendingCaptureStatus, run]);

  const saveRecording = useCallback(async (): Promise<boolean> => {
    const result = await audio.stop();
    if (!result) return false;
    if (result.kind === "pending_capture") {
      await refreshPendingCaptureStatus();
      return applyPendingCaptureResult(result.receipt);
    }
    const note = await controller.saveNote({
      transcript: "",
      audioUri: result.uri,
      durationSeconds: result.durationSeconds,
      capturedAt: result.capturedAt,
      captureTimeZone: result.captureTimeZone,
    });
    audio.commit(result.uri);
    openNote(note);
    setNotice(
      "Recording saved on this device. Add a transcript to create a reviewable proposal.",
    );
    return true;
  }, [applyPendingCaptureResult, audio, controller, openNote, refreshPendingCaptureStatus]);
  const savePendingFromPanel = useCallback((receipt: PendingCaptureReceipt) => {
    void run(async () => {
      const current = pendingCaptureStatus;
      if (current?.kind !== "pending" || current.inspection !== "known" || !current.canSave || current.receipt.id !== receipt.id || current.receipt.revision !== receipt.revision) {
        await refreshPendingCaptureStatus();
        setNotice("Recording status changed. Review the refreshed status before saving.");
        return;
      }
      await saveInspectedPendingCapture(receipt, current.durationSeconds ?? 0);
    });
  }, [pendingCaptureStatus, refreshPendingCaptureStatus, run, saveInspectedPendingCapture]);
  const autoStopGate = useRef(new RecordingAutoStopGate());
  useEffect(() => {
    const gate = autoStopGate.current;
    const eligible = gate.claim({
      startupReady,
      isolatedPreview: isIsolatedDemo,
      outcomeUnknown: privacyOutcomeUnknown,
      busy,
      status: audio.status,
      durationSeconds: audio.durationSeconds,
      maxAudioSeconds: state.settings.maxAudioSeconds,
    });
    if (!eligible) return;
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      if (busyLock.current) {
        gate.defer();
        return;
      }
      void run(async () => {
        const saved = await saveRecording();
        if (saved) setNotice("Recording reached the configured length limit and was saved.");
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      if (!fired) gate.defer();
    };
  }, [
    audio.durationSeconds,
    audio.status,
    state.settings.maxAudioSeconds,
    run,
    saveRecording,
    busy,
    isIsolatedDemo,
    privacyOutcomeUnknown,
    startupReady,
  ]);
  const confirmCancel = () =>
    confirmAction(
      "Discard this recording?",
      "This recording has not been saved.",
      () => {
        void run(async () => {
          await audio.cancel();
          await refreshPendingCaptureStatus();
        });
      },
    );
  const connectAccount = useCallback(
    async (
      provider: OAuthProvider,
      capabilities: AccountCapability[],
      accountId?: string,
    ) => {
      if (isIsolatedDemo) {
        setNotice("Account connections are disabled in the sample preview.");
        return;
      }
      await run(async () => {
        if (!resources || !privacy || !session) throw new Error("Account connection is unavailable until the secure workspace is ready.");
        const capturedConfig = Object.freeze({ ...configuredProviderAuth(provider) });
        const capturedCapabilities = [...new Set(capabilities)].sort() as AccountCapability[];
        const capturedScopes = scopesFor(provider, capturedCapabilities);
        const capturedRedirectUri = exactRedirectUri(capturedConfig);
        const owner = oauthIntentOwnershipRef.current!.begin({
          workspaceGeneration,
          controller,
          resources,
          privacy,
          sessionEpoch: session.epoch,
          sessionRuntimeId: session.runtimeId,
          provider,
          ...(accountId ? { accountId } : {}),
          accountLifecycle: oauthAccountLifecycleFingerprint(controller.getSnapshot().accounts, provider),
          platform: Platform.OS,
          clientId: capturedConfig.clientId,
          nativeRedirectUri: capturedConfig.nativeRedirectUri,
          webRedirectUri: capturedConfig.webRedirectUri,
          authority: capturedConfig.authority,
          redirectUri: capturedRedirectUri,
          capabilities: capturedCapabilities,
          scopes: capturedScopes,
        });
        const makeCurrentSnapshot = (): OAuthConnectionIntentSnapshot => {
          const gate = oauthGateRef.current;
          if (!workspaceMountedRef.current || gate.workspaceGeneration !== workspaceGeneration ||
              !gate.startupReady || gate.loading || gate.isolated || gate.privacyReviewOpen || gate.privacyOutcomeUnknown) {
            throw new Error("Sign-in was cancelled because the workspace is not available. Start again from Settings.");
          }
          const currentConfig = configuredProviderAuth(provider);
          return {
            workspaceGeneration,
            controller,
            resources,
            privacy,
            sessionEpoch: session.epoch,
            sessionRuntimeId: session.runtimeId,
            provider,
            ...(accountId ? { accountId } : {}),
            accountLifecycle: oauthAccountLifecycleFingerprint(controller.getSnapshot().accounts, provider),
            platform: Platform.OS,
            clientId: currentConfig.clientId,
            nativeRedirectUri: currentConfig.nativeRedirectUri,
            webRedirectUri: currentConfig.webRedirectUri,
            authority: currentConfig.authority,
            redirectUri: exactRedirectUri(currentConfig),
            capabilities: capturedCapabilities,
            scopes: scopesFor(provider, capturedCapabilities),
          };
        };
        const assertCurrent = () => oauthIntentOwnershipRef.current!.assertCurrent(owner, makeCurrentSnapshot());
        const assertWorkspaceCurrent = () => {
          if (!workspaceMountedRef.current || oauthGateRef.current.workspaceGeneration !== workspaceGeneration) {
            throw new Error("The workspace changed before account connection could finish.");
          }
          oauthIntentOwnershipRef.current!.assertOwnerCurrent(owner);
        };
        try {
          const completion = await runOwnedOAuthConnection({
            assertCurrent,
            assertWorkspaceCurrent,
            // The system-browser wait owns no provider request lifetime or privacy writer.
            authorize: () => authorizeWithBrowser(capturedConfig, capturedCapabilities),
            validateHandoff: (handoff) => {
              if (handoff.provider !== provider || handoff.redirectUri !== capturedRedirectUri ||
                  JSON.stringify(handoff.requestedCapabilities) !== JSON.stringify(capturedCapabilities) ||
                  JSON.stringify(handoff.requestedScopes) !== JSON.stringify(capturedScopes)) {
                throw new Error("The sign-in response no longer matches the selected provider access. Start again from Settings.");
              }
            },
            exchange: (handoff, beforeStart) => exchangeAuthorizationCode(
              {
                provider,
                clientId: capturedConfig.clientId,
                redirectUri: capturedRedirectUri,
                authority: capturedConfig.authority,
                requestedCapabilities: capturedCapabilities,
              },
              handoff,
              {
                withProviderOwnership: resources.withProviderOwnership,
                withResponseLifetime: resources.withResponseLifetimeFor("oauth"),
                beforeStart,
              },
            ),
            install: async (exchanged, assertInstallCurrent) => {
              if (!exchanged.result.email)
                throw new Error("The provider did not return a verified email address. Review account permissions and try again.");
              try {
                await controller.installVerifiedAccount(
                  {
                    ...(accountId ? { id: accountId } : {}),
                    provider,
                    displayName: exchanged.result.displayName,
                    email: exchanged.result.email,
                  },
                  exchanged.result,
                  { assertCurrent: assertInstallCurrent },
                );
              } catch (error) {
                const pendingCleanup = controller.getSnapshot().pendingCredentialCleanup.length;
                throw oauthInstallFailureWithCleanupContext(error, pendingCleanup, isPrivacyBootstrapError);
              }
            },
          });
          if (completion.canPublish) setNotice(`${provider === "google" ? "Google" : "Microsoft"} account verified and connected.`);
        } finally {
          oauthIntentOwnershipRef.current?.invalidate(owner);
        }
      });
    },
    [run, controller, resources, privacy, session, workspaceGeneration, isIsolatedDemo],
  );

  const disconnectAccount = useCallback(
    async (accountId: string) => {
      await run(async () => {
        await controller.disconnectAccount(accountId);
        setNotice("Account disconnected and pending approvals cleared.");
      });
    },
    [run, controller],
  );
  const syncAccount = useCallback(
    async (accountId: string, continueSync: boolean) => {
      await run(async () => {
        const result = await controller.syncAccount(accountId, {
          continue: continueSync,
        });
        setNotice(
          result.status === "partial"
            ? "Some items remain to sync. Continue to resume from the saved cursor."
            : result.status === "error"
              ? result.lastError ||
                "Sync needs attention. Reconnect or try again."
              : "Account sync completed.",
        );
      });
    },
    [run, controller],
  );
  const refreshMailHead = useCallback(
    (accountId: string) => {
      void run(async () => {
        const result = await controller.refreshMailHead(accountId, {
          reason: "manual",
        });
        setNotice(
          result.message ??
            (result.status === "error"
              ? "Recent mail could not be checked. Review the account and try again."
              : "Recent mail check finished."),
        );
      });
    },
    [controller, run],
  );
  const continueMailBackfill = useCallback(
    (accountId: string) => {
      void run(async () => {
        const result = await controller.continueMailBackfill(accountId);
        setNotice(
          result.message ??
            (result.status === "error"
              ? "Older mail could not be loaded. Review the account and try again."
              : "Older mail scan updated."),
        );
      });
    },
    [controller, run],
  );

  const applyBackgroundRefresh = useCallback(async (enabled: boolean) => {
    if (isIsolatedDemo || !backgroundTasks || backgroundActionBlockedReason) return undefined;
    return run(async () => {
      try {
        await controller.refreshPersistedWorkspace();
      } catch (error) {
        if (isPrivacyBootstrapError(error)) throw error;
        return { error: "refresh" as const };
      }
      try {
        await controller.saveSettings({ backgroundMailRefreshEnabled: enabled });
      } catch (error) {
        if (isPrivacyBootstrapError(error)) throw error;
        return { error: "preference" as const };
      }
      try {
        if (enabled) {
          const status = await backgroundTasks.register();
          return { status };
        }
        await backgroundTasks.unregister();
        return { status: await backgroundTasks.getStatus() };
      } catch (error) {
        if (isPrivacyBootstrapError(error)) throw error;
        return { error: "registration" as const };
      }
    });
  }, [backgroundActionBlockedReason, backgroundTasks, controller, isIsolatedDemo, run]);

  const retryBackgroundRefresh = useCallback(async () => {
    if (isIsolatedDemo || !backgroundTasks || backgroundActionBlockedReason) return undefined;
    return run(async () => {
      try {
        await controller.refreshPersistedWorkspace();
      } catch (error) {
        if (isPrivacyBootstrapError(error)) throw error;
        return { error: "refresh" as const };
      }
      try {
        const desiredEnabled = controller.getSnapshot().settings.backgroundMailRefreshEnabled === true;
        if (desiredEnabled) {
          const status = await backgroundTasks.register();
          return { status };
        }
        await backgroundTasks.unregister();
        return { status: await backgroundTasks.getStatus() };
      } catch (error) {
        if (isPrivacyBootstrapError(error)) throw error;
        return { error: "registration" as const };
      }
    });
  }, [backgroundActionBlockedReason, backgroundTasks, controller, isIsolatedDemo, run]);

  const refreshLocalData = useCallback(() => run(async () => {
    try {
      await controller.refreshPersistedWorkspace();
      return true;
    } catch (error) {
      if (isPrivacyBootstrapError(error)) throw error;
      return false;
    }
  }), [controller, run]);
  const onRefreshProactiveRecovery = useCallback(async () => {
    const operationId = proactiveRecoveryUnknownId;
    if (operationId) setProactiveRecoveryRefreshedId(undefined);
    const refreshed = await refreshLocalData();
    if (refreshed === true) {
      if (operationId) setProactiveRecoveryRefreshedId(operationId);
      setProactiveRecoveryRequiresRefresh(false);
      setProactiveRecoveryError("");
    }
  }, [proactiveRecoveryUnknownId, refreshLocalData]);
  const onInspectProactiveRecovery = useCallback(async () => {
    const operationId = proactiveRecoveryUnknownId;
    if (!operationId || proactiveRecoveryRefreshedId !== operationId || proactiveRecoveryBlocked) return;
    const receipt = await runProactiveRecovery("The recovery receipt could not be checked. Refresh local data and try again.", () =>
      controller.inspectProactiveRecoveryReceipt(operationId));
    if (!receipt) return;
    if (receipt.status === "applied") {
      setProactiveRecoveryUnknownId(undefined);
      setProactiveRecoveryRefreshedId(undefined);
      setNotice("The saved recovery receipt confirms the reset was applied. The private copy remains available on this device.");
    } else {
      setProactiveRecoveryError("The receipt is not verified. No second reset was sent.");
    }
  }, [controller, proactiveRecoveryBlocked, proactiveRecoveryRefreshedId, proactiveRecoveryUnknownId, runProactiveRecovery]);

  const mailAlertCaptureAdmissionBlocked = audio.status === "recording" || audio.status === "paused" ||
    Boolean(captureJournal && (pendingCaptureLoading || pendingCaptureStatus?.kind !== "empty"));
  const canRunMailAlertAction = useCallback(() => {
    return !isIsolatedDemo && !privacyOutcomeUnknown && !privacyReviewOpen && !isolatedPreviewFailed &&
      startupReady && !loading && !mailAlertCaptureAdmissionBlocked && !busy && !busyLock.current;
  }, [busy, isIsolatedDemo, isolatedPreviewFailed, loading, mailAlertCaptureAdmissionBlocked, privacyOutcomeUnknown, privacyReviewOpen, startupReady]);
  const requireMailAlertActionAllowed = useCallback(() => {
    if (!canRunMailAlertAction()) {
      throw new Error("That change could not be confirmed. Review the current status and try again.");
    }
  }, [canRunMailAlertAction]);
  const requireMailAlertActionSuccess = useCallback((result: boolean | undefined) => {
    if (result !== true) {
      throw new Error("That change could not be confirmed. Review the current status and try again.");
    }
  }, []);
  const canRefreshMailAlertWorkspace = useCallback(() => {
    return !isIsolatedDemo && !privacyOutcomeUnknown && !privacyReviewOpen && !isolatedPreviewFailed &&
      startupReady && !loading && !backgroundActionBlockedReason && !busy && !busyLock.current;
  }, [backgroundActionBlockedReason, busy, isIsolatedDemo, isolatedPreviewFailed, loading, privacyOutcomeUnknown, privacyReviewOpen, startupReady]);
  const requireMailAlertRefreshAllowed = useCallback(() => {
    if (!canRefreshMailAlertWorkspace()) {
      throw new Error("That change could not be confirmed. Review the current status and try again.");
    }
  }, [canRefreshMailAlertWorkspace]);
  const mailAlertRefreshAdmissionBlocked = Boolean(backgroundActionBlockedReason || isIsolatedDemo || privacyOutcomeUnknown ||
    privacyReviewOpen || isolatedPreviewFailed || !startupReady || loading);
  const proactiveRecoveryStatus = startupReady ? controller.getProactiveRecoveryStatus() : undefined;
  const onEnableMailAlerts = useCallback(async (input: EnableProactiveMailAlertsInput) => {
    requireMailAlertActionAllowed();
    const result = await run(async () => {
      await controller.enableProactiveMailAlerts(input);
      return true;
    });
    requireMailAlertActionSuccess(result);
  }, [controller, requireMailAlertActionAllowed, requireMailAlertActionSuccess, run]);
  const onRevokeMailAlerts = useCallback(async (ruleId: string) => {
    requireMailAlertActionAllowed();
    const result = await run(async () => {
      await controller.revokeProactiveMailAlerts(ruleId);
      return true;
    });
    requireMailAlertActionSuccess(result);
  }, [controller, requireMailAlertActionAllowed, requireMailAlertActionSuccess, run]);
  const onReconcileMailAlerts = useCallback(async () => {
    requireMailAlertActionAllowed();
    const result = await run(async () => {
      await controller.reconcileProactiveMailAlerts();
      return true;
    });
    requireMailAlertActionSuccess(result);
  }, [controller, requireMailAlertActionAllowed, requireMailAlertActionSuccess, run]);
  const onRefreshMailAlertWorkspace = useCallback(async () => {
    requireMailAlertRefreshAllowed();
    const result = await run(async () => {
      await controller.refreshPersistedWorkspace();
      return true;
    });
    requireMailAlertActionSuccess(result);
  }, [controller, requireMailAlertActionSuccess, requireMailAlertRefreshAllowed, run]);

  if (isIsolatedDemo && isolatedPreviewFailed) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={s.safe}>
          <View style={s.viewport}>
            <Text style={s.kicker}>ISOLATED PREVIEW</Text>
            <Text style={s.h1}>Sample preview could not load.</Text>
            <Text accessibilityRole="alert" style={s.analysisText}>{notice || "The sample data was not started."}</Text>
            <Button label="Reload preview" onPress={() => {
              if (Platform.OS === "web" && typeof window !== "undefined") window.location.reload();
            }} />
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (loading) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={s.safe}>
          <View style={[s.viewport, { alignItems: "center", justifyContent: "center", gap: 12 }]}>
            <ActivityIndicator color={C.sage} />
            <Text style={s.accountSub}>Opening your saved data…</Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!startupReady) {
    return (
      <>
        <StartupRecoveryScreen
          phase={startupRecoveryStatus?.phase === "ready" ? "failed" : startupRecoveryStatus?.phase ?? "failed"}
          inspection={startupRecoveryStatus?.inspection}
          receipt={startupRecoveryStatus?.inspection?.pendingReceipt}
          message={startupRecoveryError}
          plan={startupRecoveryPlan}
          busy={startupRecoveryBusy}
          samplePreview={isStartupRecoveryDemo}
          onRetry={() => void retryStartup()}
          onPrepare={() => void prepareStartupRecovery()}
          onCommit={() => void commitStartupRecovery()}
          onCancel={cancelStartupRecovery}
        />
        <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 10, zIndex: 20 }}>
          <ProviderCleanupNotice registry={resources?.providerCleanup ?? providerCleanupRegistry} scope="all" />
        </View>
      </>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <View style={s.viewport}>
          <View style={s.header}>
            <View>
              <Text style={s.wordmark}>still</Text>
              <Text style={s.headerHint}>A quieter way to keep up</Text>
            </View>
            <IconButton
              name="settings-outline"
              label="Open settings"
            onPress={openSettings}
            />
          </View>
          {!isIsolatedDemo && resources ? <ProviderCleanupNotice registry={resources.providerCleanup} scope="all" /> : null}
          {isIsolatedDemo ? (
            <View style={s.notice}>
              <Text style={s.noticeText}>
                {isOpenRouterChatDemo
                  ? "Sample OpenRouter Chat · in-memory only · no external access"
                  : isOpenRouterBatchDemo
                  ? "Sample OpenRouter Batch · in-memory only · no external access"
                  : isDispatchHistoryDemo
                  ? "Sample history · no external actions"
                  : isMailSyncDemo
                    ? "Sample mail · no external actions"
                    : isBackupImportDemo
                      ? "Sample backup · in-memory only · no external access"
                      : isReminderDemo
                        ? "Sample reminders · in-memory only · simulated alerts"
                    : isDeviceCalendarsDemo
                      ? "Sample device calendars · in-memory only · simulated native calls"
                      : isTranscriptionDemo
                        ? "Sample transcription · in-memory only · no API used"
                      : isStartupRecoveryDemo
                        ? "Sample recovery · in-memory only · no external access"
                        : isPrivacyCleanupDemo
                          ? "Sample privacy cleanup · in-memory only · no external access"
                          : "Sample knowledge · in-memory only · no external actions"}
              </Text>
              {isOpenRouterBatchDemo && batchPreviewMetrics ? (
                <Text style={s.noticeText}>
                  Simulated requests: {batchPreviewMetrics().postCount} submissions · {batchPreviewMetrics().getCount} explicit checks
                </Text>
              ) : null}
              {isOpenRouterChatDemo && chatPreviewMetrics ? (
                <Text style={s.noticeText}>
                  Simulated chat requests: {chatPreviewMetrics().postCount} submissions · {chatPreviewMetrics().getCount} explicit checks
                </Text>
              ) : null}
            </View>
          ) : null}
          {mailAlertTapPending && !mailAlertTapResolution ? (
            <View style={s.notice}>
              <Text style={[s.noticeText, { flex: 1 }]}>A mail alert is waiting for a safe review point.</Text>
              <Button label="Review alert" tone="quiet" disabled={!mailAlertTapExplicitReady} onPress={reviewPendingMailAlertTap} />
            </View>
          ) : null}
          {mailAlertTapStatus ? (
            <View style={s.notice}>
              <Text style={[s.noticeText, { flex: 1 }]}>A mail alert needs review in Settings.</Text>
              <Button label="Open Settings" tone="quiet" onPress={openSettings} />
              <IconButton name="close" label="Dismiss mail alert status notice" onPress={dismissMailAlertTapStatus} color={C.muted} />
            </View>
          ) : null}
          {notice || audio.error || state.pendingCredentialCleanup.length ? (
            <View style={s.notice}>
              <Ionicons
                accessible={false}
                name="information-circle-outline"
                size={17}
                color={C.sage}
              />
              <Text style={s.noticeText}>
                {[
                  notice || audio.error,
                  state.pendingCredentialCleanup.length
                    ? `Credential cleanup pending (${state.pendingCredentialCleanup.length}).`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </Text>
              {state.pendingCredentialCleanup.length ? (
                <Button
                  label={`Retry credential cleanup (${state.pendingCredentialCleanup.length})`}
                  tone="danger"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await controller.retryCredentialCleanup();
                      const remaining =
                        controller.getSnapshot().pendingCredentialCleanup
                          .length;
                      setNotice(
                        remaining
                          ? `Credential cleanup is still pending for ${remaining} item${remaining === 1 ? "" : "s"}. Retry again later.`
                          : "Pending credential cleanup completed.",
                      );
                    })
                  }
                />
              ) : (
                <IconButton name="close" label="Dismiss message" onPress={() => setNotice("")} color={C.muted} />
              )}
            </View>
          ) : null}
          {busy ? (
            <View style={s.busy}>
              <ActivityIndicator color={C.sage} />
              <Text style={s.busyText}>{transcribingNoteId
                ? isTranscriptionDemo ? "Running sample transcription…" : "Transcribing recording…"
                : "Saving locally…"}</Text>
            </View>
          ) : null}
          <View style={s.page}>
            {loading ? (
              <View
                style={{
                  flex: 1,
                  minHeight: 260,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                }}
              >
                <ActivityIndicator color={C.sage} />
                <Text style={s.intro}>Loading your notes…</Text>
              </View>
            ) : manualOpen ? (
              <ManualNoteComposer
                onCancel={() => setManualOpen(false)}
                onSave={(text) =>
                  run(async () => {
                    if (!text.trim()) return;
                    const note = await controller.saveNote({
                      transcript: text.trim(),
                      durationSeconds: 0,
                      capturedAt: new Date().toISOString(),
                      captureTimeZone:
                        Intl.DateTimeFormat().resolvedOptions().timeZone ||
                        "UTC",
                    });
                    setManualOpen(false);
                    openNote(note);
                  })
                }
              />
            ) : detail ? (
              <NoteDetailView
                key={`${detail.id}:${detail.revision}`}
                note={state.notes.find((n) => n.id === detail.id) ?? detail}
                importedAudioMissing={Boolean(detail.importOrigin?.audioMissing)}
                analysis={state.notes.find((n) => n.id === detail.id)?.analysis}
                proposals={state.proposals.filter(
                  (p) => p.noteId === detail.id,
                )}
                busy={busy || loading || !startupReady}
                preview={state.settings.mode === "preview"}
                demoMode={isIsolatedDemo}
                transcriptionDemoMode={isTranscriptionDemo}
                speechEnabled={state.settings.speechEnabled === true}
                speechProvider={state.settings.speechProvider ?? "azure"}
                transcriptionAttempts={state.transcription.attempts.filter((attempt) => attempt.noteId === detail.id)}
                assistantBatchJobs={state.assistantBatchJobs ?? []}
                assistantBatchActionsBlocked={Boolean(state.assistantBatchRecoveryStatus)}
                moreComputeActions={moreComputeActions}
                cancelingTranscriptionId={cancelingTranscriptionId}
                transcriptionRequestRunning={transcribingNoteId === detail.id}
                transcriptionRequestCleanupAttemptIds={(state.transcriptionRequestCleanupPending ?? []).map(({ attemptId }) => attemptId)}
                retryingTranscriptionCleanupId={retryingTranscriptionCleanupId}
                voiceChatTransfer={{
                  plan: chatTranscriptTransferPlan,
                  conversations: chatConversations,
                  selectedConversationId: selectedChatConversationId,
                  blocked: voiceTransferHardBlocked,
                  busy: busy || chatTranscriptTransferBusy || loading || !startupReady,
                  providerReady: state.settings.mode === "provider" && state.settings.llmProvider === "openrouter" &&
                    chatTranscriptTransferKeyReady,
                  onPrepare: () => { void prepareTranscriptForChat(); },
                  onSelectConversation: (conversationId) => {
                    if (chatTranscriptTransferPlanRef.current && !voiceTransferHardBlocked && !busy && !chatTranscriptTransferBusy &&
                        controller.getSnapshot().assistantChatConversations?.some((conversation) => conversation.id === conversationId)) {
                      setSelectedChatConversationId(conversationId);
                    }
                  },
                  onCreateConversation: createTranscriptChatConversation,
                  onSend: sendTranscriptToChat,
                  onCancel: closeTranscriptTransfer,
                }}
                analysisStatusError={
                  analysisStatusError?.key === analysisFreshnessKey
                    ? analysisStatusError.message
                    : undefined
                }
                analysisStatusChecking={Boolean(
                  activeAnalysis &&
                  analysisStatusCheckedKey !== analysisFreshnessKey,
                )}
                people={state.knowledge.people}
                projects={state.knowledge.projects}
                onRetryStatus={() => {
                  checkedAnalysisKey.current = "";
                  setAnalysisStatusError(null);
                  setAnalysisStatusCheckedKey("");
                  setAnalysisStatusRetry((retry) => retry + 1);
                }}
                onClose={closeDetail}
                onUpdate={(transcript) =>
                  run(async () => {
                    const updated = await controller.updateTranscript(
                      detail.id,
                      transcript,
                    );
                    publishDetailOwner(updated);
                  })
                }
                onConfirmImportedTimeZone={(timeZone) => {
                  const currentNote = controller
                    .getSnapshot()
                    .notes.find((note) => note.id === detail.id);
                  if (!currentNote) return;
                  void run(async () => {
                    const updated = await controller.confirmImportedNoteTimeZone(
                      detail.id,
                      { timeZone, expectedRevision: currentNote.revision },
                    );
                    publishDetailOwner(updated);
                    setNotice("Capture time zone confirmed for this imported note.");
                  });
                }}
                onAssist={(options) => {
                  void run(async () => {
                    const route = resolveTextAssistanceRoute(state.settings.mode, state.settings.llmProvider);
                    if (route === "setup_required") {
                      openSettings();
                      setNotice("Text assistance uses OpenRouter Batch. Save its Settings before submitting; immediate model requests are unavailable.");
                      return;
                    }
                    const useOpenRouterBatch = (!isIsolatedDemo || isOpenRouterBatchDemo) && route === "batch";
                    if (useOpenRouterBatch) {
                      const configured = isOpenRouterBatchDemo
                        ? true
                        : (await credentials.getCredentials()).openRouterConfigured === true;
                      if (!configured) {
                        openSettings();
                        setNotice("Save an OpenRouter API key in Settings before queuing this request.");
                        return;
                      }
                      const job = await controller.submitNoteBatch(detail.id, {
                        intent: options.intent,
                        question: options.question,
                        knowledgeSelection: options.knowledgeSelection,
                      });
                      setNotice(isOpenRouterBatchDemo
                        ? "SAMPLE · Simulated Batch request queued. No network or provider was contacted."
                        : job.status === "submission_unknown"
                        ? "Submission status is uncertain. Check Batch history; this will not submit the request again."
                        : "Request queued with OpenRouter Batch. Check for a reply when you choose.");
                      return;
                    }
                    if (route !== "preview") return;
                    const result = await controller.assistNote(
                      detail.id,
                      options,
                    );
                    const updated = controller
                      .getSnapshot()
                      .notes.find((n) => n.id === detail.id);
                    if (updated) publishDetailOwner(updated);
                    setNotice(
                      result.source === "offline_preview"
                        ? "Local preview is ready. It was not generated by AI."
                        : "Response saved against the current note revision.",
                    );
                  });
                }}
                onCheckAssistantBatch={(jobId) => run(async () => {
                  const updated = await controller.refreshAssistantBatch(jobId);
                  setNotice(updated.status === "completed"
                    ? "A validated Batch reply was saved to the note."
                    : "Batch status checked.");
                  return updated;
                })}
                onRetryAssistantBatchCleanup={isIsolatedDemo ? undefined : (jobId) =>
                  controller.retryAssistantBatchCleanup(jobId)}
                onCreateMemorySuggestion={(input) => run(async () => {
                  const suggestion = await controller.createKnowledgeSuggestionFromNote(input);
                  setNotice("Memory suggestion saved for review.");
                  return suggestion;
                })}
                onOpenProposals={() => {
                  setInboxFilter("pending");
                  setTab("inbox");
                  closeDetail();
                }}
                onTranscribe={(expectedRevision) => {
                  const selectedSpeechProvider = state.settings.speechProvider ?? "azure";
                  void speechTranscriptionAdmission.current!.run(async () => run(async () => {
                    return runExplicitSpeechTranscriptionAction({
                      provider: selectedSpeechProvider,
                      enabled: state.settings.speechEnabled === true,
                      hasAzureEndpoint: Boolean(state.settings.speechEndpoint),
                      isolatedPreview: isIsolatedDemo,
                      transcriptionSample: isTranscriptionDemo,
                      readOpenRouterConfigured: async () => (await credentials.getCredentials()).openRouterConfigured === true,
                    }, {
                      openSettings: () => {
                        if (selectedSpeechProvider === "openrouter" && state.settings.speechEnabled) {
                          setNotice("Save an OpenRouter API key in Settings before transcribing this recording.");
                        }
                        openSettings();
                      },
                      onPreviewBlocked: () => setNotice(isTranscriptionDemo
                        ? "OpenRouter Speech uploads are disabled in this sample preview."
                        : "Transcription is disabled in this sample preview."),
                      onCredentialStatusUnavailable: () => {
                        setNotice("OpenRouter key status could not be checked. Review Settings before trying again.");
                        openSettings();
                      },
                      onReady: async () => {
                        setTranscribingNoteId(detail.id);
                        try {
                          const updated = await controller.transcribeNote(detail.id, { expectedRevision });
                          publishDetailOwner(updated);
                          setNotice(isTranscriptionDemo
                            ? "Sample transcript saved — Azure was not contacted."
                            : selectedSpeechProvider === "openrouter"
                              ? "OpenRouter Speech transcript saved. Review reported usage if available."
                              : "Azure Speech transcript saved. Review it before asking about this note.");
                        } catch (error) {
                          if (!isTranscriptionDemo) throw error;
                          setNotice(sampleTranscriptionErrorNotice(error));
                        } finally {
                          setTranscribingNoteId(undefined);
                        }
                      },
                    });
                  })).then((result) => {
                    if (result.status === "failed") setNotice("Transcription could not be confirmed. Review its saved status before trying again.");
                  });
                }}
                onCancelTranscription={(attemptId) => {
                  if (cancelingTranscriptionId) return;
                  setCancelingTranscriptionId(attemptId);
                  void controller.cancelTranscription(detail.id, { attemptId })
                    .then((result) => {
                      setNotice(
                        result.status === "cancelled"
                          ? "Transcription cancellation requested."
                          : result.status === "already_terminal"
                            ? "Transcription history recovered. Review its status before starting another upload."
                            : "No active transcription request was found.",
                      );
                    })
                    .catch((error) => setNotice(messageOf(error)))
                    .finally(() => setCancelingTranscriptionId(undefined));
                }}
                onRetryTranscriptionRequestCleanup={async (attemptId) => {
                  if (transcriptionCleanupActionRef.current) throw new Error("A cleanup action is already running.");
                  transcriptionCleanupActionRef.current = attemptId;
                  setRetryingTranscriptionCleanupId(attemptId);
                  try {
                    await controller.retryTranscriptionRequestCleanup(attemptId);
                    setNotice("Local transcription request cleanup finished.");
                  } catch {
                    setNotice("Local transcription request cleanup could not be confirmed. Try again.");
                    throw new Error("Local request cleanup could not be confirmed.");
                  } finally {
                    transcriptionCleanupActionRef.current = undefined;
                    setRetryingTranscriptionCleanupId(undefined);
                  }
                }}
                onOpenSpeechSettings={() => {
                  if (isIsolatedDemo) {
                    setNotice("Speech settings are disabled in this sample preview.");
                    return;
                  }
                  openSettings();
                }}
                onAttachRecording={() =>
                  setRecordingAttachmentNoteId(detail.id)
                }
                providerReady={(state.settings.speechProvider ?? "azure") === "openrouter" || Boolean(state.settings.speechEndpoint)}
                onPlay={() => run(() => audio.play(detail.audioUri!))}
                onExportAudio={() =>
                  run(async () => {
                    if (!detail.audioUri) return;
                    const file = await loadAudioForUpload(detail.audioUri, audioBoundary);
                    if (file.platform === "web")
                      downloadBlob(file.blob, file.fileName);
                    else
                      await Sharing.shareAsync(file.uri, {
                        mimeType: file.mimeType,
                        dialogTitle: "Export voice recording",
                      });
                  })
                }
                onDelete={() =>
                  confirmAction(
                    "Delete this note?",
                    "The saved note and its audio will be removed.",
                    () =>
                      run(async () => {
                        await controller.deleteNote(detail.id);
                        closeDetail();
                      }),
                  )
                }
              />
            ) : tab === "chat" ? (
              <ChatSection
                conversations={chatConversations}
                selectedConversationId={selectedChatConversationId}
                focusTurnId={moreComputeFocusTurnId}
                turns={selectedChatConversation?.turns ?? []}
                busy={busy}
                enabled={chatEnabled}
                reviewBlocked={chatAppBlocked || Boolean(mailAlertTapResolution)}
                disabledReason={chatDisabledReason}
                recoveryMessage={chatRecoveryMessage}
                samplePreview={isOpenRouterChatDemo}
                onDeleteReviewChange={(open) => {
                  setChatDeleteReviewOpen(open);
                  setChatInteraction(open);
                }}
                onInteractionLockChange={setChatInteraction}
                onSelectConversation={setSelectedChatConversationId}
                onDeleteConversation={chatDeleteConversation}
                onCreateConversation={chatCreateConversation}
                onSend={chatSend}
                onOpenActions={openChatActions}
                onCheckJob={(jobId) => run(async () => {
                  const updated = await controller.refreshAssistantBatch(jobId);
                  setNotice(isOpenRouterChatDemo
                    ? "SAMPLE · Simulated request status checked."
                    : updated.status === "completed"
                      ? "A validated reply is saved in this conversation."
                      : "Request status checked.");
                  return updated;
                })}
                onRetryJobCleanup={(jobId) => controller.retryAssistantBatchCleanup(jobId)}
                moreComputeActions={moreComputeActions}
                onRefineTurn={chatRefineTurn}
                onReviewMemorySuggestion={openChatMemorySuggestion}
              />
            ) : tab === "record" ? (
              <RecordScreen
                audio={audio}
                busy={busy}
                demoMode={isIsolatedDemo}
                startDisabled={Boolean((Platform.OS !== "web" && !captureJournal) || (captureJournal && (pendingCaptureLoading || !pendingCaptureStatus || pendingCaptureStatus.kind !== "empty")))}
                recoveryStatus={captureJournal ? pendingCaptureStatus : Platform.OS !== "web" ? { kind: "blocked", reason: "unsupported" } : null}
                recoveryLoading={Boolean(captureJournal && pendingCaptureLoading)}
                recoveryBusy={busy || pendingCaptureBusy}
                recoveryError={pendingCaptureError}
                onRefreshRecovery={() => void run(refreshPendingCaptureStatus)}
                onInspectRecovery={inspectPendingCapture}
                onSaveRecovery={savePendingFromPanel}
                onExportRecovery={exportPendingCapture}
                onDiscardRecovery={discardPendingCapture}
                onRetryRecoveryCleanup={retryPendingCaptureCleanup}
                recent={notes.slice(0, 3)}
                onOpen={openNote}
                onSeeAll={() => setTab("library")}
                onWrite={() => setManualOpen(true)}
                onStart={() =>
                  isIsolatedDemo
                    ? setNotice(
                        "Microphone recording is disabled in the sample preview.",
                      )
                    : void run(async () => { await audio.start(); })
                }
                onPause={() => void run(async () => { await audio.pause(); })}
                onResume={() => void run(async () => { await audio.resume(); })}
                onStop={() => run(saveRecording)}
                onCancel={confirmCancel}
              />
            ) : tab === "inbox" ? (
              <>
                {chatActionFilterNoteId ? (
                  <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
                    <Text style={s.sectionTitle}>Suggested actions from this chat turn</Text>
                    <Button label="View all actions" tone="quiet" onPress={() => setChatActionFilterNoteId(undefined)} />
                  </View>
                ) : null}
                <InboxScreen
                proposals={proposals}
                accounts={state.accounts}
                mailbox={state.mailbox}
                deviceCalendars={state.deviceCalendars}
                deviceCalendarAccess={state.deviceCalendarAccess.status}
                onReplyMessage={openMailReply}
                proactive={state.proactive}
                filter={inboxFilter}
                setFilter={setInboxFilter}
                mode={state.settings.mode}
                onOpen={(proposal) => void openProposal(proposal)}
                busy={busy}
                onDismissCandidate={(candidateId) =>
                  void run(async () => {
                    await controller.dismissProactiveCandidate(candidateId);
                    setNotice("Attention item dismissed.");
                  })
                }
                onSnoozeCandidate={(candidateId, until) =>
                  void run(async () => {
                    await controller.snoozeProactiveCandidate(
                      candidateId,
                      until,
                    );
                    setNotice("Attention item snoozed.");
                  })
                }
                onRemindCandidate={(candidateId) => void createReminder(candidateId)}
                onGetCandidateSource={(candidateId) =>
                  controller.getProactiveCandidateSource(candidateId)
                }
                />
              </>
            ) : (
              <LibraryScreen
                notes={filteredNotes}
                query={query}
                setQuery={setQuery}
                docs={state.documents}
                tasks={state.tasks}
                busy={busy}
                controller={controller}
                audioBoundary={audioBoundary}
                importedBackups={state.importedBackups}
                archiveActionsBlocked={!startupReady || loading || isolatedPreviewFailed || privacyReviewOpen || privacyOutcomeUnknown ||
                  Boolean(state.mailAlertRefreshRequired || state.proactive.integrityError || state.assistantChatRecoveryStatus || state.assistantBatchRecoveryStatus ||
                    state.knowledgeRecoveryStatus || state.reminderRecoveryStatus) ||
                  proactiveRecoveryRequiresRefresh}
                knowledge={state.knowledge}
                knowledgeRecoveryStatus={state.knowledgeRecoveryStatus}
                references={knowledgeReferenceOptions(state)}
                evidenceLabels={knowledgeEvidenceLabels(state)}
                chatEvidenceLabels={safeChatMemoryEvidenceLabels(chatConversations)}
                memoryReviewBlocked={knowledgeReviewBlocked}
                memoryReviewRequest={knowledgeReviewRequest}
                onMemoryReviewRequestHandled={handleKnowledgeReviewRequest}
                previewMode={isIsolatedDemo}
                sampleBackupMode={isBackupImportDemo}
                knowledgeDemoMode={isKnowledgeDemo}
                reminderRecords={state.reminders.records}
                reminderIntents={state.reminders.intents}
                reminderRecoveryStatus={state.reminderRecoveryStatus}
                reminderDemoMode={isReminderDemo}
                onCreateReminder={() => void createReminder()}
                onOpenReminder={openReminder}
                onRetryReminder={(record) => run(() => controller.retryReminderAlert(record.id, { expectedRevision: record.revision }))}
                onDoneReminder={(record) => run(() => controller.completeReminder(record.id, { expectedRevision: record.revision }))}
                onCancelReminder={(record) => run(() => controller.cancelReminder(record.id, { expectedRevision: record.revision }))}
                onDeleteReminder={(record) => run(() => controller.deleteReminder(record.id, { expectedRevision: record.revision }))}
                onComplete={(id) =>
                  run(async () => {
                    await controller.completeTask(id);
                    setNotice("Task marked complete.");
                  })
                }
                onReopen={(id) =>
                  run(async () => {
                    await controller.reopenTask(id);
                    setNotice("Task reopened.");
                  })
                }
                onOpenNote={openNote}
                onSavePerson={(input) => run(() => controller.savePerson(input))}
                onSaveProject={(input) => run(() => controller.saveProject(input))}
                onSetKnowledgeArchived={(input) => run(() => controller.setKnowledgeEntityArchived(input))}
                onSaveKnowledgeFact={(input) => run(() => controller.saveKnowledgeFact(input))}
                onRemoveKnowledgeFact={(input) => run(async () => { await controller.removeKnowledgeFact(input); return true; })}
                onSaveKnowledgeContact={(input) => run(() => controller.saveKnowledgeContact(input))}
                onRemoveKnowledgeContact={(input) => run(async () => { await controller.removeKnowledgeContact(input); return true; })}
                onSaveKnowledgeSourceLink={(input) => run(() => controller.saveKnowledgeSourceLink(input))}
                onRemoveKnowledgeSourceLink={(input) => run(async () => { await controller.removeKnowledgeSourceLink(input); return true; })}
                onSaveKnowledgeMember={(input) => run(() => controller.saveKnowledgeMember(input))}
                onRemoveKnowledgeMember={(input) => run(async () => { await controller.removeKnowledgeMember(input); return true; })}
                onReviewKnowledgeSuggestion={(id, input) => run(() => controller.reviewKnowledgeSuggestion(id, input))}
                onEditKnowledgeSuggestion={(id, input) => run(() => controller.editKnowledgeSuggestion(id, input))}
                onPrepareKnowledgeSuggestionReview={prepareKnowledgeSuggestionReview}
                onRun={(action) => run(action)}
                onOpenDoc={(d) => {
                  const existing = state.documents.find(
                    (x) => x.path === d.path,
                  );
                  setDoc(existing ?? d);
                  setDocDraft(existing?.content ?? d.content);
                }}
                onExport={() => {
                  if (isIsolatedDemo && !isBackupImportDemo) return;
                  void run(async () => {
                    const data = await controller.exportData();
                    const exportAndShare = async () => {
                      if (Platform.OS === "web") {
                        downloadText(data, "still-export.json", "application/json");
                      } else {
                        const path = `${FileSystem.documentDirectory}still-export.json`;
                        await FileSystem.writeAsStringAsync(path, data);
                        await Sharing.shareAsync(path, { mimeType: "application/json", dialogTitle: "Export Still data" });
                      }
                    };
                    if (privacy && session && !isIsolatedDemo) {
                      await privacy.withWriter(session.epoch, { kind: "internal_export", namespace: "internal_export" }, exportAndShare);
                    } else await exportAndShare();
                  });
                }}
              />
            )}
          </View>
          {!detail && !manualOpen && !settingsOpen && !chatInteractionLocked && (
            <View style={s.tabBar} accessibilityRole="tablist">
              {(["inbox", "record", "chat", "library"] as Tab[]).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityLabel={`${item[0].toUpperCase() + item.slice(1)} tab`}
                  accessibilityState={{ selected: tab === item }}
                  disabled={busy || chatInteractionLocked || chatDeleteReviewOpen}
                  onPress={() => {
                    if (busyLock.current || chatInteractionLock.current || chatDeleteReviewOpen) return;
                    setTab(item);
                  }}
                  style={s.tab}
                >
                  <Ionicons
                    accessible={false}
                    importantForAccessibility="no"
                    name={
                      item === "inbox"
                        ? "file-tray-outline"
                        : item === "record"
                          ? "mic-outline"
                          : item === "chat"
                            ? "chatbubble-outline"
                            : "book-outline"
                    }
                    size={19}
                    color={tab === item ? C.text : C.muted}
                  />
                  <Text style={[s.tabLabel, tab === item && s.tabSelected]}>
                    {item[0].toUpperCase() + item.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
        <Modal
          visible={settingsOpen}
          animationType="slide"
          onRequestClose={() => { void closeSettings(); }}
        >
          <SafeAreaView style={s.modalSafe}>
            <SettingsScreen
              state={state}
              busy={busy}
              open={settingsOpen && !backgroundActionBlockedReason}
              backgroundTasks={backgroundTasks}
              backgroundStatusRefreshKey={backgroundStatusRefreshKey}
              backgroundActionBlockedReason={backgroundActionBlockedReason}
              onSetBackgroundRefresh={applyBackgroundRefresh}
              onRetryBackgroundRefresh={retryBackgroundRefresh}
              onRefreshLocalData={refreshLocalData}
              proactiveRecoveryStatus={proactiveRecoveryStatus}
              proactiveRecoveryPlan={proactiveRecoveryPlan}
              proactiveRecoveryBusy={proactiveRecoveryBusy}
              proactiveRecoveryError={proactiveRecoveryError}
              proactiveRecoveryRequiresRefresh={proactiveRecoveryRequiresRefresh}
              proactiveRecoveryUnknown={Boolean(proactiveRecoveryUnknownId)}
              proactiveRecoveryRefreshed={Boolean(proactiveRecoveryUnknownId && proactiveRecoveryRefreshedId === proactiveRecoveryUnknownId)}
              onOpenProactiveRecovery={() => { setProactiveRecoveryError(""); setProactiveRecoverySheetOpen(true); }}
              onPrepareProactiveRecovery={onPrepareProactiveRecovery}
              onConfirmProactiveRecovery={onConfirmProactiveRecovery}
              onCancelProactiveRecovery={onCancelProactiveRecovery}
              onRefreshProactiveRecovery={onRefreshProactiveRecovery}
              onInspectProactiveRecovery={onInspectProactiveRecovery}
              proactiveRecoverySheetOpen={proactiveRecoverySheetOpen}
              proactiveRecoveryActionBlocked={proactiveRecoveryBlocked}
              dispatchRecoveryStatus={dispatchRecoveryStatus}
              dispatchRecoveryPlan={dispatchRecoveryPlan}
              dispatchRecoveryBusy={dispatchRecoveryBusy}
              dispatchRecoveryError={dispatchRecoveryError}
              dispatchRecoverySheetOpen={dispatchRecoverySheetOpen}
              dispatchRecoveryOwner={dispatchRecoveryOwner}
              dispatchRecoveryBlocked={dispatchRecoveryReadBlocked}
              dispatchRecoveryMutationBlocked={dispatchRecoveryMutationBlocked}
              dispatchRecoveryUnknownId={dispatchRecoveryUnknownId ?? (dispatchRecoveryStatus?.status === "refresh_required" ? dispatchRecoveryStatus.lastOperationId : undefined)}
              dispatchRecoveryRefreshedId={dispatchRecoveryRefreshedId}
              dispatchRecoveryCurrentReviewOperationId={dispatchRecoveryStatus?.status === "available" ? dispatchRecoveryOwnership.currentNotVerifiedOperationId(dispatchRecoveryOwner) : undefined}
              onOpenDispatchRecovery={openDispatchRecovery}
              onPrepareDispatchRecovery={(owner) => { void onPrepareDispatchRecovery(owner); }}
              onConfirmDispatchRecovery={(owner, operationId) => { void onConfirmDispatchRecovery(owner, operationId); }}
              onCancelDispatchRecovery={(owner, operationId) => { void onCancelDispatchRecovery(owner, operationId); }}
              onCloseDispatchRecovery={(owner) => closeDispatchRecovery(owner)}
              onRefreshDispatchRecovery={(owner, operationId) => { void onRefreshDispatchRecovery(owner, operationId); }}
              onInspectDispatchRecovery={(owner, operationId) => { void onInspectDispatchRecovery(owner, operationId); }}
              onReviewCurrentDispatchRecovery={(owner, operationId) => onReviewCurrentDispatchRecovery(owner, operationId)}
              onClose={() => { void closeSettings(); }}
              onSave={(patch) => run(() => controller.saveSettings(patch))}
              onSaveAccount={(c) => run(() => controller.saveAccount(c))}
              onSaveCalendar={(c) => run(() => controller.saveCalendar(c))}
              credentialService={credentials}
              privacyEraseAvailable={isPrivacyCleanupDemo}
              onSaveCredentials={(c) => isIsolatedDemo
                ? Promise.resolve(undefined)
                : run(() => credentials.setCredentials(c))}
              onDeleteCredentials={(kind) => isIsolatedDemo
                ? Promise.resolve(undefined)
                : run(() => credentials.deleteCredentials(kind))}
              onDeleteLocalData={openPrivacyReview}
              onNotice={setNotice}
              assistantBatchJobs={state.assistantBatchJobs ?? []}
              assistantBatchRecoveryMessage={state.assistantBatchRecoveryStatus?.message}
              onCheckAssistantBatch={(jobId) => run(async () => {
                const updated = await controller.refreshAssistantBatch(jobId);
                setNotice(updated.status === "completed"
                  ? "A validated Batch reply was saved to its note."
                  : "Batch status checked.");
                return updated;
              })}
              onRetryAssistantBatchCleanup={isIsolatedDemo ? undefined : (jobId) =>
                controller.retryAssistantBatchCleanup(jobId)}
              onConnect={connectAccount}
              onDisconnect={disconnectAccount}
              onSync={syncAccount}
              onRefreshMail={refreshMailHead}
              onContinueMail={continueMailBackfill}
              onEnableMailAlerts={onEnableMailAlerts}
              onRevokeMailAlerts={onRevokeMailAlerts}
              onReconcileMailAlerts={onReconcileMailAlerts}
              onRefreshMailAlertWorkspace={onRefreshMailAlertWorkspace}
              mailAlertTapStatus={mailAlertTapStatus}
              mailAlertCaptureAdmissionBlocked={mailAlertCaptureAdmissionBlocked}
              mailAlertRefreshAdmissionBlocked={mailAlertRefreshAdmissionBlocked}
              onSaveProactiveRule={(input) =>
                run(async () => {
                  const rule = await controller.saveProactiveRule(input);
                  setNotice("Attention rule saved.");
                  return rule;
                })
              }
              onDeleteProactiveRule={(id, expectedVersion) =>
                run(async () => {
                  await controller.deleteProactiveRule(id, expectedVersion);
                  setNotice("Attention rule deleted.");
                  return true;
                })
              }
              onConnectDeviceCalendars={() => run(async () => {
                const result = await controller.connectDeviceCalendars({ expectedGeneration: state.deviceCalendars.generation });
                setNotice(result.status === "full_access" ? "Device calendars connected with full access." : `Calendar access: ${result.status.replaceAll("_", " ")}.`);
              })}
              onDisconnectDeviceCalendars={() => run(async () => {
                await controller.disconnectDeviceCalendars({ expectedGeneration: state.deviceCalendars.generation });
                setNotice("Device calendars disconnected. Saved event history remains available.");
              })}
              onCheckDeviceCalendarAccess={() => run(async () => {
                const result = await controller.checkDeviceCalendarAccess();
                setNotice(`Calendar access checked: ${result.status.replaceAll("_", " ")}.`);
              })}
              onSelectDeviceCalendars={(calendarIds) => run(async () => {
                await controller.setDeviceCalendarSelection({
                  expectedGeneration: state.deviceCalendars.generation,
                  expectedSelectionRevision: state.deviceCalendars.selectionRevision,
                  calendarIds,
                });
              })}
              onRefreshDeviceCalendars={(continueRunId) => run(async () => {
                await controller.refreshDeviceCalendars({
                  expectedGeneration: state.deviceCalendars.generation,
                  expectedSelectionRevision: state.deviceCalendars.selectionRevision,
                  ...(continueRunId ? { continueRunId } : {}),
                });
                setNotice("The selected device calendars were checked.");
              })}
              demoMode={isIsolatedDemo}
            />
          </SafeAreaView>
        </Modal>
        <Modal
          visible={!!review}
          animationType="slide"
          transparent
          onRequestClose={() => setReview(null)}
        >
          <View style={s.sheetBackdrop}>
            <View style={s.sheet}>
              <View style={s.sheetHandle} />
              <ReviewSheet
                state={state}
                proposal={currentReviewProposal}
                dispatchRecords={state.dispatchRecords}
                deviceEventDispatchRecords={state.deviceCalendars.dispatchRecords}
                mailReplyContextCount={reviewMailReplyBatchJobId
                  ? (state.assistantBatchJobs ?? []).find((job) => job.kind === 'mail_reply' && job.id === reviewMailReplyBatchJobId)?.mailReplyContextCount ?? 0
                  : 0}
                mailReplySourcesStatus={reviewMailReplyBatchJobId ? controller.getMailReplyBatchSourcesStatus(reviewMailReplyBatchJobId) : undefined}
                onRefreshMailReplySources={refreshReviewedMailReplySources}
                busy={busy}
                demoMode={isDeviceCalendarsDemo}
                onInspectDeviceEvent={(recordId) => controller.inspectDeviceEventDispatch(recordId)}
                onReconcileDeviceEvent={(recordId, input) =>
                  run(async () => {
                    const saved = await controller.reconcileDeviceEventDispatch(recordId, input);
                    setNotice("Check recorded. The device event outcome remains unchanged; nothing was created again.");
                    return saved;
                  })
                }
                onReconcile={(recordId, input) =>
                  run(async () => {
                    const saved = await controller.reconcileDispatch(
                      recordId,
                      input,
                    );
                    setNotice(
                      "Check recorded. The provider outcome remains unknown; nothing was resent.",
                    );
                    return saved;
                  })
                }
                sourceStale={Boolean(
                  currentReviewProposal &&
                  ![
                    "accepted",
                    "executed",
                    "simulated",
                    "dismissed",
                    "unknown",
                  ].includes(currentReviewProposal.status) &&
                  (currentReviewProposal.requiresRebuild ||
                    reviewFreshnessCheckedKey !== reviewFreshnessKey ||
                    (reviewFreshnessResult?.key === reviewFreshnessKey &&
                      !reviewFreshnessResult.current)),
                )}
                sourceChecking={Boolean(
                  currentReviewProposal &&
                  ![
                    "accepted",
                    "executed",
                    "simulated",
                    "dismissed",
                    "unknown",
                  ].includes(currentReviewProposal.status) &&
                  reviewFreshnessCheckedKey !== reviewFreshnessKey &&
                  reviewFreshnessError?.key !== reviewFreshnessKey,
                )}
                sourceCheckError={
                  reviewFreshnessError?.key === reviewFreshnessKey
                    ? reviewFreshnessError.message
                    : undefined
                }
                sourceCheckReason={
                  reviewFreshnessResult?.key === reviewFreshnessKey &&
                  !reviewFreshnessResult.current
                    ? reviewFreshnessResult.reason
                    : undefined
                }
                onReassist={() => {
                  const sourceNote = currentReviewProposal
                    ? state.notes.find(
                        (note) => note.id === currentReviewProposal.noteId,
                      )
                    : undefined;
                  setReview(null);
                  if (sourceNote?.origin === "assistant_chat") {
                    setNotice("This suggestion came from a chat request. Start a new chat message to ask for a revision.");
                  } else {
                    if (sourceNote) openNote(sourceNote);
                    setNotice("Run Assist again on this note to rebuild current suggestions.");
                  }
                }}
                onRetrySourceCheck={() => {
                  checkedReviewFreshnessKey.current = "";
                  setReviewFreshnessCheckedKey("");
                  setReviewFreshnessError(null);
                  setReviewFreshnessResult(null);
                  setReviewFreshnessRetry((retry) => retry + 1);
                }}
                onClose={() => setReview(null)}
                onEdit={(patch) =>
                  run(async () => {
                    if (!currentReviewProposal) return;
                    setReview(await controller.editProposal(currentReviewProposal.id, patch, { expectedRevision: currentReviewProposal.revision }));
                  })
                }
                onApprove={() =>
                  run(async () => {
                    if (!currentReviewProposal) return;
                    setReview(await controller.approveProposal(currentReviewProposal.id, { expectedRevision: currentReviewProposal.revision }));
                    setNotice(
                      "Approved for this exact version. The action remains a separate step.",
                    );
                  })
                }
                onExecute={() =>
                  run(async () => {
                    if (!currentReviewProposal) return;
                    setReview(await controller.executeProposal(currentReviewProposal.id, { expectedRevision: currentReviewProposal.revision }));
                  })
                }
                onDismiss={() =>
                  run(async () => {
                    if (!review) return;
                    await controller.dismissProposal(review.id);
                    setReview(null);
                  })
                }
              />
            </View>
          </View>
        </Modal>
        <MailReplyComposer
          visible={Boolean(replyMessageId)}
          messageId={replyMessageId}
          controller={controller}
          busy={busy}
          demoMode={isMailSyncDemo}
          notes={notes}
          documents={state.documents}
          batchJobs={state.assistantBatchJobs ?? []}
          batchEnabled={state.settings.mode === "provider" && state.settings.llmProvider === "openrouter" && mailReplyBatchKeyReady}
          onOpenSettings={openSettings}
          batchBlocked={mailReplyBatchHardBlocked}
          ownerGeneration={mailReplyOwnerGeneration}
          onSubmitBatch={submitMailReplyBatch}
          onCheckBatch={checkMailReplyBatch}
          onReviewBatch={reviewMailReplyBatch}
          onActivateBatch={activateMailReplyBatch}
          onCancelBatchReview={cancelMailReplyBatchReview}
          onDeleteBatch={deleteMailReplyBatch}
          onDiscoverContext={discoverMailReplyContext}
          onContinueContext={continueMailReplyContext}
          onLoadContextMessage={loadMailReplyContextMessage}
          onCancelContext={cancelMailReplyContext}
          onRefreshBatchSources={refreshComposerMailReplySources}
          getBatchSourcesStatus={(jobId) => controller.getMailReplyBatchSourcesStatus(jobId)}
          moreComputeActions={moreComputeActions}
          onClose={closeMailReply}
          onSave={saveMailReply}
        />
        <MailAlertTapReviewSheet
          visible={mailAlertTapResolution?.kind === "mail"}
          result={mailAlertTapResolution}
          onClose={() => setMailAlertTapResolution(null)}
          onOpenInbox={() => {
            setMailAlertTapResolution(null);
            setTab("inbox");
          }}
        />
        {recordingAttachmentNote ? (
          <RecordingAttachmentSheet
            key={recordingAttachmentNote.id}
            visible={Boolean(recordingAttachmentNoteId)}
            note={recordingAttachmentNote}
            demoMode={isIsolatedDemo}
            onPrepare={(noteId, input) =>
              controller.prepareRecordingAttachment(noteId, input)
            }
            onAttach={(input) => controller.attachRecording(input)}
            onCancelSession={(sessionId) =>
              controller.cancelRecordingAttachment(sessionId)
            }
            onAttached={(updated) => {
              openNote(updated);
              setNotice("Recording attached. Review it before transcription.");
            }}
            onClose={() => setRecordingAttachmentNoteId(null)}
          />
        ) : null}
        {reminderReviewRecord ? <ReminderReview
          key={`${reminderReviewRecord.id}:${reminderReviewRecord.revision}`}
          visible={Boolean(reminderReviewId)}
          record={reminderReviewRecord}
          busy={busy}
          isWeb={Platform.OS === "web"}
          demoMode={isReminderDemo}
          canRetry={Boolean(reminderReviewRecord.currentIntentId && (isReminderDemo || ["absent", "blocked", "unavailable", "delivery_unknown", "error"].includes(state.reminders.intents.find((item) => item.id === reminderReviewRecord.currentIntentId)?.observed ?? "unconfirmed")))}
          alertStatus={(() => {
            const intent = state.reminders.intents.find((item) => item.id === reminderReviewRecord.currentIntentId);
            if (isReminderDemo && reminderReviewRecord.status === "saved") return intent?.observed === "pending" ? "A sample alert is simulated." : "The sample alert is not scheduled.";
            if (Platform.OS === "web" && reminderReviewRecord.status === "saved") return "Browser notifications are unavailable.";
            if (intent?.observed === "pending") return "Device alert request is pending.";
            if (intent?.observed === "blocked" || intent?.observed === "unavailable") return "Device alerts are unavailable; the reminder remains saved.";
            if (intent?.observed === "error") return "The device alert could not be scheduled.";
            if (intent?.observed === "delivery_unknown") return "Alert outcome needs checking.";
            if (reminderReviewRecord.status === "saved") return "Alert status could not be confirmed.";
            const cancellations = state.reminders.intents.filter((item) => item.reminderId === reminderReviewRecord.id && item.desired === "cancelled");
            if (cancellations.length && cancellations.every((item) => item.observed === "absent")) return "Alert cancellation confirmed.";
            if (cancellations.some((item) => item.observed === "error" || item.observed === "unavailable")) return "Alert cancellation could not be confirmed.";
            if (cancellations.length) return "Alert cancellation is still being checked.";
            return undefined;
          })()}
          sourceAccountLabel={reminderSourceAccountLabel}
          onClose={() => { setReminderReviewId(null); setReminderSourceAccountLabel(undefined); }}
          onUpdate={(id, payload, expectedRevision) => run(async () => {
            const updated = await controller.updateReminderDraft(id, { ...payload, expectedRevision });
            setNotice("Changes saved. Approve this version before saving the reminder.");
            return updated;
          })}
          onRefreshSource={(record) => run(async () => {
            const updated = await controller.refreshReminderSource(record.id, { expectedRevision: record.revision });
            setNotice("Source refreshed. Review and approve this reminder again.");
            return updated;
          })}
          onApprove={(record) => run(async () => {
            const updated = await controller.approveReminder(record.id, { expectedRevision: record.revision });
            setNotice("Reminder approved. Saving it is a separate step.");
            return updated;
          })}
          onSave={(record) => run(async () => {
            const updated = await controller.saveApprovedReminder(record.id, { expectedRevision: record.revision });
            setNotice(isReminderDemo ? "Sample reminder saved. The alert is simulated." : "Reminder saved on this device.");
            return updated;
          })}
          onRetry={(record) => run(async () => {
            const updated = await controller.retryReminderAlert(record.id, { expectedRevision: record.revision });
            setNotice(isReminderDemo ? "Sample alert check completed." : "Alert retry completed; review its status below.");
            return updated;
          })}
          onDone={(record) => run(async () => {
            const updated = await controller.completeReminder(record.id, { expectedRevision: record.revision });
            setNotice("Reminder marked done.");
            return updated;
          })}
          onCancel={(record) => run(async () => {
            const updated = await controller.cancelReminder(record.id, { expectedRevision: record.revision });
            setNotice("Reminder cancelled. Alert removal is checked separately.");
            return updated;
          })}
        /> : null}
        <Modal
          visible={!!doc}
          animationType="slide"
          onRequestClose={() => setDoc(null)}
        >
          <SafeAreaView style={s.modalSafe}>
            <View style={s.modalHeader}>
              <IconButton
                name="chevron-back"
                label="Back to library"
                onPress={() => setDoc(null)}
              />
              <Text style={s.modalTitle}>{doc?.path ?? "Document"}</Text>
              <Button
                label="Save"
                onPress={() =>
                  run(async () => {
                    if (!doc) return;
                    const saved = await controller.saveDocument(
                      doc.path,
                      docDraft,
                    );
                    setDoc({ path: saved.path, content: saved.content });
                    setNotice("Document saved on this device.");
                  })
                }
              />
            </View>
            <TextInput
              multiline
              value={docDraft}
              onChangeText={setDocDraft}
              style={[s.input, s.docEditor]}
              placeholder="Write a note or personal rule…"
              placeholderTextColor={C.muted}
            />
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function PendingCapturePreview() {
  const sampleReceipt: PendingCaptureReceipt = { id: "10000000-0000-4000-8000-000000000041", revision: "10000000-0000-4000-8000-000000000042" };
  const [status, setStatus] = useState<PendingCaptureSafeStatus>({
    kind: "pending", receipt: sampleReceipt, phase: "needs_inspection", capturedAt: "2026-10-13T04:00:00.000Z",
    inspection: "not_checked", canSave: false, canExport: true, canDiscard: true, replacementOverflow: false,
  });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const empty: PendingCaptureSafeStatus = { kind: "empty" };
  const choose = (value: PendingCaptureSafeStatus) => { setStatus(value); setNotice(""); };
  const caseStatus = (name: string): PendingCaptureSafeStatus => {
    const base = { kind: "pending" as const, receipt: sampleReceipt, capturedAt: "2026-10-13T04:00:00.000Z", canExport: true, canDiscard: true, replacementOverflow: false };
    switch (name) {
      case "Oversize": return { ...base, phase: "needs_inspection", inspection: "known", durationSeconds: 601, canSave: false };
      case "Unknown": return { ...base, phase: "needs_inspection", inspection: "unknown", canSave: false };
      case "Missing": return { ...base, phase: "needs_inspection", inspection: "missing", canSave: false, canExport: false };
      case "Discarding": return { ...base, phase: "discarding", inspection: "known", durationSeconds: 4.125, canSave: false };
      case "Overflow": return { ...base, phase: "needs_inspection", inspection: "unknown", canSave: false, replacementOverflow: true };
      case "Cleanup": return { kind: "blocked", reason: "cleanup_required" };
      case "Unreadable": return { kind: "blocked", reason: "unreadable" };
      default: return { ...base, phase: "needs_inspection", inspection: "not_checked", canSave: false };
    }
  };
  const simulate = async (action: () => void) => { setBusy(true); try { action(); } finally { setBusy(false); } };
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <ScrollView contentContainerStyle={s.scroll}>
          <Text style={s.kicker}>SAMPLE RECORDING RECOVERY</Text>
          <Text style={s.h1Small}>No microphone or external actions.</Text>
          <Text style={s.intro}>This isolated preview uses fictional status only. No file, device storage, or recording is accessed.</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {["Unfinished", "Oversize", "Unknown", "Missing", "Discarding", "Overflow", "Cleanup", "Unreadable"].map((name) => (
              <Pressable key={name} accessibilityRole="button" accessibilityLabel={`Show sample ${name.toLowerCase()} status`} onPress={() => choose(caseStatus(name))} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 22, backgroundColor: C.card, borderColor: C.border, borderWidth: 1 }}>
                <Text style={{ color: C.text, fontSize: 13 }}>{name}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <PendingRecordingRecoveryPanel
            status={status}
            busy={busy}
            sampleMode
            onRefresh={() => void simulate(() => { choose(caseStatus("Unfinished")); setNotice("Sample status refreshed. No file was read."); })}
            onInspect={() => void simulate(() => { choose({ kind: "pending", receipt: sampleReceipt, phase: "inspected", capturedAt: "2026-10-13T04:00:00.000Z", inspection: "known", durationSeconds: 4.125, canSave: true, canExport: true, canDiscard: true, replacementOverflow: false }); setNotice("Sample duration checked: 4.125 seconds. No file was inspected."); })}
            onSave={() => void simulate(() => { choose(empty); setNotice("Sample saved locally. No file or device was used."); })}
            onExport={() => void simulate(() => setNotice("Sample export is disabled. No file was opened."))}
            onDiscard={() => void simulate(() => {
              if (status.kind === "pending" && status.replacementOverflow) {
                choose({ ...status, phase: "discarding", canSave: false, canExport: false, canDiscard: true });
                setNotice("Some sample files could not be tracked. Local-data cleanup is still needed; no file was deleted.");
                return;
              }
              choose(empty);
              setNotice("Sample recovery record cleared. No file was deleted.");
            })}
            onRetryCleanup={() => void simulate(() => { choose(empty); setNotice("Sample cleanup check completed. No file was removed."); })}
          />
          {notice ? <Text accessibilityLiveRegion="polite" style={s.analysisText}>{notice}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function BackgroundRefreshPreview() {
  type DemoCase = "off" | "registration-failure" | "residual" | "restricted";
  const [desiredEnabled, setDesiredEnabled] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const caseRef = useRef<DemoCase>("off");
  const statusRef = useRef<BackgroundTaskStatus>({ platform: "ios", state: "disabled", registered: false, message: "Sample task is not registered." });
  const failedOnce = useRef(false);
  const [backend] = useState<BackgroundTaskBackend>(() => ({
    async getStatus() { return statusRef.current; },
    async isRegistered() { return statusRef.current.registered; },
    async register() {
      if (caseRef.current === "registration-failure" && !failedOnce.current) {
        failedOnce.current = true;
        throw new Error("Sample registration failure.");
      }
      if (caseRef.current === "restricted") return statusRef.current;
      statusRef.current = { platform: "ios", state: "registered", registered: true, message: "Sample task is registered; iOS chooses when it runs." };
      return statusRef.current;
    },
    async unregister() {
      statusRef.current = { platform: "ios", state: "disabled", registered: false, message: "Sample task is not registered." };
    },
    async addExpirationListener() { return { remove() {} }; },
  }));
  const chooseCase = (next: DemoCase) => {
    caseRef.current = next;
    failedOnce.current = false;
    if (next === "residual") {
      setDesiredEnabled(false);
      statusRef.current = { platform: "ios", state: "registered", registered: true, message: "Sample task is still registered." };
    } else if (next === "restricted") {
      setDesiredEnabled(true);
      statusRef.current = { platform: "ios", state: "restricted", registered: false, message: "Sample background execution is restricted." };
    } else if (next === "registration-failure") {
      setDesiredEnabled(true);
      statusRef.current = { platform: "ios", state: "disabled", registered: false, message: "Sample task is not registered." };
    } else {
      setDesiredEnabled(false);
      statusRef.current = { platform: "ios", state: "disabled", registered: false, message: "Sample task is not registered." };
    }
    setRefreshKey((value) => value + 1);
  };
  const act = async (enabled: boolean, savePreference: boolean): Promise<BackgroundRefreshActionResult> => {
    if (savePreference) setDesiredEnabled(enabled);
    try {
      const status = enabled ? await backend.register() : (await backend.unregister(), await backend.getStatus());
      return { status };
    } catch {
      return { status: await backend.getStatus(), error: "registration" };
    }
  };
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <ScrollView contentContainerStyle={s.scroll}>
          <Text style={s.kicker}>SAMPLE BACKGROUND REFRESH</Text>
          <Text style={s.h1Small}>In-memory only · simulated task status</Text>
          <Text style={s.intro}>No app storage, credentials, provider calls, or iOS task registration is used.</Text>
          <Text style={s.label}>Choose a status to preview</Text>
          <View style={s.pills}>
            {(["off", "registration-failure", "residual", "restricted"] as const).map((item) => (
              <Pressable key={item} accessibilityRole="button" accessibilityLabel={`Show ${item.replaceAll("-", " ")} sample`} onPress={() => chooseCase(item)} style={[s.pill, { minHeight: 44, justifyContent: "center" }]}>
                <Text style={s.pillText}>{item.replaceAll("-", " ")}</Text>
              </Pressable>
            ))}
          </View>
          <BackgroundRefreshSection
            open
            desiredEnabled={desiredEnabled}
            backend={backend}
            busy={false}
            sampleMode
            refreshKey={refreshKey}
            onSetDesired={(enabled) => act(enabled, true)}
            onRetry={() => act(desiredEnabled, false)}
          />
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function RecordScreen({
  audio,
  busy,
  demoMode,
  startDisabled,
  recoveryStatus,
  recoveryLoading,
  recoveryBusy,
  recoveryError,
  onRefreshRecovery,
  onInspectRecovery,
  onSaveRecovery,
  onExportRecovery,
  onDiscardRecovery,
  onRetryRecoveryCleanup,
  recent,
  onOpen,
  onSeeAll,
  onWrite,
  onStart,
  onPause,
  onResume,
  onStop,
  onCancel,
}: {
  audio: AudioCapture;
  busy: boolean;
  demoMode: boolean;
  startDisabled: boolean;
  recoveryStatus: PendingCaptureSafeStatus | null;
  recoveryLoading: boolean;
  recoveryBusy: boolean;
  recoveryError: string;
  onRefreshRecovery: () => void;
  onInspectRecovery: (receipt: PendingCaptureReceipt) => void;
  onSaveRecovery: (receipt: PendingCaptureReceipt) => void;
  onExportRecovery: (receipt: PendingCaptureReceipt) => void;
  onDiscardRecovery: (receipt?: PendingCaptureReceipt) => void;
  onRetryRecoveryCleanup: () => void;
  recent: Note[];
  onOpen: (n: Note) => void;
  onSeeAll: () => void;
  onWrite: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const recording = audio.status === "recording" || audio.status === "paused";
  return (
    <ScrollView
      contentContainerStyle={s.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.kicker}>RECORD</Text>
      <Text style={s.h1}>Make space{"\n"}for a thought.</Text>
      <Text style={s.intro}>
        Capture it first. Decide what to do with it later.
      </Text>
      <View style={s.recorder}>
        {demoMode ? (
          <>
            <View style={[s.micOuter, { opacity: 0.45 }]}>
              <View style={s.micInner}>
                <Ionicons
                  accessible={false}
                  name="mic-off-outline"
                  size={28}
                  color={C.bg}
                />
              </View>
            </View>
            <Text style={s.micTitle}>Recording disabled</Text>
            <Text style={s.micSub}>
              Sample preview keeps microphone access off.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Write a note instead"
              onPress={onWrite}
              disabled={busy}
              style={s.writeInstead}
            >
              <Ionicons
                accessible={false}
                name="create-outline"
                size={16}
                color={C.text}
              />
              <Text style={s.writeText}>Write a note instead</Text>
            </Pressable>
          </>
        ) : recording ? (
          <>
            <View style={s.liveRow}>
              <View
                style={[s.liveDot, audio.status === "paused" && s.pausedDot]}
              />
              <Text style={s.liveText}>
                {audio.statusLabel ?? (audio.status === "paused" ? "Paused" : "Recording")} ·{" "}
                {formatTime(audio.durationSeconds)}
              </Text>
            </View>
            <View style={s.wave} accessibilityLabel="Audio level meter">
              {audio.meter.map((v, i) => (
                <View key={i} style={[s.waveBar, { height: 7 + v * 29 }]} />
              ))}
            </View>
            <View style={s.recordControls}>
              <Button
                label={audio.status === "paused" ? "Resume" : "Pause"}
                tone="quiet"
                disabled={busy || (audio.status === "paused" && !audio.canResume)}
                onPress={audio.status === "paused" ? onResume : onPause}
                icon={audio.status === "paused" ? "play" : "pause"}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop and save recording"
                disabled={busy}
                onPress={onStop}
                style={s.stopButton}
              >
                <View style={s.stopSquare} />
              </Pressable>
              <Button
                label="Discard"
                tone="danger"
                disabled={busy}
                onPress={onCancel}
                icon="trash-outline"
              />
            </View>
          </>
        ) : recoveryLoading || (recoveryStatus && recoveryStatus.kind !== "empty") ? (
          <PendingRecordingRecoveryPanel
            status={recoveryStatus}
            loading={recoveryLoading}
            busy={recoveryBusy}
            error={recoveryError}
            onRefresh={onRefreshRecovery}
            onInspect={onInspectRecovery}
            onSave={onSaveRecovery}
            onExport={onExportRecovery}
            onDiscard={onDiscardRecovery}
            onRetryCleanup={onRetryRecoveryCleanup}
          />
        ) : audio.hasPending ? (
          <>
            <Ionicons name="save-outline" size={29} color={C.sage} />
            <Text style={s.micTitle}>Recording ready to save</Text>
            <Text style={s.micSub}>
              The audio is preserved. Retry if storage was unavailable.
            </Text>
            <Button
              label={busy ? "Saving…" : "Save recording"}
              disabled={busy || startDisabled}
              onPress={onStop}
              icon="save-outline"
            />
            <Button
              label="Discard recording"
              tone="danger"
              disabled={busy}
              onPress={onCancel}
              icon="trash-outline"
            />
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start recording a voice note"
              disabled={busy}
              onPress={onStart}
              style={s.micOuter}
            >
              <View style={s.micInner}>
                <Ionicons
                  accessible={false}
                  name="mic"
                  size={30}
                  color={C.bg}
                />
              </View>
            </Pressable>
            <Text style={s.micTitle}>Tap to record</Text>
            <Text style={s.micSub}>Nothing starts until you choose.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Write a note instead"
              onPress={onWrite}
              disabled={busy}
              style={s.writeInstead}
            >
              <Ionicons
                accessible={false}
                name="create-outline"
                size={16}
                color={C.text}
              />
              <Text style={s.writeText}>Write a note instead</Text>
            </Pressable>
          </>
        )}
      </View>
      <View style={s.localHint}>
        <Ionicons name="lock-closed-outline" size={15} color={C.sage} />
        <Text style={s.localHintText}>
          Your recording is saved locally before any optional processing.
        </Text>
      </View>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Recent notes</Text>
        <Pressable accessibilityRole="button" onPress={onSeeAll}>
          <Text style={s.seeAll}>See all</Text>
        </Pressable>
      </View>
      {recent.length ? (
        recent.map((n) => (
          <NoteCard key={n.id} note={n} onPress={() => onOpen(n)} />
        ))
      ) : (
        <View style={s.emptySmall}>
          <Text style={s.emptyTitle}>A little room to begin.</Text>
          <Text style={s.emptyText}>
            Your recordings and handwritten notes will live here.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function ManualNoteComposer({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.modalHeader}>
          <IconButton
            name="chevron-back"
            label="Back to Record"
            onPress={onCancel}
          />
          <Text style={s.modalTitle}>Write a note</Text>
          <View style={{ width: 46 }} />
        </View>
        <Text style={s.kicker}>LOCAL NOTE</Text>
        <Text style={s.h1Small}>Put it into words.</Text>
        <Text style={s.intro}>
          Saved on this device. Nothing is transcribed or processed until you
          choose.
        </Text>
        <Field
          label="Your note"
          multiline
          value={text}
          onChangeText={setText}
          placeholder="What would you like to remember?"
        />
        <Button
          label="Save note"
          disabled={!text.trim()}
          onPress={() => onSave(text)}
        />
        <Button label="Cancel" tone="quiet" onPress={onCancel} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function InboxScreen({
  proposals,
  accounts,
  mailbox,
  deviceCalendars,
  deviceCalendarAccess,
  onReplyMessage,
  proactive,
  filter,
  setFilter,
  mode,
  onOpen,
  busy,
  onDismissCandidate,
  onSnoozeCandidate,
  onRemindCandidate,
  onGetCandidateSource,
}: {
  proposals: Proposal[];
  accounts: AppState["accounts"];
  mailbox: MailboxSnapshotMessage[];
  deviceCalendars: AppState["deviceCalendars"];
  deviceCalendarAccess: AppState["deviceCalendarAccess"]["status"];
  onReplyMessage: (messageId: string) => void;
  proactive: ProactiveState;
  filter: "pending" | "done";
  setFilter: (v: "pending" | "done") => void;
  mode: AppSettings["mode"];
  onOpen: (p: Proposal) => void;
  busy: boolean;
  onDismissCandidate: (candidateId: string) => void;
  onSnoozeCandidate: (candidateId: string, until: string) => void;
  onRemindCandidate: (candidateId: string) => void;
  onGetCandidateSource: AppController["getProactiveCandidateSource"];
}) {
  return (
    <ScrollView
      contentContainerStyle={s.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.kicker}>INBOX</Text>
      <Text style={s.h1}>Review, when ready.</Text>
      <Text style={s.intro}>
        Messages and calendar changes wait for your approval.
      </Text>
      {mode === "preview" ? (
        <View style={s.previewBadge}>
          <Ionicons
            accessible={false}
            name="sparkles-outline"
            size={14}
            color={C.sage}
          />
          <Text style={s.previewText}>Local preview · AI not connected</Text>
        </View>
      ) : null}
      <View style={s.segment}>
        {(["pending", "done"] as const).map((v) => (
          <Pressable
            key={v}
            accessibilityRole="tab"
            accessibilityLabel={
              v === "pending" ? "To review proposals" : "Saved actions"
            }
            accessibilityState={{ selected: filter === v }}
            onPress={() => setFilter(v)}
            style={[s.segmentOption, filter === v && s.segmentSelected]}
          >
            <Text
              style={[s.segmentText, filter === v && s.segmentTextSelected]}
            >
              {v === "pending" ? "To review" : "Saved actions"}
            </Text>
          </Pressable>
        ))}
      </View>
      {proposals.length ? (
        proposals.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            accounts={accounts}
            onPress={() => onOpen(p)}
          />
        ))
      ) : (
        <View style={s.empty}>
          <Ionicons
            accessible={false}
            name="checkmark-circle-outline"
            size={28}
            color={C.sage}
          />
          <Text style={s.emptyTitle}>
            {filter === "pending" ? "All caught up." : "Nothing here yet."}
          </Text>
          <Text style={s.emptyText}>
            {filter === "pending"
              ? "Saved transcripts with possible next steps will appear here as editable drafts."
              : "Saved action receipts and dismissed proposals will appear here. Tasks have their own open/completed list in Library."}
          </Text>
        </View>
      )}
      <ProactiveCandidatesSection
        proactive={proactive}
        accounts={accounts}
        deviceCalendars={deviceCalendars}
        deviceCalendarAccess={deviceCalendarAccess}
        busy={busy}
        onDismiss={onDismissCandidate}
        onSnooze={onSnoozeCandidate}
        onRemind={onRemindCandidate}
        onGetSource={onGetCandidateSource}
      />
      <MailboxSection
        messages={mailbox}
        accounts={accounts}
        onReply={onReplyMessage}
      />
    </ScrollView>
  );
}

function LibraryScreen({
  notes,
  query,
  setQuery,
  docs,
  tasks,
  busy,
  controller,
  audioBoundary,
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
  reminderIntents,
  reminderRecoveryStatus,
  reminderDemoMode,
  onCreateReminder,
  onOpenReminder,
  onRetryReminder,
  onDoneReminder,
  onCancelReminder,
  onDeleteReminder,
  onComplete,
  onReopen,
  onOpenNote,
  onOpenDoc,
  onExport,
  onSavePerson,
  onSaveProject,
  onSetKnowledgeArchived,
  onSaveKnowledgeFact,
  onRemoveKnowledgeFact,
  onSaveKnowledgeContact,
  onRemoveKnowledgeContact,
  onSaveKnowledgeSourceLink,
  onRemoveKnowledgeSourceLink,
  onSaveKnowledgeMember,
  onRemoveKnowledgeMember,
  onReviewKnowledgeSuggestion,
  onEditKnowledgeSuggestion,
  onPrepareKnowledgeSuggestionReview,
  onRun,
}: {
  notes: Note[];
  query: string;
  setQuery: (v: string) => void;
  docs: ContextDocument[];
  tasks: LocalTask[];
  busy: boolean;
  controller: AppController;
  audioBoundary?: PrivacyAudioBoundary;
  importedBackups: AppState["importedBackups"];
  archiveActionsBlocked: boolean;
  knowledge: AppState["knowledge"];
  knowledgeRecoveryStatus?: AppState["knowledgeRecoveryStatus"];
  references: { reference: KnowledgeReference; label: string }[];
  evidenceLabels: Record<string, string>;
  chatEvidenceLabels: Record<string, string>;
  memoryReviewBlocked: boolean;
  memoryReviewRequest?: { suggestionId: string; requestId: number };
  onMemoryReviewRequestHandled: (requestId: number) => void;
  previewMode: boolean;
  sampleBackupMode: boolean;
  knowledgeDemoMode: boolean;
  reminderRecords: ReminderRecord[];
  reminderIntents: ReminderIntent[];
  reminderRecoveryStatus?: AppState["reminderRecoveryStatus"];
  reminderDemoMode: boolean;
  onCreateReminder: () => void;
  onOpenReminder: (record: ReminderRecord) => void;
  onRetryReminder: (record: ReminderRecord) => Promise<unknown>;
  onDoneReminder: (record: ReminderRecord) => Promise<unknown>;
  onCancelReminder: (record: ReminderRecord) => Promise<unknown>;
  onDeleteReminder: (record: ReminderRecord) => Promise<unknown>;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onOpenNote: (n: Note) => void;
  onOpenDoc: (d: { path: string; content: string }) => void;
  onExport: () => void;
  onSavePerson: (input: SavePersonInput) => Promise<unknown>;
  onSaveProject: (input: SaveProjectInput) => Promise<unknown>;
  onSetKnowledgeArchived: (input: { kind: KnowledgeEntityKind; id: string; expectedRevision: number; archived: boolean }) => Promise<unknown>;
  onSaveKnowledgeFact: (input: SaveKnowledgeFactInput) => Promise<unknown>;
  onRemoveKnowledgeFact: (input: KnowledgeItemCommand) => Promise<unknown>;
  onSaveKnowledgeContact: (input: SaveKnowledgeContactInput) => Promise<unknown>;
  onRemoveKnowledgeContact: (input: KnowledgeItemCommand & { entityKind: 'person' }) => Promise<unknown>;
  onSaveKnowledgeSourceLink: (input: SaveKnowledgeSourceLinkInput) => Promise<unknown>;
  onRemoveKnowledgeSourceLink: (input: KnowledgeItemCommand) => Promise<unknown>;
  onSaveKnowledgeMember: (input: SaveKnowledgeMemberInput) => Promise<unknown>;
  onRemoveKnowledgeMember: (input: KnowledgeItemCommand & { entityKind: 'project' }) => Promise<unknown>;
  onReviewKnowledgeSuggestion: (id: string, input: ReviewKnowledgeSuggestionInput) => Promise<unknown>;
  onEditKnowledgeSuggestion: (id: string, input: EditKnowledgeSuggestionInput) => Promise<KnowledgeSuggestion | undefined>;
  onPrepareKnowledgeSuggestionReview: (id: string, input: { expectedRevision: number }) => Promise<KnowledgeSuggestionReview>;
  onRun: <T>(action: () => Promise<T>) => Promise<T | undefined>;
}) {
  const [importOpen, setImportOpen] = useState(false);
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
        Voice notes, transcripts, and documents saved on this device.
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
        intents={reminderIntents}
        query={query}
        busy={busy}
        isWeb={Platform.OS === 'web'}
        demoMode={reminderDemoMode}
        onAdd={onCreateReminder}
        onOpen={onOpenReminder}
        onRetry={(record) => { void onRetryReminder(record); }}
        onDone={(record) => { void onDoneReminder(record); }}
        onCancel={(record) => { void onCancelReminder(record); }}
        onDelete={(record) => { void onDeleteReminder(record); }}
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
          <NoteCard key={n.id} note={n} onPress={() => onOpenNote(n)} />
        ))
      ) : (
        <Text style={s.emptyText}>No matching notes.</Text>
      )}
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Documents</Text>
        <IconButton
          name="add"
          label="Create personal document"
          onPress={() =>
            onOpenDoc({ path: newDocumentPath(docs), content: "" })
          }
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
              onPress={() => onOpenDoc(d)}
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
      <View style={{ height: 10 }} />
      <Button
        label="Import a backup"
        tone="quiet"
        icon="cloud-download-outline"
        disabled={busy || (previewMode && !sampleBackupMode)}
        onPress={() => {
          if (previewMode && !sampleBackupMode) return;
          setImportOpen(true);
        }}
      />
      <ImportedBackupsSection
        archives={importedBackups}
        currentDocuments={docs}
        controller={controller}
        busy={busy}
        archiveActionsBlocked={archiveActionsBlocked}
        query={query}
        onDeleteImportedChatConversation={async (archiveId, conversationId) => {
          const removed = await onRun(async () => {
            await controller.deleteImportedChatConversation({ archiveId, conversationId });
            return true;
          });
          return removed === true;
        }}
      />
      <View style={{ height: 10 }} />
      <Button
        label={sampleBackupMode ? "Export sample backup" : previewMode ? "Export unavailable in sample mode" : "Export local data"}
        tone="quiet"
        icon="download-outline"
        disabled={previewMode && !sampleBackupMode || busy}
        onPress={onExport}
      />
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
          onCreate={() => { setEntityKind(section === 'people' ? 'person' : 'project'); setEditingEntityId(null); setEditorInstance((value) => value + 1); setEntitySheetOpen(true); }}
          onOpen={(entity) => { setEntityKind(section === 'people' ? 'person' : 'project'); setEditingEntityId(entity.id); setEditorInstance((value) => value + 1); setEntitySheetOpen(true); }}
          onArchive={(kind, id, revision, archived) => {
            void onSetKnowledgeArchived({ kind, id, expectedRevision: revision, archived });
          }}
        />
      ) : section === 'memory' ? (
        <>
          {knowledgeRecoveryStatus ? <View style={s.analysisStale}><Text style={s.analysisText}>{knowledgeRecoveryStatus.message}</Text></View> : null}
          <KnowledgeSuggestionSheet
            suggestions={knowledge.suggestions}
            people={knowledge.people}
            projects={knowledge.projects}
            sourceLabels={{ ...evidenceLabels, ...chatEvidenceLabels }}
            busy={busy}
            blocked={memoryReviewBlocked}
            openRequest={memoryReviewRequest}
            onRequestHandled={onMemoryReviewRequestHandled}
            onPrepareReview={onPrepareKnowledgeSuggestionReview}
            onReview={onReviewKnowledgeSuggestion}
            onEdit={onEditKnowledgeSuggestion}
          />
          <ImportedKnowledgeReview archives={importedBackups} busy={busy} controller={controller} onRun={onRun} />
        </>
      ) : null}
      <BackupImportSheet
        visible={importOpen}
        controller={controller}
        busy={busy}
        sampleMode={sampleBackupMode}
        privacyAudioBoundary={audioBoundary}
        onClose={() => setImportOpen(false)}
      />
      <KnowledgeEntitySheet
        key={editorInstance}
        visible={entitySheetOpen}
        kind={entityKind}
        entity={editingEntity}
        people={knowledge.people}
        documents={docs}
        references={references}
        busy={busy}
        onClose={() => { setEntitySheetOpen(false); setEditingEntityId(null); }}
        onSavePerson={onSavePerson}
        onSaveProject={onSaveProject}
        onSaveFact={onSaveKnowledgeFact}
        onRemoveFact={onRemoveKnowledgeFact}
        onSaveContact={onSaveKnowledgeContact}
        onRemoveContact={onRemoveKnowledgeContact}
        onSaveSourceLink={onSaveKnowledgeSourceLink}
        onRemoveSourceLink={onRemoveKnowledgeSourceLink}
        onSaveMember={onSaveKnowledgeMember}
        onRemoveMember={onRemoveKnowledgeMember}
      />
    </ScrollView>
  );
}

function SettingsScreen({
  state,
  busy,
  open,
  backgroundTasks,
  backgroundStatusRefreshKey,
  backgroundActionBlockedReason,
  onSetBackgroundRefresh,
  onRetryBackgroundRefresh,
  onRefreshLocalData,
  assistantBatchJobs,
  assistantBatchRecoveryMessage,
  onCheckAssistantBatch,
  onRetryAssistantBatchCleanup,
  proactiveRecoveryStatus,
  proactiveRecoveryPlan,
  proactiveRecoveryBusy,
  proactiveRecoveryError,
  proactiveRecoveryRequiresRefresh,
  proactiveRecoveryUnknown,
  proactiveRecoveryRefreshed,
  onOpenProactiveRecovery,
  onPrepareProactiveRecovery,
  onConfirmProactiveRecovery,
  onCancelProactiveRecovery,
  onRefreshProactiveRecovery,
  onInspectProactiveRecovery,
  proactiveRecoverySheetOpen,
  proactiveRecoveryActionBlocked,
  dispatchRecoveryStatus,
  dispatchRecoveryPlan,
  dispatchRecoveryBusy,
  dispatchRecoveryError,
  dispatchRecoverySheetOpen,
  dispatchRecoveryOwner,
  dispatchRecoveryBlocked,
  dispatchRecoveryMutationBlocked,
  dispatchRecoveryUnknownId,
  dispatchRecoveryRefreshedId,
  dispatchRecoveryCurrentReviewOperationId,
  onOpenDispatchRecovery,
  onPrepareDispatchRecovery,
  onConfirmDispatchRecovery,
  onCancelDispatchRecovery,
  onCloseDispatchRecovery,
  onRefreshDispatchRecovery,
  onInspectDispatchRecovery,
  onReviewCurrentDispatchRecovery,
  demoMode,
  onClose,
  onSave,
  onSaveAccount,
  onSaveCalendar,
  onSaveCredentials,
  onDeleteCredentials,
  credentialService,
  privacyEraseAvailable = false,
  onDeleteLocalData,
  onNotice,
  onConnect,
  onDisconnect,
  onSync,
  onRefreshMail,
  onContinueMail,
  onSaveProactiveRule,
  onDeleteProactiveRule,
  onEnableMailAlerts,
  onRevokeMailAlerts,
  onReconcileMailAlerts,
  onRefreshMailAlertWorkspace,
  mailAlertTapStatus,
  mailAlertCaptureAdmissionBlocked,
  mailAlertRefreshAdmissionBlocked,
  onConnectDeviceCalendars,
  onDisconnectDeviceCalendars,
  onCheckDeviceCalendarAccess,
  onSelectDeviceCalendars,
  onRefreshDeviceCalendars,
}: {
  state: AppState;
  open: boolean;
  backgroundTasks?: BackgroundTaskBackend;
  backgroundStatusRefreshKey: number;
  backgroundActionBlockedReason?: string;
  onSetBackgroundRefresh: (enabled: boolean) => Promise<BackgroundRefreshActionResult | undefined>;
  onRetryBackgroundRefresh: () => Promise<BackgroundRefreshActionResult | undefined>;
  onRefreshLocalData: () => Promise<boolean | undefined>;
  assistantBatchJobs: readonly AssistantBatchJobDTO[];
  assistantBatchRecoveryMessage?: string;
  onCheckAssistantBatch: (jobId: string) => Promise<unknown> | unknown;
  onRetryAssistantBatchCleanup?: (jobId: string) => Promise<unknown> | unknown;
  proactiveRecoveryStatus?: ProactiveRecoveryStatus;
  proactiveRecoveryPlan?: ProactiveRecoveryPlan;
  proactiveRecoveryBusy: boolean;
  proactiveRecoveryError: string;
  proactiveRecoveryRequiresRefresh: boolean;
  proactiveRecoveryUnknown: boolean;
  proactiveRecoveryRefreshed: boolean;
  onOpenProactiveRecovery: () => void;
  onPrepareProactiveRecovery: () => Promise<void>;
  onConfirmProactiveRecovery: (operationId: string) => Promise<void>;
  onCancelProactiveRecovery: (operationId?: string) => Promise<boolean>;
  onRefreshProactiveRecovery: () => Promise<void>;
  onInspectProactiveRecovery: () => Promise<void>;
  proactiveRecoverySheetOpen: boolean;
  proactiveRecoveryActionBlocked: boolean;
  dispatchRecoveryStatus?: DispatchRecoveryStatus;
  dispatchRecoveryPlan?: DispatchRecoveryPlan;
  dispatchRecoveryBusy: boolean;
  dispatchRecoveryError: string;
  dispatchRecoverySheetOpen: boolean;
  dispatchRecoveryOwner: number;
  dispatchRecoveryBlocked: boolean;
  dispatchRecoveryMutationBlocked: boolean;
  dispatchRecoveryUnknownId?: string;
  dispatchRecoveryRefreshedId?: string;
  dispatchRecoveryCurrentReviewOperationId?: string;
  onOpenDispatchRecovery: () => void;
  onPrepareDispatchRecovery: (owner: number) => void;
  onConfirmDispatchRecovery: (owner: number, operationId: string) => void;
  onCancelDispatchRecovery: (owner: number, operationId: string) => void;
  onCloseDispatchRecovery: (owner: number) => void;
  onRefreshDispatchRecovery: (owner: number, operationId: string) => void;
  onInspectDispatchRecovery: (owner: number, operationId: string) => void;
  onReviewCurrentDispatchRecovery: (owner: number, previousOperationId: string) => void;
  onClose: () => void;
  busy: boolean;
  demoMode: boolean;
  onConnect: (
    provider: OAuthProvider,
    capabilities: AccountCapability[],
    accountId?: string,
  ) => Promise<void>;
  onDisconnect: (accountId: string) => Promise<void>;
  onSync: (accountId: string, continueSync: boolean) => Promise<void>;
  onRefreshMail: (accountId: string) => void;
  onContinueMail: (accountId: string) => void;
  onSaveProactiveRule: (
    input: Parameters<AppController["saveProactiveRule"]>[0],
  ) => Promise<SavedProactiveRule | undefined>;
  onDeleteProactiveRule: (
    id: string,
    expectedVersion: number,
  ) => Promise<boolean | undefined>;
  onEnableMailAlerts: (input: EnableProactiveMailAlertsInput) => Promise<void>;
  onRevokeMailAlerts: (ruleId: string) => Promise<void>;
  onReconcileMailAlerts: () => Promise<void>;
  onRefreshMailAlertWorkspace: () => Promise<void>;
  mailAlertTapStatus?: MailAlertTapStatus;
  mailAlertCaptureAdmissionBlocked: boolean;
  mailAlertRefreshAdmissionBlocked: boolean;
  onConnectDeviceCalendars: () => Promise<unknown>;
  onDisconnectDeviceCalendars: () => Promise<unknown>;
  onCheckDeviceCalendarAccess: () => Promise<unknown>;
  onSelectDeviceCalendars: (calendarIds: string[]) => Promise<unknown>;
  onRefreshDeviceCalendars: (continueRunId?: string) => Promise<unknown>;
  onSave: (p: Partial<AppSettings>) => Promise<unknown>;
  onSaveAccount: (c: {
    provider: "google" | "microsoft" | "local";
    displayName: string;
    email: string;
  }) => Promise<unknown>;
  onSaveCalendar: (c: {
    accountId: string;
    name: string;
    writable?: boolean;
  }) => Promise<unknown>;
  onSaveCredentials: (c: {
    speechSubscriptionKey?: string;
    openAiApiKey?: string;
    openRouterApiKey?: string;
  }) => Promise<unknown>;
  onDeleteCredentials: (kind?: "speech" | "openai" | "openrouter") => Promise<unknown>;
  credentialService: ProviderCredentialService;
  privacyEraseAvailable?: boolean;
  onDeleteLocalData: () => void;
  onNotice: (v: string) => void;
}) {
  const recoveryPlan = proactiveRecoveryPlan ?? proactiveRecoveryStatus?.plan;
  const recoveryReason = proactiveRecoveryStatus?.reason === "archive_invalid"
    ? "The private recovery archive could not be validated. Existing saved data has not been reset."
    : proactiveRecoveryStatus?.reason === "archive_full"
      ? "The private recovery archive is full. Existing saved data has not been reset."
      : proactiveRecoveryStatus?.reason === "evidence_too_large"
        ? "The saved recovery evidence is larger than this recovery flow supports. Existing saved data has not been reset."
        : proactiveRecoveryStatus?.reason === "unsupported_storage"
          ? "This storage does not support a safe recovery review. Existing saved data has not been reset."
          : proactiveRecoveryStatus?.reason === "privacy_unavailable"
            ? "Privacy protection is unavailable. Existing saved data has not been reset."
            : proactiveRecoveryStatus?.reason === "startup_unavailable"
              ? "Local startup is not ready for recovery. Existing saved data has not been reset."
              : proactiveRecoveryStatus?.status === "busy"
                ? "Recovery is waiting for another local operation to finish. No reset was made."
                : proactiveRecoveryStatus?.status === "unavailable"
                  ? "Recovery is unavailable. Existing saved data has not been reset."
                  : "";
  const [speechEndpoint, setSpeechEndpoint] = useState(
    state.settings.speechEndpoint ?? "",
  );
  const [speechProvider, setSpeechProvider] = useState<"azure" | "openrouter">(
    state.settings.speechProvider ?? "azure",
  );
  const [effort, setEffort] = useState<"none" | "low">(
    state.settings.openRouterReasoningEffort ?? "low",
  );
  const [localRefreshMessage, setLocalRefreshMessage] = useState("");
  const [maxAudioSeconds, setMaxAudioSeconds] = useState(
    String(state.settings.maxAudioSeconds),
  );
  const [retention, setRetention] = useState(state.settings.audioRetention);
  const [providerEnabled, setProviderEnabled] = useState(
    state.settings.mode === "provider",
  );
  const [speechEnabled, setSpeechEnabled] = useState(
    state.settings.speechEnabled === true,
  );
  const [speechKey, setSpeechKey] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [credentialStatus, setCredentialStatus] = useState({
    speechConfigured: false,
    openAiConfigured: false,
    openRouterConfigured: false,
  });
  const [email, setEmail] = useState("");
  const [accountName, setAccountName] = useState("");
  const [provider, setProvider] = useState<"google" | "microsoft">("google");
  const [calendarName, setCalendarName] = useState("");
  const [calendarAccountId, setCalendarAccountId] = useState(
    state.accounts[0]?.id ?? "",
  );
  useEffect(() => {
    if (demoMode) return;
    credentialService.getCredentials()
      .then((status) => setCredentialStatus({
        speechConfigured: status.speechConfigured,
        openAiConfigured: status.openAiConfigured,
        openRouterConfigured: status.openRouterConfigured === true,
      }))
      .catch((e) => onNotice(messageOf(e)));
  }, [credentialService, demoMode, onNotice]);
  const saveSettings = async () => {
    const result = await onSave({
      mode: providerEnabled ? "provider" : "preview",
      ...buildLlmProviderSettingsPatch({
        openRouterEffort: effort,
      }),
      speechEnabled,
      ...buildSpeechProviderSettingsPatch(speechProvider),
      ...(speechProvider === "azure" ? { speechEndpoint } : {}),
      maxAudioSeconds: Number(maxAudioSeconds),
      audioRetention: retention,
    });
    if (result)
      onNotice(
        providerEnabled
          ? "Settings saved. Provider access and credentials are still unverified."
          : "Settings saved. Local preview remains enabled.",
      );
  };
  const saveKeys = async () => {
    const result = await onSaveCredentials(buildProviderCredentialInput(speechKey, openRouterKey));
    if (result) {
      setSpeechKey("");
      setOpenRouterKey("");
      setCredentialStatus(result as typeof credentialStatus);
      onNotice(
        Platform.OS === "web"
          ? "Keys saved for this browser session only."
          : "Credentials saved to the platform secure store.",
      );
    }
  };
  const saveAccount = async () => {
    if (!email.trim()) {
      onNotice("Enter an email address first.");
      return;
    }
    const result = await onSaveAccount({
      provider,
      displayName: accountName || email,
      email,
    });
    if (result) {
      setEmail("");
      setAccountName("");
      onNotice(
        "Account configuration saved. OAuth has not been connected or verified.",
      );
    }
  };
  const saveCalendar = async () => {
    if (!calendarAccountId || !calendarName) {
      onNotice("Choose a configured account and enter a calendar name.");
      return;
    }
    const result = await onSaveCalendar({
      accountId: calendarAccountId,
      name: calendarName,
      writable: false,
    });
    if (result) {
      setCalendarName("");
      onNotice("Calendar configuration saved. It is not connected.");
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={s.modalHeader}>
        <IconButton
          name="chevron-back"
          label="Close settings"
          onPress={onClose}
        />
        <Text style={s.modalTitle}>Settings</Text>
        <View style={{ width: 46 }} />
      </View>
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.intro}>
          Private by design. Provider setup is optional and can wait.
        </Text>
        {demoMode ? (
          <View style={s.analysisStale}>
            <Text style={s.analysisText}>
              Sample preview uses in-memory data. OAuth, provider keys, and
              external requests are disabled.
            </Text>
          </View>
        ) : null}
        {state.dispatchRecoveryStatus ? (
          <View style={s.analysisStale}>
            <Text style={s.analysisText}>
              {state.dispatchRecoveryStatus.message}
            </Text>
          </View>
        ) : null}
        <DispatchRecoverySection
          status={dispatchRecoveryStatus}
          integrityMessage={state.dispatchRecoveryStatus?.message}
          plan={dispatchRecoveryPlan}
          open={dispatchRecoverySheetOpen}
          busy={dispatchRecoveryBusy}
          blocked={dispatchRecoveryBlocked || Boolean(backgroundActionBlockedReason)}
          mutationBlocked={dispatchRecoveryMutationBlocked || Boolean(backgroundActionBlockedReason)}
          error={dispatchRecoveryError}
          unknownOperationId={dispatchRecoveryUnknownId}
          refreshedOperationId={dispatchRecoveryRefreshedId}
          reviewCurrentOperationId={dispatchRecoveryCurrentReviewOperationId}
          onOpen={onOpenDispatchRecovery}
          onPrepare={() => onPrepareDispatchRecovery(dispatchRecoveryOwner)}
          onConfirm={(operationId) => onConfirmDispatchRecovery(dispatchRecoveryOwner, operationId)}
          onCancel={(operationId) => onCancelDispatchRecovery(dispatchRecoveryOwner, operationId)}
          onClose={() => onCloseDispatchRecovery(dispatchRecoveryOwner)}
          onRefresh={(operationId) => onRefreshDispatchRecovery(dispatchRecoveryOwner, operationId)}
          onInspect={(operationId) => onInspectDispatchRecovery(dispatchRecoveryOwner, operationId)}
          onReviewCurrent={(operationId) => onReviewCurrentDispatchRecovery(dispatchRecoveryOwner, operationId)}
        />
        {mailAlertTapStatus ? (
          <MailAlertTapStatusCard status={mailAlertTapStatus} />
        ) : null}
        <View style={s.providerToggle}>
          <View style={{ flex: 1 }}>
            <Text style={s.accountName}>Enable provider analysis</Text>
            <Text style={s.accountSub}>
              New text requests use delayed OpenRouter Batch. Nothing is sent until you submit a request.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Enable provider analysis"
            value={providerEnabled}
            onValueChange={setProviderEnabled}
            disabled={demoMode}
            trackColor={{ false: C.border, true: C.sage }}
            thumbColor={C.text}
          />
        </View>
        <View style={s.providerToggle}>
          <View style={{ flex: 1 }}>
            <Text style={s.accountName}>Enable {speechProvider === "azure" ? "Azure" : "OpenRouter"} transcription</Text>
            <Text style={s.accountSub}>
              Separate from AI analysis. A saved recording is uploaded only after you choose Transcribe.
            </Text>
          </View>
          <Switch
            accessibilityLabel={`Enable ${speechProvider === "azure" ? "Azure" : "OpenRouter"} transcription`}
            value={speechEnabled}
            onValueChange={setSpeechEnabled}
            disabled={demoMode}
            trackColor={{ false: C.border, true: C.sage }}
            thumbColor={C.text}
          />
        </View>
        <Text style={s.sectionTitle}>Speech provider</Text>
        <View style={s.pills}>
          {(["azure", "openrouter"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: speechProvider === value }}
              accessibilityLabel={`Use ${value === "azure" ? "Azure Speech" : "OpenRouter Speech"}`}
              onPress={() => {
                if (value === "openrouter") setSpeechKey("");
                setSpeechProvider(value);
              }}
              style={[s.pill, speechProvider === value && s.pillActive]}
            >
              <Text style={[s.pillText, speechProvider === value && s.pillTextActive]}>
                {value === "azure" ? "Azure Speech" : "OpenRouter"}
              </Text>
            </Pressable>
          ))}
        </View>
        {speechProvider === "openrouter" ? (
          <View style={s.analysisStale}>
            <Text style={s.accountName}>OpenRouter transcription model</Text>
            <Text accessibilityLabel={`OpenRouter transcription model ${OPENROUTER_SPEECH_DEFAULT_MODEL}`} style={s.analysisText}>
              {OPENROUTER_SPEECH_DEFAULT_MODEL}
            </Text>
            <Text style={s.disclaimer}>
              Choose Transcribe on a saved recording to upload it to OpenRouter. Usage appears only when reported; no cost is estimated. This does not use Batch.
            </Text>
          </View>
        ) : null}
        <Text style={s.sectionTitle}>Text provider</Text>
        <View style={s.analysisStale}>
          <Text style={s.accountName}>OpenRouter Batch · openai/gpt-6-luna:batch</Text>
          <Text style={s.disclaimer}>
            Requests may take up to 24 hours. OpenRouter retains batch inputs and results for 30 days or until the batch is deleted. Provider cost appears only when reported; no cost is estimated.
          </Text>
          {state.settings.llmProvider !== "openrouter" ? <Text style={s.disclaimer}>Legacy text-provider settings are inactive. Saving these Settings explicitly switches new text requests to OpenRouter Batch.</Text> : null}
        </View>
        {speechProvider === "azure" ? <Field
          label="Speech endpoint"
          value={speechEndpoint}
          onChangeText={setSpeechEndpoint}
          placeholder="Speech resource endpoint"
          keyboardType="url"
        /> : null}
        <Text style={s.label}>Reasoning effort</Text>
        <View style={s.pills}>
          {(["none", "low"] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => setEffort(v)}
              style={[s.pill, effort === v && s.pillActive]}
            >
              <Text style={[s.pillText, effort === v && s.pillTextActive]}>
                {v}
              </Text>
            </Pressable>
          ))}
        </View>
        <Button
          label="Save OpenRouter Batch settings"
          disabled={demoMode || busy}
          onPress={() => void saveSettings()}
        />
        {demoMode ? null : (
          <>
            {speechProvider === "azure" ? <Field
              label="Speech subscription key"
              secureTextEntry
              value={speechKey}
              onChangeText={setSpeechKey}
              placeholder={
                credentialStatus.speechConfigured
                  ? Platform.OS === "web"
                    ? "Saved in this session · enter to replace"
                    : "Saved securely · enter to replace"
                  : "Not configured"
              }
            /> : null}
            <Field
              label="OpenRouter API key"
              secureTextEntry
              value={openRouterKey}
              onChangeText={setOpenRouterKey}
              placeholder={
                credentialStatus.openRouterConfigured
                  ? Platform.OS === "web"
                    ? "Saved in this session · enter to replace"
                    : "Saved securely · enter to replace"
                  : "Not configured"
              }
            />
            <Text style={s.disclaimer}>
              Native credentials use platform secure storage. Browser preview
              keeps credentials in memory only. No provider request is made by
              saving a key.
            </Text>
            <Button
              label={
                Platform.OS === "web"
                  ? "Save keys for this session"
                  : "Save entered keys securely"
              }
              tone="quiet"
              disabled={
                !speechKey.trim() &&
                !openRouterKey.trim()
              }
              onPress={() => void saveKeys()}
            />
            {credentialStatus.speechConfigured ||
            credentialStatus.openAiConfigured ||
            credentialStatus.openRouterConfigured ? (
              <Button
                label="Remove all provider keys"
                tone="danger"
                onPress={() => {
                  void onDeleteCredentials().then((result) => {
                    if (result) {
                      setCredentialStatus(result as typeof credentialStatus);
                      onNotice("Provider keys removed.");
                    }
                  });
                }}
              />
            ) : null}
          </>
        )}
        <Text style={s.sectionTitle}>Recording limits & retention</Text>
        <Field
          label="Maximum recording length · seconds"
          value={maxAudioSeconds}
          onChangeText={setMaxAudioSeconds}
          keyboardType="numeric"
        />
        <Text style={s.label}>Audio retention</Text>
        <View style={s.pills}>
          {(["keep", "delete_after_transcription"] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => setRetention(v)}
              style={[s.pill, retention === v && s.pillActive]}
            >
              <Text style={[s.pillText, retention === v && s.pillTextActive]}>
                {v === "keep"
                  ? "Keep until deleted"
                  : "Delete after transcription"}
              </Text>
            </Pressable>
          ))}
        </View>
        {assistantBatchJobs.length > 0 || assistantBatchRecoveryMessage ? (
          <AssistantBatchHistorySection
            jobs={assistantBatchJobs}
            recoveryMessage={assistantBatchRecoveryMessage}
            busy={busy}
            blocked={Boolean(assistantBatchRecoveryMessage)}
            onCheck={onCheckAssistantBatch}
            onRetryCleanup={onRetryAssistantBatchCleanup}
          />
        ) : null}
        {shouldShowProactiveRecoverySection({
          mailAlertRecovery: Boolean(state.proactiveMailAlertRecoveryStatus),
          proactiveIntegrityError: Boolean(state.proactive.integrityError),
          recoveryUnknown: proactiveRecoveryUnknown,
          requiresRefresh: proactiveRecoveryRequiresRefresh,
          status: proactiveRecoveryStatus?.status,
        }) ? (
          <View style={{ borderWidth: 1, borderColor: C.border, backgroundColor: C.card, borderRadius: 14, padding: 14, gap: 9 }}>
            <Text style={s.sectionTitle}>Attention settings need recovery</Text>
            {state.proactive.integrityError ? <Text style={s.disclaimer}>Some saved attention settings could not be validated and are held privately.</Text> : null}
            {state.proactiveMailAlertRecoveryStatus?.message ? <Text style={s.disclaimer}>{state.proactiveMailAlertRecoveryStatus.message}</Text> : null}
            {proactiveRecoveryUnknown ? (
              <>
                <Text style={s.disclaimer}>Reset outcome is not verified. Refresh local data, then check the recovery receipt.</Text>
                <Button label="Refresh local data" tone="quiet" disabled={busy || demoMode} onPress={() => void onRefreshProactiveRecovery()} />
                <Button label="Check recovery receipt" disabled={busy || demoMode || !proactiveRecoveryRefreshed} onPress={() => void onInspectProactiveRecovery()} />
                {proactiveRecoveryError ? <Text accessibilityRole="alert" style={{ color: C.red, fontSize: 13 }}>{proactiveRecoveryError}</Text> : null}
              </>
            ) : proactiveRecoveryRequiresRefresh || proactiveRecoveryStatus?.status === "refresh_required" ? (
              <>
                <Text style={s.disclaimer}>Saved data changed. Refresh local data before continuing.</Text>
                <Button label="Refresh local data" tone="quiet" disabled={busy || demoMode} onPress={() => void onRefreshProactiveRecovery()} />
                {proactiveRecoveryError ? <Text accessibilityRole="alert" style={{ color: C.red, fontSize: 13 }}>{proactiveRecoveryError}</Text> : null}
              </>
            ) : (
              <>
                {recoveryReason ? <Text accessibilityRole="alert" style={{ color: C.red, fontSize: 13, lineHeight: 19 }}>{recoveryReason}</Text> : null}
                {proactiveRecoveryStatus?.status === "available" || proactiveRecoveryStatus?.status === "prepared" ? (
                  <Button label="Review recovery" disabled={proactiveRecoveryActionBlocked || proactiveRecoveryBusy || Boolean(backgroundActionBlockedReason)} onPress={onOpenProactiveRecovery} />
                ) : null}
                {proactiveRecoveryError ? <Text accessibilityRole="alert" style={{ color: C.red, fontSize: 13 }}>{proactiveRecoveryError}</Text> : null}
              </>
            )}
          </View>
        ) : null}
        <ProactiveRecoverySheet
          key={`${proactiveRecoverySheetOpen ? "open" : "closed"}:${recoveryPlan?.operationId ?? "new"}`}
          visible={proactiveRecoverySheetOpen}
          plan={recoveryPlan}
          busy={proactiveRecoveryBusy}
          actionsBlocked={proactiveRecoveryActionBlocked}
          previewOnly={demoMode}
          error={proactiveRecoveryError}
          onPrepare={onPrepareProactiveRecovery}
          onConfirm={onConfirmProactiveRecovery}
          onCancel={onCancelProactiveRecovery}
          onClose={() => void onCancelProactiveRecovery(recoveryPlan?.operationId)}
        />
        <BackgroundRefreshSection
          open={open}
          desiredEnabled={state.settings.backgroundMailRefreshEnabled === true}
          backend={backgroundTasks}
          refreshKey={backgroundStatusRefreshKey}
          busy={busy || Boolean(backgroundActionBlockedReason)}
          blockedReason={backgroundActionBlockedReason}
          onSetDesired={onSetBackgroundRefresh}
          onRetry={onRetryBackgroundRefresh}
        />
        <Button label="Refresh local data" tone="quiet" disabled={demoMode || busy || Boolean(backgroundActionBlockedReason)} onPress={() => {
          setLocalRefreshMessage("Refreshing local data…");
          void onRefreshLocalData().then((refreshed) => setLocalRefreshMessage(refreshed
            ? "Local data refreshed."
            : "Local data could not be refreshed. Try again when other work has finished."));
        }} />
        <Text style={s.disclaimer}>Reloads changes saved while the app was away. It does not check mail; use Inbox for that.</Text>
        {localRefreshMessage ? <Text accessibilityLiveRegion="polite" style={s.disclaimer}>{localRefreshMessage}</Text> : null}
        <Button
          label="Save limits & retention"
          tone="quiet"
          onPress={() => void saveSettings()}
        />
        <ProactiveRulesSection
          rules={state.proactive.rules}
          accounts={state.accounts}
          timezone={state.settings.timezone}
          busy={busy}
          onSave={onSaveProactiveRule}
          onDelete={onDeleteProactiveRule}
        />
        <ProactiveMailAlertsSection
          rules={state.proactive.rules}
          accounts={state.accounts}
          ledger={state.proactiveMailAlerts}
          timeZone={state.settings.timezone}
          recoveryStatus={state.proactiveMailAlertRecoveryStatus}
          refreshRequired={state.mailAlertRefreshRequired}
          busy={busy}
          captureAdmissionBlocked={mailAlertCaptureAdmissionBlocked}
          refreshAdmissionBlocked={mailAlertRefreshAdmissionBlocked}
          previewOnly={demoMode}
          onEnable={onEnableMailAlerts}
          onRevoke={onRevokeMailAlerts}
          onReconcile={onReconcileMailAlerts}
          onRefresh={onRefreshMailAlertWorkspace}
        />
        <Text style={s.sectionTitle}>Accounts</Text>
        {state.accounts.length ? (
          state.accounts.map((a) => (
            <View key={a.id} style={s.accountRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.accountName}>{a.displayName || a.email}</Text>
                <Text style={s.accountSub}>
                  {a.email} ·{" "}
                  {a.connected
                    ? "Verified connection"
                    : "Configured · not connected"}
                </Text>
              </View>
              <Ionicons
                name={a.connected ? "checkmark-circle" : "ellipse-outline"}
                size={18}
                color={a.connected ? C.sage : C.muted}
              />
            </View>
          ))
        ) : (
          <Text style={s.emptyText}>No accounts configured.</Text>
        )}
        <View style={s.pills}>
          {(["google", "microsoft"] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => setProvider(v)}
              style={[s.pill, provider === v && s.pillActive]}
            >
              <Text style={[s.pillText, provider === v && s.pillTextActive]}>
                {v === "google" ? "Google" : "Microsoft"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Field
          label="Account display name"
          value={accountName}
          onChangeText={setAccountName}
          placeholder="Work or personal"
        />
        <Field
          label="Email address"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          keyboardType="email-address"
        />
        <Button
          label="Save account configuration"
          tone="quiet"
          onPress={() => void saveAccount()}
        />
        <Text style={s.sectionTitle}>Calendars</Text>
        {state.calendars.map((c) => (
          <LimitRow
            key={c.id}
            label={c.name}
            value={c.connected ? "Verified" : "Configured"}
          />
        ))}
        <Text style={s.label}>Account for this calendar</Text>
        {state.accounts.map((a) => (
          <Pressable
            key={a.id}
            onPress={() => setCalendarAccountId(a.id)}
            style={[
              s.accountChoice,
              calendarAccountId === a.id && s.accountChoiceSelected,
            ]}
          >
            <Text style={s.accountName}>{a.displayName || a.email}</Text>
            <Text style={s.accountSub}>{a.email}</Text>
          </Pressable>
        ))}
        <Field
          label="Calendar name"
          value={calendarName}
          onChangeText={setCalendarName}
          placeholder="Personal calendar"
        />
        <Button
          label="Save calendar configuration"
          tone="quiet"
          disabled={!state.accounts.length}
          onPress={() => void saveCalendar()}
        />
        <ConnectionsSection
          accounts={state.accounts}
          syncStates={state.syncStates}
          busy={busy}
          demoMode={demoMode}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onSync={onSync}
          onRefreshMail={onRefreshMail}
          onContinueMail={onContinueMail}
        />
        <DeviceCalendarsSection
          state={state}
          busy={busy}
          demoMode={isDeviceCalendarsDemo}
          onConnect={() => void onConnectDeviceCalendars()}
          onDisconnect={() => void onDisconnectDeviceCalendars()}
          onCheckAccess={() => void onCheckDeviceCalendarAccess()}
          onSelection={(ids) => void onSelectDeviceCalendars(ids)}
          onRefresh={(runId) => void onRefreshDeviceCalendars(runId)}
        />
        <Text style={s.sectionTitle}>Local data</Text>
        <Text style={s.disclaimer}>
          App database and documents use private app storage, which is not
          automatically encrypted and may be included in device backups. Exports
          are user initiated. Delete a note from its detail screen. Full deletion
          reviews tracked local data and requires a separate typed confirmation.
        </Text>
        {!demoMode || privacyEraseAvailable ? <Button label="Delete local app data" tone="danger" disabled={busy} onPress={onDeleteLocalData} /> : null}
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}


function LimitRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.limitRow}>
      <Text style={s.limitLabel}>{label}</Text>
      <Text style={s.limitValue}>{value}</Text>
    </View>
  );
}
function messageOf(e: unknown) {
  return e instanceof Error
    ? e.message
    : "Something went wrong. Your saved data is unchanged; try again.";
}
function sampleTranscriptionErrorNotice(error: unknown) {
  if (error instanceof SpeechTranscriptionError) {
    if (error.code === "no_speech") return "Sample transcription detected no speech — Azure was not contacted.";
    if (error.code === "cancelled") return "Sample transcription cancelled — Azure was not contacted.";
    if (error.dispatched || error.code === "provider_unknown" || error.code === "timeout") {
      return "Sample result is uncertain — Azure was not contacted. A new sample run is a separate request.";
    }
  }
  return "Sample transcription did not complete — Azure was not contacted.";
}
function localDateTime(iso?: string) {
  if (!iso) return { date: "", time: "" };
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}
function newDocumentPath(docs: { path: string }[]) {
  const base = `notes/${localDateTime(new Date().toISOString()).date}`;
  let suffix = 1;
  let candidate = `${base}.md`;
  while (docs.some((doc) => doc.path === candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}.md`;
  }
  return candidate;
}
function friendlyDocumentName(path: string) {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}
function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm(`${title}\n\n${message}`)
    )
      onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Continue", style: "destructive", onPress: onConfirm },
  ]);
}
function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s2 = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s2}`;
}
function downloadText(text: string, filename: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
