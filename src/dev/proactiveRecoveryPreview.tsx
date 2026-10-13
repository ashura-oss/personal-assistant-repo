import React, { useCallback, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import type { AppController, AppState } from "../core";
import type { ProactiveRecoveryPlan, ProactiveRecoveryStatus } from "../proactive/recovery";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import type { StateStore } from "../storage/contracts";
import type { ControllerIntegrationDependencies } from "../services/controller";
import type { ProviderCredentialService } from "../services/credentials";
import type { NotificationBackend } from "../services/notificationBackend";
import type { DeviceCalendarBackend } from "../services/deviceCalendarBackend";
import type { BackgroundTaskBackend } from "../background/backend.types";
import type { MailAlertNotificationBackend } from "../services/mailAlertNotificationBackend";
import type { MailAlertTapBackend } from "../proactiveMailAlerts/taps";
import type { RecordingRecoveryService } from "../audio/recovery.types";
import type { SpeechAudioService } from "../audio/speechUpload.types";
import { Button } from "../ui/primitives";
import { C, s } from "../ui/theme";
import { ProactiveRecoverySheet } from "../ui/ProactiveRecoverySheet";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function assertPreviewEnabled() {
  if (typeof __DEV__ === "undefined" || !__DEV__ || Platform.OS !== "web" ||
      process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "proactive-recovery") {
    throw new Error("Proactive recovery preview is available only in its isolated development browser scenario.");
  }
}

const denyNetwork: typeof fetch = async () => {
  throw new Error("Network access is disabled in the proactive recovery sample.");
};
const denyKeys = async (): Promise<string | null> => null;
const sampleOnlyError = () => new Error("External services are disabled in the proactive recovery sample.");

const closedCredentials: ProviderCredentialService = {
  currentSpeechCredentialGeneration: () => 0,
  assertSpeechCredentialGeneration: () => undefined,
  async readSpeechCredentialSnapshot() { return Object.freeze({ key: null, generation: 0 }); },
  async getCredentials() { return { speechConfigured: false, openAiConfigured: false }; },
  async readProviderCredential() { return null; },
  async setCredentials() { throw sampleOnlyError(); },
  async deleteCredentials() { throw sampleOnlyError(); },
};
const closedTokenStore = {
  async get() { return null; },
  async set() { throw sampleOnlyError(); },
  async delete() { throw sampleOnlyError(); },
};
const closedNotifications: NotificationBackend = {
  platform: "web",
  async getPermission() { return "unavailable"; },
  async requestPermission() { return "unavailable"; },
  async listPending() { return []; },
  async schedule() { throw sampleOnlyError(); },
  async cancel() { throw sampleOnlyError(); },
  async cancelLegacy() { throw sampleOnlyError(); },
  async installForegroundHandler() { throw sampleOnlyError(); },
};
const closedDeviceCalendars: DeviceCalendarBackend = {
  platform: "web",
  async getPermission() { return "unavailable"; },
  async requestFullPermission() { return "unavailable"; },
  async listCalendars() { throw sampleOnlyError(); },
  async getCalendar() { throw sampleOnlyError(); },
  async readEvents() { throw sampleOnlyError(); },
  async createApprovedEvent() { throw sampleOnlyError(); },
  async lookupRecord() { throw sampleOnlyError(); },
};
const closedBackgroundTasks: BackgroundTaskBackend = {
  async getStatus() { return { platform: "web", state: "unsupported", registered: false, message: "External services are disabled in this sample." }; },
  async isRegistered() { return false; },
  async register() { throw sampleOnlyError(); },
  async unregister() { throw sampleOnlyError(); },
  async addExpirationListener() { throw sampleOnlyError(); },
};
const closedMailAlerts: MailAlertNotificationBackend = {
  platform: "web",
  async getPermission() { return "unavailable"; },
  async requestPermission() { return "unavailable"; },
  async present() { return "not_admitted"; },
  async cancel() { return "not_admitted"; },
};
const closedMailAlertTaps: MailAlertTapBackend = {
  async subscribe() { return { remove() {} }; },
  async getLastResponse() { return undefined; },
};
const closedRecordingRecovery: RecordingRecoveryService = {
  async pickAndStage() { throw sampleOnlyError(); },
  async inspect() { throw sampleOnlyError(); },
  async remove() { throw sampleOnlyError(); },
};
const closedSpeechAudio: SpeechAudioService = {
  async prepare() { throw sampleOnlyError(); },
  async verify() { throw sampleOnlyError(); },
  async release() { throw sampleOnlyError(); },
  disposeMemory() {},
};

const sampleIntegration: ControllerIntegrationDependencies = {
  privacySession: privacySession(),
  credentials: closedCredentials,
  tokenStore: closedTokenStore,
  deleteToken: async () => { throw sampleOnlyError(); },
  verifyOAuthResult: async () => false,
  writeDocument: async () => undefined,
  removeAudio: async () => { throw sampleOnlyError(); },
  recordingRecovery: closedRecordingRecovery,
  speechAudioService: closedSpeechAudio,
  connectorFactory: undefined,
  reminderBackend: closedNotifications,
  deviceCalendarBackend: closedDeviceCalendars,
  backgroundTasks: closedBackgroundTasks,
  mailAlertBackend: closedMailAlerts,
  mailAlertTapBackend: closedMailAlertTaps,
  disposePrivacyResources() {},
};

class MemoryCasStore implements StateStore {
  private raw?: string;
  private generation = 0;
  private openedGeneration?: number;
  private failAfterNextSave = false;

  seed(raw: string) {
    this.raw = raw;
    this.generation += 1;
  }

  changeOutsideSnapshot() {
    if (!this.raw) throw new Error("No sample snapshot exists.");
    const parsed = JSON.parse(this.raw) as Record<string, unknown>;
    this.raw = JSON.stringify({ ...parsed, sampleConcurrentChange: this.generation + 1 });
    this.generation += 1;
  }

  failAfterNextWrite() { this.failAfterNextSave = true; }

  async load(): Promise<AppState | undefined> {
    this.openedGeneration = this.generation;
    return this.raw ? JSON.parse(this.raw) as AppState : undefined;
  }

  async readCurrentSnapshot() {
    await this.assertCurrent();
    return this.raw ? { raw: this.raw, schemaVersion: 1 } : undefined;
  }

  async save(state: AppState): Promise<void> {
    await this.assertCurrent();
    this.raw = JSON.stringify(state);
    this.generation += 1;
    this.openedGeneration = this.generation;
    if (this.failAfterNextSave) {
      this.failAfterNextSave = false;
      throw new Error("Fictional acknowledgement was lost after the sample write.");
    }
  }

  async clear(): Promise<void> {
    await this.assertCurrent();
    this.raw = undefined;
    this.generation += 1;
    this.openedGeneration = this.generation;
  }

  async assertCurrent(): Promise<void> {
    if (this.openedGeneration === undefined || this.openedGeneration !== this.generation) {
      throw new Error("The fictional sample snapshot changed in another workspace.");
    }
  }
}

function privacySession() {
  const epoch = uuid(100);
  return {
    epoch,
    async assertCurrent() {},
    async getStatus() {
      return {
        phase: "ready" as const, epoch, activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
        limits: { namespaces: 64, oauthTokenRefs: 512, legacyMarkdownPaths: 4096, writerLeases: 128, cleanupTargets: 5130, cleanupBatch: 16 },
        coverage: "tracked_with_legacy_limits" as const,
      };
    },
  };
}

async function archiveEntries(count: number) {
  const sourceJson = JSON.stringify({ proactive: { fictionalArchive: true } });
  const sourceBytes = new TextEncoder().encode(sourceJson).byteLength;
  const sourceSha256 = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, sourceJson, { encoding: Crypto.CryptoEncoding.HEX })).toLowerCase();
  return Array.from({ length: count }, (_, index) => ({
    operationId: uuid(200 + index), archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    sourceJson, sourceSha256, sourceBytes,
  }));
}

