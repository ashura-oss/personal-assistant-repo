import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Proposal } from "../core";
import type { DispatchRecord, DispatchReconciliation } from "../dispatch";
import { controller } from "../services/controller";
import { DispatchHistory } from "./DispatchHistory";
import { Button, Field, IconButton } from "./primitives";
import { s } from "./theme";

type ReviewSheetProps = {
  state: ReturnType<typeof controller.getSnapshot>;
  proposal: Proposal | null;
  dispatchRecords: DispatchRecord[];
  busy?: boolean;
  onClose: () => void;
  onEdit: (
    p: Partial<
      Pick<
        Proposal,
        | "title"
        | "body"
        | "accountId"
        | "recipients"
        | "calendarId"
        | "dueAt"
        | "email"
        | "event"
      >
    >,
  ) => void;
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
  sourceStale?: boolean;
  sourceChecking?: boolean;
  sourceCheckError?: string;
  sourceCheckReason?: string;
  onRetrySourceCheck?: () => void;
  onReassist?: () => void;
};
export function ReviewSheet(props: ReviewSheetProps) {
  if (!props.proposal) return null;
  return (
    <ReviewSheetContent
      key={`${props.proposal.id}:${props.proposal.revision}`}
      {...props}
      proposal={props.proposal}
    />
  );
}

