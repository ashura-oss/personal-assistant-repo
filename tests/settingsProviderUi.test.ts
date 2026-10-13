import { describe, expect, it, vi } from "vitest";
vi.stubGlobal("__DEV__", false);
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} }, createAudioPlayer: () => ({}),
  requestRecordingPermissionsAsync: async () => ({ granted: false }), setAudioModeAsync: async () => undefined,
  useAudioRecorder: () => ({}), useAudioRecorderState: () => ({ isRecording: false }),
}));
vi.mock("expo-calendar", () => ({}));
vi.mock("expo-background-task", () => ({}));
vi.mock("expo-notifications", () => ({}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-sqlite", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: () => undefined }));
vi.mock("expo-auth-session", () => ({}));
vi.mock("expo-linking", () => ({}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }));
vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const pass = (tag: string) => ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(tag, {}, children);
  return {
    Platform: { OS: "web", select: (values: Record<string, unknown>) => values.web ?? values.default },
    StyleSheet: { create: (value: unknown) => value },
    View: pass("div"), Text: pass("span"), ScrollView: pass("div"), Modal: pass("div"),
    Pressable: pass("button"), Switch: pass("input"), TextInput: pass("input"),
    ActivityIndicator: pass("span"), Alert: { alert: () => undefined }, KeyboardAvoidingView: pass("div"), AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  };
});
vi.mock("expo-file-system/legacy", () => ({}));
vi.mock("expo-file-system", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaProvider: ({ children }: { children?: unknown }) => children, SafeAreaView: ({ children }: { children?: unknown }) => children }));
const { buildLlmProviderSettingsPatch, buildSpeechProviderSettingsPatch, buildProviderCredentialInput } = await import("../App");

const values = {
  endpoint: "https://azure.example.test/openai/v1/",
  deployment: "legacy-deployment",
  model: "gpt-6-luna",
  azureEffort: "none" as const,
  openRouterEffort: "low" as const,
  maxRequestBytes: 24_000,
  maxOutputTokens: 600,
  monthlyBudgetUsd: 3,
  maxAttempts: 1,
  maxCallsPerDay: 20,
};

describe("assistant provider Settings UI contracts", () => {
  it("keeps OpenRouter batch profile fields separate from saved Azure settings and limits", () => {
    expect(buildLlmProviderSettingsPatch("openrouter", values)).toEqual({
      llmProvider: "openrouter",
      openRouterModel: "openai/gpt-6-luna:batch",
      openRouterReasoningEffort: "low",
    });
  });

  it("retains the legacy Azure profile and controls when Azure remains selected", () => {
    expect(buildLlmProviderSettingsPatch("azure", values)).toEqual({
      llmProvider: "azure",
      openAiEndpoint: values.endpoint,
      openAiDeployment: values.deployment,
      model: values.model,
      reasoningEffort: "none",
      maxRequestBytes: 24_000,
      maxOutputTokens: 600,
      monthlyBudgetUsd: 3,
      maxAttempts: 1,
      maxCallsPerDay: 20,
    });
  });

  it("keeps Speech provider selection independent from the AI provider", () => {
    expect(buildSpeechProviderSettingsPatch("openrouter")).toEqual({ speechProvider: "openrouter" });
    expect(buildSpeechProviderSettingsPatch("azure")).toEqual({ speechProvider: "azure" });
  });

  it("saves only the selected provider key while keeping Azure Speech independent", () => {
    expect(buildProviderCredentialInput("openrouter", " speech-test ", "azure-test", " router-test ")).toEqual({
      speechSubscriptionKey: "speech-test",
      openRouterApiKey: "router-test",
    });
    expect(buildProviderCredentialInput("azure", "", " azure-test ", "router-test")).toEqual({
      openAiApiKey: "azure-test",
    });
    expect(buildProviderCredentialInput("azure", "", " azure-test ", " router-test ", true)).toEqual({
      openAiApiKey: "azure-test",
      openRouterApiKey: "router-test",
    });
  });

});
