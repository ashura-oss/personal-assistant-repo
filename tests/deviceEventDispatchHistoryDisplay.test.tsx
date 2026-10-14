/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSnapshotDTO } from "../src/cloud/workspaceDto";
import type { DeviceEventDispatchRecord } from "../src/deviceCalendars/types";
import { createInitialWorkspaceState } from "../src/services/controller.shared";
import { DeviceEventDispatchHistory } from "../src/ui/DeviceEventDispatchHistory";
import { projectDeviceEventReconciliationDisplayFacts } from "../src/ui/reviewSheetAuthority";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const element = (tag: string) => ({ children, style: _style, onPress, disabled, ...props }: Record<string, unknown> & { children?: React.ReactNode; style?: unknown; onPress?: () => void; disabled?: boolean }) =>
    ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}), ...(disabled ? { disabled: true } : {}) }, children);
  return { Pressable: element("button"), Text: element("span"), TextInput: element("input"), View: element("div") };
});
vi.mock("../src/ui/primitives", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement("button", { type: "button", disabled, onClick: onPress }, label),
    Field: () => ReactModule.createElement("input"),
  };
});
vi.mock("../src/ui/theme", () => ({ C: { card: "#000", border: "#111", text: "#fff", muted: "#aaa", red: "#f00" }, s: new Proxy({}, { get: () => ({}) }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("device event immutable history display", () => {
  it("renders an actual safe DTO receipt without native actions or private references", () => {
    const state = createInitialWorkspaceState(() => "11111111-1111-4111-8111-111111111111");
    state.deviceCalendars.dispatchRecords.push({
      version: 1, id: "22222222-2222-4222-8222-222222222222", proposalId: "33333333-3333-4333-8333-333333333333", revision: 4,
      sourceProvenance: { version: 1, assistContractVersion: "v1", analysisFingerprint: "a".repeat(64), noteId: "44444444-4444-4444-8444-444444444444", noteRevision: 2,
        capturedAt: "2026-10-14T08:00:00.000Z", captureTimeZone: "Asia/Singapore", intent: "assist", sources: [], policySources: [], settingsFingerprint: "b".repeat(64) },
      sourceActionKey: "private-action", duplicateKey: "private-duplicate", payloadDigest: "c".repeat(64),
      target: { installationId: "private-installation", generation: 9, selectionRevision: 5, calendarLocalId: "private-calendar-row", nativeId: "private-native-calendar", fingerprint: "private-fingerprint", title: "Personal", sourceLabel: "On iPhone" },
      payload: { title: "Approved event", notes: "Frozen approved notes", start: "2026-10-16T02:00:00.000Z", end: "2026-10-16T03:00:00.000Z", timeZone: "UTC", allDay: false, attendees: [], invitePolicy: "none", alarms: [] },
      claimAt: "2026-10-15T02:00:00.000Z", outcome: "unknown", reconciliations: [
        { id: "one", disposition: "confirmed_present", at: "2026-10-15T03:00:00.000Z", note: "First check", nativeEventId: "private-native-event" },
        { id: "two", disposition: "not_found", at: "2026-10-15T04:00:00.000Z", note: "Second check" },
      ],
    } satisfies DeviceEventDispatchRecord);
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: "55555555-5555-4555-8555-555555555555", privacyEpoch: 1, revision: 1 });
    const record = { ...snapshot.state.deviceCalendars.dispatchHistory[0]!, targetLabel: "Personal · On iPhone",
      reconciliations: projectDeviceEventReconciliationDisplayFacts(state.deviceCalendars.dispatchRecords[0]!.reconciliations) };
    act(() => root.render(React.createElement(DeviceEventDispatchHistory, { record, busy: false })));

    expect(host.textContent).toContain("Approved event");
    expect(host.textContent).toContain("Frozen approved notes");
    expect(host.textContent).toContain("Outcome unknown");
    expect(host.textContent).toContain("Calendar check actions are unavailable here.");
    expect(host.textContent?.match(/Native event reference recorded/g)).toHaveLength(1);
    expect(host.textContent).toContain("Second check");
    expect(host.textContent).not.toContain("private-installation");
    expect(host.textContent).not.toContain("private-native-calendar");
    expect(host.textContent).not.toContain("private-action");
    const check = [...host.querySelectorAll("button")].find((button) => button.textContent === "Check this iPhone calendar");
    expect(check?.disabled).toBe(true);
  });
});
