/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchRecoveryPlan, DispatchRecoveryStatus } from "../src/dispatch/recovery";
import { DispatchRecoverySection } from "../src/ui/DispatchRecoverySection";

vi.mock("react-native", async () => {
  const R = await import("react");
  const pass = (tag: string) => ({ children, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => R.createElement(tag, props, children);
  return {
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? R.createElement("div", {}, children) : null,
    ScrollView: pass("div"), Text: pass("span"), View: pass("div"),
    TextInput: ({ value, onChangeText, accessibilityLabel, placeholder, editable }: { value: string; onChangeText: (value: string) => void; accessibilityLabel: string; placeholder?: string; editable: boolean }) =>
      R.createElement("input", { value, "aria-label": accessibilityLabel, placeholder, disabled: !editable, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value) }),
  };
});
vi.mock("react-native-safe-area-context", async () => {
  const R = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) => R.createElement("div", {}, children);
  return { SafeAreaProvider: pass, SafeAreaView: pass };
});
vi.mock("../src/ui/primitives", async () => {
  const R = await import("react");
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => R.createElement("button", { type: "button", disabled, onClick: onPress }, label),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => R.createElement("button", { type: "button", onClick: onPress }, label),
  };
});
vi.mock("../src/ui/theme", () => ({ C: new Proxy({}, { get: () => "" }), s: new Proxy({}, { get: () => ({}) }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const plan: DispatchRecoveryPlan = {
  operationId: "private-op-id", expiresAt: "2026-10-14T10:00:00.000Z", evidenceBytes: 42, archiveCount: 1,
  effects: { quarantinedReceiptCount: 1, preservedValidReceiptCount: 2, remoteProposalsRetired: 3, sourceActionFencesAdded: 1, unresolvedReceiptCount: 1 },
};
const status: DispatchRecoveryStatus = {
  status: "available", archiveCount: 1, archiveBytes: 42, unresolvedReceiptCount: 1,
};

describe("dispatch recovery Settings UI", () => {
  it("requires the exact confirmation and explains the local retirement consequences without exposing archive data", () => {
    const confirm = vi.fn();
    act(() => root.render(React.createElement(DispatchRecoverySection, {
      status, plan, open: true, busy: false, blocked: false, mutationBlocked: false, error: "", onOpen: vi.fn(), onPrepare: vi.fn(),
      onConfirm: confirm, onCancel: vi.fn(), onClose: vi.fn(), onRefresh: vi.fn(), onInspect: vi.fn(), onReviewCurrent: vi.fn(),
    })));
    expect(host.textContent).toContain("Retire damaged action history");
    expect(host.textContent).toContain("OAuth remains connected");
    expect(host.textContent).toContain("Some content cleanup may remain paused");
    expect(host.textContent).toContain("1 record with unresolved outcomes");
    expect(host.textContent).not.toContain("private-op-id");
    expect(host.textContent).not.toContain("sourceJson");
    const confirmButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Retire damaged action history");
    expect(confirmButton?.disabled).toBe(true);
    const input = host.querySelector("input");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "RETIRE ACTION"); input?.dispatchEvent(new Event("input", { bubbles: true })); input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(confirmButton?.disabled).toBe(true);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "RETIRE ACTIONS"); input?.dispatchEvent(new Event("input", { bubbles: true })); input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(confirmButton?.disabled).toBe(false);
    act(() => confirmButton?.click());
    expect(confirm).toHaveBeenCalledExactlyOnceWith("private-op-id");
  });

  it("requires an exact saved operation refresh before showing receipt inspection as available", () => {
    const refresh = vi.fn(); const inspect = vi.fn();
    const props = {
      status: { ...status, status: "refresh_required" as const, lastOperationId: "unknown-op" }, open: false, busy: false,
      blocked: false, mutationBlocked: false, error: "", unknownOperationId: "unknown-op", onOpen: vi.fn(), onPrepare: vi.fn(), onConfirm: vi.fn(),
      onCancel: vi.fn(), onClose: vi.fn(), onRefresh: refresh, onInspect: inspect, onReviewCurrent: vi.fn(),
    };
    act(() => root.render(React.createElement(DispatchRecoverySection, props)));
    const inspectButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Inspect saved receipt");
    expect(inspectButton?.disabled).toBe(true);
    act(() => host.querySelector("button")?.click());
    expect(refresh).toHaveBeenCalledExactlyOnceWith("unknown-op");
    act(() => root.render(React.createElement(DispatchRecoverySection, { ...props, refreshedOperationId: "different-op" })));
    expect([...host.querySelectorAll("button")].find((button) => button.textContent === "Inspect saved receipt")?.disabled).toBe(true);
    act(() => root.render(React.createElement(DispatchRecoverySection, { ...props, refreshedOperationId: "unknown-op" })));
    const refreshedInspectButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Inspect saved receipt");
    expect(refreshedInspectButton?.disabled).toBe(false);
    act(() => refreshedInspectButton?.click());
    expect(inspect).toHaveBeenCalledExactlyOnceWith("unknown-op");
  });

  it("shows a separate-review action only for the exact not-verified operation while current status is available", () => {
    const reviewCurrent = vi.fn();
    const props = {
      status, open: false, busy: false, blocked: false, mutationBlocked: false, error: "",
      unknownOperationId: "unknown-op", reviewCurrentOperationId: "unknown-op",
      onOpen: vi.fn(), onPrepare: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(),
      onRefresh: vi.fn(), onInspect: vi.fn(), onReviewCurrent: reviewCurrent,
    };
    act(() => root.render(React.createElement(DispatchRecoverySection, props)));
    expect(host.textContent).toContain("The previous local retirement could not be verified. This starts a separate review of the current damaged history.");
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Review current damaged history");
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(reviewCurrent).toHaveBeenCalledExactlyOnceWith("unknown-op");

    act(() => root.render(React.createElement(DispatchRecoverySection, { ...props, reviewCurrentOperationId: "different-op" })));
    expect([...host.querySelectorAll("button")].some((item) => item.textContent === "Review current damaged history")).toBe(false);
    act(() => root.render(React.createElement(DispatchRecoverySection, { ...props, status: { ...status, status: "unavailable" as const } })));
    expect([...host.querySelectorAll("button")].some((item) => item.textContent === "Review current damaged history")).toBe(false);
    act(() => root.render(React.createElement(DispatchRecoverySection, { ...props, mutationBlocked: true })));
    expect([...host.querySelectorAll("button")].find((item) => item.textContent === "Review current damaged history")?.disabled).toBe(true);
  });
});