export type ProactiveRecoveryPreviewFixture = {
  controller: AppController;
  store: MemoryCasStore;
};

/** Uses the production controller and recovery policy over a fictional in-memory CAS store. */
export async function createProactiveRecoveryPreview(variant: "corrupt" | "archive-full" | "archive-invalid" = "corrupt"): Promise<ProactiveRecoveryPreviewFixture> {
  assertPreviewEnabled();
  const { AppControllerImpl } = await import("../services/controller");
  const store = new MemoryCasStore();
  const session = privacySession();
  const integration: ControllerIntegrationDependencies = { ...sampleIntegration, privacySession: session };
  const providers = {
    speech: new AzureSpeechClient({ fetcher: denyNetwork, readKey: denyKeys }),
    openAi: new AzureOpenAIClient(denyNetwork, denyKeys),
  };
  const seedController = new AppControllerImpl(store, providers, integration);
  await seedController.load();
  const seed = structuredClone(seedController.getSnapshot()) as AppState & Record<string, unknown>;
  seed.proactive = { schemaVersion: 404, rules: "fictional malformed sample" } as unknown as AppState["proactive"];
  if (variant === "archive-full") seed.proactiveRecoveryArchives = { version: 1, entries: await archiveEntries(4) };
  if (variant === "archive-invalid") seed.proactiveRecoveryArchives = { version: 77, entries: [] };
  store.seed(JSON.stringify(seed));

  const controller = new AppControllerImpl(store, providers, integration);
  await controller.load();
  return { controller, store };
}

