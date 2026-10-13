import { Platform } from "react-native";
import type { AppState, Note } from "../core";
import type { PreparedSpeechAudio, SpeechAudioService } from "../audio/speechUpload.types";
import { AppControllerImpl } from "../services/controller";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import type { StateStore } from "../storage/contracts";

type Outcome = "success" | "no-speech" | "uncertain" | "pending";

class MemoryStateStore implements StateStore {
  private value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

const SAMPLE_KEY = "sample-only-not-a-provider-key";
const SAMPLE_AUDIO_URI = "indexeddb-audio:still-transcription-sample";
const SAMPLE_AUDIO_BYTES = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
const SAMPLE_AUDIO_HASH = "a".repeat(64);

function assertPreviewEnabled() {
  if (
    typeof __DEV__ === "undefined" || !__DEV__ || Platform.OS !== "web" ||
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "transcription"
  ) {
    throw new Error("The transcription sample is available only in its isolated development browser preview.");
  }
}

const denyExternalIO: typeof fetch = async () => {
  throw new Error("External requests are disabled in the transcription sample.");
};
const denyProviderKeys = async (): Promise<string | null> => {
  throw new Error("Real provider keys are disabled in the transcription sample.");
};

function createSampleAudioService(): SpeechAudioService {
  const leases = new Map<string, PreparedSpeechAudio>();
  return {
    async prepare(note: Note, { leaseId, maxDurationSeconds, signal }) {
      if (signal?.aborted) throw signal.reason ?? new Error("Sample transcription cancelled.");
      if (note.audioUri !== SAMPLE_AUDIO_URI || note.durationSeconds <= 0 || note.durationSeconds > maxDurationSeconds) {
        throw new Error("The sample recording is unavailable or outside the configured duration limit.");
      }
      const blob = new Blob([SAMPLE_AUDIO_BYTES], { type: "audio/wav" });
      const prepared: PreparedSpeechAudio = Object.freeze({
        leaseId,
        platform: "web",
        format: "wav",
        mimeType: "audio/wav",
        byteLength: blob.size,
        sha256: SAMPLE_AUDIO_HASH,
        durationSeconds: note.durationSeconds,
        upload: Object.freeze({ blob, fileName: "sample-clip.wav" }),
      });
      leases.set(leaseId, prepared);
      return prepared;
    },
    async verify(prepared, signal) {
      if (signal?.aborted) throw signal.reason ?? new Error("Sample transcription cancelled.");
      if (leases.get(prepared.leaseId) !== prepared || prepared.sha256 !== SAMPLE_AUDIO_HASH) {
        throw new Error("The fictional sample audio lease is no longer available.");
      }
    },
    async release(leaseId) { leases.delete(leaseId); },
  };
}

function createSampleSpeechFetcher(outcome: Outcome): typeof fetch {
  const endpoint = "https://sample.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15";
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (url !== endpoint || init?.method !== "POST" || headers.get("Ocp-Apim-Subscription-Key") !== SAMPLE_KEY || !(body instanceof FormData)) {
      throw new Error("The transcription sample rejected an unexpected request shape.");
    }
    const entries = [...body.keys()].sort();
    const audio = body.get("audio");
    let definition: unknown;
    try { definition = JSON.parse(String(body.get("definition"))); } catch { definition = undefined; }
    if (
      entries.join(",") !== "audio,definition" || body.getAll("audio").length !== 1 ||
      !(audio instanceof Blob) || audio.type !== "audio/wav" ||
      JSON.stringify(definition) !== JSON.stringify({ locales: ["en-US"] })
    ) {
      throw new Error("The transcription sample rejected an unexpected audio payload.");
    }
    if (outcome === "pending") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("Sample upload cancelled."));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("Sample upload cancelled.")), { once: true });
      });
    }
    if (outcome === "uncertain") throw new Error("Sample provider response was deliberately lost after dispatch.");
    const response = outcome === "no-speech"
      ? { durationMilliseconds: 3_760, combinedPhrases: [] }
      : { durationMilliseconds: 3_760, combinedPhrases: [{ text: "Please review the launch timeline with Morgan before Friday." }] };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Isolated fictional transcript flow. It uses a closed, validated mock request and memory-only storage. */
export async function createTranscriptionPreview() {
  assertPreviewEnabled();
  const selected = process.env.EXPO_PUBLIC_PREVIEW_TRANSCRIPTION_OUTCOME;
  const outcome: Outcome = selected === "no-speech" || selected === "uncertain" || selected === "pending" ? selected : "success";
  const store = new MemoryStateStore();
  const speech = new AzureSpeechClient({
    fetcher: createSampleSpeechFetcher(outcome),
    readKeySnapshot: async () => ({ key: SAMPLE_KEY, generation: 0 }),
    currentCredentialGeneration: () => 0,
    assertCredentialGeneration: (generation) => {
      if (generation !== 0) throw new Error("Sample credential generation changed.");
    },
    audio: createSampleAudioService(),
    deadlineMs: 60_000,
  });
  const providers = {
    speech,
    openAi: new AzureOpenAIClient(denyExternalIO, denyProviderKeys),
  };
  const controller = new AppControllerImpl(store, providers, {
    writeDocument: async () => undefined,
  });
  await controller.load();
  await controller.saveSettings({
    mode: "preview",
    speechEnabled: true,
    speechEndpoint: "https://sample.cognitiveservices.azure.com",
    maxAudioSeconds: 600,
  });
  const note = await controller.saveNote({
    transcript: "I have a sample recording about the project timeline.",
    audioUri: SAMPLE_AUDIO_URI,
    durationSeconds: 4.125,
    capturedAt: new Date().toISOString(),
    captureTimeZone: "Asia/Singapore",
  });
  const sampleState = structuredClone(controller.getSnapshot());
  const sampleNote = sampleState.notes.find((item) => item.id === note.id);
  if (!sampleNote) throw new Error("The sample recording note could not be loaded.");
  sampleNote.durationSeconds = 4.125;
  await store.save(sampleState);
  const previewController = new AppControllerImpl(store, providers, { writeDocument: async () => undefined });
  await previewController.load();
  return previewController;
}
