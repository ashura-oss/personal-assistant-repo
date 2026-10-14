import type { WorkspaceSnapshotDTO, WorkspaceReminderRecordOrigin } from "../cloud/workspaceDto";
import type { ReminderIntent, ReminderRecord } from "../reminders";
import type { ProactiveCandidate, ProactiveSource } from "../proactive";

export type ReminderDisplayRecord = WorkspaceSnapshotDTO["state"]["reminders"]["records"][number];
export type ReminderIntentDisplay = WorkspaceSnapshotDTO["state"]["reminders"]["intents"][number];

export type ReminderAlertChannel = "device" | "browser_unavailable" | "simulated";
export type ReminderAlertDisplay = Readonly<{
  channel: ReminderAlertChannel;
  capability: "available" | "unavailable" | "unknown" | "simulated";
  observed?: ReminderIntent["observed"];
  status?: string;
  sectionStatus?: string;
  canRetry: boolean;
}>;

function displayCandidate(value: ProactiveCandidate): ProactiveCandidate {
  return {
    id: value.id, suppressionKey: value.suppressionKey, ruleId: value.ruleId, ruleRevision: value.ruleRevision,
    sourceId: value.sourceId, sourceVersion: value.sourceVersion, sourceKind: value.sourceKind, namespace: value.namespace,
    ...(value.accountId ? { accountId: value.accountId } : {}), providerId: value.providerId, eligibleAt: value.eligibleAt,
    reasonCode: value.reasonCode, quote: value.quote, quoteField: value.quoteField,
  };
}

function displaySource(value: ProactiveSource): ProactiveSource {
  const base = { sourceId: value.sourceId, namespace: value.namespace, ...(value.accountId ? { accountId: value.accountId } : {}),
    providerId: value.providerId, sourceVersion: value.sourceVersion, availability: value.availability, freshness: value.freshness };
  if (value.kind === "mail") return { ...base, kind: "mail", ...(value.senderEmail ? { senderEmail: value.senderEmail } : {}),
    ...(value.isRead !== undefined ? { isRead: value.isRead } : {}), ...(value.subject ? { subject: value.subject } : {}),
    ...(value.snippet ? { snippet: value.snippet } : {}), ...(value.receivedAt ? { receivedAt: value.receivedAt } : {}),
    ...(value.receivedAtUtcCertified !== undefined ? { receivedAtUtcCertified: value.receivedAtUtcCertified } : {}) };
  if (value.kind === "task") return { ...base, kind: "task", ...(value.title ? { title: value.title } : {}),
    ...(value.status ? { status: value.status } : {}), ...(value.dueAt ? { dueAt: value.dueAt } : {}),
    ...(value.dueAtUtcCertified !== undefined ? { dueAtUtcCertified: value.dueAtUtcCertified } : {}) };
  return { ...base, kind: "meeting", ...(value.subject ? { subject: value.subject } : {}),
    ...(value.startAt ? { startAt: value.startAt } : {}), ...(value.startAtUtcCertified !== undefined ? { startAtUtcCertified: value.startAtUtcCertified } : {}) };
}

function displayOrigin(record: ReminderRecord): WorkspaceReminderRecordOrigin {
  if (record.origin.kind === "manual") return { kind: "manual" };
  if (record.origin.kind === "note") return { kind: "note", noteId: record.origin.noteId, proposalId: record.origin.proposalId,
    proposalRevision: record.origin.proposalRevision, sourceRevision: record.origin.sourceRevision,
    sourceVersion: record.origin.sourceVersion, quote: record.origin.quote };
  return { kind: "proactive", candidate: displayCandidate(record.origin.candidate),
    rule: { id: record.origin.rule.id, revision: record.origin.rule.revision, version: record.origin.rule.version, name: record.origin.rule.name },
    source: displaySource(record.origin.source), capturedAt: record.origin.capturedAt, expiresAt: record.origin.expiresAt };
}

export function toReminderDisplayRecord(record: ReminderRecord): ReminderDisplayRecord {
  return { id: record.id, revision: record.revision, title: record.title, body: record.body, dueAt: record.dueAt,
    displayTimeZone: record.displayTimeZone, privacyMode: record.privacyMode, origin: displayOrigin(record), status: record.status,
    createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.firstSavedAt ? { firstSavedAt: record.firstSavedAt } : {}),
    ...(record.approvedRevision !== undefined ? { approvedRevision: record.approvedRevision } : {}) };
}

export function deriveReminderAlertDisplay(
  record: ReminderRecord,
  intents: readonly ReminderIntent[],
  channel: ReminderAlertChannel,
  demoMode: boolean,
): ReminderAlertDisplay {
  const current = record.currentIntentId
    ? intents.find((item) => item.id === record.currentIntentId && item.reminderId === record.id && item.reminderRevision === record.revision)
    : undefined;
  const capability = channel === "browser_unavailable" ? "unavailable" : channel === "simulated" ? "simulated"
    : current?.observed === "blocked" || current?.observed === "unavailable" ? "unavailable"
      : current?.observed === "pending" ? "available" : "unknown";
  const cancellations = intents.filter((item) => item.reminderId === record.id && item.desired === "cancelled");
  if (demoMode && channel === "simulated" && record.status === "saved") return {
    channel, capability, ...(current ? { observed: current.observed } : {}),
    status: current?.observed === "pending" ? "A sample alert is simulated." : "The sample alert is not scheduled.",
    sectionStatus: current?.observed === "pending" ? "Sample alert · simulated" : "Sample alert · not scheduled",
    canRetry: Boolean(current && (demoMode || ["absent", "blocked", "unavailable", "delivery_unknown", "error"].includes(current.observed))),
  };
  if (record.status !== "saved") {
    const status = cancellations.length
      ? cancellations.every((item) => item.observed === "absent") ? "Alert cancellation confirmed."
        : cancellations.some((item) => item.observed === "error" || item.observed === "unavailable") ? "Alert cancellation could not be confirmed."
          : "Alert cancellation is still being checked."
      : undefined;
    return { channel, capability, ...(status ? { status, sectionStatus: status } : {}), canRetry: false };
  }
  const status = channel === "browser_unavailable" ? "Browser notifications are unavailable."
    : !current ? "Alert status could not be confirmed."
      : current.observed === "pending" ? "Device alert request is pending."
        : current.observed === "blocked" || current.observed === "unavailable" ? "Device alerts are unavailable; the reminder remains saved."
          : current.observed === "error" ? "The device alert could not be scheduled."
            : current.observed === "delivery_unknown" ? "Alert outcome needs checking."
              : "Alert status could not be confirmed.";
  const retryable = current && ["absent", "blocked", "unavailable", "delivery_unknown", "error"].includes(current.observed);
  const sectionStatus = channel === "browser_unavailable" ? "Device alerts are unavailable in the browser."
    : current?.observed === "blocked" || current?.observed === "unavailable" ? "Device alerts are unavailable. The reminder is still saved here."
      : current?.observed === "error" ? "The alert could not be scheduled."
        : status;
  return { channel, capability, ...(current ? { observed: current.observed } : {}), status, sectionStatus,
    canRetry: channel === "device" && record.status === "saved" && Boolean(retryable) };
}
