import type { AppState, Note } from "../core";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import { AppControllerImpl } from "../services/controller";
import type { StateStore } from "../storage/contracts";

class MemoryStateStore implements StateStore {
  private value?: AppState;

  async load() {
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: AppState) {
    this.value = structuredClone(state);
  }

  async clear() {
    this.value = undefined;
  }
}

function assertBackupPreviewEnabled() {
  if (
    typeof __DEV__ === "undefined" ||
    !__DEV__ ||
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "backup-import"
  ) {
    throw new Error("The sample backup is available only in its isolated development preview.");
  }
}

const denyExternalIO: typeof fetch = async () => {
  throw new Error("External provider requests are disabled in the backup sample preview.");
};

const denyKeys = async (): Promise<string | null> => {
  throw new Error("Provider credentials are disabled in the backup sample preview.");
};

/** In-memory preview only; this controller never reads or writes production app state. */
export async function createBackupScenario() {
  assertBackupPreviewEnabled();
  const store = new MemoryStateStore();
  const providers = {
    speech: new AzureSpeechClient({ fetcher: denyExternalIO, readKey: denyKeys }),
    openAi: new AzureOpenAIClient(denyExternalIO, denyKeys),
  };
  const controller = new AppControllerImpl(
    store,
    providers,
  );
  await controller.load();

  const state = controller.getSnapshot();
  const requiredContext = ["memory/PROFILE.md", "memory/RULES.md", "memory/ROUTINES.md"];
  for (const path of requiredContext) {
    if (!state.documents.some((document) => document.path === path)) {
      throw new Error(`The backup sample is missing its expected local context document: ${path}`);
    }
  }
  const existingNote: Note = {
    id: "sample-existing-note",
    title: "Sample note already on this device",
    transcript: "Confirm the revised project timeline before Friday.",
    durationSeconds: 0,
    createdAt: "2026-10-12T09:15:00.000Z",
    capturedAt: "2026-10-12T09:15:00.000Z",
    captureTimeZone: "Asia/Singapore",
    status: "recorded",
    revision: 1,
  };
  const seededState = structuredClone(controller.getSnapshot());
  seededState.notes.unshift(existingNote);
  await store.save(seededState);
  const previewController = new AppControllerImpl(store, providers);
  await previewController.load();
  return previewController;
}
