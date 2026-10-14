/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialWorkspaceState } from "../src/services/controller.shared";
import type { ReminderIntent, ReminderRecord } from "../src/reminders";
import { createWorkspaceSnapshotDTO } from "../src/cloud/workspaceDto";
import { deriveReminderAlertDisplay, toReminderDisplayRecord } from "../src/ui/reminderDisplay";
import { RemindersSection } from "../src/ui/RemindersSection";
import { ReminderReview } from "../src/ui/ReminderReview";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const element = (tag: string) => ({ children, style: _style, onPress, accessibilityRole, accessibilityLabel, ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void }) => ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}), ...(accessibilityRole ? { role: accessibilityRole } : {}), ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}) }, children);
  return { Pressable: element("button"), Text: element("span"), View: element("div"), Modal: element("div"), KeyboardAvoidingView: element("div"), ScrollView: element("div"), Platform: { OS: "ios" } };
});
vi.mock("../src/ui/primitives", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement("button", { type: "button", disabled, onClick: onPress }, label),
    Field: ({ label, value }: { label: string; value: string }) => ReactModule.createElement("label", null, label, ReactModule.createElement("input", { value, readOnly: true })),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement("button", { type: "button", onClick: onPress }, label),
  };
});
vi.mock("../src/ui/theme", () => ({ C: { text: "#fff", muted: "#aaa", border: "#333", card: "#222" }, s: new Proxy({}, { get: () => ({}) }) }));

const reminderId = "22222222-2222-4222-8222-222222222222";
const oldIntentId = "33333333-3333-4333-8333-333333333333";
const currentIntentId = "44444444-4444-4444-8444-444444444444";
const installationId = "11111111-1111-4111-8111-111111111111";
const stamp = "2026-10-15T01:00:00.000Z";

function fixture() {
  const state = createInitialWorkspaceState(() => "55555555-5555-4555-8555-555555555555");
  const record: ReminderRecord = {
    id: reminderId, revision: 3, title: "Review the launch plan", body: "Check the local notes.",
    dueAt: "2026-10-16T01:00:00.000Z", displayTimeZone: "Asia/Singapore", privacyMode: "full", origin: { kind: "manual" },
    status: "saved", createdAt: stamp, updatedAt: stamp, firstSavedAt: stamp, approvedRevision: 3,
    approvedPayloadDigest: "a".repeat(64), currentIntentId,
  };
  const intent = (id: string, observed: ReminderIntent["observed"], reminderRevision = 3): ReminderIntent => ({
    id, reminderId, reminderRevision, epoch: id === currentIntentId ? 2 : 1,
    identifier: "private-notification-identifier", payloadDigest: "b".repeat(64),
    payload: { title: record.title, body: record.body, dueAt: record.dueAt, displayTimeZone: record.displayTimeZone, privacyMode: record.privacyMode },
    desired: "scheduled", observed, createdAt: stamp, updatedAt: stamp,
  });
  const previous = intent(oldIntentId, "error");
  const current = intent(currentIntentId, "pending");
  state.reminders.installationId = installationId;
  state.reminders.records.push(record);
  state.reminders.intents.push(previous, current);
  const dto = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: "66666666-6666-4666-8666-666666666666", privacyEpoch: 1, revision: 1 });
  return { record, intents: [previous, current], dto };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("readonly reminder display", () => {
  it("renders an actual safe workspace DTO and sends only the id and expected revision", () => {
    const { record, intents, dto } = fixture();
    const safe = dto.state.reminders.records[0]!;
    expect(safe).not.toHaveProperty("currentIntentId");
    expect(safe).not.toHaveProperty("approvedPayloadDigest");
    expect(dto.state.reminders.intents[0]).not.toHaveProperty("identifier");
    const onOpen = vi.fn();
    const summary = deriveReminderAlertDisplay(record, intents, "device", false);
    expect(summary).toMatchObject({ channel: "device", capability: "available", observed: "pending", canRetry: false });
    act(() => root.render(<RemindersSection
      records={dto.state.reminders.records}
      alertDisplays={{ [safe.id]: summary }}
      query="" busy={false} alertChannel="device" demoMode={false} onAdd={() => undefined}
      onOpen={onOpen} onRetry={() => undefined} onDone={() => undefined} onCancel={() => undefined} onDelete={() => undefined}
    />));
    expect(host.textContent).toContain(record.title);
    expect(host.textContent).toContain("Saved reminder");
    expect(host.textContent).toContain("Device alert request is pending.");
    expect(host.textContent).not.toContain("private-notification-identifier");
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "View reminder")?.click());
    expect(onOpen).toHaveBeenCalledWith(reminderId, 3);

    act(() => root.render(<ReminderReview
      visible record={safe} busy={false} demoMode={false} alertDisplay={summary} onClose={() => undefined}
      onUpdate={async () => undefined} onRefreshSource={async () => undefined} onApprove={async () => undefined}
      onSave={async () => undefined} onRetry={async () => undefined} onDone={async () => undefined} onCancel={async () => undefined}
    />));
    expect(host.textContent).toContain("Review the launch plan");
    expect(host.textContent).toContain("Device alert request is pending.");
    expect(host.textContent).not.toContain("private-notification-identifier");
  });

  it("matches only the exact current intent and never offers a retry without a matching native authority", () => {
    const { record, intents } = fixture();
    const summary = deriveReminderAlertDisplay(record, [...intents].reverse(), "device", false);
    expect(summary.observed).toBe("pending");
    expect(summary.canRetry).toBe(false);
    expect(deriveReminderAlertDisplay({ ...record, currentIntentId: undefined }, intents, "simulated", true).canRetry).toBe(false);
    const missingIntent = deriveReminderAlertDisplay(record, [intents[0]!], "device", false);
    expect(missingIntent.observed).toBeUndefined();
    expect(missingIntent).toMatchObject({ capability: "unknown", canRetry: false });
    const wrongRevision = deriveReminderAlertDisplay(record, [{ ...intents[1]!, reminderRevision: 2 }], "device", false);
    expect(wrongRevision.observed).toBeUndefined();
    expect(wrongRevision).toMatchObject({ capability: "unknown", canRetry: false });
    expect(deriveReminderAlertDisplay({ ...record, currentIntentId: oldIntentId }, intents, "device", false)).toMatchObject({ observed: "error", canRetry: true });
    expect(toReminderDisplayRecord(record)).not.toHaveProperty("currentIntentId");
  });
});