function ReviewSheetContent({
  state,
  proposal,
  dispatchRecords,
  busy = false,
  onClose,
  onEdit,
  onApprove,
  onExecute,
  onDismiss,
  onReconcile,
  sourceStale = false,
  sourceChecking = false,
  sourceCheckError,
  sourceCheckReason,
  onRetrySourceCheck,
  onReassist,
}: Omit<ReviewSheetProps, "proposal"> & { proposal: Proposal }) {
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
  const [emailOperation, setEmailOperation] = useState<"draft" | "send">(
    proposal.email?.operation ?? "draft",
  );
  const initialEventTime = localDateTime(
    proposal.event?.start ?? proposal.dueAt,
  );
  const initialEventEnd = localDateTime(
    proposal.event?.end ??
      (proposal.dueAt
        ? new Date(Date.parse(proposal.dueAt) + 3600000).toISOString()
        : undefined),
  );
  const [eventStartDate, setEventStartDate] = useState(initialEventTime.date);
  const [eventStartTime, setEventStartTime] = useState(initialEventTime.time);
  const [eventEndDate, setEventEndDate] = useState(initialEventEnd.date);
  const [eventEndTime, setEventEndTime] = useState(initialEventEnd.time);
  const eventTimeZone =
    proposal.event?.timeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
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
  const frozenReplySource = mailReply?.source;
  const effectiveEmailOperation = mailReply ? "draft" : emailOperation;
  const parsedDate =
    dueDate && dueTime ? new Date(`${dueDate}T${dueTime}`) : null;
  const dateValue =
    parsedDate && Number.isFinite(parsedDate.getTime())
      ? parsedDate.toISOString()
      : undefined;
  const localDue = localDateTime(proposal.dueAt);
  const scheduleInputInvalid = Boolean(dueDate) !== Boolean(dueTime);
  const emailPayload = {
    operation: mailReply ? ("draft" as const) : emailOperation,
    to: parseCsv(emailTo),
    cc: parseCsv(emailCc),
    bcc: parseCsv(emailBcc),
    subject: emailSubject,
    text: emailText,
    attachments: proposal.email?.attachments ?? [],
    ...(proposal.email?.reply ? { reply: proposal.email.reply } : {}),
  };
  const eventStart = localIso(eventStartDate, eventStartTime, eventTimeZone);
  const eventEnd = localIso(eventEndDate, eventEndTime, eventTimeZone);
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
      JSON.stringify(eventPayload) !== JSON.stringify(proposal.event ?? {}));
  const chosenAccount = state.accounts.find((a) => a.id === accountId);
  const calendars = state.calendars.filter(
    (c) => !accountId || c.accountId === accountId,
  );
  const actionLabel =
    proposal.kind === "email"
      ? state.settings.mode === "preview"
        ? effectiveEmailOperation === "draft"
          ? mailReply
            ? "Preview reply draft"
            : "Preview email draft"
          : "Preview email send"
        : effectiveEmailOperation === "draft"
          ? mailReply
            ? "Create approved reply draft"
            : "Create approved draft"
          : "Send approved email"
      : proposal.kind === "reminder"
        ? "Schedule reminder"
        : proposal.kind === "event"
          ? state.settings.mode === "preview"
            ? "Preview calendar action"
            : "Create approved event"
          : proposal.kind === "memory"
            ? "Save memory"
            : "Save task";
  const chosenCalendar = state.calendars.find(
    (calendar) => calendar.id === calendarId,
  );
  const replyAccount = frozenReplySource
    ? state.accounts.find(
        (account) =>
          account.id === frozenReplySource.accountId &&
          account.email === frozenReplySource.accountEmail &&
          account.connected &&
          account.authStatus === "connected" &&
          account.connectionGeneration ===
            frozenReplySource.connectionGeneration &&
          sameIdentity(account.identity, frozenReplySource.identity),
      )
    : undefined;
  const blocked =
    state.settings.mode !== "preview" &&
    (proposal.kind === "email"
      ? mailReply
        ? !replyAccount?.capabilities?.includes("mail.draft")
        : !chosenAccount?.connected ||
          !chosenAccount.capabilities?.includes(
            effectiveEmailOperation === "draft" ? "mail.draft" : "mail.send",
          )
      : proposal.kind === "event"
        ? !chosenAccount?.connected ||
          !chosenCalendar?.connected ||
          !chosenCalendar.writable ||
          !chosenAccount.capabilities?.includes("calendar.write")
        : false);
  const invalidPayload =
    scheduleInputInvalid ||
    (proposal.kind === "email" && (!emailTo.trim() || !emailSubject.trim())) ||
    (proposal.kind === "event" &&
      (!eventStart ||
        !eventEnd ||
        Date.parse(eventEnd) <= Date.parse(eventStart) ||
        !eventTimeZone.trim()));
  const proposalDispatches = dispatchRecords.filter(
    (record) => record.proposalId === proposal.id,
  );
  const receiptRecord = proposal.dispatchRecordId
    ? dispatchRecords.find((record) => record.id === proposal.dispatchRecordId)
    : proposalDispatches.find((record) => record.outcome !== "pending");
  const isExternalHistory =
    (proposal.kind === "email" || proposal.kind === "event") &&
    !proposal.simulated;
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
    const receiptStatus = receiptRecord?.outcome ?? proposal.status;
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
          {receiptRecord?.title ??
            (historyIncomplete ? "Saved external action" : proposal.title)}
        </Text>
        <Text style={s.label}>
          {proposal.status === "simulated"
            ? "LOCAL PREVIEW"
            : historyIncomplete
              ? "HISTORY INCOMPLETE"
              : receiptStatus === "accepted"
                ? `ACCEPTED BY ${receiptRecord?.account.provider === "google" ? "GMAIL" : receiptRecord?.account.provider === "microsoft" ? "MICROSOFT" : "PROVIDER"}`
                : receiptStatus === "unknown"
                  ? "OUTCOME UNKNOWN"
                  : receiptStatus.toUpperCase()}
        </Text>
        {isExternalHistory ? (
          <DispatchHistory
            records={proposalDispatches}
            incomplete={historyIncomplete}
            busy={busy}
            onReconcile={onReconcile}
            title="Approved details"
          />
        ) : null}
        {!isExternalHistory && proposal.email ? (
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
        {!isExternalHistory && proposal.event ? (
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
        {!isExternalHistory && proposal.dueAt ? (
          <Text style={s.analysisSource}>
            Scheduled · {new Date(proposal.dueAt).toLocaleString()}
          </Text>
        ) : null}
        {!isExternalHistory ? (
          <Text style={s.proposalBody}>{proposal.body}</Text>
        ) : null}
        {!isExternalHistory && proposal.remoteId ? (
          <Text style={s.analysisSource}>
            Provider reference · {proposal.remoteId}
          </Text>
        ) : null}
        {proposal.notificationId ? (
          <Text style={s.analysisSource}>
            Local notification reference · {proposal.notificationId}
          </Text>
        ) : null}
        {!isExternalHistory && proposal.remoteAcceptedAt ? (
          <Text style={s.analysisSource}>
            Accepted at · {new Date(proposal.remoteAcceptedAt).toLocaleString()}
          </Text>
        ) : null}
        {proposal.status === "unknown" && !receiptRecord ? (
          <Text style={s.errorText}>
            This action may already have been accepted. Check its status before
            taking any further action.
          </Text>
        ) : null}
        {!isExternalHistory && proposal.lastError ? (
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
            Source details are checked before approval. The full message body was not saved.
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
            state.accounts
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
              {proposal.email?.reply?.mode === "reply_all" ? "Reply all" : "Reply"} · Mailbox draft for separate review and approval.
            </Text>
          )}
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
          {!mailReply ? (
            <Field
              label="Bcc"
              value={emailBcc}
              onChangeText={setEmailBcc}
              placeholder="Optional recipients"
              keyboardType="email-address"
            />
          ) : null}
          {mailReply ? (
            <View style={s.fieldWrap}>
              <Text style={s.label}>Subject · {emailSubject}</Text>
            </View>
          ) : (
            <Field
              label="Subject"
              value={emailSubject}
              onChangeText={setEmailSubject}
            />
          )}
          <Field
            label="Message"
            value={emailText}
            onChangeText={setEmailText}
            multiline
          />
          <Text style={s.disclaimer}>
            {proposal.email?.attachments.length
              ? `Attachments included in this approved draft (${proposal.email.attachments.length}); review is read-only because no attachment picker is configured.`
              : "No attachments."}
          </Text>
        </>
      ) : null}
      {proposal.kind === "event" ? (
        <>
          <Text style={s.label}>Calendar</Text>
          {calendars.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="radio"
              accessibilityLabel={`Use ${c.name}`}
              accessibilityState={{ selected: calendarId === c.id }}
              onPress={() => {
                setCalendarId(c.id);
                setAccountId(c.accountId);
              }}
              style={[
                s.accountChoice,
                calendarId === c.id && s.accountChoiceSelected,
              ]}
            >
              <Text style={s.accountName}>{c.name}</Text>
              <Text style={s.accountSub}>
                {state.accounts.find((a) => a.id === c.accountId)?.email ??
                  "Account unavailable"}{" "}
                ·{" "}
                {c.connected && c.writable
                  ? "Writable"
                  : "Not connected for changes"}
              </Text>
            </Pressable>
          ))}
          <View style={s.inlineFields}>
            <View style={{ flex: 1 }}>
              <Field
                label="Starts · date"
                value={eventStartDate}
                onChangeText={setEventStartDate}
                placeholder="YYYY-MM-DD"
              />
            </View>
            <View style={{ width: 104 }}>
              <Field
                label="Local time"
                value={eventStartTime}
                onChangeText={setEventStartTime}
                placeholder="HH:MM"
              />
            </View>
          </View>
          <View style={s.inlineFields}>
            <View style={{ flex: 1 }}>
              <Field
                label="Ends · date"
                value={eventEndDate}
                onChangeText={setEventEndDate}
                placeholder="YYYY-MM-DD"
              />
            </View>
            <View style={{ width: 104 }}>
              <Field
                label="Local time"
                value={eventEndTime}
                onChangeText={setEventEndTime}
                placeholder="HH:MM"
              />
            </View>
          </View>
          <Text style={s.disclaimer}>
            Times use your device&apos;s local time zone: {eventTimeZone}.
          </Text>
          <Field
            label="Attendees"
            value={eventAttendees}
            onChangeText={setEventAttendees}
            placeholder="name@example.com, ..."
            keyboardType="email-address"
          />
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
      {state.settings.mode === "preview" &&
      (proposal.kind === "email" || proposal.kind === "event") ? (
        <Text style={s.disclaimer}>
          Preview mode simulates this action. No email will be sent and no
          external calendar will change.
        </Text>
      ) : null}
      <Text style={s.disclaimer}>
        Edits, approval, and action are separate. Approval applies only to this
        exact version.
      </Text>
      {edited ? (
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
                ? "Approve reply draft"
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
              Connect and verify this exact account before this action is
              available.
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

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameIdentity(
  current: import("../core").Account["identity"] | undefined,
  frozen: NonNullable<import("../core").Account["identity"]>,
) {
  return Boolean(
    current &&
      current.providerNamespace === frozen.providerNamespace &&
      current.clientId === frozen.clientId &&
      current.subject === frozen.subject &&
      current.issuer === frozen.issuer &&
      current.tenantId === frozen.tenantId &&
      current.resourceUserId === frozen.resourceUserId,
  );
}

function localIso(
  date: string,
  time: string,
  timeZone: string,
): string | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch || !timeZone.trim()) return undefined;
  const target = [
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  ];
  const nominal = Date.UTC(
    target[0],
    target[1] - 1,
    target[2],
    target[3],
    target[4],
  );
  if (
    new Date(nominal).getUTCFullYear() !== target[0] ||
    new Date(nominal).getUTCMonth() + 1 !== target[1] ||
    new Date(nominal).getUTCDate() !== target[2] ||
    target[3] > 23 ||
    target[4] > 59
  )
    return undefined;
  try {
    let instant = nominal;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (let i = 0; i < 4; i++) {
      const values = formatter
        .formatToParts(instant)
        .reduce<Record<string, number>>((result, item) => {
          if (["year", "month", "day", "hour", "minute"].includes(item.type))
            result[item.type] = Number(item.value);
          return result;
        }, {});
      const represented = Date.UTC(
        values.year,
        values.month - 1,
        values.day,
        values.hour,
        values.minute,
      );
      const correction = nominal - represented;
      if (correction === 0) return new Date(instant).toISOString();
      instant += correction;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
