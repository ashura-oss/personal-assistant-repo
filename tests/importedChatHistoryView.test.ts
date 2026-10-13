/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InertImportedChatConversation } from "../src/chat/portable";
import { ImportedChatHistoryView } from "../src/ui/ImportedChatHistoryView";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const view = (tag: string) => ({ children, onPress, accessibilityLabel, accessibilityRole: _role, accessibilityState: _state,
    selectable: _selectable, contentContainerStyle: _contentStyle, showsVerticalScrollIndicator: _scrollIndicator,
    ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
    ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}), ...(onPress ? { onClick: onPress } : {}) }, children);
  return {
    Modal: ({ visible, children }: { visible: boolean; children?: React.ReactNode; [key: string]: unknown }) => visible ? ReactModule.createElement("div", { role: "dialog" }, children) : null,
    Pressable: view("button"), ScrollView: view("div"), Text: view("span"), View: view("div"),
  };
});
vi.mock("react-native-safe-area-context", async () => {
  const ReactModule = await import("react");
  const Safe = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement("div", null, children);
  return { SafeAreaView: Safe };
});
vi.mock("../src/ui/primitives", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement("button", { type: "button", disabled, onClick: onPress }, label),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement("button", { type: "button", onClick: onPress }, label),
  };
});
vi.mock("../src/ui/theme", () => ({ C: { bg: "#111", card: "#222", border: "#333", text: "#fff", muted: "#aaa", sage: "#9a9", red: "#d66" }, s: { kicker: {}, h1Small: {} } }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const history: InertImportedChatConversation = {
  id: "11111111-1111-4111-8111-111111111111",
  origin: "portable_backup_unverified",
  title: "Trip planning",
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
  turns: [
    {
      id: "22222222-2222-4222-8222-222222222222", origin: "portable_backup_unverified", userText: "Find a quiet cafe.",
      createdAt: "2026-10-10T08:02:00.000Z", capturedAt: "2026-10-10T08:01:00.000Z", captureTimeZone: "Asia/Singapore",
      reply: { summary: "A calm option.", answer: "Consider the garden cafe.", clarifications: ["Check opening hours."], completedAt: "2026-10-10T08:03:00.000Z" },
      accounting: { costUsd: 0, isByok: true, promptTokens: 0 },
    },
    {
      id: "33333333-3333-4333-8333-333333333333", origin: "portable_backup_unverified", userText: "Anything else?",
      createdAt: "2026-10-10T08:04:00.000Z", capturedAt: "2026-10-10T08:04:00.000Z", captureTimeZone: "Asia/Singapore",
      accounting: {},
    },
    {
      id: "44444444-4444-4444-8444-444444444444", origin: "portable_backup_unverified", userText: "What was the reported charge?",
      createdAt: "2026-10-10T08:05:00.000Z", capturedAt: "2026-10-10T08:05:00.000Z", captureTimeZone: "Asia/Singapore",
      accounting: { costUsd: 0.000000001 },
    },
  ],
};

function render(props: Partial<React.ComponentProps<typeof ImportedChatHistoryView>> = {}) {
  act(() => root.render(React.createElement(ImportedChatHistoryView, { conversations: [history], ...props })));
}
function button(label: string) { return [...host.querySelectorAll("button")].find((item) => item.textContent === label); }
async function openHistory() {
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Read imported conversation Trip planning"]')?.click(); });
}

describe("ImportedChatHistoryView", () => {
  it("searches archived conversation titles and message text", () => {
    render({ query: "garden cafe" });
    expect(host.textContent).toContain("Trip planning");
    render({ query: "private unrelated phrase" });
    expect(host.textContent).not.toContain("Trip planning");
    expect(host.textContent).toContain("No imported Chat history matches this search.");
  });

  it("shows ordered inert text and distinguishes reported zero from unavailable usage without action controls", async () => {
    render();
    await openHistory();
    expect(host.textContent).toContain("IMPORTED · UNVERIFIED · READ ONLY");
    expect(host.textContent!.indexOf("Find a quiet cafe.")).toBeLessThan(host.textContent!.indexOf("Anything else?"));
    expect(host.textContent).toContain("US$0.00000000");
    expect(host.textContent).toContain("US$1e-9");
    expect(host.textContent).toContain("Reported cost unavailable");
    expect(host.textContent).toContain("BYOK · provider inference fee is not included in this reported cost");
    expect([...host.querySelectorAll("button")].map((item) => item.textContent).join(" ")).not.toMatch(/approve|send message|check for reply|create action/i);
  });

  it("cancels deletion without mutation and leaves confirmation recoverable after a failed deletion", async () => {
    const onDeleteConversation = vi.fn(async () => false);
    render({ onDeleteConversation });
    await openHistory();
    await act(async () => { button("Delete imported conversation")?.click(); });
    await act(async () => { button("Cancel")?.click(); });
    expect(onDeleteConversation).not.toHaveBeenCalled();
    await act(async () => { button("Delete imported conversation")?.click(); });
    await act(async () => { button("Confirm deletion")?.click(); await Promise.resolve(); });
    expect(host.textContent).toContain("Could not confirm removal. Refresh local data and check this archive before trying again.");
    expect(button("Cancel")).toBeTruthy();
    await act(async () => { button("Cancel")?.click(); });
    expect(button("Delete imported conversation")).toBeTruthy();
  });

  it("singleflights confirmation and only closes after an explicit successful callback", async () => {
    let resolve!: (value: boolean) => void;
    const onDeleteConversation = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    render({ onDeleteConversation });
    await openHistory();
    await act(async () => { button("Delete imported conversation")?.click(); });
    act(() => { button("Confirm deletion")?.click(); button("Confirm deletion")?.click(); });
    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(true); await Promise.resolve(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the review open during the app's own busy period and leaves cancel usable after uncertain failure", async () => {
    let resolve!: (value: boolean) => void;
    const onDeleteConversation = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    render({ onDeleteConversation });
    await openHistory();
    await act(async () => { button("Delete imported conversation")?.click(); });
    act(() => { button("Confirm deletion")?.click(); });
    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
    render({ onDeleteConversation, busy: true });
    expect(button("Deleting…")).toBeTruthy();
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(button("Cancel")?.disabled).toBe(true);
    await act(async () => { resolve(false); await Promise.resolve(); });
    expect(host.textContent).toContain("Could not confirm removal. Refresh local data and check this archive before trying again.");
    expect(button("Cancel")?.disabled).toBe(false);
    await act(async () => { button("Cancel")?.click(); });
    expect(button("Delete imported conversation")).toBeTruthy();
  });

  it("closes on a hard recovery block and ignores a late delete completion", async () => {
    let resolve!: (value: boolean) => void;
    const onDeleteConversation = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    render({ onDeleteConversation });
    await openHistory();
    await act(async () => { button("Delete imported conversation")?.click(); });
    act(() => { button("Confirm deletion")?.click(); });
    render({ onDeleteConversation, blocked: true });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { resolve(true); await Promise.resolve(); });
    expect(host.textContent).not.toContain("It remains");
    render({ onDeleteConversation, blocked: false });
    expect(host.querySelector('[aria-label="Read imported conversation Trip planning"]')).toBeTruthy();
  });
});
