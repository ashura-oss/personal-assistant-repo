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
const { buildLlmProviderSettingsPatch, buildSpeechProviderSettingsPatch, buildProviderCredentialInput, resolveTextAssistanceRoute } = await import("../App");

describe("assistant provider Settings UI contracts", () => {
  it("routes only newly saved text settings to Batch and leaves legacy Azure fields untouched", () => {
    const legacy = {
      llmProvider: "azure" as const,
      openAiEndpoint: "https://legacy.example.test/",
      openAiDeployment: "legacy-deployment",
      model: "legacy-model",
      maxOutputTokens: 600,
      monthlyBudgetUsd: 3,
      maxAttempts: 1,
      maxCallsPerDay: 20,
    };
    const patch = buildLlmProviderSettingsPatch({ openRouterEffort: "low" });
    expect(patch).toEqual({
      llmProvider: "openrouter",
      openRouterModel: "openai/gpt-6-luna:batch",
      openRouterReasoningEffort: "low",
    });
    expect({ ...legacy, ...patch }).toMatchObject({
      llmProvider: "openrouter",
      openAiEndpoint: legacy.openAiEndpoint,
      openAiDeployment: legacy.openAiDeployment,
      model: legacy.model,
      maxOutputTokens: legacy.maxOutputTokens,
      monthlyBudgetUsd: legacy.monthlyBudgetUsd,
      maxAttempts: legacy.maxAttempts,
      maxCallsPerDay: legacy.maxCallsPerDay,
    });
  });

  it("does not silently route legacy or missing providers to a model request", () => {
    expect(resolveTextAssistanceRoute("provider", "azure")).toBe("setup_required");
    expect(resolveTextAssistanceRoute("provider", undefined)).toBe("setup_required");
    expect(resolveTextAssistanceRoute("provider", "openrouter")).toBe("batch");
    expect(resolveTextAssistanceRoute("preview", "azure")).toBe("preview");
  });

  it("keeps Speech provider selection independent from the AI provider", () => {
    expect(buildSpeechProviderSettingsPatch("openrouter")).toEqual({ speechProvider: "openrouter" });
    expect(buildSpeechProviderSettingsPatch("azure")).toEqual({ speechProvider: "azure" });
  });

  it("saves OpenRouter and Azure Speech keys independently without routing credentials through legacy Azure text", () => {
    expect(buildProviderCredentialInput(" speech-test ", " router-test ")).toEqual({
      speechSubscriptionKey: "speech-test",
      openRouterApiKey: "router-test",
    });
    expect(buildProviderCredentialInput("", " router-test ")).toEqual({
      openRouterApiKey: "router-test",
    });
    expect(buildProviderCredentialInput(" speech-test ", " ")).toEqual({ speechSubscriptionKey: "speech-test" });
  });

});
