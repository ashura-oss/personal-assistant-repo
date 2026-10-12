import React, {
  useCallback,
  useEffect,
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
  AppSettings,
  AppController,
  AccountCapability,
  LocalTask,
  MailboxSnapshotMessage,
  SavedProactiveRule,
  ProactiveState,
} from "./src/core";
import { controller as productionController } from "./src/services/controller";
import { createDispatchHistoryScenario } from "./src/dev/receiptScenario";
import { createMailSyncScenario } from "./src/dev/mailSyncScenario";
import { useAudioCapture } from "./src/audio/useAudioCapture";
import type { AudioCapture } from "./src/audio/types";
import {
  deleteCredentials,
  getCredentials,
  setCredentials,
} from "./src/services/credentials";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { loadAudioForUpload } from "./src/audio/readAudio";
import { ConnectionsSection } from "./src/ui/ConnectionsSection";
import { MailboxSection } from "./src/ui/MailboxSection";
import { MailReplyComposer } from "./src/ui/MailReplyComposer";
import { ProactiveCandidatesSection } from "./src/ui/ProactiveCandidatesSection";
import { ProactiveRulesSection } from "./src/ui/ProactiveRulesSection";
import { useProactiveClock } from "./src/ui/useProactiveClock";
import { ReviewSheet } from "./src/ui/ReviewSheet";
import { NoteDetail as NoteDetailView } from "./src/ui/NoteDetail";
import { TasksSection } from "./src/ui/TasksSection";
import { IconButton, Button, Field } from "./src/ui/primitives";
import { C, s } from "./src/ui/theme";
import {
  authorizeWithBrowser,
  configuredProviderAuth,
  type OAuthProvider,
} from "./src/auth/browser";
import { exchangeAuthorizationCode } from "./src/connectors/oauth";

type Tab = "inbox" | "record" | "library";

const previewScenario =
  typeof __DEV__ !== "undefined" && __DEV__
    ? process.env.EXPO_PUBLIC_PREVIEW_SCENARIO
    : undefined;
const isDispatchHistoryDemo = previewScenario === "dispatch-history";
const isMailSyncDemo = previewScenario === "mail-sync";
const isIsolatedDemo = isDispatchHistoryDemo || isMailSyncDemo;

function useAppState(appController: AppController) {
  return useSyncExternalStore(
    (listener) => appController.subscribe(listener),
    () => appController.getSnapshot(),
    () => appController.getSnapshot(),
  );
}

