import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { MailReplyBatchContextReviewItem, MailReplyBatchSourcesRefreshResult } from "../core";
import type { DispatchReconciliation } from "../dispatch";
import type { DeviceEventReconciliation } from "../deviceCalendars/types";
import type { WorkspaceSnapshotDTO } from "../cloud/workspaceDto";
import { resolveReminderLocalDateTime } from "../reminders/time";
import { DispatchHistory } from "./DispatchHistory";
import { DeviceEventDispatchHistory, type DeviceEventHistoryDisplay } from "./DeviceEventDispatchHistory";
import { Button, Field, IconButton } from "./primitives";
import { s } from "./theme";

export type ReviewProposalDisplay = WorkspaceSnapshotDTO["state"]["proposals"][number];
export type ReviewDispatchDisplay = WorkspaceSnapshotDTO["state"]["dispatchRecords"][number];
export type ReviewDeviceEventDisplay = DeviceEventHistoryDisplay;
type EmailOperation = "draft" | "send";
export type ReviewEditCommand = Readonly<{
  title?: string;
  body?: string;
  accountId?: string;
  recipients?: readonly string[];
  calendarId?: string;
  eventDestination?: EventProposalDisplayDestination;
  dueAt?: string;
  email?: ReviewProposalDisplay["email"];
  event?: ReviewProposalDisplay["event"];
}>;
type EventProposalDisplayDestination = ReviewProposalDisplay["eventDestination"];
type ReviewAccountChoice = Readonly<{
  id: string;
  provider: "google" | "microsoft" | "local";
  displayName: string;
  email: string;
  connected: boolean;
  allowedEmailOperations: readonly EmailOperation[];
}>;
type ReviewCalendarChoice = Readonly<{
  id: string;
  accountId: string;
  name: string;
  accountEmail: string;
  writable: boolean;
  unavailableReason?: string;
}>;
type ReviewDeviceCalendarChoice = Readonly<{
  localId: string;
  title: string;
  sourceName?: string;
  allowsModifications: boolean;
  selected: boolean;
}>;
type ReviewSheetProps = {
  settingsMode: "preview" | "provider";
  accounts: readonly ReviewAccountChoice[];
  calendars: readonly ReviewCalendarChoice[];
  deviceCalendars: Readonly<{
    enabled: boolean;
    selectedCalendarIds: readonly string[];
    choices: readonly ReviewDeviceCalendarChoice[];
    accessStatus: "needs_check" | "full_access" | "write_only" | "denied" | "undetermined" | "unavailable";
    writeAvailable: boolean;
    unavailableReason?: string;
  }>;
  proposal: ReviewProposalDisplay | null;
  dispatchRecords: readonly ReviewDispatchDisplay[];
  currentDispatchRecord?: ReviewDispatchDisplay;
  deviceEventDispatchRecords?: readonly ReviewDeviceEventDisplay[];
  currentDeviceEventDispatchRecord?: ReviewDeviceEventDisplay;
  replyAllowedOperations?: readonly EmailOperation[];
  busy?: boolean;
  demoMode?: boolean;
  onClose: () => void;
  onEdit: (command: ReviewEditCommand) => void;
  onApprove: () => void;
  onExecute: () => void;
  onDismiss: () => void;
  onReconcile?: (
    recordId: string,
    input: {
      disposition: DispatchReconciliation;
      note: string;
      remoteId?: string;
    },
  ) => Promise<unknown>;
  onInspectDeviceEvent?: (recordId: string) => Promise<Readonly<{ lookup: Readonly<{ candidates: readonly Readonly<{ title: string; start: string; timeZone?: string }> []; partial: boolean; identity: "unverified" | "native_id_match" }> }>>;
  onReconcileDeviceEvent?: (recordId: string, input: { disposition: DeviceEventReconciliation; note: string }) => Promise<unknown>;
  sourceStale?: boolean;
  sourceChecking?: boolean;
  sourceCheckError?: string;
  sourceCheckReason?: string;
  onRetrySourceCheck?: () => void;
  onReassist?: () => void;
  mailReplyContextCount?: number;
  mailReplySourcesStatus?: { readonly status: 'missing' | 'refresh_required' | 'current' | 'invalid'; readonly expiresAt?: string };
  onRefreshMailReplySources?: (jobId: string, proposalId: string, proposalRevision: number, isCurrent: () => boolean) => Promise<MailReplyBatchSourcesRefreshResult | undefined>;
};
export function ReviewSheet(props: ReviewSheetProps) {
  if (!props.proposal) return null;
  if (props.proposal.dispatchRecoveryRetired === true) {
    return (
      <RetiredProposalReview
        proposal={props.proposal}
        dispatchRecords={props.dispatchRecords}
        onClose={props.onClose}
      />
    );
  }
  return (
    <ReviewSheetContent
      key={`${props.proposal.id}:${props.proposal.revision}`}
      {...props}
      proposal={props.proposal}
    />
  );
}
function RetiredProposalReview({ proposal, dispatchRecords, onClose }: {
  proposal: ReviewProposalDisplay;
  dispatchRecords: readonly ReviewDispatchDisplay[];
  onClose: () => void;
}) {
  const records = dispatchRecords.filter((record) => record.proposalId === proposal.id);
  return (
    <ScrollView style={s.sheetBody} contentContainerStyle={s.sheetContent} showsVerticalScrollIndicator={false}>
      <View style={s.sheetTop}>
        <Text style={s.kicker}>RETIRED ACTION · READ ONLY</Text>
        <IconButton name="close" label="Close review" onPress={onClose} />
      </View>
      <Text style={s.h1Small}>{proposal.title}</Text>
      <Text style={s.label}>{proposal.kind.toUpperCase()} · ORIGINAL STATUS {proposal.status.toUpperCase()}</Text>
      <Text style={s.disclaimer}>This existing remote proposal was retired with damaged action history and is permanently read-only. Its original status and receipts are preserved.</Text>
      {proposal.email ? (
        <View style={s.analysisBlock}>
          <Text style={s.analysisSource}>To · {proposal.email.to.join(", ") || "None"}</Text>
          {proposal.email.cc.length ? <Text style={s.analysisSource}>Cc · {proposal.email.cc.join(", ")}</Text> : null}
          {proposal.email.bcc.length ? <Text style={s.analysisSource}>Bcc · {proposal.email.bcc.join(", ")}</Text> : null}
          <Text style={s.analysisSource}>Subject · {proposal.email.subject}</Text>
          <Text selectable style={s.analysisText}>Message · {proposal.email.text}</Text>
        </View>
      ) : null}
      {proposal.event ? (
        <View style={s.analysisBlock}>
          <Text style={s.analysisSource}>Event · {proposal.event.title}</Text>
          <Text style={s.analysisSource}>{proposal.event.start} – {proposal.event.end} · {proposal.event.timeZone}</Text>
          <Text style={s.analysisSource}>Invitation policy · {proposal.event.invitePolicy === "send" ? "send with event" : "no invitations"}</Text>
        </View>
      ) : null}
      {records.length ? <DispatchHistory records={records} incomplete={proposal.dispatchHistoryIncomplete} title="Preserved receipts" /> : null}
      <Button label="Close review" tone="quiet" onPress={onClose} />
    </ScrollView>
  );
}

