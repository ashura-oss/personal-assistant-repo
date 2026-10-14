import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { ActivityIndicator, AppState as NativeAppState, Modal, Platform, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { AppState, AccountCapability } from "./src/core";
import { useAudioCapture } from "./src/audio/useAudioCapture";
import type { ProviderCredentialService } from "./src/services/credentials";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { loadAudioForUpload } from "./src/audio/readAudio";
import { ProviderCleanupNotice } from "./src/ui/ProviderCleanupNotice";
import { oauthInstallFailureWithCleanupContext, runOwnedOAuthConnection } from "./src/ui/oauthConnectionIntent";
import { PrivacyCleanupScreen } from "./src/ui/PrivacyCleanupScreen";
import { PrivacyEraseReview } from "./src/ui/PrivacyEraseReview";
import { WorkspaceView, PendingCapturePreview, BackgroundRefreshPreview, type WorkspaceBindings, type WorkspaceCaptureReadiness, type WorkspaceConnectionIntent, type WorkspacePlatformPorts, type WorkspaceProps } from "./WorkspaceView";
import { pickPortableBackup } from "./src/backupFiles";
import { MailAlertPreview } from "./src/dev/mailAlertPreview";
import { MailAlertTapPreview } from "./src/dev/mailAlertTapPreview";
import { ProactiveRecoveryPreview } from "./src/dev/proactiveRecoveryPreview";
import { Button } from "./src/ui/primitives";
import { C, s } from "./src/ui/theme";
import { authorizeWithBrowser, configuredProviderAuth, exactRedirectUri, scopesFor, type OAuthProvider } from "./src/auth/browser";
import { exchangeAuthorizationCode } from "./src/connectors/oauth";
import { providerCleanupRegistry } from "./src/services/providerResponseLifetime";
import type { PrivacyService, PrivacyWorkspaceSession } from "./src/privacy/service";
import type { PrivacyPublicStatus, PrivacyErasePlan } from "./src/privacy/types";
export type { WorkspaceBindings, WorkspaceProps } from "./WorkspaceView";
export { buildLlmProviderSettingsPatch, buildSpeechProviderSettingsPatch, buildProviderCredentialInput, resolveTextAssistanceRoute } from "./WorkspaceView";
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

export function Workspace(props: WorkspaceProps) {
  const { controller, captureJournal, audioBoundary, privacy, session, resources } = props;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [readiness, setReadiness] = useState<WorkspaceCaptureReadiness>(() => ({
    ready: false,
    maxAudioSeconds: controller.getSnapshot().settings.maxAudioSeconds,
  }));
  const updateReadiness = useCallback((next: WorkspaceCaptureReadiness) => {
    if (!mountedRef.current) return false;
    setReadiness((current) => current.ready === next.ready && current.maxAudioSeconds === next.maxAudioSeconds ? current : next);
    return true;
  }, []);
  const audio = useAudioCapture(audioBoundary, captureJournal, readiness);
  const capture = useMemo(() => ({
    pendingJournal: captureJournal,
    setReadiness: updateReadiness,
    save: async (result: Extract<import("./src/audio/types").AudioCaptureStopResult, { uri: string }>) => {
      const note = await controller.saveNote({
        transcript: "",
        audioUri: result.uri,
        durationSeconds: result.durationSeconds,
        capturedAt: result.capturedAt,
        captureTimeZone: result.captureTimeZone,
      });
      audio.commit(result.uri);
      return note;
    },
  }), [audio, captureJournal, controller, updateReadiness]);
  const media = useMemo(() => ({
    exportSavedAudio: async (uri: string) => {
      const file = await loadAudioForUpload(uri, audioBoundary);
      if (file.platform === "web") downloadBlob(file.blob, file.fileName);
      else await Sharing.shareAsync(file.uri, { mimeType: file.mimeType, dialogTitle: "Export voice recording" });
    },
  }), [audioBoundary]);
  const files = useMemo(() => ({
    chooseBackup: () => pickPortableBackup(audioBoundary),
    exportWorkspaceData: async (data: string) => {
      if (Platform.OS === "web") downloadText(data, "still-export.json", "application/json");
      else {
        const path = FileSystem.documentDirectory + "still-export.json";
        await FileSystem.writeAsStringAsync(path, data);
        await Sharing.shareAsync(path, { mimeType: "application/json", dialogTitle: "Export Still data" });
      }
    },
  }), [audioBoundary]);
  const connections = useMemo<WorkspacePlatformPorts["connections"]>(() => ({
    describe: (provider, capabilities) => {
      const config = configuredProviderAuth(provider);
      return Object.freeze({
        platform: Platform.OS,
        clientId: config.clientId,
        nativeRedirectUri: config.nativeRedirectUri,
        webRedirectUri: config.webRedirectUri,
        ...(config.authority ? { authority: config.authority } : {}),
        redirectUri: exactRedirectUri(config),
        capabilities: Object.freeze([...capabilities]),
        scopes: Object.freeze(scopesFor(provider, [...capabilities])),
        accountLifecycle: oauthAccountLifecycleFingerprint(controller.getSnapshot().accounts, provider),
      });
    },
    connect: async (intent: WorkspaceConnectionIntent) => {
      if (!resources || !privacy || !session) throw new Error("Account connection is unavailable until the secure workspace is ready.");
      const capturedConfig = Object.freeze({ ...configuredProviderAuth(intent.provider) });
      const capturedCapabilities = [...intent.capabilities] as AccountCapability[];
      const capturedScopes = scopesFor(intent.provider, capturedCapabilities);
      const capturedRedirectUri = exactRedirectUri(capturedConfig);
      if (capturedConfig.clientId !== intent.description.clientId ||
          capturedRedirectUri !== intent.description.redirectUri ||
          JSON.stringify(capturedCapabilities) !== JSON.stringify(intent.description.capabilities) ||
          JSON.stringify(capturedScopes) !== JSON.stringify(intent.description.scopes)) {
        throw new Error("The sign-in setup changed. Start again from Settings.");
      }
      const completion = await runOwnedOAuthConnection({
        assertCurrent: intent.assertCurrent,
        assertWorkspaceCurrent: intent.assertWorkspaceCurrent,
        authorize: () => authorizeWithBrowser(capturedConfig, capturedCapabilities),
        validateHandoff: (handoff) => {
          if (handoff.provider !== intent.provider || handoff.redirectUri !== capturedRedirectUri ||
              JSON.stringify(handoff.requestedCapabilities) !== JSON.stringify(capturedCapabilities) ||
              JSON.stringify(handoff.requestedScopes) !== JSON.stringify(capturedScopes)) {
            throw new Error("The sign-in response no longer matches the selected provider access. Start again from Settings.");
          }
        },
        exchange: (handoff, beforeStart) => exchangeAuthorizationCode(
          {
            provider: intent.provider,
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
                ...(intent.accountId ? { id: intent.accountId } : {}),
                provider: intent.provider,
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
      return Object.freeze({ canPublish: completion.canPublish });
    },
  }), [controller, resources, privacy, session]);
  const lifecycle = useMemo(() => ({
    currentState: () => NativeAppState.currentState ?? "unknown",
    subscribe: (listener: (state: string) => void) => NativeAppState.addEventListener("change", listener),
    backgroundTasks: props.backgroundTasks,
    mailAlertTaps: props.mailAlertTaps,
  }), [props.backgroundTasks, props.mailAlertTaps]);
  const privacyPorts = useMemo(() => ({ audioBoundary, service: privacy, session, resources, providerCleanup: resources?.providerCleanup ?? providerCleanupRegistry }), [audioBoundary, privacy, session, resources]);
  const platform = useMemo<WorkspacePlatformPorts>(() => ({ audio, capture, media, files, connections, lifecycle, privacy: privacyPorts }), [audio, capture, media, files, connections, lifecycle, privacyPorts]);
  return <WorkspaceView {...props} platform={platform} />;
}

function downloadText(text: string, filename: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
