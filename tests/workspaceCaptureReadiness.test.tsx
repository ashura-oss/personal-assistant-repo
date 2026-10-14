/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  hookOptions: [] as { ready: boolean; maxAudioSeconds: number }[],
  workspaceProps: undefined as { platform: { capture: { setReadiness: (value: { ready: boolean; maxAudioSeconds: number }) => boolean } } } | undefined,
  audioCapture: { commit: () => undefined },
}));

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
    Platform: { OS: "ios", select: (values: Record<string, unknown>) => values.ios ?? values.default },
    StyleSheet: { create: (value: unknown) => value },
    View: pass("div"), Text: pass("span"), ScrollView: pass("div"), Modal: pass("div"),
    Pressable: pass("button"), Switch: pass("input"), TextInput: pass("input"),
    ActivityIndicator: pass("span"), Alert: { alert: () => undefined }, KeyboardAvoidingView: pass("div"),
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaProvider: ({ children }: { children?: unknown }) => children, SafeAreaView: ({ children }: { children?: unknown }) => children }));
vi.mock("expo-file-system/legacy", () => ({}));
vi.mock("expo-file-system", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("../src/audio/useAudioCapture", () => ({
  useAudioCapture: (_boundary: unknown, _journal: unknown, readiness: { ready: boolean; maxAudioSeconds: number }) => {
    harness.hookOptions.push(readiness);
    return harness.audioCapture;
  },
}));
vi.mock("../WorkspaceView", () => ({
  WorkspaceView: (props: (typeof harness.workspaceProps) extends infer T ? Exclude<T, undefined> : never) => {
    harness.workspaceProps = props;
    return null;
  },
  PendingCapturePreview: () => null,
  BackgroundRefreshPreview: () => null,
  buildLlmProviderSettingsPatch: vi.fn(),
  buildSpeechProviderSettingsPatch: vi.fn(),
  buildProviderCredentialInput: vi.fn(),
  resolveTextAssistanceRoute: vi.fn(),
}));

const { Workspace } = await import("../AppLegacy");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  harness.hookOptions = [];
  harness.workspaceProps = undefined;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("native Workspace capture readiness bridge", () => {
  it("starts blocked, forwards readiness updates once, and rejects updates after unmount", () => {
    const props = {
      controller: { getSnapshot: () => ({ settings: { maxAudioSeconds: 18 } }) },
      credentials: {},
      isolated: false,
      workspaceGeneration: 4,
      privacyReviewOpen: false,
      onPrivacyReview: vi.fn(),
      onPrivacyInvalidated: vi.fn(),
    } as never;

    act(() => root.render(React.createElement(Workspace, props)));
    expect(harness.hookOptions.at(-1)).toEqual({ ready: false, maxAudioSeconds: 18 });
    const publishReadiness = harness.workspaceProps?.platform.capture.setReadiness;
    expect(publishReadiness).toBeTypeOf("function");

    act(() => { expect(publishReadiness?.({ ready: true, maxAudioSeconds: 37 })).toBe(true); });
    expect(harness.hookOptions.at(-1)).toEqual({ ready: true, maxAudioSeconds: 37 });
    const hookCallCount = harness.hookOptions.length;
    act(() => {
      expect(publishReadiness?.({ ready: true, maxAudioSeconds: 37 })).toBe(true);
      expect(publishReadiness?.({ ready: true, maxAudioSeconds: 37 })).toBe(true);
    });
    expect(harness.hookOptions.length).toBeLessThanOrEqual(hookCallCount + 1);

    act(() => root.unmount());
    expect(publishReadiness?.({ ready: false, maxAudioSeconds: 18 })).toBe(false);
  });
});