function fixedStatus(status: ProactiveRecoveryStatus): string {
  switch (status.status) {
    case "busy": return "Another sample operation is in progress. No reset was made.";
    case "refresh_required": return "Sample data changed. Refresh it before continuing.";
    case "unavailable": return status.reason === "archive_invalid"
      ? "The private recovery archive could not be validated. No reset was made."
      : status.reason === "archive_full"
        ? "The private recovery archive is full. No reset was made."
        : status.reason === "evidence_too_large"
          ? "The sample evidence exceeds the supported review size. No reset was made."
          : "Sample recovery is unavailable. No reset was made.";
    case "not_needed": return "No recovery is needed.";
    case "available":
    case "prepared": return "Sample recovery is ready for an explicit review.";
  }
}

export function ProactiveRecoveryPreview() {
  const [scenario, setScenario] = useState<ProactiveRecoveryPreviewFixture | undefined>();
  const [plan, setPlan] = useState<ProactiveRecoveryPlan | undefined>();
  const [statusText, setStatusText] = useState("Choose a fictional fixture case to begin.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unknownOperationId, setUnknownOperationId] = useState<string | undefined>();
  const [refreshed, setRefreshed] = useState(false);
  const [receiptText, setReceiptText] = useState("");
  const [changeAtConfirmArmed, setChangeAtConfirmArmed] = useState(false);
  const [loseAckArmed, setLoseAckArmed] = useState(false);
  const [, rerender] = useState(0);
  const controller = scenario?.controller;
  useSyncExternalStore(
    (listener) => controller?.subscribe(() => listener()) ?? (() => undefined),
    () => controller?.getSnapshot() ?? null,
    () => controller?.getSnapshot() ?? null,
  );

  const start = useCallback(async (variant: "corrupt" | "archive-full" | "archive-invalid") => {
    setBusy(true); setError(""); setPlan(undefined); setUnknownOperationId(undefined); setRefreshed(false); setReceiptText("");
    setChangeAtConfirmArmed(false); setLoseAckArmed(false);
    setScenario(undefined);
    try {
      const next = await createProactiveRecoveryPreview(variant);
      setScenario(next);
      setStatusText("");
      rerender((value) => value + 1);
    } catch {
      setError("The fictional recovery fixture could not be prepared.");
    } finally { setBusy(false); }
  }, []);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (!controller || busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch { setError("The sample action could not be confirmed. Review the sample status before continuing."); }
    finally { setBusy(false); rerender((value) => value + 1); }
  }, [busy, controller]);

  const prepare = () => run(async () => {
    const nextPlan = await controller!.prepareProactiveRecovery();
    setPlan(nextPlan);
    setStatusText("Review prepared using the sample controller. Nothing has been reset.");
  });
  const cancel = (operationId?: string) => run(async () => {
    if (operationId) await controller!.cancelProactiveRecovery(operationId);
    setPlan(undefined);
    setStatusText("Sample review canceled. Sample data was not changed.");
  });
  const confirm = (operationId: string) => {
    if (!controller || busy || unknownOperationId) return;
    setBusy(true); setError("");
    void (async () => {
      try {
        const changeSnapshot = changeAtConfirmArmed;
        const loseAcknowledgement = loseAckArmed;
        setChangeAtConfirmArmed(false);
        setLoseAckArmed(false);
        if (changeSnapshot) scenario?.store.changeOutsideSnapshot();
        if (loseAcknowledgement) scenario?.store.failAfterNextWrite();
        const result = await controller.confirmProactiveRecovery({ operationId, confirmation: "RESET RULES" });
        setPlan(undefined);
        if (result.status === "applied") {
          setUnknownOperationId(undefined);
          setRefreshed(false);
          setReceiptText("");
          setStatusText("Sample reset applied by the real controller over memory-only storage.");
        } else {
          setUnknownOperationId(result.operationId);
          setRefreshed(false);
          setStatusText("The reset result is still unverified.");
          setReceiptText("Reset outcome is not verified. Refresh the sample, then check the receipt.");
        }
      } catch {
        setPlan(undefined);
        setError("Review changed. Refresh sample data before preparing a new review.");
      } finally { setBusy(false); rerender((value) => value + 1); }
    })();
  };
  const refreshSample = () => run(async () => {
    await controller!.refreshPersistedWorkspace();
    setRefreshed(Boolean(unknownOperationId));
    setStatusText("Sample data refreshed.");
    setReceiptText(unknownOperationId
      ? "Sample data refreshed. Receipt inspection is a separate read-only step."
      : "Sample data refreshed. Prepare a new review against the current sample data.");
  });
  const inspectReceipt = () => run(async () => {
    if (!unknownOperationId || !refreshed) return;
    const result = await controller!.inspectProactiveRecoveryReceipt(unknownOperationId);
    if (result.status === "applied") {
      setUnknownOperationId(undefined);
      setStatusText("Sample reset was verified.");
      setReceiptText("Sample recovery receipt confirms the reset was applied.");
    } else {
      setReceiptText("The sample receipt is not verified. No second reset was sent.");
    }
  });

  const recoveryStatus = controller?.getProactiveRecoveryStatus();
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.kicker}>SAMPLE · SIMULATED</Text>
        <Text style={s.h1Small}>Proactive recovery</Text>
        <Text style={s.intro}>Fictional malformed attention data is handled by the real AppControllerImpl and recovery policy. Storage is in memory only; no device, provider, network, or microphone APIs are used.</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Choose a sample case</Text>
          <Button label="Start corrupt-data case" disabled={busy || Boolean(unknownOperationId)} onPress={() => void start("corrupt")} />
          <Button label="Start full-archive case" tone="quiet" disabled={busy || Boolean(unknownOperationId)} onPress={() => void start("archive-full")} />
          <Button label="Start invalid-archive case" tone="quiet" disabled={busy || Boolean(unknownOperationId)} onPress={() => void start("archive-invalid")} />
        </View>
        {controller ? <View style={styles.card}>
          <Text style={styles.cardTitle}>Sample recovery status</Text>
          <Text style={styles.body}>{recoveryStatus ? fixedStatus(recoveryStatus) : "Opening sample controller…"}</Text>
          {statusText ? <Text style={styles.meta}>{statusText}</Text> : null}
          <Text style={styles.meta}>{recoveryStatus?.archiveBytes == null ? "Private archive size unavailable" : `${recoveryStatus.archiveBytes} bytes · ${recoveryStatus.archiveCount ?? "unknown"} ${recoveryStatus.archiveCount === 1 ? "previous copy" : "previous copies"}`}</Text>
          {plan ? <Text style={styles.meta}>Review plan is ready. The actual controller verifies expiry, snapshot, and confirmation.</Text> : null}
          {receiptText ? <Text style={styles.body}>{receiptText}</Text> : null}
          {unknownOperationId ? <>
            <Button label="Refresh sample data" tone="quiet" disabled={busy} onPress={() => void refreshSample()} />
            <Button label="Check sample recovery receipt" disabled={busy || !refreshed} onPress={() => void inspectReceipt()} />
          </> : null}
          {!unknownOperationId && recoveryStatus?.status === "refresh_required" ? (
            <Button label="Refresh sample data" tone="quiet" disabled={busy} onPress={() => void refreshSample()} />
          ) : null}
          {!unknownOperationId ? <>
            <Button label={changeAtConfirmArmed ? "Snapshot change armed for confirmation" : "Change snapshot at next confirmation"} tone="quiet" disabled={busy || !scenario} onPress={() => { setChangeAtConfirmArmed((value) => !value); setLoseAckArmed(false); }} />
            <Button label={loseAckArmed ? "Lost acknowledgement armed" : "Lose next save acknowledgement"} tone="quiet" disabled={busy || !scenario} onPress={() => { setLoseAckArmed((value) => !value); setChangeAtConfirmArmed(false); }} />
            <Button label="Prepare sample review" disabled={busy || !scenario || recoveryStatus?.status !== "available"} onPress={() => void prepare()} />
          </> : null}
        </View> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {busy ? <ActivityIndicator color={C.sage} /> : null}
        <Text style={styles.meta}>Every fixture button changes only the isolated in-memory sample.</Text>
        </ScrollView>
        {controller ? <ProactiveRecoverySheet
          key={`${plan?.operationId ?? "new"}`}
          visible={Boolean(plan)} plan={plan} busy={busy} previewOnly
          error={error} onPrepare={() => void prepare()} onConfirm={(id) => void confirm(id)}
          onCancel={(id) => void cancel(id)} onClose={() => void cancel(plan?.operationId)}
        /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = {
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, gap: 9 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: "700" as const },
  body: { color: C.text, fontSize: 14, lineHeight: 20 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
};
