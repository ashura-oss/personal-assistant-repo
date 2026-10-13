import { Platform } from "react-native";
import type { AppState } from "../core";
import { AppControllerImpl } from "../services/controller";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import type { StateStore } from "../storage/contracts";
import type { NotificationBackend } from "../services/notificationBackend";
import type {
  DeviceCalendarBackend,
  DeviceCalendarDiscoveryResult,
  DeviceCalendarReadResult,
  DeviceCalendarReadWindow,
  DeviceCalendarRow,
  DeviceEventDispatchRecord,
  DeviceEventSnapshot,
} from "../deviceCalendars";
import { createDeviceCalendarRow, validateDeviceEventSnapshot } from "../deviceCalendars";

const CALENDARS = [
  { localId: "6fbe3d4b-06e2-4ac5-8866-9be132142101", nativeId: "sample-personal", title: "Personal", writable: true, zone: "Asia/Singapore" },
  { localId: "6fbe3d4b-06e2-4ac5-8866-9be132142102", nativeId: "sample-work", title: "Work", writable: true, zone: "Asia/Singapore" },
  { localId: "6fbe3d4b-06e2-4ac5-8866-9be132142103", nativeId: "sample-readonly", title: "Read-only", writable: false, zone: "Asia/Singapore" },
] as const;

