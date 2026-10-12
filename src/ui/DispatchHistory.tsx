import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { DispatchRecord, DispatchReconciliation } from "../dispatch";
import { Button, Field } from "./primitives";
import { s } from "./theme";

type ReconcileInput = {
  disposition: DispatchReconciliation;
  note: string;
  remoteId?: string;
};

type DispatchHistoryProps = {
  records: DispatchRecord[];
  incomplete?: boolean;
  busy?: boolean;
  onReconcile?: (recordId: string, input: ReconcileInput) => Promise<unknown>;
  title?: string;
};

const dispositions: { value: DispatchReconciliation; label: string }[] = [
  { value: "confirmed_present", label: "Confirmed in provider" },
  { value: "not_found", label: "Could not find it" },
  { value: "abandoned", label: "Stop checking" },
];

export function DispatchHistory({
  records,
  incomplete = false,
  busy = false,
  onReconcile,
  title = "Dispatch history",
}: DispatchHistoryProps) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...records].sort((a, b) =>
    b.dispatchStartedAt.localeCompare(a.dispatchStartedAt),
  );
  const visible = showAll ? sorted : sorted.slice(0, 5);

  if (!sorted.length && !incomplete) return null;

  return (
    <View style={s.analysisBlock}>
      <Text style={s.label}>{title.toUpperCase()}</Text>
      {incomplete ? (
        <View style={s.analysisStale}>
          <Text style={s.analysisText}>HISTORY INCOMPLETE</Text>
          <Text style={s.analysisSource}>
            Historical account snapshot unavailable. This older action does not
            contain a frozen sender, destination, or approved payload record.
          </Text>
        </View>
      ) : null}
      {visible.map((record, index) => (
        <DispatchRecordView
          key={record.id}
          record={record}
          attemptNumber={sorted.length - index}
          busy={busy}
          onReconcile={onReconcile}
        />
      ))}
      {sorted.length > 5 ? (
        <Button
          label={
            showAll
              ? "Show fewer attempts"
              : `Show ${sorted.length - 5} older attempts`
          }
          tone="quiet"
          onPress={() => setShowAll((shown) => !shown)}
        />
      ) : null}
    </View>
  );
}

