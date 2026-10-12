import type { AppState } from "../core";
import { AppControllerImpl } from "../services/controller";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import type { StateStore } from "../storage/contracts";
import { Platform } from "react-native";

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

function assertKnowledgePreviewEnabled() {
  if (
    typeof __DEV__ === "undefined" ||
    !__DEV__ ||
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "knowledge"
  ) {
    throw new Error(
      "The sample knowledge workspace is available only in its isolated development preview.",
    );
  }
}

const denyExternalIO: typeof fetch = async () => {
  throw new Error("External requests are disabled in the knowledge sample preview.");
};

const denyProviderKeys = async (): Promise<string | null> => {
  throw new Error("Provider credentials are disabled in the knowledge sample preview.");
};

/** Fictional, memory-backed knowledge review fixture. No production store or provider is used. */
export async function createKnowledgeScenario() {
  assertKnowledgePreviewEnabled();
  if (Platform.OS !== "web") {
    throw new Error("The knowledge sample workspace is available in the isolated browser preview only.");
  }

  const store = new MemoryStateStore();
  const controller = new AppControllerImpl(store, {
    speech: new AzureSpeechClient({ fetcher: denyExternalIO, readKey: denyProviderKeys }),
    openAi: new AzureOpenAIClient(denyExternalIO, denyProviderKeys),
  }, {
    writeDocument: async () => undefined,
  });
  await controller.load();

  const person = await controller.savePerson({
    name: "Morgan Lee",
    aliases: ["Morgan", "M. Lee"],
    narrative: "Morgan coordinates Project Atlas and prefers concise Friday status updates.",
  });
  const project = await controller.saveProject({
    name: "Project Atlas",
    aliases: ["Atlas rollout"],
    narrative: "A fictional sample project for reviewing local people, projects, and memory suggestions.",
    goal: "Prepare a calm, well-reviewed launch.",
    status: "active",
    startsOn: "2026-10-01",
    targetOn: "2026-11-06",
    dateTimeZone: "Asia/Singapore",
  });
  const note = await controller.saveNote({
    transcript: "Morgan Lee is coordinating Project Atlas. Morgan prefers Friday status updates. The Atlas launch target is November 6, 2026.",
    capturedAt: "2026-10-12T09:15:00.000Z",
    captureTimeZone: "Asia/Singapore",
  });
  await controller.createKnowledgeSuggestionFromNote({
    noteId: note.id,
    sourceId: "transcript",
    quote: "Morgan prefers Friday status updates.",
    targetKind: "person",
    targetId: person.id,
    change: {
      type: "add_fact",
      entityKind: "person",
      entityId: person.id,
      statement: "Prefers Friday status updates.",
    },
  });

  // Keep a reference to the sample project in its own local link list for browsing.
  await controller.saveKnowledgeSourceLink({
    entityKind: "project",
    entityId: project.id,
    expectedEntityRevision: project.revision,
    reference: { kind: "note", id: note.id },
    label: "Launch planning note",
  });
  return controller;
}