class MemoryStateStore implements StateStore {
  private value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

function assertPreviewEnabled() {
  if (typeof __DEV__ === "undefined" || !__DEV__ || Platform.OS !== "web" || process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "device-calendars") {
    throw new Error("The device-calendar sample is available only in its isolated development browser preview.");
  }
}

const deniedFetch: typeof fetch = async () => { throw new Error("External requests are disabled in the device-calendar sample."); };
const deniedKey = async (): Promise<string | null> => { throw new Error("Provider keys are disabled in the device-calendar sample."); };
const uuid = (n: number) => `a0be3d4b-06e2-4ac5-8866-9be132142${String(n).padStart(3, "0")}`;
const fingerprint = (n: number) => `${String(n).padStart(2, "0")}`.repeat(32);

function sampleCalendarRows(previous: readonly DeviceCalendarRow[] = []): DeviceCalendarRow[] {
  return CALENDARS.map((calendar, index) => {
    const old = previous.find((row) => row.nativeId === calendar.nativeId);
    return createDeviceCalendarRow({
      localId: old?.localId ?? calendar.localId,
      dto: {
        nativeId: calendar.nativeId,
        title: calendar.title,
        sourceName: "Sample account",
        sourceType: "local",
        timeZone: calendar.zone,
        allowsModifications: calendar.writable,
      },
      fingerprint: fingerprint(index + 1),
      observedAt: new Date().toISOString(),
    });
  });
}

function fixtureEvents(calendarId: string, generation: number, observedAt: string): DeviceEventSnapshot[] {
  const base = Date.now() + 2 * 86_400_000;
  const start = (offset: number) => new Date(base + offset).toISOString();
  const rows = [
    { nativeEventId: "sample-recurring-series", title: "Planning check-in", start: start(0), end: start(30 * 60_000) },
    { nativeEventId: "sample-recurring-series", title: "Planning check-in", start: start(7 * 86_400_000), end: start(7 * 86_400_000 + 30 * 60_000) },
  ];
  const calendarIndex = Math.max(0, CALENDARS.findIndex((calendar) => calendar.localId === calendarId));
  return rows.map((row, index) => validateDeviceEventSnapshot({
    id: uuid(210 + calendarIndex * 2 + index), calendarId, nativeEventId: row.nativeEventId,
    occurrenceStart: row.start, title: row.title, notes: "Fictional recurring sample event.", notesTruncated: false,
    start: row.start, end: row.end, timeZone: "Asia/Singapore", allDay: false, cancelled: false,
    observedAt, generation,
  }));
}

function createMockDeviceCalendarBackend(): DeviceCalendarBackend {
  let connected = false;
  const created = new Map<string, DeviceEventSnapshot>();
  const forceUnknownOutcome = process.env.EXPO_PUBLIC_PREVIEW_DEVICE_EVENT_OUTCOME === "unknown";
  const backend: DeviceCalendarBackend = {
    platform: "mock",
    async getPermission() { return connected ? "full_access" : "undetermined"; },
    async requestFullPermission() { connected = true; return "full_access"; },
    async listCalendars(previous = []) {
      if (!connected) throw new Error("Connect the sample calendars first.");
      return { calendars: sampleCalendarRows(previous), omitted: 0, discoveryTruncated: false } satisfies DeviceCalendarDiscoveryResult;
    },
    async getCalendar(nativeId, previous) {
      const rows = sampleCalendarRows(previous ? [previous] : []);
      const row = rows.find((item) => item.nativeId === nativeId);
      if (!connected || !row) throw new Error("Sample calendar is unavailable.");
      return row;
    },
    async readEvents(calendarLocalId, nativeCalendarId, _window: DeviceCalendarReadWindow, observedAt, generation) {
      if (!connected) throw new Error("Connect the sample calendars first.");
      const sample = sampleCalendarRows().find((item) => item.nativeId === nativeCalendarId);
      if (!sample || sample.localId !== calendarLocalId) throw new Error("Sample calendar changed.");
      const events = fixtureEvents(calendarLocalId, generation, observedAt);
      return { events, scanned: events.length, omitted: 0, duplicateRows: 0, conflicts: 0, partial: false } satisfies DeviceCalendarReadResult;
    },
    async createApprovedEvent(record: DeviceEventDispatchRecord, beforeCreate) {
      if (!connected || beforeCreate() !== true) throw new Error("The sample event changed before creation.");
      const event = validateDeviceEventSnapshot({
        id: uuid(220 + created.size), calendarId: record.target.calendarLocalId,
        nativeEventId: `sample-created-${created.size + 1}`, occurrenceStart: record.payload.start,
        title: record.payload.title, notes: record.payload.notes, notesTruncated: false,
        start: record.payload.start, end: record.payload.end, timeZone: record.payload.timeZone,
        allDay: false, cancelled: false, observedAt: new Date().toISOString(), generation: record.target.generation,
      });
      created.set(record.id, event);
      if (forceUnknownOutcome) return { status: "unknown" };
      return { status: "saved", nativeEventId: event.nativeEventId, event };
    },
    async lookupRecord(record) {
      const event = created.get(record.id);
      const nativeIdMatches = Boolean(event && record.nativeEventId && record.nativeEventId === event.nativeEventId &&
        record.target.calendarLocalId === event.calendarId && record.payload.start === event.occurrenceStart);
      return { candidates: event ? [event] : [], partial: false, identity: nativeIdMatches ? "native_id_match" : "unverified" };
    },
  };
  return backend;
}

const mockNotifications: NotificationBackend = {
  platform: "mock",
  async getPermission() { return "unavailable"; },
  async requestPermission() { return "unavailable"; },
  async listPending() { return []; },
  async schedule() { throw new Error("Notifications are disabled in the device-calendar sample."); },
  async cancel() {},
  async cancelLegacy() {},
  async installForegroundHandler() {},
};

/** Fictional in-memory device-calendar workflow. All external providers and real native calls are closed. */
export async function createDeviceCalendarPreview() {
  assertPreviewEnabled();
  const store = new MemoryStateStore();
  const controller = new AppControllerImpl(store, {
    speech: new AzureSpeechClient({ fetcher: deniedFetch, readKey: deniedKey }),
    openAi: new AzureOpenAIClient(deniedFetch, deniedKey),
  }, {
    writeDocument: async () => undefined,
    deviceCalendarBackend: createMockDeviceCalendarBackend(),
    reminderBackend: mockNotifications,
  });
  await controller.load();
  await controller.saveSettings({ mode: "preview", timezone: "Asia/Singapore" });
  const note = await controller.saveNote({
    transcript: "Schedule a meeting with Morgan on November 3, 2026 from 10:00 AM to 10:30 AM to review the launch timeline.",
    capturedAt: new Date().toISOString(),
    captureTimeZone: "Asia/Singapore",
  });
  const proposals = await controller.processNote(note.id);
  const eventDraft = proposals.find((proposal) => proposal.kind === "event");
  if (!eventDraft) throw new Error("Could not prepare the fictional sample calendar suggestion.");
  await controller.editProposal(eventDraft.id, {
    title: "Review the launch timeline with Morgan",
    body: "Review the launch timeline and confirm the next milestones.",
    dueAt: "2026-11-03T02:00:00.000Z",
    event: {
      title: "Review the launch timeline with Morgan",
      description: "Review the launch timeline and confirm the next milestones.",
      start: "2026-11-03T02:00:00.000Z",
      end: "2026-11-03T02:30:00.000Z",
      timeZone: "Asia/Singapore",
      attendees: ["morgan@example.invalid"],
      invitePolicy: "send",
    },
  });
  return controller;
}
