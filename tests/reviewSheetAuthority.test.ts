import { describe, expect, it } from "vitest";
import type { Account, MailReplyProvenance, Proposal } from "../src/core";
import type { DispatchRecord } from "../src/dispatch";
import type { DeviceEventDispatchRecord } from "../src/deviceCalendars/types";
import { projectDeviceEventReconciliationDisplayFacts, resolveLinkedDispatchRecord, resolveLinkedDeviceEventRecord, resolveReviewReplyAllowedOperations } from "../src/ui/reviewSheetAuthority";

const proposalId = "11111111-1111-4111-8111-111111111111";
const linkedId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const sourceProvenance = { version: 1 as const, assistContractVersion: "v1", analysisFingerprint: "b".repeat(64), noteId: proposalId, noteRevision: 1,
  capturedAt: "2026-10-15T00:00:00.000Z", captureTimeZone: "UTC", intent: "assist" as const, sources: [], policySources: [], settingsFingerprint: "c".repeat(64) };

function receipt(id: string, owner = proposalId): DispatchRecord {
  return {
    version: 1, id, proposalId: owner, approvedRevision: 1, payloadDigest: "a".repeat(64), sourceActionKey: "source-action", duplicateKey: "duplicate",
    sourceProvenance,
    operation: "send", accountId: "account", account: { provider: "google", identity: { providerNamespace: "google", clientId: "client", subject: "subject" }, displayName: "Owner", email: "owner@example.test" },
    title: id, body: "Body", payload: { kind: "email", email: { to: [], cc: [], bcc: [], subject: id, text: "Body", attachments: [] } },
    dispatchStartedAt: "2026-10-15T00:00:00.000Z", outcome: "unknown", reconciliations: [],
  };
}

function deviceReceipt(id: string): DeviceEventDispatchRecord {
  return { version: 1, id, proposalId, revision: 2, sourceProvenance, sourceActionKey: "device-action", duplicateKey: "device-duplicate", payloadDigest: "e".repeat(64),
    target: { installationId: "installation", generation: 1, selectionRevision: 1, calendarLocalId: "calendar", nativeId: "native-calendar", fingerprint: "f".repeat(64), title: "Personal", sourceLabel: "iPhone" },
    payload: { title: id, notes: "Body", start: "2026-10-16T10:00:00.000Z", end: "2026-10-16T11:00:00.000Z", timeZone: "UTC", allDay: false, attendees: [], invitePolicy: "none", alarms: [] },
    claimAt: "2026-10-15T00:00:00.000Z", outcome: "unknown", reconciliations: [] };
}

describe("ReviewSheet parent authority selections", () => {
  it("keeps native reference facts attached only to the reconciliation that recorded them", () => {
    expect(projectDeviceEventReconciliationDisplayFacts([
      { id: "one", disposition: "confirmed_present", at: "2026-10-15T01:00:00.000Z", note: "First check", nativeEventId: "private-native-event" },
      { id: "two", disposition: "not_found", at: "2026-10-15T02:00:00.000Z", note: "Second check" },
    ])).toEqual([
      { disposition: "confirmed_present", at: "2026-10-15T01:00:00.000Z", note: "First check", nativeReferenceRecorded: true },
      { disposition: "not_found", at: "2026-10-15T02:00:00.000Z", note: "Second check", nativeReferenceRecorded: false },
    ]);
  });

  it("selects only the proposal's exact linked receipt when histories are reordered and treats a missing link as incomplete", () => {
    const first = receipt(otherId);
    const current = receipt(linkedId);
    const proposal: Proposal = { id: proposalId, kind: "email", title: "Reply", body: "Body", status: "unknown", revision: 2, recipients: [], evidence: [], dispatchRecordId: linkedId };
    expect(resolveLinkedDispatchRecord(proposal, [first, current])).toBe(current);
    expect(resolveLinkedDispatchRecord({ ...proposal, dispatchRecordId: undefined }, [current, first])).toBeUndefined();
    expect(resolveLinkedDispatchRecord({ ...proposal, dispatchRecordId: otherId }, [current, receipt(otherId, otherId)])).toBeUndefined();
  });

  it("selects a device receipt only by its exact private link", () => {
    const proposal: Proposal = { id: proposalId, kind: "event", title: "Meeting", body: "", status: "unknown", revision: 2, recipients: [], evidence: [], deviceEventDispatchRecordId: linkedId };
    const record = deviceReceipt(linkedId);
    const reordered = [deviceReceipt(otherId), record];
    expect(resolveLinkedDeviceEventRecord(proposal, reordered)).toBe(record);
    expect(resolveLinkedDeviceEventRecord({ ...proposal, deviceEventDispatchRecordId: undefined }, reordered)).toBeUndefined();
  });

  it("requires exact frozen account identity and generation before allowing reply operations", () => {
    const provenance: MailReplyProvenance = { version: 2, kind: "mail_reply", sourceDigest: "d".repeat(64), expiresAt: "2099-10-15T00:00:00.000Z",
      source: { version: 1, accountId: "account-1", accountEmail: "owner@example.test", identity: { providerNamespace: "google", clientId: "client", subject: "subject" },
        connectionGeneration: 4, localMessageId: "local", providerMessageId: "provider", idFormat: "gmail", internetMessageId: "<message@example.test>",
        subject: "Subject", replyMetadataComplete: true, observedAt: "2026-10-15T00:00:00.000Z", sourceDigest: "d".repeat(64) } };
    const proposal: Proposal = { id: proposalId, kind: "email", title: "Reply", body: "Body", status: "approved", revision: 1, recipients: [], evidence: [], provenance,
      email: { operation: "send", to: ["recipient@example.test"], cc: [], bcc: [], subject: "Subject", text: "Body", attachments: [] } };
    const account: Account = { id: "account-1", provider: "google", displayName: "Owner", email: "owner@example.test", connected: true, authStatus: "connected",
      connectionGeneration: 4, identity: { providerNamespace: "google", clientId: "client", subject: "subject" }, capabilities: ["mail.draft", "mail.send"] };
    expect(resolveReviewReplyAllowedOperations(proposal, [account])).toEqual(["draft", "send"]);
    expect(resolveReviewReplyAllowedOperations(proposal, [{ ...account, connectionGeneration: 5 }])).toEqual([]);
    expect(resolveReviewReplyAllowedOperations(proposal, [{ ...account, identity: { providerNamespace: "google", clientId: "client", subject: "different" } }])).toEqual([]);
    expect(resolveReviewReplyAllowedOperations(proposal, [{ ...account, email: "different@example.test" }])).toEqual([]);
  });
});
