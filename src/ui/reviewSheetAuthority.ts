import type { Account, Proposal } from "../core";
import type { DispatchRecord } from "../dispatch";
import type { DeviceEventDispatchRecord } from "../deviceCalendars/types";

export function projectDeviceEventReconciliationDisplayFacts(records: DeviceEventDispatchRecord["reconciliations"]) {
  return records.map(({ disposition, at, note, nativeEventId }) => ({
    disposition,
    at,
    note,
    nativeReferenceRecorded: Boolean(nativeEventId),
  }));
}

export function resolveLinkedDispatchRecord(proposal: Proposal | null | undefined, records: readonly DispatchRecord[]) {
  if (!proposal?.dispatchRecordId) return undefined;
  return records.find((record) => record.id === proposal.dispatchRecordId && record.proposalId === proposal.id);
}

export function resolveLinkedDeviceEventRecord(proposal: Proposal | null | undefined, records: readonly DeviceEventDispatchRecord[]) {
  if (!proposal?.deviceEventDispatchRecordId) return undefined;
  return records.find((record) => record.id === proposal.deviceEventDispatchRecordId && record.proposalId === proposal.id);
}

export function resolveReviewReplyAllowedOperations(proposal: Proposal | null | undefined, accounts: readonly Account[]) {
  const provenance = proposal?.provenance;
  if (!provenance || !("kind" in provenance) || provenance.kind !== "mail_reply") return [] as const;
  const frozen = provenance.source;
  const account = accounts.find((candidate) => {
    const identity = candidate.identity;
    if (!identity) return false;
    return candidate.id === frozen.accountId && candidate.email === frozen.accountEmail && candidate.connected &&
      candidate.authStatus === "connected" && candidate.connectionGeneration === frozen.connectionGeneration &&
      identity.providerNamespace === frozen.identity.providerNamespace && identity.clientId === frozen.identity.clientId &&
      identity.subject === frozen.identity.subject && identity.issuer === frozen.identity.issuer && identity.tenantId === frozen.identity.tenantId &&
      identity.resourceUserId === frozen.identity.resourceUserId;
  });
  if (!account) return [] as const;
  return [
    ...(account.capabilities?.includes("mail.draft") ? ["draft" as const] : []),
    ...(account.capabilities?.includes("mail.send") ? ["send" as const] : []),
  ];
}
