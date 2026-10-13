import { describe, expect, it, vi } from "vitest";
import { shouldShowProactiveRecoverySection } from "../src/ui/ProactiveRecoverySheet";

vi.mock("react-native", () => ({ Modal: () => null, ScrollView: () => null, Text: () => null, TextInput: () => null, View: () => null }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaProvider: () => null, SafeAreaView: () => null }));
vi.mock("../src/ui/primitives", () => ({ Button: () => null, IconButton: () => null }));
vi.mock("../src/ui/theme", () => ({ C: {}, s: {} }));
describe("proactive recovery Settings entry", () => {
  it("appears for corrupt rules and explicit unresolved outcomes, but not healthy data", () => {
    const healthy = {
      mailAlertRecovery: false,
      proactiveIntegrityError: false,
      recoveryUnknown: false,
      requiresRefresh: false,
      status: "available" as const,
    };
    expect(shouldShowProactiveRecoverySection(healthy)).toBe(false);
    expect(shouldShowProactiveRecoverySection({ ...healthy, proactiveIntegrityError: true })).toBe(true);
    expect(shouldShowProactiveRecoverySection({ ...healthy, recoveryUnknown: true })).toBe(true);
    expect(shouldShowProactiveRecoverySection({ ...healthy, status: "refresh_required" })).toBe(true);
  });
});