function ReviewSheetContent({
  settingsMode,
  accounts,
  calendars: allCalendars,
  deviceCalendars,
  proposal,
  dispatchRecords,
  deviceEventDispatchRecords = [],
  currentDispatchRecord,
  currentDeviceEventDispatchRecord,
  replyAllowedOperations = [],
  busy = false,
  demoMode = false,
  onClose,
  onEdit,
  onApprove,
  onExecute,
  onDismiss,
  onReconcile,
  onInspectDeviceEvent,
  onReconcileDeviceEvent,
  sourceStale = false,
  sourceChecking = false,
  sourceCheckError,
  sourceCheckReason,
  onRetrySourceCheck,
  onReassist,
  mailReplyContextCount = 0,
  mailReplySourcesStatus,
  onRefreshMailReplySources,
}: Omit<ReviewSheetProps, "proposal"> & { proposal: ReviewProposalDisplay }) {
  const previewMode = demoMode || settingsMode === "preview";
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
  const [recipients] = useState(proposal.recipients.join(", "));
  const [accountId, setAccountId] = useState(proposal.accountId ?? "");
  const [calendarId, setCalendarId] = useState(proposal.calendarId ?? "");
  const [dueDate, setDueDate] = useState(localDateTime(proposal.dueAt).date);
  const [dueTime, setDueTime] = useState(localDateTime(proposal.dueAt).time);
  const [emailTo, setEmailTo] = useState(
    proposal.email?.to.join(", ") ?? proposal.recipients.join(", "),
  );
  const [emailCc, setEmailCc] = useState(proposal.email?.cc.join(", ") ?? "");
  const [emailBcc, setEmailBcc] = useState(
    proposal.email?.bcc.join(", ") ?? "",
  );
  const [emailSubject, setEmailSubject] = useState(
    proposal.email?.subject ?? proposal.title,
  );
  const [emailText, setEmailText] = useState(
    proposal.email?.text ?? proposal.body,
  );
  const [refreshedMailSources, setRefreshedMailSources] = useState<readonly MailReplyBatchContextReviewItem[]>([]);
  const [refreshingMailSources, setRefreshingMailSources] = useState(false);
  const [mailSourcesNotice, setMailSourcesNotice] = useState("");
  const mailSourcesActionLock = React.useRef(false);
  const mailSourcesMounted = React.useRef(true);
  const mailSourcesOwner = React.useRef({ proposalId: proposal.id, revision: proposal.revision, busy });
  React.useLayoutEffect(() => {
    mailSourcesOwner.current = { proposalId: proposal.id, revision: proposal.revision, busy };
  }, [busy, proposal.id, proposal.revision]);
  React.useEffect(() => {
    mailSourcesMounted.current = true;
    return () => { mailSourcesMounted.current = false; };
  }, []);
  const [emailOperation, setEmailOperation] = useState<"draft" | "send">(
    proposal.email?.operation ?? "draft",
  );
  const initialEventTimeZone = proposal.event?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initialEventTime = proposal.event
    ? localDateTimeInZone(proposal.event.start, initialEventTimeZone)
    : localDateTime(proposal.dueAt);
  const initialEventEnd = proposal.event
    ? localDateTimeInZone(proposal.event.end, initialEventTimeZone)
    : localDateTime(proposal.dueAt ? new Date(Date.parse(proposal.dueAt) + 3600000).toISOString() : undefined);
  const [eventStartDate, setEventStartDate] = useState(initialEventTime.date);
  const [eventStartTime, setEventStartTime] = useState(initialEventTime.time);
  const [eventEndDate, setEventEndDate] = useState(initialEventEnd.date);
  const [eventEndTime, setEventEndTime] = useState(initialEventEnd.time);
  const [eventTimeZone, setEventTimeZone] = useState(initialEventTimeZone);
  const [startFoldChoice, setStartFoldChoice] = useState<0 | 1 | undefined>();
  const [endFoldChoice, setEndFoldChoice] = useState<0 | 1 | undefined>();
  const initialDestination = proposal.eventDestination ?? (proposal.accountId && proposal.calendarId
    ? { kind: "remote_calendar" as const, accountId: proposal.accountId, calendarId: proposal.calendarId }
    : undefined);
  const [eventDestination, setEventDestination] = useState<EventProposalDisplayDestination>(initialDestination);
  const [eventAttendees, setEventAttendees] = useState(
    proposal.event?.attendees.join(", ") ?? "",
  );
  const [invitePolicy, setInvitePolicy] = useState(
    proposal.event?.invitePolicy ?? "send",
  );
  const mailReply =
    proposal.provenance &&
    "kind" in proposal.provenance &&
    proposal.provenance.kind === "mail_reply"
      ? proposal.provenance
      : null;
  const immutableBatchReply = mailReply?.version === 2 && Boolean(mailReply.batchJobId?.trim());
  const frozenReplySource = mailReply?.source;
  const refreshMailReplySources = async () => {
    const jobId = mailReply?.batchJobId;
    if (!immutableBatchReply || !jobId || !onRefreshMailReplySources || mailSourcesActionLock.current || busy) return;
    const proposalId = proposal.id;
    const proposalRevision = proposal.revision;
    mailSourcesActionLock.current = true;
    setRefreshingMailSources(true);
    setMailSourcesNotice("");
    const isCurrent = () => mailSourcesMounted.current && mailSourcesOwner.current.proposalId === proposalId &&
      mailSourcesOwner.current.revision === proposalRevision && (!mailSourcesOwner.current.busy || mailSourcesActionLock.current);
    try {
      const refreshed = await onRefreshMailReplySources(jobId, proposalId, proposalRevision, isCurrent);
      if (isCurrent() && refreshed?.jobId === jobId && refreshed.status === 'current') {
        setRefreshedMailSources(refreshed.sources);
        setMailSourcesNotice('The fixed target and selected messages were checked again. Review the saved proposal before approving it.');
      }
    } catch {
      if (isCurrent()) setMailSourcesNotice('Selected sources could not be refreshed. This proposal remains read-only until its source can be checked.');
    } finally {
      if (isCurrent()) setRefreshingMailSources(false);
      mailSourcesActionLock.current = false;
    }
  };
  const effectiveEmailOperation = immutableBatchReply
    ? proposal.email?.operation === "send" ? "send" : "draft"
    : mailReply ? "draft" : emailOperation;
  const parsedDate =
    dueDate && dueTime ? new Date(`${dueDate}T${dueTime}`) : null;
  const dateValue =
    parsedDate && Number.isFinite(parsedDate.getTime())
      ? parsedDate.toISOString()
      : undefined;
  const localDue = localDateTime(proposal.dueAt);
  const scheduleInputInvalid = Boolean(dueDate) !== Boolean(dueTime);
  const emailPayload = {
    operation: effectiveEmailOperation,
    to: parseCsv(emailTo),
    cc: parseCsv(emailCc),
    bcc: parseCsv(emailBcc),
    subject: emailSubject,
    text: emailText,
    attachments: proposal.email?.attachments ?? [],
    ...(proposal.email?.reply ? { reply: proposal.email.reply } : {}),
  };
  const startResolutions = resolveReminderLocalDateTime(`${eventStartDate}T${eventStartTime}`, eventTimeZone);
  const endResolutions = resolveReminderLocalDateTime(`${eventEndDate}T${eventEndTime}`, eventTimeZone);
  const eventStartChanged = !proposal.event || (
    eventStartDate !== localDateTimeInZone(proposal.event!.start, proposal.event!.timeZone).date ||
    eventStartTime !== localDateTimeInZone(proposal.event!.start, proposal.event!.timeZone).time ||
    eventTimeZone !== proposal.event!.timeZone
  );
  const eventEndChanged = !proposal.event || (
    eventEndDate !== localDateTimeInZone(proposal.event!.end, proposal.event!.timeZone).date ||
    eventEndTime !== localDateTimeInZone(proposal.event!.end, proposal.event!.timeZone).time ||
    eventTimeZone !== proposal.event!.timeZone
  );
  const eventStart = !eventStartChanged
    ? proposal.event?.start ?? ""
    : startResolutions.length === 1 ? startResolutions[0]
      : startResolutions.length === 2 && startFoldChoice !== undefined ? startResolutions[startFoldChoice] : undefined;
  const eventEnd = !eventEndChanged
    ? proposal.event?.end ?? ""
    : endResolutions.length === 1 ? endResolutions[0]
      : endResolutions.length === 2 && endFoldChoice !== undefined ? endResolutions[endFoldChoice] : undefined;
  const eventPayload = {
    start: eventStart ?? "",
    end: eventEnd ?? "",
    timeZone: eventTimeZone,
    attendees: parseCsv(eventAttendees),
    invitePolicy,
    title,
    description: body,
  };
  const edited =
    title !== proposal.title ||
    body !== proposal.body ||
    recipients !== proposal.recipients.join(", ") ||
    accountId !== (proposal.accountId ?? "") ||
    calendarId !== (proposal.calendarId ?? "") ||
    (proposal.kind === "reminder" &&
      (dateValue !== proposal.dueAt ||
        dueDate !== localDue.date ||
        dueTime !== localDue.time)) ||
    (proposal.kind === "email" &&
      JSON.stringify(emailPayload) !==
        JSON.stringify(
          proposal.email ?? {
            to: proposal.recipients,
            cc: [],
            bcc: [],
            subject: proposal.title,
            text: proposal.body,
            attachments: [],
          },
        )) ||
    (proposal.kind === "event" &&
      (JSON.stringify(eventPayload) !== JSON.stringify(proposal.event ?? {}) || JSON.stringify(eventDestination) !== JSON.stringify(initialDestination)));
  const chosenAccount = accounts.find((a) => a.id === accountId);
  const calendars = allCalendars.filter(
    (c) => !accountId || c.accountId === accountId,
  );
  const actionLabel =
    proposal.kind === "email"
      ? previewMode
        ? effectiveEmailOperation === "draft"
          ? mailReply
            ? "Preview reply draft"
            : "Preview email draft"
          : "Preview email send"
        : effectiveEmailOperation === "draft"
          ? mailReply
            ? "Create approved reply draft"
            : "Create approved draft"
          : mailReply ? "Send approved reply" : "Send approved email"
      : proposal.kind === "reminder"
        ? "Schedule reminder"
        : proposal.kind === "event"
          ? eventDestination?.kind === "device_calendar"
            ? demoMode ? "Simulate device event save" : "Create approved device event"
            : previewMode
              ? "Preview calendar action"
              : "Create approved event"
          : proposal.kind === "memory"
            ? "Save memory"
            : "Save task";
  const chosenCalendar = calendars.find((calendar) => calendar.id === calendarId && calendar.accountId === accountId);
  const chosenDeviceCalendar = deviceCalendars.choices.find((calendar) => calendar.localId === eventDestination?.calendarId);
  const deviceCalendarWritable = Boolean(
    eventDestination?.kind === "device_calendar" &&
    deviceCalendars.writeAvailable &&
    chosenDeviceCalendar?.selected && chosenDeviceCalendar.allowsModifications,
  );
  const blocked =
    (!previewMode || (proposal.kind === "event" && eventDestination?.kind === "device_calendar")) &&
    (proposal.kind === "email"
      ? mailReply
        ? !replyAllowedOperations.includes(effectiveEmailOperation)
        : !chosenAccount?.allowedEmailOperations.includes(effectiveEmailOperation)
      : proposal.kind === "event"
        ? eventDestination?.kind === "device_calendar"
          ? !deviceCalendarWritable || parseCsv(eventAttendees).length > 0 || invitePolicy !== "none"
          : eventDestination?.kind !== "remote_calendar" ||
            !chosenAccount?.connected ||
            !chosenCalendar?.writable
        : false);
  const invalidPayload =
    scheduleInputInvalid ||
    (proposal.kind === "email" && (!emailTo.trim() || !emailSubject.trim())) ||
    (proposal.kind === "event" &&
      (!eventStart ||
        !eventEnd ||
        Date.parse(eventEnd) <= Date.parse(eventStart) ||
        !eventDestination ||
        (eventDestination.kind === "device_calendar" && !eventDestination.calendarId) ||
        !eventTimeZone.trim() ||
        (eventDestination?.kind === "device_calendar" && (parseCsv(eventAttendees).length > 0 || invitePolicy !== "none")) ||
        (eventStartChanged && startResolutions.length !== 1 && !(startResolutions.length === 2 && startFoldChoice !== undefined)) ||
        (eventEndChanged && endResolutions.length !== 1 && !(endResolutions.length === 2 && endFoldChoice !== undefined))));
  const proposalDispatches = dispatchRecords.filter(
    (record) => record.proposalId === proposal.id,
  );
  const receiptRecord = currentDispatchRecord?.proposalId === proposal.id ? currentDispatchRecord : undefined;
  const isExternalHistory =
    (proposal.kind === "email" || proposal.kind === "event") &&
    !proposal.simulated && proposal.eventDestination?.kind !== "device_calendar";
  const proposalDeviceEventRecords = deviceEventDispatchRecords.filter((record) => record.proposalId === proposal.id);
  const deviceEventRecord = currentDeviceEventDispatchRecord?.proposalId === proposal.id ? currentDeviceEventDispatchRecord : undefined;
  const isDeviceEventHistory = proposal.kind === "event" && (
    proposal.eventDestination?.kind === "device_calendar" || proposalDeviceEventRecords.length > 0
  );
  const historyIncomplete =
    isExternalHistory &&
    !receiptRecord &&
    (proposal.dispatchHistoryIncomplete ||
      ["accepted", "unknown", "executed"].includes(proposal.status) ||
      (proposal.status === "failed" && Boolean(proposal.remoteOperation)));
  if (
    ["accepted", "executed", "simulated", "dismissed", "unknown"].includes(
      proposal.status,
    )
  ) {
    const receiptStatus = deviceEventRecord?.outcome ?? receiptRecord?.outcome ?? proposal.status;
    return (
      <ScrollView
        style={s.sheetBody}
        contentContainerStyle={s.sheetContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.sheetTop}>
          <Text style={s.kicker}>
            {proposal.status === "unknown"
              ? "SAVED ACTION · CHECK STATUS"
              : "SAVED ACTION"}
          </Text>
          <IconButton name="close" label="Close review" onPress={onClose} />
        </View>
        <Text style={s.h1Small}>
          {isDeviceEventHistory
            ? deviceEventRecord?.payload.title ?? "Device event history unavailable"
            : receiptRecord?.title ??
              (historyIncomplete ? "Saved external action" : proposal.title)}
        </Text>
        <Text style={s.label}>
          {isDeviceEventHistory
            ? deviceEventRecord ? "DEVICE EVENT RECORD" : "DEVICE HISTORY INCOMPLETE"
            : proposal.status === "simulated"
            ? "LOCAL PREVIEW"
            : historyIncomplete
              ? "HISTORY INCOMPLETE"
              : receiptStatus === "accepted"
                ? `ACCEPTED BY ${receiptRecord?.account.provider === "google" ? "GMAIL" : receiptRecord?.account.provider === "microsoft" ? "MICROSOFT" : "PROVIDER"}`
                : receiptStatus === "unknown"
                  ? "OUTCOME UNKNOWN"
                  : receiptStatus.toUpperCase()}
        </Text>
        {isDeviceEventHistory ? proposalDeviceEventRecords.length ? proposalDeviceEventRecords.map((record) => (
          <DeviceEventDispatchHistory
            key={record.id}
            record={record}
            busy={busy}
            demoMode={demoMode}
            unavailableReason="This device calendar history is read-only here. Check the event directly in Calendar on this iPhone."
            onInspect={onInspectDeviceEvent}
            onReconcile={onReconcileDeviceEvent}
          />
        )) : <Text style={s.disclaimer}>Device event history is incomplete. The saved action will not be repeated.</Text> : null}
        {isExternalHistory && !isDeviceEventHistory ? (
          <DispatchHistory
            records={proposalDispatches}
            incomplete={historyIncomplete}
            busy={busy}
            onReconcile={onReconcile}
            title="Approved details"
          />
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory && proposal.email ? (
          <View style={s.analysisBlock}>
            <Text style={s.analysisSource}>
              {proposal.email.operation === "send"
                ? "Email send"
                : "Mailbox draft"}
              {proposal.email.to.length
                ? ` · To ${proposal.email.to.join(", ")}`
                : ""}
            </Text>
            {proposal.email.cc.length ? (
              <Text style={s.analysisSource}>
                Cc · {proposal.email.cc.join(", ")}
              </Text>
            ) : null}
            {proposal.email.bcc.length ? (
              <Text style={s.analysisSource}>
                Bcc · {proposal.email.bcc.join(", ")}
              </Text>
            ) : null}
            <Text style={s.analysisSource}>
              Subject · {proposal.email.subject}
            </Text>
          </View>
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory && proposal.event ? (
          <View style={s.analysisBlock}>
            <Text style={s.analysisSource}>
              {new Date(proposal.event.start).toLocaleString(undefined, {
                timeZone: proposal.event.timeZone,
              })}
              {" – "}
              {new Date(proposal.event.end).toLocaleString(undefined, {
                timeZone: proposal.event.timeZone,
              })}
              {` · ${proposal.event.timeZone}`}
            </Text>
            {proposal.event.attendees.length ? (
              <Text style={s.analysisSource}>
                Attendees · {proposal.event.attendees.join(", ")}
              </Text>
            ) : null}
            <Text style={s.analysisSource}>
              Invitations ·{" "}
              {proposal.event.invitePolicy === "send"
                ? "sent with event"
                : "not sent"}
            </Text>
          </View>
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory && proposal.dueAt ? (
          <Text style={s.analysisSource}>
            Scheduled · {new Date(proposal.dueAt).toLocaleString()}
          </Text>
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory ? (
          <Text style={s.proposalBody}>{proposal.body}</Text>
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory && proposal.remoteId ? (
          <Text style={s.analysisSource}>
            Provider reference · {proposal.remoteId}
          </Text>
        ) : null}
        {!isDeviceEventHistory && proposal.notificationId ? (
          <Text style={s.analysisSource}>
            Local notification reference · {proposal.notificationId}
          </Text>
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory && proposal.remoteAcceptedAt ? (
          <Text style={s.analysisSource}>
            Accepted at · {new Date(proposal.remoteAcceptedAt).toLocaleString()}
          </Text>
        ) : null}
        {proposal.status === "unknown" && !receiptRecord && !isDeviceEventHistory ? (
          <Text style={s.errorText}>
            This action may already have been accepted. Check its status before
            taking any further action.
          </Text>
        ) : null}
        {!isExternalHistory && !isDeviceEventHistory && proposal.lastError ? (
          <Text style={s.errorText}>{proposal.lastError}</Text>
        ) : null}
        {!isExternalHistory &&
          proposal.evidence.map((e, i) => (
            <Text key={i} style={s.evidenceQuote}>
              “{e.quote}”
            </Text>
          ))}
        <Button label="Close review" tone="quiet" onPress={onClose} />
      </ScrollView>
    );
  }
  return (
    <ScrollView
      style={s.sheetBody}
      contentContainerStyle={s.sheetContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={s.sheetTop}>
        <Text style={s.kicker}>REVIEW DRAFT</Text>
        <IconButton name="close" label="Close review" onPress={onClose} />
      </View>
      <Text style={s.h1Small}>{proposal.title}</Text>
      <Text style={s.label}>
        {proposal.kind.toUpperCase()} · {proposal.status.toUpperCase()}
      </Text>
      {mailReply && frozenReplySource ? (
        <View style={s.analysisBlock}>
          <Text style={s.analysisSource}>
            Reply to {frozenReplySource.from || frozenReplySource.senderEmail || "Sender unavailable"}
          </Text>
          <Text style={s.analysisSource}>
            Original subject · {frozenReplySource.subject || "(no subject)"}
          </Text>
          <Text style={s.analysisSource}>
            Account at review · {frozenReplySource.accountEmail}
          </Text>
          <Text style={s.evidenceQuote}>
            Saved excerpt: “{frozenReplySource.snippet || "No excerpt was saved."}”
          </Text>
          <Text style={s.disclaimer}>
            Approval rechecks the saved source details. This action preserves the source metadata and excerpt; selected message text is kept separately in the local cache.
          </Text>
        </View>
      ) : null}
      {proposal.kind === "email" ? (
        <>
          <Text style={s.label}>
            {mailReply ? "Drafting account" : "Sending account"}
          </Text>
          {mailReply && frozenReplySource ? (
            <View style={s.accountChoice}>
              <Text style={s.accountName}>{frozenReplySource.accountEmail}</Text>
              <Text style={s.accountSub}>Frozen to the verified source account</Text>
            </View>
          ) : (
            accounts
              .filter(
                (a) => a.provider === "google" || a.provider === "microsoft",
              )
              .map((a) => (
                <Pressable
                  key={a.id}
                  accessibilityRole="radio"
                  accessibilityLabel={`Use ${a.email}`}
                  accessibilityState={{ selected: accountId === a.id }}
                  onPress={() => setAccountId(a.id)}
                  style={[
                    s.accountChoice,
                    accountId === a.id && s.accountChoiceSelected,
                  ]}
                >
                  <Text style={s.accountName}>{a.displayName || a.email}</Text>
                  <Text style={s.accountSub}>
                    {a.email} ·{" "}
                    {a.connected ? "Verified" : "Configured · not connected"}
                  </Text>
                </Pressable>
              ))
          )}
          {!mailReply ? <Text style={s.label}>Email action</Text> : null}
          {!mailReply ? <View style={s.pills}>
            {(["draft", "send"] as const).map((operation) => (
              <Pressable
                key={operation}
                accessibilityRole="radio"
                accessibilityLabel={
                  operation === "draft" ? "Draft in mailbox" : "Send email"
                }
                accessibilityState={{ selected: emailOperation === operation }}
                onPress={() => setEmailOperation(operation)}
                style={[s.pill, emailOperation === operation && s.pillActive]}
              >
                <Text
                  style={[
                    s.pillText,
                    emailOperation === operation && s.pillTextActive,
                  ]}
                >
                  {operation === "draft" ? "Draft in mailbox" : "Send email"}
                </Text>
              </Pressable>
            ))}
          </View> : (
            <Text style={s.disclaimer}>
              {proposal.email?.reply?.mode === "reply_all" ? "Reply all" : "Reply"} · {effectiveEmailOperation === "draft" ? "Mailbox draft for separate review and approval." : "Send proposal for separate approval and sending."}
            </Text>
          )}
          {immutableBatchReply ? (
            <View style={s.analysisBlock}>
              <Text style={s.analysisSource}>To · {emailTo || "None"}</Text>
              {emailCc.trim() ? <Text style={s.analysisSource}>Cc · {emailCc}</Text> : null}
              <Text style={s.analysisSource}>Subject · {emailSubject}</Text>
              <Text selectable style={s.analysisText}>Message · {emailText}</Text>
              <Text style={s.disclaimer}>{effectiveEmailOperation === "send"
                ? "This send proposal came from a completed Batch request and is immutable. Approval and sending are separate. To change it, write a separate manual reply in the message composer."
                : "This reply draft came from a completed Batch request and is immutable. To change it, write a separate manual reply in the message composer."}</Text>
              {effectiveEmailOperation === "send" && frozenReplySource?.identity.providerNamespace === "microsoft"
                ? <Text style={s.disclaimer}>Outlook may display this reply outside the original conversation.</Text>
                : null}
              {mailReply?.batchJobId && mailReplyContextCount > 0 ? <>
                <Text style={s.analysisSource}>Selected conversation sources · {mailReplyContextCount} message{mailReplyContextCount === 1 ? '' : 's'} in addition to the fixed target</Text>
                {mailReplySourcesStatus?.status === 'invalid' ? <Text style={s.errorText}>The saved source binding is invalid. Review a new reply request.</Text> : null}
                {mailReplySourcesStatus?.status === 'current' && mailReplySourcesStatus.expiresAt ? <Text style={s.analysisSource}>Last checked source proof expires {new Date(mailReplySourcesStatus.expiresAt).toLocaleString()}</Text> : null}
                <Button label={refreshingMailSources ? 'Refreshing fixed target and selected messages…' : 'Refresh fixed target and selected messages'} tone="quiet" disabled={busy || refreshingMailSources || mailReplySourcesStatus?.status === 'invalid' || !onRefreshMailReplySources} onPress={() => void refreshMailReplySources()} />
                {mailSourcesNotice ? <Text style={s.disclaimer}>{mailSourcesNotice}</Text> : null}
                {refreshedMailSources.map((item) => <View key={item.selectionId} style={s.analysisBlock}>
                  <Text style={s.analysisSource}>{item.isReplyTarget ? 'Fixed reply target' : 'Selected conversation message'} · {item.subject || '(no subject)'}</Text>
                  <Text style={s.analysisSource}>{item.sender || 'Sender unknown'} · {item.sentAt || item.receivedAt ? new Date(item.sentAt ?? item.receivedAt!).toLocaleString() : 'Time unknown'}</Text>
                  <Text style={s.analysisSource}>{item.representation.replaceAll('_', ' ')} · {item.completeness.replaceAll('_', ' ')} · {item.bytes.toLocaleString()} bytes</Text>
                  {item.omissionReasons.map((reason, index) => <Text key={`${item.selectionId}-${index}`} style={s.disclaimer}>Omitted · {reason.replaceAll('_', ' ')}</Text>)}
                </View>)}
              </> : null}
            </View>
          ) : (
            <>
              <Field
                label="To"
                value={emailTo}
                onChangeText={setEmailTo}
                placeholder="name@example.com"
                keyboardType="email-address"
              />
              <Field
                label="Cc"
                value={emailCc}
                onChangeText={setEmailCc}
                placeholder="Optional recipients"
                keyboardType="email-address"
              />
            </>
          )}
          {!mailReply ? (
            <Field
              label="Bcc"
              value={emailBcc}
              onChangeText={setEmailBcc}
              placeholder="Optional recipients"
              keyboardType="email-address"
            />
          ) : null}
          {immutableBatchReply && emailBcc.trim() ? <Text style={s.analysisSource}>Bcc · {emailBcc}</Text> : null}
          {!immutableBatchReply && mailReply ? (
            <View style={s.fieldWrap}>
              <Text style={s.label}>Subject · {emailSubject}</Text>
            </View>
          ) : !mailReply ? (
            <Field
              label="Subject"
              value={emailSubject}
              onChangeText={setEmailSubject}
            />
          ) : null}
          {!immutableBatchReply ? <Field
            label="Message"
            value={emailText}
            onChangeText={setEmailText}
            multiline
          /> : null}
          <Text style={s.disclaimer}>
            {proposal.email?.attachments.length
              ? `Attachments included in this approved draft (${proposal.email.attachments.length}); review is read-only because no attachment picker is configured.`
              : "No attachments."}
          </Text>
        </>
      ) : null}
      {proposal.kind === "event" ? (
        <>
          <Text style={s.label}>Where to save</Text>
          <View style={s.pills}>
            {(["remote_calendar", "device_calendar"] as const).map((kind) => (
              <Pressable
                key={kind}
                accessibilityRole="radio"
                accessibilityLabel={kind === "remote_calendar" ? "Online calendar" : "On this iPhone"}
                accessibilityState={{ selected: eventDestination?.kind === kind }}
                onPress={() => {
                  if (kind === "remote_calendar") {
                    const fallback = allCalendars.find((item) => item.id === calendarId && item.accountId === accountId) ?? calendars[0];
                    if (fallback) {
                      setAccountId(fallback.accountId);
                      setCalendarId(fallback.id);
                    }
                    setEventDestination(fallback ? { kind: "remote_calendar", accountId: fallback.accountId, calendarId: fallback.id } : undefined);
                  } else {
                    setAccountId("");
                    setCalendarId("");
                    const selectedLocalId = deviceCalendars.choices.find((calendar) => calendar.selected && calendar.allowsModifications)?.localId;
                    const writableId = selectedLocalId ?? deviceCalendars.choices.find((calendar) => calendar.allowsModifications)?.localId;
                    setEventDestination({ kind: "device_calendar", calendarId: writableId ?? "" });
                  }
                }}
                style={[s.pill, eventDestination?.kind === kind && s.pillActive]}
              >
                <Text style={[s.pillText, eventDestination?.kind === kind && s.pillTextActive]}>{kind === "remote_calendar" ? "Online calendar" : "On this iPhone"}</Text>
              </Pressable>
            ))}
          </View>
          {eventDestination?.kind === "remote_calendar" ? (
            <>
              <Text style={s.label}>Online calendar account</Text>
              {accounts.filter((account) => account.provider === "google" || account.provider === "microsoft").map((account) => (
                <Pressable key={account.id} accessibilityRole="radio" accessibilityLabel={`Use online calendar account ${account.email}`}
                  accessibilityState={{ selected: accountId === account.id }} onPress={() => {
                    const fallback = allCalendars.find((calendar) => calendar.accountId === account.id && calendar.writable) ??
                      allCalendars.find((calendar) => calendar.accountId === account.id);
                    setAccountId(account.id); setCalendarId(fallback?.id ?? "");
                    setEventDestination(fallback ? { kind: "remote_calendar", accountId: account.id, calendarId: fallback.id } : undefined);
                  }} style={[s.accountChoice, accountId === account.id && s.accountChoiceSelected]}>
                  <Text style={s.accountName}>{account.displayName || account.email}</Text>
                  <Text style={s.accountSub}>{account.email} · {account.connected ? "Verified" : "Configured · not connected"}</Text>
                </Pressable>
              ))}
            </>
          ) : null}
          {eventDestination?.kind === "remote_calendar" ? calendars.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="radio"
              accessibilityLabel={`Use ${c.name}`}
              accessibilityState={{ selected: calendarId === c.id }}
              onPress={() => {
                setCalendarId(c.id);
                setAccountId(c.accountId);
                setEventDestination({ kind: "remote_calendar", accountId: c.accountId, calendarId: c.id });
              }}
              style={[
                s.accountChoice,
                calendarId === c.id && s.accountChoiceSelected,
              ]}
            >
              <Text style={s.accountName}>{c.name}</Text>
              <Text style={s.accountSub}>
                {c.accountEmail ||
                  "Account unavailable"}{" "}
                ·{" "}
                {c.writable
                  ? "Writable"
                  : c.unavailableReason}
              </Text>
            </Pressable>
          )) : null}
          {eventDestination?.kind === "device_calendar" ? (
            <>
              {deviceCalendars.choices.filter((calendar) => calendar.selected && calendar.allowsModifications).map((calendar) => (
                <Pressable
                  key={calendar.localId}
                  accessibilityRole="radio"
                  accessibilityLabel={`Save on this iPhone to ${calendar.title}`}
                  accessibilityState={{ selected: eventDestination.calendarId === calendar.localId }}
                  onPress={() => setEventDestination({ kind: "device_calendar", calendarId: calendar.localId })}
                  style={[s.accountChoice, eventDestination.calendarId === calendar.localId && s.accountChoiceSelected]}
                >
                  <Text style={s.accountName}>{calendar.title}</Text>
                  <Text style={s.accountSub}>{calendar.sourceName || "On this iPhone"} · Writable</Text>
                </Pressable>
              ))}
              {!deviceCalendars.writeAvailable ? <Text style={s.disclaimer}>{deviceCalendars.unavailableReason ?? "Full Calendar access is required to create an event on this iPhone."}</Text> : null}
              {!deviceCalendars.choices.some((calendar) => calendar.selected && calendar.allowsModifications) ? <Text style={s.disclaimer}>Choose a selected writable calendar in Settings first.</Text> : null}
              <Text style={s.disclaimer}>No invitations are sent. Calendar may sync the event according to its account settings.</Text>
            </>
          ) : null}
          <View style={s.inlineFields}>
            <View style={{ flex: 1 }}>
              <Field
                label="Starts · date"
                value={eventStartDate}
                onChangeText={(value) => { setEventStartDate(value); setStartFoldChoice(undefined); }}
                placeholder="YYYY-MM-DD"
              />
            </View>
            <View style={{ width: 104 }}>
              <Field
                label="Local time"
                value={eventStartTime}
                onChangeText={(value) => { setEventStartTime(value); setStartFoldChoice(undefined); }}
                placeholder="HH:MM"
              />
            </View>
          </View>
          <View style={s.inlineFields}>
            <View style={{ flex: 1 }}>
              <Field
                label="Ends · date"
                value={eventEndDate}
                onChangeText={(value) => { setEventEndDate(value); setEndFoldChoice(undefined); }}
                placeholder="YYYY-MM-DD"
              />
            </View>
            <View style={{ width: 104 }}>
              <Field
                label="Local time"
                value={eventEndTime}
                onChangeText={(value) => { setEventEndTime(value); setEndFoldChoice(undefined); }}
                placeholder="HH:MM"
              />
            </View>
          </View>
          <Field label="Time zone · IANA name" value={eventTimeZone} onChangeText={(value) => { setEventTimeZone(value); setStartFoldChoice(undefined); setEndFoldChoice(undefined); }} placeholder="Asia/Singapore" />
          <Text style={s.disclaimer}>Times use the selected time zone: {eventTimeZone || "choose an IANA time zone"}.</Text>
          {eventStart ? <Text style={s.disclaimer}>Resolved start · {formatZonedInstant(eventStart, eventTimeZone)}</Text> : null}
          {eventEnd ? <Text style={s.disclaimer}>Resolved end · {formatZonedInstant(eventEnd, eventTimeZone)}</Text> : null}
          {eventStartChanged && startResolutions.length === 0 ? <Text style={s.errorText}>Enter a valid start date, time, and time zone. This local time may not exist when clocks move forward.</Text> : null}
          {eventStartChanged && startResolutions.length === 2 ? <View style={s.evidence}><Text style={s.label}>START TIME OCCURS TWICE</Text>{startResolutions.map((instant, index) => <Button key={instant} label={`${index === 0 ? "First" : "Second"} · ${formatZonedInstant(instant, eventTimeZone)}`} tone={startFoldChoice === index ? "light" : "quiet"} onPress={() => setStartFoldChoice(index as 0 | 1)} />)}</View> : null}
          {eventEndChanged && endResolutions.length === 0 ? <Text style={s.errorText}>Enter a valid end date, time, and time zone. This local time may not exist when clocks move forward.</Text> : null}
          {eventEndChanged && endResolutions.length === 2 ? <View style={s.evidence}><Text style={s.label}>END TIME OCCURS TWICE</Text>{endResolutions.map((instant, index) => <Button key={instant} label={`${index === 0 ? "First" : "Second"} · ${formatZonedInstant(instant, eventTimeZone)}`} tone={endFoldChoice === index ? "light" : "quiet"} onPress={() => setEndFoldChoice(index as 0 | 1)} />)}</View> : null}
          <Field
            label="Attendees"
            value={eventAttendees}
            onChangeText={setEventAttendees}
            placeholder="name@example.com, ..."
            keyboardType="email-address"
          />
          {eventDestination?.kind === "device_calendar" ? <Text style={s.disclaimer}>To create on this iPhone, remove every attendee and choose “Do not invite.” No invitations will be sent.</Text> : null}
          <Text style={s.label}>Invitation policy</Text>
          <View style={s.pills}>
            {(["send", "none"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityLabel={
                  value === "send"
                    ? "Send invitations"
                    : "Do not send invitations"
                }
                accessibilityState={{ selected: invitePolicy === value }}
                onPress={() => setInvitePolicy(value)}
                style={[s.pill, invitePolicy === value && s.pillActive]}
              >
                <Text
                  style={[
                    s.pillText,
                    invitePolicy === value && s.pillTextActive,
                  ]}
                >
                  {value === "send" ? "Send invitations" : "Do not invite"}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {proposal.kind === "reminder" ? (
        <View style={s.inlineFields}>
          <View style={{ flex: 1 }}>
            <Field
              label="Date · local time zone"
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="YYYY-MM-DD"
            />
          </View>
          <View style={{ width: 104 }}>
            <Field
              label="Time"
              value={dueTime}
              onChangeText={setDueTime}
              placeholder="HH:MM"
            />
          </View>
        </View>
      ) : null}
      {proposal.kind !== "email" ? (
        <Field label="Draft title" value={title} onChangeText={setTitle} />
      ) : null}
      {proposal.kind !== "email" ? (
        <Field
          label={
            proposal.kind === "event" ? "Event description" : "Draft details"
          }
          value={body}
          onChangeText={setBody}
          multiline
        />
      ) : null}
      {proposal.evidence.length ? (
        <View style={s.evidence}>
          <Text style={s.label}>WHY THIS WAS SUGGESTED</Text>
          {proposal.evidence.map((e, i) => (
            <Text key={i} style={s.evidenceQuote}>
              “{e.quote}”
            </Text>
          ))}
        </View>
      ) : null}
      {proposal.lastError ? (
        <Text style={s.errorText}>{proposal.lastError}</Text>
      ) : null}
      {proposal.status === "failed" && proposalDispatches.length ? (
        <DispatchHistory
          records={proposalDispatches}
          busy={busy}
          onReconcile={onReconcile}
          title="Provider attempt history"
        />
      ) : null}
      {proposal.status === "failed" &&
      isExternalHistory &&
      !proposalDispatches.length ? (
        <DispatchHistory
          records={[]}
          incomplete
          busy={busy}
          title="Provider attempt history"
        />
      ) : null}
      {sourceChecking || sourceStale || sourceCheckError ? (
        <View style={s.analysisStale}>
          <Text style={s.analysisText}>
            {sourceChecking
              ? "Checking saved sources…"
              : (sourceCheckError ??
                sourceCheckReason ??
                (mailReply
                  ? "This saved mail source changed or needs a new check. Check recent mail and compose the reply again."
                  : "Some sources changed since this suggestion. Refresh the response before approving or executing it."))}
          </Text>
          {sourceCheckError && onRetrySourceCheck ? (
            <Button
              label="Check source status again"
              tone="quiet"
              onPress={onRetrySourceCheck}
            />
          ) : null}
          {sourceStale && !mailReply && !sourceCheckError && !sourceChecking && onReassist ? (
            <Button
              label="Open note to run Assist"
              tone="quiet"
              onPress={onReassist}
            />
          ) : null}
        </View>
      ) : null}
      {proposal.status === "unknown" ? (
        <Text style={s.errorText}>
          Check the provider before retrying. The last result may have been
          accepted.
        </Text>
      ) : null}
      {proposal.kind === "reminder" ? (
        <Text style={s.disclaimer}>
          A scheduled reminder uses a local notification on native. Browser
          preview cannot alert while the tab is closed. Set both a local date
          and time.
        </Text>
      ) : null}
      {previewMode &&
      (proposal.kind === "email" || proposal.kind === "event") ? (
        <Text style={s.disclaimer}>
          {proposal.kind === "event" && eventDestination?.kind === "device_calendar"
            ? demoMode
              ? "Sample only. This uses a closed mock calendar and does not change an iPhone calendar."
              : "Approval creates an event in the selected on-device calendar. No invitations are sent; Calendar may sync it according to its account settings."
            : demoMode
            ? "Sample preview only. No mailbox draft, email, or calendar change will be created."
            : "Preview mode simulates this action. No email will be sent and no external calendar will change."}
        </Text>
      ) : null}
      <Text style={s.disclaimer}>
        Edits, approval, and action are separate. Approval applies only to this
        exact version.
      </Text>
      {edited && !immutableBatchReply ? (
        <Button
          label="Save edits"
          disabled={
            invalidPayload || sourceStale || sourceChecking || Boolean(sourceCheckError)
          }
          onPress={() =>
            onEdit({
              title:
                proposal.kind === "email"
                  ? mailReply
                    ? proposal.title
                    : emailSubject
                  : title,
              body: proposal.kind === "email" ? emailText : body,
              recipients:
                proposal.kind === "email"
                  ? emailPayload.to
                  : proposal.kind === "event"
                    ? eventPayload.attendees
                    : parseCsv(recipients),
              accountId:
                mailReply && frozenReplySource
                  ? frozenReplySource.accountId
                  : accountId || undefined,
              calendarId: calendarId || undefined,
              eventDestination: proposal.kind === "event" ? eventDestination : undefined,
              dueAt:
                proposal.kind === "event"
                  ? eventStart
                  : proposal.kind === "reminder"
                    ? dateValue
                    : undefined,
              email: proposal.kind === "email" ? emailPayload : undefined,
              event: proposal.kind === "event" ? eventPayload : undefined,
            })
          }
        />
      ) : null}
      {proposal.status === "draft" ? (
        <Button
          label={
            proposal.kind === "email"
              ? mailReply
                ? immutableBatchReply && effectiveEmailOperation === "send" ? "Approve send proposal" : "Approve reply draft"
                : effectiveEmailOperation === "draft"
                ? "Approve email draft"
                : "Approve email send"
              : `Approve ${proposal.kind} draft`
          }
          disabled={
            edited || invalidPayload || sourceStale || sourceChecking || Boolean(sourceCheckError)
          }
          onPress={onApprove}
        />
      ) : null}
      {proposal.status === "approved" ? (
        <>
          <Button
            label={actionLabel}
            disabled={
              blocked || edited || sourceStale || sourceChecking || Boolean(sourceCheckError)
            }
            onPress={onExecute}
          />
          {blocked ? (
            <Text style={s.disclaimer}>
              {proposal.kind === "event" && eventDestination?.kind === "device_calendar"
                ? !deviceCalendars.writeAvailable
                  ? deviceCalendars.unavailableReason ?? "Connect device calendars and allow full access before creating this event."
                  : parseCsv(eventAttendees).length > 0 || invitePolicy !== "none"
                    ? "Remove attendees and choose “Do not invite” to create this event on this iPhone."
                    : "Choose a selected writable calendar in Settings before creating this event."
                : proposal.kind === "event" && eventDestination?.kind === "remote_calendar" && !chosenAccount?.connected
                  ? "Connect and verify this exact account before this action is available."
                  : proposal.kind === "event" && eventDestination?.kind === "remote_calendar" && !chosenCalendar?.writable
                    ? chosenCalendar?.unavailableReason ?? "Choose a writable calendar connected to an account with calendar write access."
                : "Connect and verify this exact account before this action is available."}
            </Text>
          ) : null}
        </>
      ) : null}
      <Button label="Dismiss" tone="quiet" onPress={onDismiss} />
    </ScrollView>
  );
}

function localDateTime(iso?: string) {
  if (!iso) return { date: "", time: "" };
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function localDateTimeInZone(iso: string, timeZone: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return { date: "", time: "" };
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      date: `${value.year}-${value.month}-${value.day}`,
      time: `${value.hour}:${value.minute}`,
    };
  } catch {
    return { date: "", time: "" };
  }
}

function formatZonedInstant(iso: string, timeZone: string) {
  try {
    const showSeconds = new Date(iso).getSeconds() !== 0;
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(showSeconds ? { second: "2-digit" as const } : {}),
      timeZoneName: "shortOffset",
    }).format(new Date(iso)) + ` (${new Date(iso).toISOString()})`;
  } catch {
    return `${iso} · ${timeZone}`;
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