function DispatchRecordView({
  record,
  attemptNumber,
  busy,
  onReconcile,
}: {
  record: DispatchRecord;
  attemptNumber: number;
  busy: boolean;
  onReconcile?: DispatchHistoryProps["onReconcile"];
}) {
  const [disposition, setDisposition] = useState<DispatchReconciliation | null>(
    null,
  );
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [note, setNote] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const operation =
    record.operation === "draft"
      ? "Mailbox draft"
      : record.operation === "send"
        ? "Email send"
        : "Calendar event";
  const outcomeLabel =
    record.outcome === "accepted"
      ? `Accepted by ${providerName(record.account.provider)}`
      : record.outcome === "unknown"
        ? "Outcome unknown"
        : record.outcome === "rejected"
          ? record.rejectionCode === "precondition_failed"
            ? "Action stopped"
            : "Provider rejected"
          : "Dispatch in progress";

  return (
    <View style={s.noteCard}>
      <Text style={s.noteTitle}>
        {record.outcome === "pending"
          ? `Attempt ${attemptNumber}`
          : outcomeLabel}
      </Text>
      <Text style={s.analysisSource}>
        {new Date(record.dispatchStartedAt).toLocaleString()} · {operation}
      </Text>
      <Text style={s.analysisSource}>
        Sender · {record.account.displayName || record.account.email} ·{" "}
        {record.account.email} · {providerName(record.account.provider)}
      </Text>
      {record.operation === "event" && record.calendar ? (
        <View>
          <Text style={s.analysisSource}>
            Calendar · {record.calendar.name || "Unnamed calendar"}
          </Text>
          <Text style={s.analysisSource}>
            Destination · {record.calendar.providerId}
          </Text>
        </View>
      ) : null}
      {record.payload.kind === "email" ? (
        <View style={s.analysisBlock}>
          <Text style={s.analysisSource}>
            To · {record.payload.email.to.join(", ")}
          </Text>
          {record.payload.email.cc.length ? (
            <Text style={s.analysisSource}>
              Cc · {record.payload.email.cc.join(", ")}
            </Text>
          ) : null}
          {record.payload.email.bcc.length ? (
            <Text style={s.analysisSource}>
              Bcc · {record.payload.email.bcc.join(", ")}
            </Text>
          ) : null}
          <Text style={s.analysisSource}>
            Subject · {record.payload.email.subject || "(no subject)"}
          </Text>
          <Text style={s.proposalBody}>{record.payload.email.text}</Text>
          {record.payload.email.attachments.length ? (
            <View>
              <Text style={s.analysisSource}>Attachments</Text>
              {record.payload.email.attachments.map((attachment) => (
                <Text key={attachment.id} style={s.analysisSource}>
                  {attachment.fileName} · {attachment.mimeType} ·{" "}
                  {formatBytes(attachment.sizeBytes)}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : (
        <View style={s.analysisBlock}>
          <Text style={s.analysisSource}>
            Event · {record.payload.event.title ?? record.title}
          </Text>
          <Text style={s.analysisSource}>
            {new Date(record.payload.event.start).toLocaleString(undefined, {
              timeZone: record.payload.event.timeZone,
            })}
            {" – "}
            {new Date(record.payload.event.end).toLocaleString(undefined, {
              timeZone: record.payload.event.timeZone,
            })}
            {` · ${record.payload.event.timeZone}`}
          </Text>
          {record.payload.event.attendees.length ? (
            <Text style={s.analysisSource}>
              Attendees · {record.payload.event.attendees.join(", ")}
            </Text>
          ) : null}
          <Text style={s.analysisSource}>
            Invitations ·{" "}
            {record.payload.event.invitePolicy === "send"
              ? "sent with event"
              : "not sent"}
          </Text>
          <Text style={s.proposalBody}>
            {record.payload.event.description ?? record.body}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${showTechnicalDetails ? "Hide" : "Show"} technical details`}
        accessibilityState={{ expanded: showTechnicalDetails }}
        onPress={() => setShowTechnicalDetails((shown) => !shown)}
        style={s.accountChoice}
      >
        <Text style={s.analysisSource}>
          {showTechnicalDetails ? "Hide" : "Show"} technical details
        </Text>
      </Pressable>
      {showTechnicalDetails ? (
        <View style={s.analysisBlock}>
          <Text style={s.analysisSource}>Record · {record.id}</Text>
          <Text style={s.analysisSource}>
            Approved payload digest · {record.payloadDigest}
          </Text>
        </View>
      ) : null}
      {record.remoteId ? (
        <Text style={s.analysisSource}>
          Provider reference · {record.remoteId}
        </Text>
      ) : null}
      {record.outcomeAt ? (
        <Text style={s.analysisSource}>
          Outcome recorded · {new Date(record.outcomeAt).toLocaleString()}
        </Text>
      ) : null}
      {record.rejectionCode ? (
        <Text style={s.analysisSource}>
          Result · {record.rejectionCode.replaceAll("_", " ")}
        </Text>
      ) : null}

      {record.reconciliations.length ? (
        <View style={s.analysisBlock}>
          <Text style={s.label}>PROVIDER CHECKS</Text>
          {record.reconciliations.map((item) => (
            <View key={item.id} style={s.emptySmall}>
              <Text style={s.analysisSource}>
                {dispositionLabel(item.disposition)} ·{" "}
                {new Date(item.at).toLocaleString()}
              </Text>
              {item.note ? (
                <Text style={s.proposalBody}>{item.note}</Text>
              ) : null}
              {item.remoteId ? (
                <Text style={s.analysisSource}>
                  Reference · {item.remoteId}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {record.outcome === "unknown" && onReconcile ? (
        <View style={s.analysisBlock}>
          <Text style={s.disclaimer}>
            This records your check. It does not resend the action or confirm
            delivery.
          </Text>
          {dispositions.map((item) => (
            <Pressable
              key={item.value}
              accessibilityRole="radio"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: disposition === item.value }}
              disabled={busy}
              onPress={() => setDisposition(item.value)}
              style={[
                s.accountChoice,
                disposition === item.value && s.accountChoiceSelected,
                busy && s.disabled,
              ]}
            >
              <Text style={s.accountName}>{item.label}</Text>
            </Pressable>
          ))}
          <Field
            label="Check notes · optional"
            value={note}
            onChangeText={setNote}
            multiline
            placeholder="What did you verify?"
          />
          <Field
            label="Provider reference · optional"
            value={remoteId}
            onChangeText={setRemoteId}
            placeholder="Message, draft, or event reference"
          />
          <Button
            label="Save check result"
            disabled={busy || !disposition}
            onPress={() => {
              if (!disposition) return;
              void (async () => {
                const saved = await onReconcile(record.id, {
                  disposition,
                  note: note.trim(),
                  ...(remoteId.trim() ? { remoteId: remoteId.trim() } : {}),
                });
                if (saved) {
                  setDisposition(null);
                  setNote("");
                  setRemoteId("");
                }
              })();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function providerName(provider: DispatchRecord["account"]["provider"]): string {
  return provider === "google" ? "Gmail" : "Microsoft";
}

function dispositionLabel(disposition: DispatchReconciliation): string {
  return (
    dispositions.find((item) => item.value === disposition)?.label ??
    disposition
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
