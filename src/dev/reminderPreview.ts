import { Platform } from "react-native";
import type { AppState, LocalTask } from "../core";
import { extractPreviewProposals, AppControllerImpl } from "../services/controller";
import { notificationContentForIntent } from "../reminders";
import type { NotificationBackend, PendingNotificationRequest } from "../services/notificationBackend";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import type { StateStore } from "../storage/contracts";

class MemoryStateStore implements StateStore {
  private value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

function assertPreviewEnabled() {
  if (typeof __DEV__ === "undefined" || !__DEV__ || process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "reminders") {
    throw new Error("The reminders sample is available only in its isolated development preview.");
  }
  if (Platform.OS !== "web") throw new Error("The reminders sample is available in the isolated browser preview only.");
}

const deniedFetch: typeof fetch = async () => { throw new Error("External requests are disabled in the reminders sample."); };
const deniedKey = async (): Promise<string | null> => { throw new Error("Provider keys are disabled in the reminders sample."); };

function createSimulatedNotificationBackend(): NotificationBackend {
  const pending = new Map<string, PendingNotificationRequest>();
  return {
    platform: "mock",
    async getPermission() { return "authorized"; },
    async requestPermission() { return "authorized"; },
    async listPending() { return [...pending.values()]; },
    async schedule(intent, installationId, beforeSchedule) {
      if (!installationId) throw new Error("Sample installation is unavailable.");
      if (beforeSchedule?.() === false) throw new Error("The sample alert changed before scheduling.");
      const content = notificationContentForIntent(intent, installationId);
      pending.set(intent.identifier, {
        identifier: intent.identifier,
        title: content.title,
        body: content.body,
        data: content.data,
        trigger: { dueAt: intent.payload?.dueAt, repeats: false, verifiable: true },
        extraContentSafe: true,
      });
      return intent.identifier;
    },
    async cancel(identifier) { pending.delete(identifier); },
    async cancelLegacy(cancellation) { pending.delete(cancellation.identifier); },
    async installForegroundHandler() {},
  };
}

/**
 * Isolated, memory-only reminder workflow. It uses a closed mock notification backend;
 * production storage, provider networking, keys, OAuth, and microphone are not used.
 */
export async function createReminderPreview() {
  assertPreviewEnabled();
  const store = new MemoryStateStore();
  const providers = {
    speech: new AzureSpeechClient({ fetcher: deniedFetch, readKey: deniedKey }),
    openAi: new AzureOpenAIClient(deniedFetch, deniedKey),
  };
  const integration = { reminderBackend: createSimulatedNotificationBackend() };
  let controller = new AppControllerImpl(store, providers, integration);
  await controller.load();
  await controller.saveSettings({ timezone: "Asia/Singapore", mode: "preview" });
  const note = await controller.saveNote({
    transcript: "I need to review the launch checklist.",
    capturedAt: new Date().toISOString(),
    captureTimeZone: "Asia/Singapore",
  });
  const proposal = extractPreviewProposals(note).find((item) => item.kind === "task");
  if (!proposal) throw new Error("Could not prepare the fictional sample task.");
  proposal.status = "executed";
  const dueAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const task: LocalTask = {
    id: proposal.id,
    title: "Review the launch checklist",
    body: "A fictional task used to preview local reminders.",
    status: "open",
    createdAt: new Date().toISOString(),
    dueAt,
    sourceNoteId: note.id,
    sourceRevision: note.revision,
    proposalId: proposal.id,
  };
  const seeded = structuredClone(controller.getSnapshot());
  seeded.proposals.unshift(proposal);
  seeded.tasks.unshift(task);
  await store.save(seeded);

  controller = new AppControllerImpl(store, providers, integration);
  await controller.load();
  await controller.saveProactiveRule({
    name: "Launch checklist",
    enabled: true,
    accountIds: [],
    trigger: { type: "task_due", minutes: 60 },
  });
  await controller.evaluateLocalCandidates();
  return controller;
}
