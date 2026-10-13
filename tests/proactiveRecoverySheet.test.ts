/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProactiveRecoveryPlan } from "../src/proactive/recovery";
import { ProactiveRecoverySheet } from "../src/ui/ProactiveRecoverySheet";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const passthrough = (tag: string) => ({ children, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, props, children);
  return {
    Platform: { OS: "web" }, StyleSheet: { create: (value: unknown) => value },
    View: passthrough("div"), Text: passthrough("span"), ScrollView: passthrough("div"),
    Pressable: ({ children, style: _style, onPress, accessibilityLabel, disabled }: { children?: React.ReactNode; style?: unknown; onPress?: () => void; accessibilityLabel?: string; disabled?: boolean }) =>
      ReactModule.createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled }, children),
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? ReactModule.createElement("div", {}, children) : null,
    TextInput: ({ style: _style, value, onChangeText, accessibilityLabel, placeholder }: { style?: unknown; value: string; onChangeText: (text: string) => void; accessibilityLabel: string; placeholder?: string }) =>
      ReactModule.createElement("input", { value, "aria-label": accessibilityLabel, placeholder, onChange: (event: Event) => onChangeText((event.target as HTMLInputElement).value) }),
  };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }));
vi.mock("react-native-safe-area-context", async () => {
  const ReactModule = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement("div", {}, children);
  return { SafeAreaProvider: pass, SafeAreaView: pass };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const plan: ProactiveRecoveryPlan = {
  operationId: "private-operation-uuid", expiresAt: "2026-10-13T12:05:00.000Z", evidenceBytes: 512,
  archiveCount: 2,
  effects: {
    resetsRules: true, resetsAttention: true, resetsDismissalsAndSnoozes: true,
    mailConsentsToRevoke: 1, mailReceiptsPreserved: 3, mailCleanup: "pending",
  },
};

describe("proactive recovery review sheet", () => {
  it("requires the exact typed phrase and never renders private identifiers or saved values", () => {
    const confirm = vi.fn();
    act(() => root.render(React.createElement(ProactiveRecoverySheet, {
      visible: true, plan, busy: false, previewOnly: true, onPrepare: vi.fn(), onConfirm: confirm,
      onCancel: vi.fn(), onClose: vi.fn(),
    })));
    expect(host.textContent).toContain("SAMPLE · SIMULATED");
    expect(host.textContent).toContain("Mail alert cancellation will be recorded for later reconciliation.");
    expect(host.textContent).not.toContain("private-operation-uuid");
    expect(host.textContent).not.toContain("sourceJson");
    const confirmButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Reset rules and local attention"));
    expect(confirmButton?.disabled).toBe(true);
    const input = host.querySelector("input");
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "reset rules");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(confirmButton?.disabled).toBe(true);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "RESET RULES");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(confirmButton?.disabled).toBe(false);
    act(() => confirmButton?.click());
    expect(confirm).toHaveBeenCalledWith("private-operation-uuid");
  });

  it("does not imply mail cleanup is confirmed when counts are unavailable", () => {
    const unavailablePlan: ProactiveRecoveryPlan = {
      ...plan, effects: { ...plan.effects, mailConsentsToRevoke: null, mailReceiptsPreserved: null, mailCleanup: "unavailable" },
    };
    act(() => root.render(React.createElement(ProactiveRecoverySheet, {
      visible: true, plan: unavailablePlan, busy: false, onPrepare: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(),
    })));
    expect(host.textContent).toContain("Mail alert settings cannot be validated and will be preserved without change.");
    expect(host.textContent).toContain("Mail alert history cannot be validated and will be preserved without change.");
    expect(host.textContent).toContain("Mail alert cancellation status is unavailable; existing notifications are not confirmed removed.");
    expect(host.textContent).not.toContain("will be revoked");
  });

  it("keeps cancel available while other actions are blocked and resets confirmation for a new plan", () => {
    const cancel = vi.fn();
    const confirm = vi.fn();
    const first = { ...plan, operationId: "first-operation" };
    const second = { ...plan, operationId: "second-operation" };
    act(() => root.render(React.createElement(ProactiveRecoverySheet, {
      key: first.operationId, visible: true, plan: first, busy: false, actionsBlocked: true,
      onPrepare: vi.fn(), onConfirm: confirm, onCancel: cancel, onClose: vi.fn(),
    })));
    const input = host.querySelector("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "RESET RULES");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => root.render(React.createElement(ProactiveRecoverySheet, {
      key: second.operationId, visible: true, plan: second, busy: false, actionsBlocked: true,
      onPrepare: vi.fn(), onConfirm: confirm, onCancel: cancel, onClose: vi.fn(),
    })));
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("");
    const buttons = [...host.querySelectorAll("button")];
    const confirmButton = buttons.find((button) => button.textContent?.includes("Reset rules and local attention"));
    const cancelButton = buttons.find((button) => button.textContent?.includes("Cancel review"));
    expect(confirmButton?.disabled).toBe(true);
    expect(cancelButton?.disabled).toBe(false);
    act(() => cancelButton?.click());
    expect(cancel).toHaveBeenCalledWith("second-operation");
    expect(confirm).not.toHaveBeenCalled();
  });
});