function freshnessAccountState(
  state: ReturnType<typeof productionController.getSnapshot>,
) {
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
          {note.audioUri
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
        {note.status === "processed"
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
  accounts: ReturnType<typeof productionController.getSnapshot>["accounts"];
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

export default function App() {
  const [controller, setController] =
    useState<AppController>(productionController);
  const state = useAppState(controller);
  const [tab, setTab] = useState<Tab>(isIsolatedDemo ? "inbox" : "record");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detail, setDetail] = useState<Note | null>(null);
  const [review, setReview] = useState<Proposal | null>(null);
  const [replyMessageId, setReplyMessageId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useProactiveClock(
    controller,
    loading,
    state.proactive.lastEvaluation?.nextCheckAt,
  );
  const foregroundMailBusy = useRef(false);
  const audio = useAudioCapture();
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
  const checkedAnalysisKey = useRef("");
  const checkedReviewFreshnessKey = useRef("");

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const selected = isDispatchHistoryDemo
          ? await createDispatchHistoryScenario()
          : isMailSyncDemo
            ? await createMailSyncScenario()
            : productionController;
        if (!mounted) return;
        setController(selected);
        await selected.load();
      } catch (e) {
        if (mounted) setNotice(messageOf(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const notes = [...state.notes].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const filteredNotes = notes.filter((n) =>
    `${n.title} ${n.transcript}`.toLowerCase().includes(query.toLowerCase()),
  );
  const proposals = state.proposals.filter((p) =>
    inboxFilter === "pending"
      ? ["draft", "approved", "dispatching", "failed"].includes(p.status)
      : ["accepted", "executed", "dismissed", "simulated", "unknown"].includes(
          p.status,
        ),
  );
  const activeDetailNote = detail
    ? state.notes.find((note) => note.id === detail.id)
    : undefined;
  const activeAnalysis = activeDetailNote?.analysis;
  const activeDetailNoteId = activeDetailNote?.id;
  const activeAnalysisFingerprint = activeAnalysis?.fingerprint;
  const currentReviewProposal = review
    ? (state.proposals.find((proposal) => proposal.id === review.id) ?? review)
    : null;
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
  ]);

  useEffect(() => {
    if (
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
      if (busyLock.current) return undefined;
      busyLock.current = true;
      setBusy(true);
      setNotice("");
      try {
        return await fn();
      } catch (e) {
        setNotice(messageOf(e));
      } finally {
        busyLock.current = false;
        setBusy(false);
      }
    },
    [],
  );
  const refreshForegroundMail = useCallback(async () => {
    if (isIsolatedDemo || loading || foregroundMailBusy.current) return;
    foregroundMailBusy.current = true;
    try {
      await controller.refreshForegroundMail();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      foregroundMailBusy.current = false;
    }
  }, [controller, loading]);

  useEffect(() => {
    if (loading || isIsolatedDemo) return;
    const initialRefresh = setTimeout(() => {
      void refreshForegroundMail();
    }, 0);

    let previousNativeState = NativeAppState.currentState;
    const nativeSubscription = NativeAppState.addEventListener(
      "change",
      (nextState) => {
        if (previousNativeState !== "active" && nextState === "active") {
          void refreshForegroundMail();
        }
        previousNativeState = nextState;
      },
    );

    let removeWebListener: (() => void) | undefined;
    if (Platform.OS === "web" && typeof document !== "undefined") {
      let wasVisible = document.visibilityState === "visible";
      const onVisibilityChange = () => {
        const isVisible = document.visibilityState === "visible";
        if (!wasVisible && isVisible) void refreshForegroundMail();
        wasVisible = isVisible;
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      removeWebListener = () =>
        document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      clearTimeout(initialRefresh);
      nativeSubscription.remove();
      removeWebListener?.();
    };
  }, [loading, refreshForegroundMail]);
  const openNote = (note: Note) => {
    setDetail(note);
    setTab("record");
  };
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
  const saveRecording = useCallback(async () => {
    const result = await audio.stop();
    if (!result) return;
    const note = await controller.saveNote({
      transcript: "",
      audioUri: result.uri,
      durationSeconds: result.durationSeconds,
      capturedAt: result.capturedAt,
      captureTimeZone: result.captureTimeZone,
    });
    audio.commit(result.uri);
    setDetail(note);
    setNotice(
      "Recording saved on this device. Add a transcript to create a reviewable proposal.",
    );
  }, [audio, controller]);
  useEffect(() => {
    if (
      audio.status === "recording" &&
      audio.durationSeconds >= state.settings.maxAudioSeconds
    ) {
      const timer = setTimeout(() => {
        void run(async () => {
          await saveRecording();
          setNotice(
            "Recording reached the configured length limit and was saved.",
          );
        });
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [
    audio.durationSeconds,
    audio.status,
    state.settings.maxAudioSeconds,
    run,
    saveRecording,
  ]);
  const confirmCancel = () =>
    confirmAction(
      "Discard this recording?",
      "This recording has not been saved.",
      () => {
        void run(() => audio.cancel());
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
        const config = configuredProviderAuth(provider);
        const handoff = await authorizeWithBrowser(config, capabilities);
        const exchanged = await exchangeAuthorizationCode(
          {
            provider,
            clientId: config.clientId,
            redirectUri: handoff.redirectUri,
            authority: config.authority,
            requestedCapabilities: capabilities,
          },
          handoff,
        );
        if (!exchanged.result.email)
          throw new Error(
            "The provider did not return a verified email address. Review account permissions and try again.",
          );
        try {
          await controller.installVerifiedAccount(
            {
              ...(accountId ? { id: accountId } : {}),
              provider,
              displayName: exchanged.result.displayName,
              email: exchanged.result.email,
            },
            exchanged.result,
          );
        } catch (error) {
          const pendingCleanup =
            controller.getSnapshot().pendingCredentialCleanup.length;
          if (pendingCleanup) {
            throw new Error(
              `The account was not connected. Credential cleanup is pending for ${pendingCleanup} item${pendingCleanup === 1 ? "" : "s"}; retry below.`,
            );
          }
          throw error;
        }
        setNotice(
          `${provider === "google" ? "Google" : "Microsoft"} account verified and connected.`,
        );
      });
    },
    [run, controller],
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
              onPress={() => setSettingsOpen(true)}
            />
          </View>
          {isIsolatedDemo ? (
            <View style={s.notice}>
              <Text style={s.noticeText}>
                {isDispatchHistoryDemo
                  ? "Sample history · no external actions"
                  : "Sample mail · no external actions"}
              </Text>
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
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss message"
                  onPress={() => setNotice("")}
                  hitSlop={8}
                >
                  <Ionicons
                    accessible={false}
                    name="close"
                    size={17}
                    color={C.muted}
                  />
                </Pressable>
              )}
            </View>
          ) : null}
          {busy ? (
            <View style={s.busy}>
              <ActivityIndicator color={C.sage} />
              <Text style={s.busyText}>Saving locally…</Text>
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
                    setDetail(note);
                  })
                }
              />
            ) : detail ? (
              <NoteDetailView
                key={`${detail.id}:${detail.revision}`}
                note={state.notes.find((n) => n.id === detail.id) ?? detail}
                analysis={state.notes.find((n) => n.id === detail.id)?.analysis}
                proposals={state.proposals.filter(
                  (p) => p.noteId === detail.id,
                )}
                busy={busy}
                preview={state.settings.mode === "preview"}
                analysisStatusError={
                  analysisStatusError?.key === analysisFreshnessKey
                    ? analysisStatusError.message
                    : undefined
                }
                analysisStatusChecking={Boolean(
                  activeAnalysis &&
                  analysisStatusCheckedKey !== analysisFreshnessKey,
                )}
                onRetryStatus={() => {
                  checkedAnalysisKey.current = "";
                  setAnalysisStatusError(null);
                  setAnalysisStatusCheckedKey("");
                  setAnalysisStatusRetry((retry) => retry + 1);
                }}
                onClose={() => setDetail(null)}
                onUpdate={(transcript) =>
                  run(async () => {
                    const updated = await controller.updateTranscript(
                      detail.id,
                      transcript,
                    );
                    setDetail(updated);
                  })
                }
                onAssist={(options) => {
                  void run(async () => {
                    const result = await controller.assistNote(
                      detail.id,
                      options,
                    );
                    const updated = controller
                      .getSnapshot()
                      .notes.find((n) => n.id === detail.id);
                    if (updated) setDetail(updated);
                    setNotice(
                      result.source === "offline_preview"
                        ? "Local preview is ready. It was not generated by AI."
                        : "Response saved against the current note revision.",
                    );
                  });
                }}
                onOpenProposals={() => {
                  setInboxFilter("pending");
                  setTab("inbox");
                  setDetail(null);
                }}
                onTranscribe={() =>
                  state.settings.speechEndpoint
                    ? run(async () => {
                        const updated = await controller.transcribeNote(
                          detail.id,
                        );
                        setDetail(updated);
                        setNotice(
                          "Transcript saved. Review it before asking about this note.",
                        );
                      })
                    : setSettingsOpen(true)
                }
                providerReady={Boolean(state.settings.speechEndpoint)}
                onPlay={() => run(() => audio.play(detail.audioUri!))}
                onExportAudio={() =>
                  run(async () => {
                    if (!detail.audioUri) return;
                    const file = await loadAudioForUpload(detail.audioUri);
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
                        setDetail(null);
                      }),
                  )
                }
              />
            ) : tab === "record" ? (
              <RecordScreen
                audio={audio}
                busy={busy}
                demoMode={isIsolatedDemo}
                recent={notes.slice(0, 3)}
                onOpen={openNote}
                onSeeAll={() => setTab("library")}
                onWrite={() => setManualOpen(true)}
                onStart={() =>
                  isIsolatedDemo
                    ? setNotice(
                        "Microphone recording is disabled in the sample preview.",
                      )
                    : run(() => audio.start())
                }
                onPause={() => run(() => audio.pause())}
                onResume={() => run(() => audio.resume())}
                onStop={() => run(saveRecording)}
                onCancel={confirmCancel}
              />
            ) : tab === "inbox" ? (
              <InboxScreen
                proposals={proposals}
                accounts={state.accounts}
                mailbox={state.mailbox}
                onReplyMessage={(messageId) => setReplyMessageId(messageId)}
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
                onGetCandidateSource={(candidateId) =>
                  controller.getProactiveCandidateSource(candidateId)
                }
              />
            ) : (
              <LibraryScreen
                notes={filteredNotes}
                query={query}
                setQuery={setQuery}
                docs={state.documents}
                tasks={state.tasks}
                busy={busy}
                demoMode={isIsolatedDemo}
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
                onOpenDoc={(d) => {
                  const existing = state.documents.find(
                    (x) => x.path === d.path,
                  );
                  setDoc(existing ?? d);
                  setDocDraft(existing?.content ?? d.content);
                }}
                onExport={() => {
                  if (isIsolatedDemo) return;
                  void run(async () => {
                    const data = await controller.exportData();
                    if (Platform.OS === "web")
                      downloadText(
                        data,
                        "still-export.json",
                        "application/json",
                      );
                    else {
                      const path = `${FileSystem.documentDirectory}still-export.json`;
                      await FileSystem.writeAsStringAsync(path, data);
                      await Sharing.shareAsync(path, {
                        mimeType: "application/json",
                        dialogTitle: "Export Still data",
                      });
                    }
                  });
                }}
              />
            )}
          </View>
          {!detail && !manualOpen && !settingsOpen && (
            <View style={s.tabBar} accessibilityRole="tablist">
              {(["inbox", "record", "library"] as Tab[]).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityLabel={`${item[0].toUpperCase() + item.slice(1)} tab`}
                  accessibilityState={{ selected: tab === item }}
                  onPress={() => setTab(item)}
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
          onRequestClose={() => setSettingsOpen(false)}
        >
          <SafeAreaView style={s.modalSafe}>
            <SettingsScreen
              state={state}
              busy={busy}
              onClose={() => setSettingsOpen(false)}
              onSave={(patch) => run(() => controller.saveSettings(patch))}
              onSaveAccount={(c) => run(() => controller.saveAccount(c))}
              onSaveCalendar={(c) => run(() => controller.saveCalendar(c))}
              onSaveCredentials={(c) => run(() => setCredentials(c))}
              onDeleteCredentials={(kind) => run(() => deleteCredentials(kind))}
              onNotice={setNotice}
              onConnect={connectAccount}
              onDisconnect={disconnectAccount}
              onSync={syncAccount}
              onRefreshMail={refreshMailHead}
              onContinueMail={continueMailBackfill}
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
                busy={busy}
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
                  if (sourceNote) openNote(sourceNote);
                  setNotice(
                    "Run Assist again on this note to rebuild current suggestions.",
                  );
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
                    if (!review) return;
                    setReview(await controller.editProposal(review.id, patch));
                  })
                }
                onApprove={() =>
                  run(async () => {
                    if (!review) return;
                    setReview(await controller.approveProposal(review.id));
                    setNotice(
                      "Approved for this exact draft. Sending remains a separate step.",
                    );
                  })
                }
                onExecute={() =>
                  run(async () => {
                    if (!review) return;
                    setReview(await controller.executeProposal(review.id));
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
          onClose={() => setReplyMessageId(null)}
          onSave={saveMailReply}
        />
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

function RecordScreen({
  audio,
  busy,
  demoMode,
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
                {audio.status === "paused" ? "Paused" : "Recording"} ·{" "}
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
                disabled={busy}
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
        ) : audio.hasPending ? (
          <>
            <Ionicons name="cloud-upload-outline" size={29} color={C.sage} />
            <Text style={s.micTitle}>Recording ready to save</Text>
            <Text style={s.micSub}>
              The audio is preserved. Retry if storage was unavailable.
            </Text>
            <Button
              label={busy ? "Saving…" : "Save recording"}
              disabled={busy}
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
  onReplyMessage,
  proactive,
  filter,
  setFilter,
  mode,
  onOpen,
  busy,
  onDismissCandidate,
  onSnoozeCandidate,
  onGetCandidateSource,
}: {
  proposals: Proposal[];
  accounts: ReturnType<typeof productionController.getSnapshot>["accounts"];
  mailbox: MailboxSnapshotMessage[];
  onReplyMessage: (messageId: string) => void;
  proactive: ProactiveState;
  filter: "pending" | "done";
  setFilter: (v: "pending" | "done") => void;
  mode: AppSettings["mode"];
  onOpen: (p: Proposal) => void;
  busy: boolean;
  onDismissCandidate: (candidateId: string) => void;
  onSnoozeCandidate: (candidateId: string, until: string) => void;
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
        busy={busy}
        onDismiss={onDismissCandidate}
        onSnooze={onSnoozeCandidate}
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
  demoMode,
  onComplete,
  onReopen,
  onOpenNote,
  onOpenDoc,
  onExport,
}: {
  notes: Note[];
  query: string;
  setQuery: (v: string) => void;
  docs: { path: string; content: string }[];
  tasks: LocalTask[];
  busy: boolean;
  demoMode: boolean;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onOpenNote: (n: Note) => void;
  onOpenDoc: (d: { path: string; content: string }) => void;
  onExport: () => void;
}) {
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
      {docs.length ? (
        docs.map((d) => {
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
          No documents yet. Add personal notes or rules here.
        </Text>
      )}
      <View style={{ height: 10 }} />
      <Button
        label={
          demoMode ? "Export unavailable in sample mode" : "Export local data"
        }
        tone="quiet"
        icon="download-outline"
        disabled={demoMode}
        onPress={onExport}
      />
      <Text style={s.disclaimer}>
        JSON export contains transcripts, settings, and documents, not audio
        files. Export each recording from its note. Protect exported files as
        sensitive data.
      </Text>
    </ScrollView>
  );
}

function SettingsScreen({
  state,
  busy,
  demoMode,
  onClose,
  onSave,
  onSaveAccount,
  onSaveCalendar,
  onSaveCredentials,
  onDeleteCredentials,
  onNotice,
  onConnect,
  onDisconnect,
  onSync,
  onRefreshMail,
  onContinueMail,
  onSaveProactiveRule,
  onDeleteProactiveRule,
}: {
  state: ReturnType<typeof productionController.getSnapshot>;
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
  }) => Promise<unknown>;
  onDeleteCredentials: (kind?: "speech" | "openai") => Promise<unknown>;
  onNotice: (v: string) => void;
}) {
  const [endpoint, setEndpoint] = useState(state.settings.openAiEndpoint ?? "");
  const [deployment, setDeployment] = useState(
    state.settings.openAiDeployment ?? "",
  );
  const [speechEndpoint, setSpeechEndpoint] = useState(
    state.settings.speechEndpoint ?? "",
  );
  const [model, setModel] = useState(state.settings.model ?? "gpt-6-luna");
  const [effort, setEffort] = useState<"none" | "low">(
    state.settings.reasoningEffort ?? "none",
  );
  const [maxRequestKb, setMaxRequestKb] = useState(
    String(Math.round((state.settings.maxRequestBytes ?? 24000) / 1000)),
  );
  const [maxOutput, setMaxOutput] = useState(
    String(state.settings.maxOutputTokens),
  );
  const [budget, setBudget] = useState(String(state.settings.monthlyBudgetUsd));
  const [maxAttempts, setMaxAttempts] = useState(
    String(state.settings.maxAttempts),
  );
  const [dailyLimit, setDailyLimit] = useState(
    String(state.settings.maxCallsPerDay),
  );
  const [maxAudioSeconds, setMaxAudioSeconds] = useState(
    String(state.settings.maxAudioSeconds),
  );
  const [retention, setRetention] = useState(state.settings.audioRetention);
  const [providerEnabled, setProviderEnabled] = useState(
    state.settings.mode === "provider",
  );
  const [speechKey, setSpeechKey] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [credentialStatus, setCredentialStatus] = useState({
    speechConfigured: false,
    openAiConfigured: false,
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
    getCredentials()
      .then(setCredentialStatus)
      .catch((e) => onNotice(messageOf(e)));
  }, [demoMode, onNotice]);
  const saveSettings = async () => {
    const requestKb = Number(maxRequestKb);
    if (!Number.isFinite(requestKb) || requestKb < 4 || requestKb > 96) {
      onNotice("Set the request size from 4 to 96 KB.");
      return;
    }
    const outputTokens = Number(maxOutput);
    if (
      !Number.isFinite(outputTokens) ||
      outputTokens < 1 ||
      outputTokens > 2400
    ) {
      onNotice("Set the output limit from 1 to 2,400 tokens.");
      return;
    }
    const result = await onSave({
      mode: providerEnabled ? "provider" : "preview",
      openAiEndpoint: endpoint,
      openAiDeployment: deployment,
      speechEndpoint,
      model,
      reasoningEffort: effort,
      maxRequestBytes: Math.round(requestKb * 1000),
      maxOutputTokens: outputTokens,
      monthlyBudgetUsd: Number(budget),
      maxAttempts: Number(maxAttempts),
      maxCallsPerDay: Number(dailyLimit),
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
    const result = await onSaveCredentials({
      speechSubscriptionKey: speechKey || undefined,
      openAiApiKey: openAiKey || undefined,
    });
    if (result) {
      setSpeechKey("");
      setOpenAiKey("");
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
        {state.dispatchRecordQuarantine.length ? (
          <View style={s.analysisStale}>
            <Text style={s.analysisText}>
              Action history needs recovery before sending.
            </Text>
          </View>
        ) : null}
        <View style={s.providerToggle}>
          <View style={{ flex: 1 }}>
            <Text style={s.accountName}>Enable Azure analysis</Text>
            <Text style={s.accountSub}>
              Your saved transcript and selected context will be sent for
              analysis when you request it.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Enable Azure analysis"
            value={providerEnabled}
            onValueChange={setProviderEnabled}
            disabled={demoMode}
            trackColor={{ false: C.border, true: C.sage }}
            thumbColor={C.text}
          />
        </View>
        <Text style={s.sectionTitle}>Azure · optional</Text>
        <Field
          label="OpenAI endpoint"
          value={endpoint}
          onChangeText={setEndpoint}
          placeholder="https://your-resource.openai.azure.com/openai/v1/"
          keyboardType="url"
        />
        <Field
          label="Deployment name"
          value={deployment}
          onChangeText={setDeployment}
          placeholder="Your Azure deployment"
        />
        <Field
          label="Speech endpoint"
          value={speechEndpoint}
          onChangeText={setSpeechEndpoint}
          placeholder="Speech resource endpoint"
          keyboardType="url"
        />
        <Field
          label="Model"
          value={model}
          onChangeText={setModel}
          placeholder="gpt-6-luna"
        />
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
          label="Save provider settings"
          onPress={() => void saveSettings()}
        />
        {demoMode ? null : (
          <>
            <Field
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
            />
            <Field
              label="OpenAI API key"
              secureTextEntry
              value={openAiKey}
              onChangeText={setOpenAiKey}
              placeholder={
                credentialStatus.openAiConfigured
                  ? Platform.OS === "web"
                    ? "Saved in this session · enter to replace"
                    : "Saved securely · enter to replace"
                  : "Not configured"
              }
            />
            <Text style={s.disclaimer}>
              Native credentials use platform secure storage. Browser preview
              keeps credentials in memory only. Azure access, browser CORS, and
              real transcription remain unverified.
            </Text>
            <Button
              label={
                Platform.OS === "web"
                  ? "Save keys for this session"
                  : "Save entered keys securely"
              }
              tone="quiet"
              disabled={!speechKey && !openAiKey}
              onPress={() => void saveKeys()}
            />
            {credentialStatus.speechConfigured ||
            credentialStatus.openAiConfigured ? (
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
        <Text style={s.sectionTitle}>Limits & retention</Text>
        <Field
          label="Maximum request size · KB"
          value={maxRequestKb}
          onChangeText={setMaxRequestKb}
          keyboardType="numeric"
        />
        <Text style={s.disclaimer}>
          24 KB is roughly 6,000 English tokens. Token counts vary by content;
          the enforced limit is the serialized request size in bytes.
        </Text>
        <Field
          label="Output limit · tokens"
          value={maxOutput}
          onChangeText={setMaxOutput}
          keyboardType="numeric"
        />
        <Field
          label="Estimated cost ceiling · USD"
          value={budget}
          onChangeText={setBudget}
          keyboardType="numeric"
        />
        <Text style={s.disclaimer}>
          This guard applies only when provider rates are known. Until then,
          actual charges are reported as unknown.
        </Text>
        <Field
          label="Provider attempts per action"
          value={maxAttempts}
          onChangeText={setMaxAttempts}
          keyboardType="numeric"
        />
        <Field
          label="Provider attempts per day"
          value={dailyLimit}
          onChangeText={setDailyLimit}
          keyboardType="numeric"
        />
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
        <LimitRow
          label="Usage cost estimate"
          value={
            state.usage.priceKnown
              ? `$${state.usage.estimatedCostUsd.toFixed(2)}`
              : "Unknown · no verified rate card"
          }
        />
        <LimitRow
          label="Recorded requests this month"
          value={String(state.usage.requests)}
        />
        <LimitRow
          label="Background refresh"
          value="Foreground only in this preview"
        />
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
        <Text style={s.sectionTitle}>Local data</Text>
        <Text style={s.disclaimer}>
          App database and documents use private app storage, which is not
          automatically encrypted and may be included in device backups. Exports
          are user initiated. Delete a note from its detail screen.
        </Text>
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
